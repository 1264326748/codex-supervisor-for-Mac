import { v4 as uuidv4 } from 'uuid';
import { parseSupervisorDispatchActionsFromText } from '../../shared/parsers.js';

function nowIso() {
  return new Date().toISOString();
}

function isPlanningBusy(state) {
  return state === 'running' || state === 'retrying';
}

function isRecoverableStatus(status) {
  return ['planning', 'running', 'partial_error', 'error'].includes(String(status || ''));
}

function buildCodexRuntimeCommand() {
  return [
    'codex',
    '--no-alt-screen',
    '-c mcp_servers.context7.enabled=false',
    '-c mcp_servers.mcp-deepwiki.enabled=false',
    '-c mcp_servers.open-websearch.enabled=false',
    '-c mcp_servers.playwright.enabled=false',
    '-c mcp_servers.serena.enabled=false',
    '-c mcp_servers.spec-workflow.enabled=false',
  ].join(' ');
}

function normalizeDispatchInstruction(text) {
  return String(text || '')
    .replace(/\s+/g, ' ')
    .trim();
}

function detectExampleDispatchReason(instruction) {
  const clean = String(instruction || '').trim();
  const compact = clean.replace(/\s+/g, '');
  if (!clean) {
    return '空指令';
  }

  const exactPlaceholders = new Set([
    '具体执行指令',
    '新的执行指令',
    '示例指令',
    'example instruction',
    'placeholder',
    'your instruction here',
    '待填写',
  ]);
  if (exactPlaceholders.has(clean.toLowerCase()) || exactPlaceholders.has(clean)) {
    return '命中占位词';
  }

  if (/具体执行指令|新的执行指令|your instruction here|placeholder|待填写/i.test(clean)) {
    return '命中占位词';
  }
  if (/示例|example|模板|样例/i.test(clean)) {
    return '命中示例语义';
  }
  if (compact.length <= 18 && /指令/.test(clean)) {
    return '疑似示例短语';
  }
  return '';
}

function countPendingApprovals(session, targetId) {
  const list = Array.isArray(session?.approvals) ? session.approvals : [];
  return list.filter((item) => (
    item.status === 'pending'
    && item.workerId === targetId
  )).length;
}

export class SessionOrchestrator {
  constructor({ sessionStore, runtimeManager, plannerService, dispatchService, approvalBroker, onBroadcast }) {
    this.store = sessionStore;
    this.runtime = runtimeManager;
    this.planner = plannerService;
    this.dispatcher = dispatchService;
    this.approvalBroker = approvalBroker;
    this.onBroadcast = onBroadcast;
    this.watchers = new Map();
    this.planningJobs = new Map();

    this.runtime.on('output', (event) => {
      this.pushEvent(event.sessionId, {
        type: 'worker-log',
        payload: event,
      });
    });
  }

  listSessions() {
    return this.store.listSessions();
  }

