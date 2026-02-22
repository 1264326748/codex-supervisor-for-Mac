import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  createSession,
  getSession,
  listSessions,
  replanSession,
  resumeUnfinishedSession,
  sendSessionInput,
  resolveApproval,
  resolveApprovalBatch,
  stopSession,
  subscribeSessionEvents,
} from './api/ipc-client.js';
import { SessionCreatePanel } from './components/SessionCreatePanel.jsx';
import { TopologyPanel } from './components/TopologyPanel.jsx';
import { ApprovalQueuePanel } from './components/ApprovalQueuePanel.jsx';
import { LiveLogPanel } from './components/LiveLogPanel.jsx';
import { RealtimeOutputPanel } from './components/RealtimeOutputPanel.jsx';

function summarizeBatchResult(result) {
  const list = Array.isArray(result?.results) ? result.results : [];
  const successCount = list.filter((item) => item.ok).length;
  const failedCount = list.length - successCount;
  return { successCount, failedCount };
}

export function App() {
  const [sessions, setSessions] = useState([]);
  const [selectedSessionId, setSelectedSessionId] = useState('');
  const [selectedSession, setSelectedSession] = useState(null);
  const [creating, setCreating] = useState(false);
  const [resolving, setResolving] = useState(false);
  const [replanning, setReplanning] = useState(false);
  const [resuming, setResuming] = useState(false);
  const [sendingWindowInput, setSendingWindowInput] = useState(false);
  const [notice, setNotice] = useState('');

  const refreshSessionList = useCallback(async () => {
    const rows = await listSessions();
    setSessions(rows);
    return rows;
  }, []);

  const refreshSelected = useCallback(async (sessionId) => {
    if (!sessionId) {
      setSelectedSession(null);
      return null;
    }
    const session = await getSession(sessionId);
    setSelectedSession(session);
    return session;
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const rows = await refreshSessionList();
        if (rows.length > 0) {
          setSelectedSessionId(rows[0].sessionId);
          await refreshSelected(rows[0].sessionId);
        }
      } catch (error) {
        setNotice(error.message);
      }
    })();
  }, [refreshSessionList, refreshSelected]);

  useEffect(() => {
    const unsubscribe = subscribeSessionEvents(async (event) => {
      if (!event || !event.sessionId) {
        return;
      }
      if (event.type === 'error') {
        setNotice(event.payload?.message || '出现错误');
      }
      if (event.type === 'manual-input-blocked-by-pending') {
        const count = Number(event.payload?.pendingCount || 0);
        setNotice(`主管当前有待确认项（${count} 条），请先在右侧队列处理后再继续发指令。`);
      }
      if (event.type === 'manual-input-no-output-timeout') {
        setNotice('主管暂未产生新输出，可能正在等待确认。请先检查右侧待处理队列。');
      }
      if (event.type === 'supervisor-dispatch-rejected-as-example') {
        setNotice('已拦截示例占位派发内容，请让主管输出真实可执行指令。');
      }
      await refreshSessionList();
      if (event.sessionId === selectedSessionId) {
        await refreshSelected(selectedSessionId);
      }
    });

    return () => {
      unsubscribe();
    };
  }, [selectedSessionId, refreshSessionList, refreshSelected]);

  const pendingCount = useMemo(() => {
    if (!selectedSession || !Array.isArray(selectedSession.approvals)) {
      return 0;
    }
    return selectedSession.approvals.filter((item) => item.status === 'pending').length;
  }, [selectedSession]);

  const handleCreateSession = async (payload) => {
    setNotice('');
    setCreating(true);
    try {
      const session = await createSession(payload);
      await refreshSessionList();
      setSelectedSessionId(session.sessionId);
      await refreshSelected(session.sessionId);
      setNotice(`会话已创建：${session.sessionId}`);
    } catch (error) {
      setNotice(error.message);
    } finally {
      setCreating(false);
    }
  };

  const handleResolveApproval = async ({ approvalId, choice, instruction }) => {
    if (!selectedSessionId) {
      return;
    }
    setResolving(true);
    setNotice('');
    try {
      await resolveApproval({
        sessionId: selectedSessionId,
        approvalId,
        choice,
        instruction,
      });
      await refreshSelected(selectedSessionId);
      await refreshSessionList();
      setNotice('已处理待确认项');
    } catch (error) {
      setNotice(error.message);
    } finally {
      setResolving(false);
    }
  };

  const handleBatchResolve = async (actions) => {
    if (!selectedSessionId) {
      return;
    }
    const list = Array.isArray(actions) ? actions : [];
    if (list.length === 0) {
      return;
    }

    setResolving(true);
    setNotice('');
    try {
      const result = await resolveApprovalBatch({
        sessionId: selectedSessionId,
        actions: list,
      });
      await refreshSelected(selectedSessionId);
      await refreshSessionList();

      const summary = summarizeBatchResult(result);
      setNotice(`批量处理完成：成功 ${summary.successCount}，失败 ${summary.failedCount}`);
    } catch (error) {
      setNotice(error.message);
    } finally {
      setResolving(false);
    }
  };

  const handleStopSession = async (sessionId) => {
    if (!sessionId) {
      return;
    }
    try {
      await stopSession(sessionId);
      await refreshSessionList();
      await refreshSelected(sessionId);
      setNotice(`会话已停止：${sessionId}`);
    } catch (error) {
      setNotice(error.message);
    }
  };

  const handleRetryPlanning = async (sessionId) => {
    if (!sessionId) {
      return;
    }

    setReplanning(true);
    setNotice('');
    try {
      await replanSession(sessionId);
      await refreshSessionList();
      await refreshSelected(sessionId);
      setNotice(`已触发主管重新规划：${sessionId}`);
    } catch (error) {
      setNotice(error.message);
    } finally {
      setReplanning(false);
    }
  };

  const handleResumeUnfinished = async (sessionId) => {
    if (!sessionId) {
      return;
    }
    setResuming(true);
    setNotice('');
    try {
      const result = await resumeUnfinishedSession(sessionId);
      await refreshSessionList();
      await refreshSelected(sessionId);
      const supervisorOk = result?.supervisor?.ok ? '成功' : '失败';
      const workerOkCount = Array.isArray(result?.workers)
        ? result.workers.filter((item) => item.ok).length
        : 0;
      const workerTotal = Array.isArray(result?.workers) ? result.workers.length : 0;
      setNotice(`已触发继续执行：主管发送${supervisorOk}，执行窗口 ${workerOkCount}/${workerTotal} 已收到。`);
    } catch (error) {
      setNotice(error.message);
    } finally {
      setResuming(false);
    }
  };

  const handleSendWindowInput = async ({ sessionId, targetId, text }) => {
    const sid = String(sessionId || '').trim();
    const tid = String(targetId || '').trim();
    const content = String(text || '').trim();
    if (!sid || !tid || !content) {
      return;
    }

    setSendingWindowInput(true);
    setNotice('');
    try {
      await sendSessionInput({
        sessionId: sid,
        targetId: tid,
        text: content,
        pressEnter: true,
      });
      await refreshSelected(sid);
      setNotice(`已发送到 ${tid}`);
    } catch (error) {
      setNotice(error.message);
      throw error;
    } finally {
      setSendingWindowInput(false);
    }
  };

  return (
    <div className="app-shell">
      <header className="app-header">
        <div>
          <h1>任务主管控制台</h1>
          <p className="muted">主管负责拆解，执行窗口并行处理，确认请求统一在右侧排队。</p>
        </div>
        <div className="header-meta">
          <span>待处理确认：{pendingCount}</span>
          {selectedSession?.runtimeMeta?.tmuxSession && <span>tmux: {selectedSession.runtimeMeta.tmuxSession}</span>}
        </div>
      </header>

      {notice && <div className="notice">{notice}</div>}

      <main className="app-grid">
        <aside className="left-column">
          <SessionCreatePanel onCreate={handleCreateSession} loading={creating} />
          <section className="panel session-list-panel">
            <h2>会话列表</h2>
            {sessions.length === 0 && <p className="muted">当前没有会话。</p>}
            <ul className="session-list">
              {sessions.map((item) => (
                <li key={item.sessionId}>
                  <button
                    type="button"
                    className={item.sessionId === selectedSessionId ? 'selected' : ''}
                    onClick={async () => {
                      setSelectedSessionId(item.sessionId);
                      await refreshSelected(item.sessionId);
                    }}
                  >
                    <strong>{item.sessionId}</strong>
                    <span>{item.status}</span>
                    <span>规划：{item.planningState || '-'}</span>
                    <span>{item.pendingApprovals} 待处理</span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        </aside>

        <section className="center-column">
          <TopologyPanel
            session={selectedSession}
            onStop={handleStopSession}
            onRetryPlanning={handleRetryPlanning}
            replanBusy={replanning}
            onResumeUnfinished={handleResumeUnfinished}
            resumeBusy={resuming}
          />
          <RealtimeOutputPanel
            session={selectedSession}
            onSendInput={handleSendWindowInput}
            sending={sendingWindowInput}
          />
          <LiveLogPanel session={selectedSession} />
        </section>

        <aside className="right-column">
          <ApprovalQueuePanel
            session={selectedSession}
            onResolve={handleResolveApproval}
            onBatchResolve={handleBatchResolve}
            busy={resolving}
          />
        </aside>
      </main>
    </div>
  );
}
