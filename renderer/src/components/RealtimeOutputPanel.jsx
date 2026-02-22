import React, { useEffect, useMemo, useRef, useState } from 'react';

function getTargetOptions(session) {
  if (!session) {
    return [];
  }

  const list = [];
  list.push({
    targetId: 'supervisor',
    label: '主管',
    lines: Array.isArray(session.supervisor?.lastLines) ? session.supervisor.lastLines : [],
    lastLine: session.supervisor?.lastLine || '',
  });

  for (const worker of session.workers || []) {
    list.push({
      targetId: worker.workerId,
      label: worker.workerId,
      lines: Array.isArray(worker.lastLines) ? worker.lastLines : [],
      lastLine: worker.lastLine || '',
    });
  }

  return list;
}

function buildContinueInstruction(targetId) {
  if (targetId === 'supervisor') {
    return '请先检查当前是否存在未完成事项；如需分配给执行窗口请直接下发；如无需分配请直接回复结论。';
  }

  return '继续执行你当前未完成任务，不要停在建议阶段。请直接推进改动、执行必要命令，并同步结果与阻塞点。';
}

function buildSupervisorDecisionInstruction() {
  return [
    '请根据我接下来输入的新要求，先判断应直接答复还是下发给执行窗口。',
    '若需要下发，请使用结构化下发标签（dispatch_json、dispatch_batch_json、dispatch_all_json）。',
    '不要输出示例模板，不要使用“具体执行指令”“新的执行指令”等占位词。',
    '只输出真实可执行的下发内容。',
  ].join(' ');
}

export function RealtimeOutputPanel({ session, onSendInput, sending = false }) {
  const targets = useMemo(() => getTargetOptions(session), [session]);
  const [selectedTargetId, setSelectedTargetId] = useState('supervisor');
  const [draftsByTarget, setDraftsByTarget] = useState({});
  const [localError, setLocalError] = useState('');
  const textRef = useRef(null);

  useEffect(() => {
    if (targets.length === 0) {
      setSelectedTargetId('supervisor');
      return;
    }
    const exists = targets.some((item) => item.targetId === selectedTargetId);
    if (!exists) {
      setSelectedTargetId(targets[0].targetId);
    }
  }, [targets, selectedTargetId]);

  const selected = useMemo(() => {
    if (targets.length === 0) {
      return null;
    }
    return targets.find((item) => item.targetId === selectedTargetId) || targets[0];
  }, [targets, selectedTargetId]);

  const outputText = useMemo(() => {
    if (!selected || !Array.isArray(selected.lines) || selected.lines.length === 0) {
      return '';
    }
    return selected.lines.join('\n');
  }, [selected]);
  const draft = selected ? (draftsByTarget[selected.targetId] || '') : '';
  const recentText = useMemo(() => {
    if (!selected || !Array.isArray(selected.lines)) {
      return '';
    }
    return selected.lines.slice(-24).join('\n');
  }, [selected]);
  const looksWaitingInstruction = useMemo(() => {
    return /如果你要|下一步可以继续|if you want|next step/i.test(recentText);
  }, [recentText]);

  useEffect(() => {
    const box = textRef.current;
    if (!box) {
      return;
    }
    box.scrollTop = box.scrollHeight;
  }, [outputText]);

  const setCurrentDraft = (value) => {
    if (!selected) {
      return;
    }
    setDraftsByTarget((prev) => ({
      ...prev,
      [selected.targetId]: value,
    }));
  };

  const sendToTarget = async ({ targetId, text }) => {
    if (!session || !targetId || !String(text || '').trim()) {
      return;
    }
    if (typeof onSendInput !== 'function') {
      return;
    }

    setLocalError('');
    try {
      await onSendInput({
        sessionId: session.sessionId,
        targetId,
        text: String(text || '').trim(),
      });
    } catch (error) {
      setLocalError(String(error?.message || error || '发送失败'));
      throw error;
    }
  };

  const submitDraft = async () => {
    if (!selected) {
      return;
    }
    const text = String(draft || '').trim();
    if (!text) {
      setLocalError('请输入要发送的内容');
      return;
    }
    await sendToTarget({
      targetId: selected.targetId,
      text,
    });
    setCurrentDraft('');
  };

  if (!session) {
    return (
      <section className="panel realtime-output-panel">
        <h2>窗口实时输出</h2>
        <p className="muted">请选择会话后查看各窗口输出。</p>
      </section>
    );
  }

  return (
    <section className="panel realtime-output-panel">
      <div className="realtime-output-header">
        <h2>窗口实时输出</h2>
        <div className="realtime-output-selector">
          <label htmlFor="target-select">窗口</label>
          <select
            id="target-select"
            value={selected?.targetId || ''}
            onChange={(event) => setSelectedTargetId(event.target.value)}
          >
            {targets.map((item) => (
              <option key={item.targetId} value={item.targetId}>
                {item.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      <p className="muted realtime-output-lastline">
        最新行：{selected?.lastLine || '暂无输出'}
      </p>

      <p className="muted realtime-output-tip">
        可直接向当前窗口发送新指令。主管窗口可用于实时协同与临时加任务。
      </p>

      {looksWaitingInstruction && selected?.targetId !== 'supervisor' && (
        <div className="realtime-output-suggest">
          <span>检测到该窗口处于“等待你确认继续”的状态。</span>
          <button
            className="secondary"
            type="button"
            disabled={sending}
            onClick={async () => {
              await sendToTarget({
                targetId: selected.targetId,
                text: buildContinueInstruction(selected.targetId),
              });
            }}
          >
            发送继续执行
          </button>
        </div>
      )}

      <div ref={textRef} className="realtime-output-body">
        {outputText ? <pre>{outputText}</pre> : <p className="muted">该窗口暂无可展示输出。</p>}
      </div>

      <div className="realtime-output-composer">
        <div className="realtime-output-quick-actions">
          <button
            className="secondary"
            type="button"
            disabled={sending || !selected}
            onClick={async () => {
              if (!selected) {
                return;
              }
              await sendToTarget({
                targetId: selected.targetId,
                text: buildContinueInstruction(selected.targetId),
              });
            }}
          >
            当前窗口继续执行
          </button>
          <button
            className="secondary"
            type="button"
            disabled={sending}
            onClick={async () => {
              await sendToTarget({
                targetId: 'supervisor',
                text: buildSupervisorDecisionInstruction(),
              });
            }}
          >
            提醒主管先判断再分配
          </button>
        </div>

        <label className="realtime-output-input-label">
          发送到：{selected?.label || '-'}
        </label>
        <textarea
          value={draft}
          onChange={(event) => setCurrentDraft(event.target.value)}
          placeholder={selected?.targetId === 'supervisor'
            ? '在这里输入给主管的新要求；主管会自行判断直接答复或下发。'
            : '在这里输入给执行窗口的新要求。'}
          rows={4}
          onKeyDown={async (event) => {
            if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
              event.preventDefault();
              await submitDraft();
            }
          }}
        />
        <div className="realtime-output-submit-row">
          <span className="muted">快捷键：Ctrl+Enter 发送</span>
          <button className="primary" type="button" disabled={sending || !selected} onClick={submitDraft}>
            {sending ? '发送中' : '发送'}
          </button>
        </div>
        {localError && <p className="planning-error">{localError}</p>}
      </div>
    </section>
  );
}