  recoverSessionsOnStartup() {
    const sessionIds = this.store.listSessionIds();
    for (const sessionId of sessionIds) {
      const session = this.store.getSession(sessionId);
      if (!session || !isRecoverableStatus(session.status)) {
        continue;
      }

      const workerIds = Array.isArray(session.workers)
        ? session.workers.map((item) => item.workerId).filter(Boolean)
        : [];
      const targetIds = ['supervisor', ...workerIds];
      const tmuxSession = String(session.runtimeMeta?.tmuxSession || '').trim();

      if (session.runtime !== 'tmux' || !tmuxSession) {
        this.store.updateSession(sessionId, (current) => {
          current.status = 'error';
          current.error = '应用重启后无法恢复该会话运行时';
          current.planning = {
            ...(current.planning || {}),
            state: 'failed',
            phase: 'runtime-lost',
            message: '应用重启后无法恢复该会话运行时',
            lastError: '应用重启后无法恢复该会话运行时',
            finishedAt: nowIso(),
          };
          return current;
        });
        this.store.appendEvent(sessionId, {
          type: 'session_recover_failed',
          payload: {
            reason: 'unsupported-runtime',
            runtime: session.runtime,
          },
        });
        this.pushSnapshot(sessionId);
        continue;
      }

      const attached = this.runtime.attachTmuxSession({
        sessionId,
        tmuxSession,
        targetIds,
      });
      if (!attached.ok) {
        this.store.updateSession(sessionId, (current) => {
          current.status = 'error';
          current.error = attached.error || '会话恢复失败';
          current.planning = {
            ...(current.planning || {}),
            state: 'failed',
            phase: 'runtime-lost',
            message: attached.error || '会话恢复失败',
            lastError: attached.error || '会话恢复失败',
            finishedAt: nowIso(),
          };
          return current;
        });
        this.store.appendEvent(sessionId, {
          type: 'session_recover_failed',
          payload: {
            reason: attached.error || 'attach-failed',
            tmuxSession,
          },
        });
        this.pushSnapshot(sessionId);
        continue;
      }

      this.startWatcher(sessionId);
      const planningState = String(session.planning?.state || '');
      const needManualPlanningRecovery = session.status === 'planning' || isPlanningBusy(planningState);
      if (needManualPlanningRecovery) {
        this.store.updateSession(sessionId, (current) => {
          current.status = 'error';
          current.error = '应用重启后已暂停自动规划，请手动重新触发规划';
          current.planning = {
            ...(current.planning || {}),
            state: 'failed',
            phase: 'recovery-pending',
            message: '应用已恢复连接，但未自动继续规划。请手动点击“重新触发规划”。',
            lastError: '应用重启后已暂停自动规划，请手动重新触发规划',
            finishedAt: nowIso(),
          };
          return current;
        });
      }

      this.store.appendEvent(sessionId, {
        type: 'session_recovered',
        payload: {
          runtime: 'tmux',
          tmuxSession,
          autoResumeTriggered: false,
          needManualPlanningRecovery,
        },
      });
      this.pushEvent(sessionId, {
        type: 'session-recovered',
        payload: {
          runtime: 'tmux',
          tmuxSession,
          autoResumeTriggered: false,
          needManualPlanningRecovery,
        },
      });

      this.pushSnapshot(sessionId);
    }
  }

  getSession(sessionId) {
    const session = this.store.getSession(sessionId);
    if (!session) {
      return null;
    }

    return {
      ...session,
      logTail: this.store.readLogTail(sessionId, 160),
    };
  }

  async createSession({ objective, workerCount, workspacePath }) {
    const cleanObjective = String(objective || '').trim();
    const cleanPath = String(workspacePath || process.cwd()).trim();
    const count = Number(workerCount || 0);

    if (!cleanObjective) {
      throw new Error('目标不能为空');
    }
    if (!Number.isInteger(count) || count <= 0) {
      throw new Error('执行窗口数量必须是正整数');
    }

    const sessionId = `session-${Date.now()}-${uuidv4().slice(0, 8)}`;
    const codexCommand = buildCodexRuntimeCommand();
    const runtimeStart = this.runtime.startSession({
      sessionId,
      workspacePath: cleanPath,
      workerCount: count,
      preferredRuntime: 'hybrid',
      supervisorCommand: codexCommand,
      workerCommand: codexCommand,
    });

    const workers = runtimeStart.workerIds.map((workerId) => ({
      workerId,
      mode: 'executor_agent',
      status: 'starting',
      lastLine: '',
      lastLines: [],
    }));

    this.store.createSession({
      sessionId,
      objective: cleanObjective,
      workspacePath: cleanPath,
      status: 'planning',
      runtime: runtimeStart.runtime,
      runtimeMeta: {
        tmuxSession: runtimeStart.tmuxSession || '',
      },
      planning: {
        state: 'running',
        phase: 'start',
        attempt: 0,
        maxAttempts: 3,
        message: '主管准备开始拆解',
        lastError: '',
        errors: [],
        startedAt: nowIso(),
        finishedAt: '',
      },
      supervisor: {
        workerId: runtimeStart.supervisorId,
        mode: 'supervisor_plan',
        status: 'running',
        lastLine: '',
        lastLines: [],
        processedDispatchKeys: [],
      },
      workers,
      planSummary: '',
      planTasks: [],
      approvals: [],
      dontAskRules: [],
      approvalPolicy: {
        supervisor: {
          continueSuggestion: 'auto_continue',
        },
        worker: {
          continueSuggestion: 'queue',
        },
      },
      autoContinueHistory: [],
      createdAt: nowIso(),
      updatedAt: nowIso(),
    });

    this.pushSnapshot(sessionId);
    this.startWatcher(sessionId);
    this.startPlanningCycle(sessionId, {
      objective: cleanObjective,
      workerCount: count,
      trigger: 'initial',
    });

    return this.getSession(sessionId);
  }

