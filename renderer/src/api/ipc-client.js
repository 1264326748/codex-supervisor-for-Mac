function getApi() {
  const api = window.desktopApi;
  if (!api) {
    throw new Error('桌面桥接不可用，请重启应用；若仍为空白请查看 /tmp/codex-supervisor-desktop-main.log');
  }
  return api;
}

export async function listSessions() {
  const result = await getApi().listSessions();
  if (!result.ok) {
    throw new Error(result.error || '读取会话列表失败');
  }
  return result.sessions || [];
}

export async function getSession(sessionId) {
  const result = await getApi().getSession(sessionId);
  if (!result.ok) {
    throw new Error(result.error || '读取会话详情失败');
  }
  return result.session;
}

export async function createSession(payload) {
  const result = await getApi().createSession(payload);
  if (!result.ok) {
    throw new Error(result.error || '创建会话失败');
  }
  return result.session;
}

export async function replanSession(sessionId) {
  const result = await getApi().replanSession(sessionId);
  if (!result.ok) {
    throw new Error(result.error || '重新触发规划失败');
  }
  return result.session;
}

export async function resumeUnfinishedSession(sessionId) {
  const result = await getApi().resumeUnfinishedSession(sessionId);
  if (!result.ok) {
    throw new Error(result.error || '恢复未完成任务失败');
  }
  return result.result;
}

export async function sendSessionInput({ sessionId, targetId, text, pressEnter = true }) {
  const result = await getApi().sendSessionInput({
    sessionId,
    targetId,
    text,
    pressEnter,
  });
  if (!result.ok) {
    throw new Error(result.error || '发送窗口指令失败');
  }
  return result.result;
}

export async function resolveApproval(payload) {
  const result = await getApi().resolveApproval(payload);
  if (!result.ok) {
    throw new Error(result.error || '处理待确认失败');
  }
  return result.result;
}

export async function resolveApprovalBatch(payload) {
  const result = await getApi().resolveApprovalBatch(payload);
  if (!result.ok) {
    throw new Error(result.error || '批量处理待确认失败');
  }
  return result.result;
}

export async function stopSession(sessionId) {
  const result = await getApi().stopSession(sessionId);
  if (!result.ok) {
    throw new Error(result.error || '停止会话失败');
  }
  return true;
}

export function subscribeSessionEvents(handler) {
  return getApi().subscribe(handler);
}
