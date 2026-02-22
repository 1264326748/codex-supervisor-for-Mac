import { parseSupervisorPlanFromText, parseDispatchInstructionFromText } from '../../shared/parsers.js';

const POLL_INTERVAL_MS = 1800;
const PLAN_WAIT_TIMEOUT_MS = 180000;
const FORMAT_REPAIR_TIMEOUT_MS = 90000;
const SUPERVISOR_READY_TIMEOUT_MS = 90000;
const READY_CHECK_INTERVAL_MS = 1200;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildNonParsableJsonExample() {
  return '{"planSummary":"一句话总结","tasks":[{"workerIndex":<number>,"title":"子任务标题","instruction":"可直接发送给执行窗口的完整指令","dependsOn":[<number>]}]}';
}

function toSingleLine(text) {
  return String(text || '')
    .replace(/\s*\n+\s*/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function probeSupervisorReady(text) {
  const lines = String(text || '')
    .replace(/\r/g, '')
    .split('\n');
  const recentLines = lines.slice(-120);
  const source = recentLines.join('\n');
  if (!source) {
    return false;
  }

  const hasShellPrompt = /\?\s+for shortcuts/i.test(source)
    || /\/\s+for commands/i.test(source);
  const lastModelLine = recentLines
    .slice()
    .reverse()
    .find((line) => /model:/i.test(line)) || '';
  const modelReady = lastModelLine ? !/model:\s+loading/i.test(lastModelLine) : true;
  const hasCodexBanner = />_\s+OpenAI Codex/i.test(source);

  return hasShellPrompt && modelReady && hasCodexBanner;
}

export class SupervisorPlannerService {
  constructor({ runtimeManager, sessionStore, onEvent }) {
    this.runtime = runtimeManager;
    this.store = sessionStore;
    this.onEvent = onEvent;
  }

  buildPlanPrompt({ objective, workerCount, previousError = '', attempt = 1, totalAttempts = 1 }) {
    const retrySuffix = previousError
      ? `上一轮失败原因：${previousError}。请修正格式并重新输出完整 JSON。`
      : '';

    return toSingleLine([
      '你现在是任务主管窗口。',
      '要求：仅做规划，不执行命令，不改文件。',
      `总目标：${objective}`,
      `执行窗口数量：${workerCount}`,
      `当前尝试：第 ${attempt} / ${totalAttempts} 轮`,
      '请输出一个结构化计划，必须严格使用以下格式：',
      `<task_plan_json>${buildNonParsableJsonExample()}</task_plan_json>`,
      '注意：',
      `1) tasks 数量必须等于 ${workerCount}；`,
      `2) workerIndex 必须覆盖 1 到 ${workerCount}；`,
      '3) 每条 instruction 必须为非空字符串，且可直接执行；',
      '4) 输出内容里只有 JSON 标签块，不要额外说明；',
      retrySuffix,
    ].join('\n'));
  }

  buildFormatRepairPrompt({ workerCount, reason = '' }) {
    const reasonText = reason
      ? `上一轮解析失败原因：${reason}`
      : '';

    return toSingleLine([
      '你上一条回复已收到，但系统无法解析。',
      reasonText,
      '不要重新分析目标，不要补充解释。',
      '请把你刚才给出的分工内容，改写成严格 JSON 标签块并立即输出：',
      `<task_plan_json>${buildNonParsableJsonExample()}</task_plan_json>`,
      '强约束：',
      `1) tasks 必须正好 ${workerCount} 条；`,
      `2) workerIndex 必须覆盖 1 到 ${workerCount}；`,
      '3) instruction 必须是非空字符串；',
      '4) 禁止输出任何额外文字。',
    ].join('\n'));
  }

  async requestPlan({
    sessionId,
    objective,
    workerCount,
    maxRetries = 2,
    onProgress,
    allowFallback = false,
  }) {
    const totalAttempts = maxRetries + 1;
    const errors = [];

    onProgress?.({
      state: 'running',
      phase: 'start',
      attempt: 0,
      maxAttempts: totalAttempts,
      message: '主管开始拆解任务',
      lastError: '',
      errors,
    });

    onProgress?.({
      state: 'running',
      phase: 'supervisor-wait-ready',
      attempt: 0,
      maxAttempts: totalAttempts,
      message: '等待主管窗口就绪',
      lastError: '',
      errors,
    });

    const ready = await this.waitSupervisorReady({
      sessionId,
      timeoutMs: SUPERVISOR_READY_TIMEOUT_MS,
    });
    if (!ready.ok) {
      const readyError = ready.error || '主管窗口未就绪';
      errors.push(readyError);

      if (allowFallback) {
        const fallbackPlan = this.buildFallbackPlan({ objective, workerCount });
        this.store.appendEvent(sessionId, {
          type: 'supervisor_plan_fallback',
          payload: fallbackPlan,
        });

        onProgress?.({
          state: 'fallback',
          phase: 'fallback',
          attempt: 0,
          maxAttempts: totalAttempts,
          message: '主管窗口未就绪，已启用本地兜底分解',
          lastError: errors[errors.length - 1],
          errors,
        });

        return fallbackPlan;
      }

      onProgress?.({
        state: 'failed',
        phase: 'strict-failed',
        attempt: 0,
        maxAttempts: totalAttempts,
        message: '主管窗口未就绪，严格模式已终止本次规划',
        lastError: readyError,
        errors,
      });

      throw new Error(`主管规划失败（严格模式）：${readyError}`);
    }

    for (let attempt = 1; attempt <= totalAttempts; attempt += 1) {
      const lastError = errors.length > 0 ? errors[errors.length - 1] : '';
      const prompt = this.buildPlanPrompt({
        objective,
        workerCount,
        previousError: lastError,
        attempt,
        totalAttempts,
      });

      onProgress?.({
        state: 'running',
        phase: 'attempt',
        attempt,
        maxAttempts: totalAttempts,
        message: `主管第 ${attempt} 轮拆解中`,
        lastError,
        errors,
      });

      const sendResult = this.runtime.sendInput({
        sessionId,
        targetId: 'supervisor',
        text: prompt,
        pressEnter: true,
      });
      if (!sendResult.ok) {
        const sendError = `主管窗口发送规划指令失败: ${sendResult.stderr || 'unknown'}`;
        onProgress?.({
          state: 'failed',
          phase: 'send-failed',
          attempt,
          maxAttempts: totalAttempts,
          message: sendError,
          lastError: sendError,
          errors: [...errors, sendError],
        });
        throw new Error(sendError);
      }

      const parsed = await this.waitForPlanResult({
        sessionId,
        workerCount,
        timeoutMs: PLAN_WAIT_TIMEOUT_MS,
      });
      if (parsed.ok) {
        this.store.appendEvent(sessionId, {
          type: 'supervisor_plan_received',
          payload: parsed.plan,
        });
        this.onEvent?.(sessionId, {
          type: 'supervisor-plan',
          payload: parsed.plan,
        });
        onProgress?.({
          state: 'succeeded',
          phase: 'succeeded',
          attempt,
          maxAttempts: totalAttempts,
          message: '主管规划成功，准备下发任务',
          lastError: '',
          errors,
        });
        return parsed.plan;
      }

      const repairReason = parsed.error || '未解析到有效计划';
      onProgress?.({
        state: 'running',
        phase: 'repair-attempt',
        attempt,
        maxAttempts: totalAttempts,
        message: '主管输出未通过解析，尝试自动格式修复',
        lastError: repairReason,
        errors,
      });

      const repair = await this.tryRecoverPlanFormat({
        sessionId,
        workerCount,
        reason: repairReason,
      });
      if (repair.ok) {
        this.store.appendEvent(sessionId, {
          type: 'supervisor_plan_repaired',
          payload: {
            attempt,
            reason: repairReason,
            plan: repair.plan,
          },
        });
        this.onEvent?.(sessionId, {
          type: 'supervisor-plan',
          payload: repair.plan,
        });
        onProgress?.({
          state: 'succeeded',
          phase: 'succeeded',
          attempt,
          maxAttempts: totalAttempts,
          message: '主管输出已自动修复为结构化格式，准备下发任务',
          lastError: '',
          errors,
        });
        return repair.plan;
      }

      const combinedError = `规划失败: ${repairReason}; 格式修复失败: ${repair.error || 'unknown'}`;
      errors.push(combinedError);
      this.store.appendEvent(sessionId, {
        type: 'supervisor_plan_retry',
        payload: {
          attempt,
          error: combinedError,
        },
      });

      onProgress?.({
        state: attempt < totalAttempts ? 'retrying' : 'failed',
        phase: 'retry',
        attempt,
        maxAttempts: totalAttempts,
        message: attempt < totalAttempts
          ? `第 ${attempt} 轮失败，准备重试`
          : (allowFallback ? '主管规划重试结束，转入兜底方案' : '主管规划重试结束，严格模式终止'),
        lastError: combinedError,
        errors,
      });
    }

    const latestError = errors.length > 0 ? errors[errors.length - 1] : '主管规划失败';
    if (!allowFallback) {
      onProgress?.({
        state: 'failed',
        phase: 'strict-failed',
        attempt: totalAttempts,
        maxAttempts: totalAttempts,
        message: '主管未给出可解析计划，严格模式终止',
        lastError: latestError,
        errors,
      });
      throw new Error(`主管规划失败（严格模式）：${latestError}`);
    }

    const fallbackPlan = this.buildFallbackPlan({ objective, workerCount });
    this.store.appendEvent(sessionId, {
      type: 'supervisor_plan_fallback',
      payload: fallbackPlan,
    });

    onProgress?.({
      state: 'fallback',
      phase: 'fallback',
      attempt: totalAttempts,
      maxAttempts: totalAttempts,
      message: '已启用本地兜底分解',
      lastError: latestError,
      errors,
    });

    return fallbackPlan;
  }

  async waitSupervisorReady({ sessionId, timeoutMs }) {
    const startedAt = Date.now();
    let lastLinesHash = '';

    while (Date.now() - startedAt < timeoutMs) {
      await sleep(READY_CHECK_INTERVAL_MS);
      const capture = this.runtime.readRecentLines({
        sessionId,
        targetId: 'supervisor',
        lineCount: 180,
      });
      if (!capture.ok) {
        continue;
      }

      const text = capture.lines.join('\n');
      if (!text) {
        continue;
      }

      if (text === lastLinesHash) {
        continue;
      }
      lastLinesHash = text;

      if (probeSupervisorReady(text)) {
        return {
          ok: true,
        };
      }
    }

    return {
      ok: false,
      error: '等待主管窗口就绪超时',
    };
  }

  async tryRecoverPlanFormat({ sessionId, workerCount, reason = '' }) {
    const repairPrompt = this.buildFormatRepairPrompt({ workerCount, reason });
    const sendResult = this.runtime.sendInput({
      sessionId,
      targetId: 'supervisor',
      text: repairPrompt,
      pressEnter: true,
    });
    if (!sendResult.ok) {
      return {
        ok: false,
        error: sendResult.stderr || sendResult.error || '发送格式修复指令失败',
      };
    }

    const parsed = await this.waitForPlanResult({
      sessionId,
      workerCount,
      timeoutMs: FORMAT_REPAIR_TIMEOUT_MS,
    });
    if (parsed.ok) {
      return parsed;
    }

    return {
      ok: false,
      error: parsed.error || '格式修复未得到可解析结果',
    };
  }

  async waitForPlanResult({ sessionId, workerCount, timeoutMs }) {
    const startedAt = Date.now();
    let lastText = '';
    let parseSignalCount = 0;
    let lastRetryableReason = '';

    while (Date.now() - startedAt < timeoutMs) {
      await sleep(POLL_INTERVAL_MS);
      const capture = this.runtime.readRecentLines({ sessionId, targetId: 'supervisor', lineCount: 1500 });
      if (!capture.ok) {
        continue;
      }
      const text = capture.lines.join('\n');
      if (!text || text === lastText) {
        continue;
      }
      lastText = text;
      const parsed = parseSupervisorPlanFromText(text);
      if (!parsed.ok) {
        parseSignalCount += 1;
        continue;
      }
      const normalized = this.normalizePlan(parsed.plan, workerCount);
      if (!normalized.ok) {
        if (normalized.retryable) {
          parseSignalCount += 1;
          lastRetryableReason = normalized.error || '';
          continue;
        }
        return normalized;
      }
      return {
        ok: true,
        plan: normalized.plan,
      };
    }

    return {
      ok: false,
      error: lastRetryableReason || (parseSignalCount > 0
        ? '主管已输出内容，但结构化格式不完整或字段不匹配'
        : '等待主管规划超时'),
    };
  }

  normalizePlan(plan, workerCount) {
    const tasks = Array.isArray(plan?.tasks) ? plan.tasks : [];
    if (tasks.length < workerCount) {
      return {
        ok: false,
        retryable: true,
        error: `tasks 数量不足，期望 ${workerCount}，收到 ${tasks.length}`,
      };
    }

    const sorted = tasks
      .slice()
      .sort((a, b) => Number(a.workerIndex) - Number(b.workerIndex));

    const mapped = sorted
      .slice(0, workerCount)
      .map((task, index) => ({
        workerId: `worker-${index + 1}`,
        workerIndex: index + 1,
        title: String(task.title || `子任务 ${index + 1}`),
        instruction: String(task.instruction || '').trim(),
        dependsOn: Array.isArray(task.dependsOn) ? task.dependsOn : [],
      }));

    if (mapped.some((task) => !task.instruction)) {
      return {
        ok: false,
        retryable: true,
        error: '存在空 instruction',
      };
    }

    return {
      ok: true,
      plan: {
        planSummary: String(plan.planSummary || '').trim(),
        tasks: mapped,
      },
    };
  }

  buildFallbackPlan({ objective, workerCount }) {
    const tasks = [];
    for (let i = 1; i <= workerCount; i += 1) {
      tasks.push({
        workerId: `worker-${i}`,
        workerIndex: i,
        title: `子任务 ${i}`,
        dependsOn: i === 1 ? [] : [i - 1],
        instruction: [
          `目标：${objective}`,
          `你是执行窗口 worker-${i}。`,
          '请先说明你将完成的子范围，再开始执行。',
          '在本窗口内只处理你负责的内容，完成后给出阶段结果。',
        ].join('\n'),
      });
    }

    return {
      planSummary: '主管规划未返回有效结构化结果，已使用本地兜底分解。',
      tasks,
    };
  }

  async requestReplanForNoChoice({ sessionId, workerId, instruction }) {
    const prompt = toSingleLine([
      '收到用户拒绝当前执行路径。',
      `目标窗口：${workerId}`,
      `用户补充要求：${instruction}`,
      '请生成新的下发指令，使用以下格式：',
      `<dispatch_json>{"workerId":"${workerId}","instruction":"新的执行指令"}</dispatch_json>`,
      '禁止输出任何额外说明。',
    ].join('\n'));

    const sendResult = this.runtime.sendInput({
      sessionId,
      targetId: 'supervisor',
      text: prompt,
      pressEnter: true,
    });
    if (!sendResult.ok) {
      return { ok: false, error: sendResult.stderr || '主管发送失败' };
    }

    const startedAt = Date.now();
    let lastText = '';
    while (Date.now() - startedAt < 60000) {
      await sleep(POLL_INTERVAL_MS);
      const capture = this.runtime.readRecentLines({ sessionId, targetId: 'supervisor', lineCount: 220 });
      if (!capture.ok) {
        continue;
      }
      const text = capture.lines.join('\n');
      if (!text || text === lastText) {
        continue;
      }
      lastText = text;
      const parsed = parseDispatchInstructionFromText(text);
      if (!parsed.ok) {
        continue;
      }

      return {
        ok: true,
        dispatch: parsed.dispatch,
      };
    }

    return {
      ok: false,
      error: '等待主管回传修订指令超时',
    };
  }
}
