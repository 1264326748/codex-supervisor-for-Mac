import React from 'react';

function stringifyPayload(payload) {
  if (!payload) {
    return '';
  }
  try {
    return JSON.stringify(payload, null, 2);
  } catch {
    return String(payload);
  }
}

export function LiveLogPanel({ session }) {
  const logs = Array.isArray(session?.logTail) ? session.logTail : [];

  return (
    <section className="panel log-panel">
      <h2>执行日志</h2>
      {logs.length === 0 && <p className="muted">暂无日志输出。</p>}
      {logs.length > 0 && (
        <div className="log-list">
          {logs.map((item, index) => (
            <article key={`${item.at || 'at'}-${index}`} className="log-item">
              <header>
                <strong>{item.type || 'event'}</strong>
                <span>{item.at ? new Date(item.at).toLocaleString() : '-'}</span>
              </header>
              <pre>{stringifyPayload(item.payload)}</pre>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
