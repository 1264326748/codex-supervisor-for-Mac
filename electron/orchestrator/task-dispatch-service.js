export class TaskDispatchService {
  constructor({ runtimeManager, sessionStore, onEvent }) {
    this.runtime = runtimeManager;
    this.store = sessionStore;
    this.onEvent = onEvent;
  }

  async dispatchPlan({ sessionId, plan }) {
    const tasks = Array.isArray(plan?.tasks) ? plan.tasks : [];
    const results = [];

    for (const task of tasks) {
      const content = toSingleLine([
        `你是 ${task.workerId}。`,
        `子任务标题：${task.title}。`,
        `依赖：${Array.isArray(task.dependsOn) && task.dependsOn.length ? task.dependsOn.join(',') : '无'}。`,
        task.instruction,
        '收到后请直接开始执行，并持续输出进展。',
      ].join('\n'));

      const sent = this.runtime.sendInput({
        sessionId,
        targetId: task.workerId,
        text: content,
        pressEnter: true,
      });

      const item = {
        workerId: task.workerId,
        ok: !!sent.ok,
        error: sent.ok ? '' : (sent.stderr || sent.error || '下发失败'),
      };

      this.store.appendEvent(sessionId, {
        type: 'worker_task_dispatched',
        payload: {
          workerId: task.workerId,
          title: task.title,
          ok: item.ok,
          error: item.error,
        },
      });

      this.onEvent?.(sessionId, {
        type: 'task-dispatched',
        payload: {
          ...item,
          title: task.title,
        },
      });

      results.push(item);
    }

    return results;
  }
}

function toSingleLine(text) {
  return String(text || '')
    .replace(/\s*\n+\s*/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}
