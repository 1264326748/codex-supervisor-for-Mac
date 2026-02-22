import React from 'react';

function statusText(status) {
  const map = {
    starting: '启动中',
    planning: '规划中',
    running: '运行中',
    retrying: '重试中',
    waiting_user_input: '等待用户处理',
    partial_error: '部分失败',
    error: '错误',
    done: '完成',
    stopped: '已停止',
    fallback: '已使用兜底',
    succeeded: '成功',
    failed: '失败',
  };
  return map[status] || status || '-';
}

function isPlanningBusy(planningState, replanBusy) {
  if (replanBusy) {
    return true;
  }
  return planningState === 'running' || planningState === 'retrying';
}

export function TopologyPanel({
  session,
  onStop,
  onRetryPlanning,
  replanBusy,
  onResumeUnfinished,
  resumeBusy,
}) {
  if (!session) {
    return (
      <section className="panel">
        <h2>会话拓扑</h2>
        <p className="muted">请选择左侧会话查看拓扑。</p>
      </section>
    );
  }

  const planning = session.planning || {};
  const planningBusy = isPlanningBusy(planning.state, replanBusy);
  const canRetry = session.status !== 'stopped' && !planningBusy;
  const canResume = session.status !== 'stopped' && !resumeBusy;

  return (
    <section className="panel topology-panel">
      <div className="panel-header-row">
        <div>
          <h2>会话拓扑</h2>
          <p className="muted">状态：{statusText(session.status)} | 运行时：{session.runtime}</p>
        </div>
        <div className="panel-header-actions">
          <button
            className="secondary"
            type="button"
            onClick={() => onRetryPlanning(session.sessionId)}
            disabled={!canRetry}
          >
            {planningBusy ? '主管规划进行中' : '重新触发规划'}
          </button>
          <button
            className="secondary"
            type="button"
            onClick={() => onResumeUnfinished(session.sessionId)}
            disabled={!canResume}
          >
            {resumeBusy ? '继续指令发送中' : '检查未完成并继续'}
          </button>
          <button className="secondary" type="button" onClick={() => onStop(session.sessionId)}>
            停止会话
          </button>
        </div>
      </div>

      <section className="planning-status-block">
        <h3>主管规划状态</h3>
        <div className="planning-status-grid">
          <span>阶段：{statusText(planning.state || '')} / {planning.phase || '-'}</span>
          <span>尝试：{planning.attempt || 0} / {planning.maxAttempts || '-'}</span>
          {planning.trigger && <span>来源：{planning.trigger === 'manual' ? '手动触发' : '自动启动'}</span>}
        </div>
        <p className="planning-message">{planning.message || '等待主管返回拆解结果...'}</p>
        {planning.lastError && <p className="planning-error">最近失败：{planning.lastError}</p>}
      </section>

      <div className="topology-grid">
        <article className="node-card supervisor-card">
          <header>
            <h3>主管</h3>
            <span className={`status-tag status-${session.supervisor?.status || 'running'}`}>
              {statusText(session.supervisor?.status || 'running')}
            </span>
          </header>
          <p className="node-line">{session.supervisor?.lastLine || '暂无输出'}</p>
          <p className="node-meta">模式：规划</p>
        </article>

        {(session.workers || []).map((worker) => (
          <article key={worker.workerId} className="node-card">
            <header>
              <h3>{worker.workerId}</h3>
              <span className={`status-tag status-${worker.status || 'running'}`}>
                {statusText(worker.status)}
              </span>
            </header>
            <p className="node-line">{worker.lastLine || '暂无输出'}</p>
            <p className="node-meta">模式：执行</p>
          </article>
        ))}
      </div>

      <section className="plan-summary">
        <h3>主管规划摘要</h3>
        <p>{session.planSummary || '等待主管产出规划内容...'}</p>
      </section>
    </section>
  );
}
