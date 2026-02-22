import { v4 as uuidv4 } from 'uuid';
import { detectApprovalPrompt } from './prompt-detector.js';

const APPROVAL_REARM_MS = 90 * 1000;
const AUTO_CONTINUE_HISTORY_MAX = 240;

function buildContinueExecutionInstruction() {
  return '继续执行你刚才提出的下一步，不要停在建议阶段。请直接推进改动或命令，并同步结果与阻塞点。';
}

function buildSupervisorInstructionForContinueSuggestion({ workerId, instruction, sourceText }) {
  const cleanWorkerId = String(workerId || '').trim();
  const cleanInstruction = String(instruction || '').trim();
  const cleanSource = String(sourceText || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 240);

  return [
    `执行窗口 ${cleanWorkerId} 当前停在“如需我继续”的建议阶段。`,
    cleanSource ? `窗口原话摘要：${cleanSource}` : '',
    `用户新要求：${cleanInstruction}`,
    '请先判断应直接答复，还是下发给执行窗口。',
    '如果需要下发，必须输出结构化标签；不要只说“已通知”。',
    `<dispatch_json>{"workerId":"${cleanWorkerId}","instruction":"新的执行指令"}</dispatch_json>`,
  ]
    .filter(Boolean)
    .join(' ');
}

function appendDontAskRule(session, { workerId, fingerprint, kind }) {
  session.dontAskRules.push({
    workerId,
    fingerprint,
    kind,
    createdAt: new Date().toISOString(),
  });
}

function setTargetStatus(session, targetId, status) {
  if (targetId === 'supervisor') {
    if (!session.supervisor || typeof session.supervisor !== 'object') {
      session.supervisor = {
        workerId: 'supervisor',
        mode: 'supervisor_plan',
        status: 'running',
        lastLine: '',
        lastLines: [],
      };
    }
    session.supervisor.status = status;
    return;
  }

  const worker = (session.workers || []).find((item) => item.workerId === targetId);
  if (worker) {
    worker.status = status;
  }
}

function buildSupervisorNoChoiceInstruction({ sourceTargetId, instruction }) {
  const cleanInstruction = String(instruction || '').trim();
  return [
    `用户拒绝了 ${sourceTargetId} 当前执行路径。`,
    cleanInstruction ? `用户补充要求：${cleanInstruction}` : '',
    '请按用户补充要求调整后继续执行，并明确下一步动作。',
  ]
    .filter(Boolean)
    .join(' ');
}

function parseTimestamp(value) {
  const ts = Date.parse(String(value || ''));
  if (!Number.isFinite(ts) || ts <= 0) {
    return 0;
  }
  return ts;
}

function getApprovalRearmMs(kind) {
  if (kind === 'continue_suggestion') {
    return APPROVAL_REARM_MS;
  }
  return APPROVAL_REARM_MS;
}

function nowIso() {
  return new Date().toISOString();
}

function getContinueSuggestionPolicy(session, targetId) {
  const policy = session?.approvalPolicy;
  if (targetId === 'supervisor') {
    const configured = String(policy?.supervisor?.continueSuggestion || '').trim();
    if (configured) {
      return configured;
    }
    return 'auto_continue';
  }

  const configured = String(policy?.worker?.continueSuggestion || '').trim();
  if (configured) {
    return configured;
  }
  return 'queue';
}

function recordAutoContinueHistory(session, { workerId, fingerprint, kind }) {
  const current = Array.isArray(session.autoContinueHistory) ? session.autoContinueHistory : [];
  current.push({
    workerId,
    fingerprint,
    kind,
    at: nowIso(),
  });
  session.autoContinueHistory = current.slice(-AUTO_CONTINUE_HISTORY_MAX);
}