  retryPlanning(sessionId) {
    const session = this.store.getSession(sessionId);
    if (!session) {
      throw new Error('会话不存在');
    }
    if (session.status === 'stopped') {
      throw new Error('会话已停止，不能重新规划');
    }
    if (this.planningJobs.has(sessionId)) {
      throw new Error('主管规划正在执行中，请稍后再试');
    }

    const workerCount = Array.isArray(session.workers) ? session.workers.length : 0;
    if (!Number.isInteger(workerCount) || workerCount <= 0) {
      throw new Error('当前会话没有可规划的执行窗口');
    }

    this.store.updateSession(sessionId, (current) => {
      current.status = 'planning';
      current.planning = {
        ...(current.planning || {}),
        state: 'running',
        phase: 'manual-start',
        attempt: 0,
        maxAttempts: 3,
        message: '已手动触发主管重新规划',
        lastError: '',
        errors: [],
        startedAt: nowIso(),
        finishedAt: '',
      };
      return current;
    });

    this.store.appendEvent(sessionId, {
      type: 'planning_manual_retriggered',
      payload: {
        at: nowIso(),
      },
    });

    this.pushSnapshot(sessionId);
    this.startPlanningCycle(sessionId, {
      objective: String(session.objective || '').trim(),
      workerCount,
      trigger: 'manual',
    });

    return this.getSession(sessionId);
  }

  async resumeUnfinishedSession(sessionId, { source = 'manual' } = {}) {
    const session = this.store.getSession(sessionId);
    if (!session) {
      throw new Error('会话不存在');
    }
    if (session.status === 'stopped') {
      throw new Error('会话已停止，无法恢复未完成任务');
    }

    const workerIds = Array.isArray(session.workers)
      ? session.workers.map((item) => item.workerId).filter(Boolean)
      : [];
    if (workerIds.length === 0) {
      throw new Error('当前会话没有可恢复的执行窗口');
    }

    const supervisorPrompt = [
      '应用已恢复，请检查所有执行窗口的未完成任务。',
      `会话目标：${session.objective}`,
      `执行窗口：${workerIds.join(', ')}`,
      '若某窗口任务尚未完成，请提醒其继续推进并在输出中标注窗口编号与当前阶段；',
      '若某窗口已完成，请明确标注已完成。',
      '仅做进度协同，不要改写既有任务边界。',
    ].join(' ');
    const supervisorSend = this.runtime.sendInput({
      sessionId,
      targetId: 'supervisor',
      text: supervisorPrompt,
      pressEnter: true,
    });

    const workerResults = [];
    for (const workerId of workerIds) {
      const matchedTask = (session.planTasks || []).find((item) => item.workerId === workerId);
      const workerPrompt = [
        '应用已恢复，请继续你当前未完成任务。',
        matchedTask?.title ? `当前子任务：${matchedTask.title}。` : '',
        '先用一句话同步当前进度，再继续执行。',
      ]
        .filter(Boolean)
        .join(' ');
      const sent = this.runtime.sendInput({
        sessionId,
        targetId: workerId,
        text: workerPrompt,
        pressEnter: true,
      });
      workerResults.push({
        workerId,
        ok: !!sent.ok,
        error: sent.ok ? '' : (sent.stderr || sent.error || '发送失败'),
      });
    }

    const payload = {
      source,
      supervisor: {
        ok: !!supervisorSend.ok,
        error: supervisorSend.ok ? '' : (supervisorSend.stderr || supervisorSend.error || '发送失败'),
      },
      workers: workerResults,
    };

    this.store.appendEvent(sessionId, {
      type: 'session_resume_requested',
      payload,
    });
    this.pushEvent(sessionId, {
      type: 'session-resume-requested',
      payload,
    });
    this.pushSnapshot(sessionId);

    return {
      ok: payload.supervisor.ok && workerResults.every((item) => item.ok),
      ...payload,
    };
  }

