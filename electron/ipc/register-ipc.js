import { ipcMain } from 'electron';

export function registerIpcHandlers({ orchestrator }) {
  ipcMain.handle('session:list', async () => {
    return {
      ok: true,
      sessions: orchestrator.listSessions(),
    };
  });

  ipcMain.handle('session:get', async (_event, payload) => {
    const sessionId = String(payload?.sessionId || '').trim();
    const session = orchestrator.getSession(sessionId);
    if (!session) {
      return { ok: false, error: '会话不存在' };
    }
    return { ok: true, session };
  });

  ipcMain.handle('session:create', async (_event, payload) => {
    try {
      const session = await orchestrator.createSession({
        objective: payload?.objective,
        workerCount: payload?.workerCount,
        workspacePath: payload?.workspacePath,
      });
      return { ok: true, session };
    } catch (error) {
      return { ok: false, error: String(error?.message || error) };
    }
  });

  ipcMain.handle('session:replan', async (_event, payload) => {
    const sessionId = String(payload?.sessionId || '').trim();
    try {
      const session = orchestrator.retryPlanning(sessionId);
      return {
        ok: true,
        session,
      };
    } catch (error) {
      return { ok: false, error: String(error?.message || error) };
    }
  });

  ipcMain.handle('session:resume-unfinished', async (_event, payload) => {
    const sessionId = String(payload?.sessionId || '').trim();
    try {
      const result = await orchestrator.resumeUnfinishedSession(sessionId, {
        source: 'manual',
      });
      return {
        ok: true,
        result,
      };
    } catch (error) {
      return { ok: false, error: String(error?.message || error) };
    }
  });

  ipcMain.handle('session:send-input', async (_event, payload) => {
    const sessionId = String(payload?.sessionId || '').trim();
    const targetId = String(payload?.targetId || '').trim();
    const text = String(payload?.text || '');
    const pressEnter = payload?.pressEnter !== false;

    try {
      const result = orchestrator.sendManualInput({
        sessionId,
        targetId,
        text,
        pressEnter,
        source: 'manual-ui',
      });
      return {
        ok: true,
        result,
      };
    } catch (error) {
      return { ok: false, error: String(error?.message || error) };
    }
  });

  ipcMain.handle('approval:resolve', async (_event, payload) => {
    const sessionId = String(payload?.sessionId || '').trim();
    const approvalId = String(payload?.approvalId || '').trim();
    const choice = Number(payload?.choice || 0);
    const instruction = String(payload?.instruction || '').trim();

    try {
      const result = await orchestrator.resolveApproval({
        sessionId,
        approvalId,
        choice,
        instruction,
      });
      return { ok: true, result };
    } catch (error) {
      return { ok: false, error: String(error?.message || error) };
    }
  });

  ipcMain.handle('approval:resolve-batch', async (_event, payload) => {
    const sessionId = String(payload?.sessionId || '').trim();
    const actions = Array.isArray(payload?.actions) ? payload.actions : [];

    try {
      const result = await orchestrator.resolveApprovalsBatch({
        sessionId,
        actions,
      });
      return { ok: true, result };
    } catch (error) {
      return { ok: false, error: String(error?.message || error) };
    }
  });

  ipcMain.handle('session:stop', async (_event, payload) => {
    const sessionId = String(payload?.sessionId || '').trim();
    const result = orchestrator.stopSession(sessionId);
    if (!result.ok) {
      return { ok: false, error: String(result.error || '停止失败') };
    }
    return { ok: true };
  });
}