function hasRecentlyHandledSameApproval({ session, workerId, fingerprint, kind }) {
  const approvals = Array.isArray(session.approvals) ? session.approvals : [];
  const now = Date.now();
  const rearmMs = getApprovalRearmMs(kind);
  if (rearmMs <= 0) {
    return false;
  }

  const latest = approvals
    .filter((item) => (
      item.workerId === workerId
      && item.fingerprint === fingerprint
      && item.kind === kind
      && item.status === 'resolved'
    ))
    .sort((a, b) => parseTimestamp(b.resolvedAt || b.createdAt) - parseTimestamp(a.resolvedAt || a.createdAt))[0];

  if (!latest) {
    return false;
  }

  const latestTs = parseTimestamp(latest.resolvedAt || latest.createdAt);
  if (!latestTs) {
    const historyList = Array.isArray(session.autoContinueHistory) ? session.autoContinueHistory : [];
    return historyList.some((item) => (
      item.workerId === workerId
      && item.fingerprint === fingerprint
      && item.kind === kind
      && (now - parseTimestamp(item.at)) < rearmMs
    ));
  }

  if ((now - latestTs) < rearmMs) {
    return true;
  }

  const historyList = Array.isArray(session.autoContinueHistory) ? session.autoContinueHistory : [];
  return historyList.some((item) => (
    item.workerId === workerId
    && item.fingerprint === fingerprint
    && item.kind === kind
    && (now - parseTimestamp(item.at)) < rearmMs
  ));
}

export class ApprovalBrokerService {
  constructor({ runtimeManager, sessionStore, plannerService, onEvent }) {
    this.runtime = runtimeManager;
    this.store = sessionStore;
    this.plannerService = plannerService;
    this.onEvent = onEvent;
  }

  scanAndQueue({ session }) {
    let changed = false;
    const recoveredSupervisorPending = this.autoContinuePendingSupervisorSuggestions({ session });
    if (recoveredSupervisorPending) {
      changed = true;
    }

    const workers = Array.isArray(session.workers) ? session.workers : [];
    const targets = [
      {
        targetId: 'supervisor',
        updateCapture: (capture) => {
          if (!session.supervisor || typeof session.supervisor !== 'object') {
            session.supervisor = {
              workerId: 'supervisor',
              mode: 'supervisor_plan',
              status: 'running',
              lastLine: '',
              lastLines: [],
            };
          }
          session.supervisor.lastLines = capture.lines;
          session.supervisor.lastLine = capture.lastLine;
        },
      },
      ...workers.map((worker) => ({
        targetId: worker.workerId,
        updateCapture: (capture) => {
          worker.lastLines = capture.lines;
          worker.lastLine = capture.lastLine;
        },
      })),
    ];

    for (const target of targets) {
      const capture = this.runtime.readRecentLines({
        sessionId: session.sessionId,
        targetId: target.targetId,
        lineCount: 140,
      });

      const lines = capture.ok ? capture.lines : [];
      const lastLine = capture.ok ? capture.lastLine : '';
      target.updateCapture({
        lines,
        lastLine,
      });

      const detection = detectApprovalPrompt(lines);
      if (!detection.hit) {
        continue;
      }

      const continuePolicy = detection.kind === 'continue_suggestion'
        ? getContinueSuggestionPolicy(session, target.targetId)
        : 'queue';

      const pendingSame = (session.approvals || []).find((item) => (
        item.status === 'pending'
        && item.workerId === target.targetId
        && item.fingerprint === detection.fingerprint
        && item.kind === detection.kind
      ));
      if (pendingSame) {
        continue;
      }

      if (hasRecentlyHandledSameApproval({
        session,
        workerId: target.targetId,
        fingerprint: detection.fingerprint,
        kind: detection.kind,
      })) {
        continue;
      }

      if (detection.kind === 'continue_suggestion' && continuePolicy === 'auto_continue') {
        const result = this.runtime.sendInput({
          sessionId: session.sessionId,
          targetId: target.targetId,
          text: buildContinueExecutionInstruction(),
          pressEnter: true,
        });
        const ok = !!result.ok;
        if (ok) {
          setTargetStatus(session, target.targetId, 'running');
          recordAutoContinueHistory(session, {
            workerId: target.targetId,
            fingerprint: detection.fingerprint,
            kind: detection.kind,
          });
        }
        this.store.appendEvent(session.sessionId, {
          type: ok ? 'approval_auto_continued' : 'approval_auto_continue_failed',
          payload: {
            workerId: target.targetId,
            fingerprint: detection.fingerprint,
            kind: detection.kind,
            policy: continuePolicy,
            ok,
            error: ok ? '' : (result.stderr || result.error || '自动继续发送失败'),
          },
        });
        this.onEvent?.(session.sessionId, {
          type: ok ? 'approval-auto-continued' : 'approval-auto-continue-failed',
          payload: {
            workerId: target.targetId,
            fingerprint: detection.fingerprint,
            kind: detection.kind,
            policy: continuePolicy,
            ok,
            error: ok ? '' : (result.stderr || result.error || '自动继续发送失败'),
          },
        });
        changed = true;
        continue;
      }

      const matchedRule = (session.dontAskRules || []).find((rule) => (
        rule.workerId === target.targetId
        && rule.fingerprint === detection.fingerprint
        && (!rule.kind || rule.kind === detection.kind)
      ));
      if (matchedRule) {
        const autoInstruction = detection.kind === 'continue_suggestion'
          ? buildContinueExecutionInstruction()
          : '2';
        const result = this.runtime.sendInput({
          sessionId: session.sessionId,
          targetId: target.targetId,
          text: autoInstruction,
          pressEnter: true,
        });
        this.store.appendEvent(session.sessionId, {
          type: 'approval_auto_resolved',
          payload: {
            workerId: target.targetId,
            fingerprint: detection.fingerprint,
            kind: detection.kind,
            ok: !!result.ok,
          },
        });
        this.onEvent?.(session.sessionId, {
          type: 'approval-auto-resolved',
          payload: {
            workerId: target.targetId,
            fingerprint: detection.fingerprint,
            kind: detection.kind,
            ok: !!result.ok,
          },
        });
        continue;
      }

      const approval = {
        id: uuidv4(),
        sessionId: session.sessionId,
        workerId: target.targetId,
        sourceText: detection.promptText,
        fingerprint: detection.fingerprint,
        kind: detection.kind,
        options: detection.options,
        status: 'pending',
        createdAt: new Date().toISOString(),
      };
      session.approvals.push(approval);
      setTargetStatus(session, target.targetId, 'waiting_user_input');

      this.store.appendEvent(session.sessionId, {
        type: 'approval_created',
        payload: approval,
      });
      this.onEvent?.(session.sessionId, {
        type: 'approval-created',
        payload: approval,
      });
      changed = true;
    }

    return changed;
  }