  startPlanningCycle(sessionId, { objective, workerCount, trigger }) {
    if (this.planningJobs.has(sessionId)) {
      return;
    }

    const job = this.runPlanningCycle(sessionId, {
      objective,
      workerCount,
      trigger,
    }).finally(() => {
      this.planningJobs.delete(sessionId);
    });

    this.planningJobs.set(sessionId, job);
  }

  async runPlanningCycle(sessionId, { objective, workerCount, trigger = 'initial' }) {
    try {
      await this.bootstrapSession(sessionId, {
        objective,
        workerCount,
        trigger,
      });
    } catch (error) {
      const failMessage = String(error?.message || error);
      const failPhase = failMessage.includes('主管规划失败（严格模式）')
        ? 'planning-failed'
        : 'bootstrap-error';
      this.store.updateSession(sessionId, (current) => {
        current.status = 'error';
        current.error = failMessage;
        current.planning = {
          ...(current.planning || {}),
          state: 'failed',
          phase: failPhase,
          message: failMessage,
          lastError: failMessage,
          finishedAt: nowIso(),
        };
        return current;
      });
      this.store.appendEvent(sessionId, {
        type: trigger === 'manual' ? 'planning_manual_failed' : 'session_bootstrap_failed',
        payload: { message: failMessage, trigger },
      });
      this.pushEvent(sessionId, {
        type: 'error',
        payload: { message: failMessage },
      });
      this.pushSnapshot(sessionId);
    }
  }

  async bootstrapSession(sessionId, { objective, workerCount, trigger = 'initial' }) {
    this.store.updateSession(sessionId, (current) => {
      current.status = 'planning';
      current.planning = {
        ...(current.planning || {}),
        state: 'running',
        phase: trigger === 'manual' ? 'manual-start' : 'start',
        attempt: 0,
        maxAttempts: 3,
        message: trigger === 'manual' ? '手动重启规划流程中' : '主管准备开始拆解',
        lastError: '',
        errors: [],
        startedAt: nowIso(),
        finishedAt: '',
      };
      return current;
    });
    this.pushSnapshot(sessionId);

    const plan = await this.planner.requestPlan({
      sessionId,
      objective,
      workerCount,
      allowFallback: false,
      onProgress: (progress) => {
        const progressPayload = {
          ...progress,
          trigger,
        };

        this.store.updateSession(sessionId, (current) => {
          current.planning = {
            ...(current.planning || {}),
            ...progressPayload,
            startedAt: current.planning?.startedAt || nowIso(),
            finishedAt: ['succeeded', 'failed', 'fallback'].includes(progress.state)
              ? nowIso()
              : (current.planning?.finishedAt || ''),
          };
          return current;
        });

        this.store.appendEvent(sessionId, {
          type: 'planning_status_updated',
          payload: progressPayload,
        });

        this.pushEvent(sessionId, {
          type: 'planning-status',
          payload: progressPayload,
        });
        this.pushSnapshot(sessionId);
      },
    });

    this.store.updateSession(sessionId, (current) => {
      current.planSummary = String(plan.planSummary || '').trim();
      current.planTasks = plan.tasks;
      current.planning = {
        ...(current.planning || {}),
        state: current.planning?.state === 'fallback' ? 'fallback' : 'succeeded',
        phase: 'dispatching',
        message: '主管规划完成，准备派发到执行窗口',
        finishedAt: nowIso(),
      };
      return current;
    });

    const dispatchResult = await this.dispatcher.dispatchPlan({
      sessionId,
      plan,
    });

    this.store.updateSession(sessionId, (current) => {
      for (const worker of current.workers) {
        const matched = dispatchResult.find((item) => item.workerId === worker.workerId);
        if (!matched) {
          continue;
        }
        worker.status = matched.ok ? 'running' : 'error';
      }
      current.status = dispatchResult.every((item) => item.ok) ? 'running' : 'partial_error';
      current.planning = {
        ...(current.planning || {}),
        phase: 'completed',
        message: dispatchResult.every((item) => item.ok)
          ? '任务已全部派发'
          : '任务已派发，但存在失败窗口',
      };
      return current;
    });

    this.store.appendEvent(sessionId, {
      type: 'planning_cycle_completed',
      payload: {
        trigger,
        ok: dispatchResult.every((item) => item.ok),
      },
    });

    this.pushSnapshot(sessionId);
  }

  startWatcher(sessionId) {
    if (this.watchers.has(sessionId)) {
      return;
    }

    const timer = setInterval(() => {
      const session = this.store.getSession(sessionId);
      if (!session) {
        this.stopWatcher(sessionId);
        return;
      }

      let changed = false;
      const supervisorCapture = this.runtime.readRecentLines({
        sessionId,
        targetId: 'supervisor',
        lineCount: 120,
      });
      if (supervisorCapture.ok) {
        if (session.supervisor.lastLine !== supervisorCapture.lastLine) {
          session.supervisor.lastLine = supervisorCapture.lastLine;
          changed = true;
        }
        const supervisorLines = Array.isArray(supervisorCapture.lines) ? supervisorCapture.lines : [];
        const nextSupervisorLines = supervisorLines.slice(-160);
        const prevSupervisorLines = Array.isArray(session.supervisor.lastLines) ? session.supervisor.lastLines : [];
        if (JSON.stringify(prevSupervisorLines) !== JSON.stringify(nextSupervisorLines)) {
          session.supervisor.lastLines = nextSupervisorLines;
          changed = true;
        }

        const parsedDispatches = parseSupervisorDispatchActionsFromText(
          supervisorLines.join('\n'),
          {
            workerIds: Array.isArray(session.workers)
              ? session.workers.map((item) => item.workerId)
              : [],
          },
        );
        if (parsedDispatches.ok) {
          const dispatchApplied = this.applySupervisorDispatchActions({
            session,
            actions: parsedDispatches.actions,
          });
          if (dispatchApplied) {
            changed = true;
          }
        }
      }

      for (const worker of session.workers || []) {
        const capture = this.runtime.readRecentLines({
          sessionId,
          targetId: worker.workerId,
          lineCount: 120,
        });
        if (capture.ok) {
          const nextLast = capture.lastLine;
          if (worker.lastLine !== nextLast) {
            worker.lastLine = nextLast;
            worker.lastLines = capture.lines;
            changed = true;
          }
        }
      }

      const approvalChanged = this.approvalBroker.scanAndQueue({ session });
      if (approvalChanged) {
        changed = true;
      }

      if (changed) {
        this.store.saveSession(session);
        this.pushSnapshot(sessionId);
      }
    }, 2000);

    this.watchers.set(sessionId, timer);
  }

  buildDispatchActionKey(action) {
    const workerId = String(action?.workerId || '').trim().toLowerCase();
    const instruction = normalizeDispatchInstruction(action?.instruction || '');
    if (!workerId || !instruction) {
      return '';
    }
    return `${workerId}::${instruction}`;
  }