  autoContinuePendingSupervisorSuggestions({ session }) {
    const pendingList = Array.isArray(session.approvals)
      ? session.approvals.filter((item) => (
        item.status === 'pending'
        && item.workerId === 'supervisor'
        && item.kind === 'continue_suggestion'
      ))
      : [];
    if (pendingList.length === 0) {
      return false;
    }

    const continuePolicy = getContinueSuggestionPolicy(session, 'supervisor');
    if (continuePolicy !== 'auto_continue') {
      return false;
    }

    const result = this.runtime.sendInput({
      sessionId: session.sessionId,
      targetId: 'supervisor',
      text: buildContinueExecutionInstruction(),
      pressEnter: true,
    });
    const ok = !!result.ok;
    if (!ok) {
      this.store.appendEvent(session.sessionId, {
        type: 'approval_auto_continue_failed',
        payload: {
          workerId: 'supervisor',
          count: pendingList.length,
          approvalIds: pendingList.map((item) => item.id),
          policy: continuePolicy,
          ok: false,
          error: result.stderr || result.error || '自动继续发送失败',
          source: 'pending-recovery',
        },
      });
      this.onEvent?.(session.sessionId, {
        type: 'approval-auto-continue-failed',
        payload: {
          workerId: 'supervisor',
          count: pendingList.length,
          approvalIds: pendingList.map((item) => item.id),
          policy: continuePolicy,
          ok: false,
          error: result.stderr || result.error || '自动继续发送失败',
          source: 'pending-recovery',
        },
      });
      return false;
    }

    const resolvedAt = nowIso();
    for (const item of pendingList) {
      item.status = 'resolved';
      item.resolvedAt = resolvedAt;
      item.resolvedChoice = 1;
      item.instruction = '';
      recordAutoContinueHistory(session, {
        workerId: 'supervisor',
        fingerprint: item.fingerprint,
        kind: item.kind,
      });
    }
    setTargetStatus(session, 'supervisor', 'running');

    this.store.appendEvent(session.sessionId, {
      type: 'approval_auto_continued',
      payload: {
        workerId: 'supervisor',
        count: pendingList.length,
        approvalIds: pendingList.map((item) => item.id),
        policy: continuePolicy,
        ok: true,
        source: 'pending-recovery',
      },
    });
    this.onEvent?.(session.sessionId, {
      type: 'approval-auto-continued',
      payload: {
        workerId: 'supervisor',
        count: pendingList.length,
        approvalIds: pendingList.map((item) => item.id),
        policy: continuePolicy,
        ok: true,
        source: 'pending-recovery',
      },
    });
    return true;
  }