  applySupervisorDispatchActions({ session, actions }) {
    const list = Array.isArray(actions) ? actions : [];
    if (list.length === 0) {
      return false;
    }

    if (!session.supervisor || typeof session.supervisor !== 'object') {
      session.supervisor = {
        workerId: 'supervisor',
        mode: 'supervisor_plan',
        status: 'running',
        lastLine: '',
        lastLines: [],
      };
    }
    const processedRaw = Array.isArray(session.supervisor.processedDispatchKeys)
      ? session.supervisor.processedDispatchKeys
      : [];
    const processedSet = new Set(
      processedRaw
        .map((item) => String(item || '').trim())
        .filter(Boolean),
    );

    let appliedAny = false;
    for (const action of list) {
      const workerId = String(action?.workerId || '').trim();
      const instruction = normalizeDispatchInstruction(action?.instruction || '');
      const actionKey = this.buildDispatchActionKey({ workerId, instruction });
      if (!workerId || !instruction || !actionKey) {
        continue;
      }
      if (processedSet.has(actionKey)) {
        continue;
      }

      const exampleReason = detectExampleDispatchReason(instruction);
      if (exampleReason) {
        processedSet.add(actionKey);
        appliedAny = true;
        this.store.appendEvent(session.sessionId, {
          type: 'supervisor_dispatch_rejected_as_example',
          payload: {
            workerId,
            instruction,
            ok: false,
            reason: exampleReason,
            source: 'supervisor-structured-output',
          },
        });
        this.pushEvent(session.sessionId, {
          type: 'supervisor-dispatch-rejected-as-example',
          payload: {
            workerId,
            instruction,
            ok: false,
            reason: exampleReason,
            source: 'supervisor-structured-output',
          },
        });
        continue;
      }

      const sent = this.runtime.sendInput({
        sessionId: session.sessionId,
        targetId: workerId,
        text: instruction,
        pressEnter: true,
      });
      const ok = !!sent.ok;
      const error = ok ? '' : (sent.stderr || sent.error || '下发失败');

      if (ok) {
        const worker = Array.isArray(session.workers)
          ? session.workers.find((item) => item.workerId === workerId)
          : null;
        if (worker) {
          worker.status = 'running';
        }
      }

      processedSet.add(actionKey);
      appliedAny = true;

      this.store.appendEvent(session.sessionId, {
        type: ok ? 'supervisor_dispatch_applied' : 'supervisor_dispatch_failed',
        payload: {
          workerId,
          instruction,
          ok,
          error,
          source: 'supervisor-structured-output',
        },
      });
      this.pushEvent(session.sessionId, {
        type: ok ? 'supervisor-dispatch-applied' : 'supervisor-dispatch-failed',
        payload: {
          workerId,
          instruction,
          ok,
          error,
          source: 'supervisor-structured-output',
        },
      });
    }

    if (!appliedAny) {
      return false;
    }

    const processedList = Array.from(processedSet);
    session.supervisor.processedDispatchKeys = processedList.slice(-360);
    return true;
  }

  stopWatcher(sessionId) {
    const timer = this.watchers.get(sessionId);
    if (!timer) {
      return;
    }
    clearInterval(timer);
    this.watchers.delete(sessionId);
  }

  async resolveApproval({ sessionId, approvalId, choice, instruction }) {
    const session = this.store.getSession(sessionId);
    if (!session) {
      throw new Error('会话不存在');
    }

    const result = await this.approvalBroker.resolve({
      session,
      approvalId,
      choice,
      instruction,
    });

    if (!result.ok) {
      throw new Error(result.error || '处理失败');
    }

    this.store.saveSession(session);
    this.pushSnapshot(sessionId);

    return result;
  }

  async resolveApprovalsBatch({ sessionId, actions }) {
    const list = Array.isArray(actions) ? actions : [];
    const results = [];

    for (const action of list) {
      try {
        const resolved = await this.resolveApproval({
          sessionId,
          approvalId: String(action.approvalId || '').trim(),
          choice: Number(action.choice || 0),
          instruction: String(action.instruction || '').trim(),
        });
        results.push({
          approvalId: String(action.approvalId || '').trim(),
          ok: true,
          result: resolved,
        });
      } catch (error) {
        results.push({
          approvalId: String(action.approvalId || '').trim(),
          ok: false,
          error: String(error?.message || error),
        });
      }
    }

    return {
      ok: results.every((item) => item.ok),
      results,
    };
  }