  async resolve({ session, approvalId, choice, instruction = '' }) {
    const approval = (session.approvals || []).find((item) => item.id === approvalId);
    if (!approval) {
      return { ok: false, error: '待处理项不存在' };
    }
    if (approval.status !== 'pending') {
      return { ok: false, error: '该待处理项已处理' };
    }

    if (choice === 3 && !String(instruction || '').trim()) {
      return { ok: false, error: '选择 3 时必须填写替代指令' };
    }

    const targetExists = approval.workerId === 'supervisor'
      ? !!session.supervisor
      : !!(session.workers || []).find((item) => item.workerId === approval.workerId);
    if (!targetExists) {
      return { ok: false, error: `关联窗口不存在: ${approval.workerId}` };
    }

    let finalApplyResult = {
      ok: false,
      stderr: '发送确认结果失败',
    };
    if (approval.kind === 'continue_suggestion') {
      const continueChoiceText = choice === 2
        ? `${buildContinueExecutionInstruction()} 后续同类确认将自动继续执行。`
        : buildContinueExecutionInstruction();

      if (choice === 1 || choice === 2) {
        finalApplyResult = this.runtime.sendInput({
          sessionId: session.sessionId,
          targetId: approval.workerId,
          text: continueChoiceText,
          pressEnter: true,
        });
      } else if (choice === 3) {
        finalApplyResult = this.runtime.sendInput({
          sessionId: session.sessionId,
          targetId: 'supervisor',
          text: buildSupervisorInstructionForContinueSuggestion({
            workerId: approval.workerId,
            instruction,
            sourceText: approval.sourceText,
          }),
          pressEnter: true,
        });
      }
    } else {
      finalApplyResult = this.runtime.sendInput({
        sessionId: session.sessionId,
        targetId: approval.workerId,
        text: String(choice),
        pressEnter: true,
      });
    }

    if (!finalApplyResult.ok) {
      return { ok: false, error: finalApplyResult.stderr || '发送确认结果失败' };
    }

    let replan = null;
    if (choice === 2) {
      appendDontAskRule(session, {
        workerId: approval.workerId,
        fingerprint: approval.fingerprint,
        kind: approval.kind,
      });
    }

    if (choice === 3) {
      if (approval.kind !== 'continue_suggestion') {
        if (approval.workerId === 'supervisor') {
          const supervisorAdjust = this.runtime.sendInput({
            sessionId: session.sessionId,
            targetId: 'supervisor',
            text: buildSupervisorNoChoiceInstruction({
              sourceTargetId: approval.workerId,
              instruction,
            }),
            pressEnter: true,
          });
          replan = {
            ok: !!supervisorAdjust.ok,
            mode: 'supervisor_direct_instruction',
            dispatch: {
              workerId: 'supervisor',
              instruction: String(instruction || '').trim(),
            },
            error: supervisorAdjust.ok ? '' : (supervisorAdjust.stderr || supervisorAdjust.error || '发送失败'),
          };
        } else {
          replan = await this.plannerService.requestReplanForNoChoice({
            sessionId: session.sessionId,
            workerId: approval.workerId,
            instruction: String(instruction || '').trim(),
          });
        }

        if (replan.ok && approval.workerId !== 'supervisor') {
          this.runtime.sendInput({
            sessionId: session.sessionId,
            targetId: replan.dispatch.workerId,
            text: replan.dispatch.instruction,
            pressEnter: true,
          });
        }
      } else {
        replan = {
          ok: true,
          mode: 'supervisor_manual_dispatch',
          dispatch: {
            workerId: approval.workerId,
            instruction: String(instruction || '').trim(),
          },
        };
      }
    }

    approval.status = 'resolved';
    approval.resolvedAt = new Date().toISOString();
    approval.resolvedChoice = choice;
    approval.instruction = String(instruction || '').trim();

    setTargetStatus(session, approval.workerId, 'running');

    this.store.appendEvent(session.sessionId, {
      type: 'approval_resolved',
      payload: {
        approvalId,
        workerId: approval.workerId,
        choice,
        instruction: approval.instruction,
        replan,
      },
    });

    this.onEvent?.(session.sessionId, {
      type: 'approval-resolved',
      payload: {
        approvalId,
        workerId: approval.workerId,
        choice,
        instruction: approval.instruction,
        replan,
      },
    });

    return {
      ok: true,
      replan,
    };
  }
}