  sendManualInput({ sessionId, targetId, text, pressEnter = true, source = 'manual-console' }) {
    const id = String(sessionId || '').trim();
    const target = String(targetId || '').trim();
    const content = String(text || '');

    if (!id) {
      throw new Error('会话不存在');
    }
    if (!target) {
      throw new Error('目标窗口不能为空');
    }
    if (!content.trim()) {
      throw new Error('发送内容不能为空');
    }

    const session = this.store.getSession(id);
    if (!session) {
      throw new Error('会话不存在');
    }

    const allowedTargets = new Set([
      'supervisor',
      ...(Array.isArray(session.workers) ? session.workers.map((item) => item.workerId) : []),
    ]);
    if (!allowedTargets.has(target)) {
      throw new Error(`目标窗口不存在：${target}`);
    }

    const sent = this.runtime.sendInput({
      sessionId: id,
      targetId: target,
      text: content,
      pressEnter: !!pressEnter,
    });
    if (!sent.ok) {
      const message = sent.stderr || sent.error || '发送失败';
      this.store.appendEvent(id, {
        type: 'manual_input_failed',
        payload: {
          targetId: target,
          source,
          error: message,
          length: content.length,
        },
      });
      throw new Error(message);
    }

    this.store.appendEvent(id, {
      type: 'manual_input_sent',
      payload: {
        targetId: target,
        source,
        length: content.length,
        preview: content.slice(0, 180),
      },
    });
    this.pushEvent(id, {
      type: 'manual-input-sent',
      payload: {
        targetId: target,
        source,
        length: content.length,
      },
    });

    if (target === 'supervisor') {
      const pendingCount = countPendingApprovals(session, 'supervisor');
      if (pendingCount > 0) {
        const firstPending = (session.approvals || []).find((item) => (
          item.status === 'pending'
          && item.workerId === 'supervisor'
        ));
        const payload = {
          targetId: 'supervisor',
          source,
          pendingCount,
          pendingApprovalId: firstPending?.id || '',
        };
        this.store.appendEvent(id, {
          type: 'manual_input_blocked_by_pending',
          payload,
        });
        this.pushEvent(id, {
          type: 'manual-input-blocked-by-pending',
          payload,
        });
      }

      const baselineLastLine = String(session.supervisor?.lastLine || '');
      setTimeout(() => {
        const latest = this.store.getSession(id);
        if (!latest || latest.status === 'stopped') {
          return;
        }
        const latestPendingCount = countPendingApprovals(latest, 'supervisor');
        if (latestPendingCount <= 0) {
          return;
        }
        const latestLastLine = String(latest.supervisor?.lastLine || '');
        if (latestLastLine !== baselineLastLine) {
          return;
        }
        const payload = {
          targetId: 'supervisor',
          source,
          waitedMs: 15000,
          pendingCount: latestPendingCount,
          lastLine: latestLastLine,
        };
        this.store.appendEvent(id, {
          type: 'manual_input_no_output_timeout',
          payload,
        });
        this.pushEvent(id, {
          type: 'manual-input-no-output-timeout',
          payload,
        });
      }, 15000);
    }

    this.pushSnapshot(id);

    return {
      ok: true,
      targetId: target,
      length: content.length,
    };
  }

  stopSession(sessionId) {
    const result = this.runtime.stopSession(sessionId);
    this.stopWatcher(sessionId);
    this.store.updateSession(sessionId, (session) => {
      session.status = 'stopped';
      return session;
    });
    this.pushSnapshot(sessionId);
    return result;
  }

  isSessionPlanningBusy(sessionId) {
    if (this.planningJobs.has(sessionId)) {
      return true;
    }
    const session = this.store.getSession(sessionId);
    if (!session) {
      return false;
    }
    return isPlanningBusy(session.planning?.state);
  }

  pushSnapshot(sessionId) {
    const snapshot = this.getSession(sessionId);
    if (!snapshot) {
      return;
    }
    this.pushEvent(sessionId, {
      type: 'session-updated',
      payload: {
        session: snapshot,
      },
    });
  }

  pushEvent(sessionId, event) {
    this.onBroadcast?.(sessionId, {
      ...event,
      sessionId,
      at: nowIso(),
    });
  }
}
