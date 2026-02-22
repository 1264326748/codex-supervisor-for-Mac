import React, { useEffect, useMemo, useState } from 'react';

function sortByCreatedAtAsc(items) {
  return items.slice().sort((a, b) => {
    const ta = Date.parse(a.createdAt || '') || 0;
    const tb = Date.parse(b.createdAt || '') || 0;
    return ta - tb;
  });
}

function toTimeLabel(value) {
  const ts = Date.parse(value || '');
  if (!Number.isFinite(ts) || ts <= 0) {
    return '-';
  }
  return new Date(ts).toLocaleTimeString();
}

function nextSelectionAfterBatch(currentSelection, processedIds) {
  const processedSet = new Set(processedIds.map((id) => String(id || '').trim()));
  const next = {};
  for (const [approvalId, selected] of Object.entries(currentSelection)) {
    if (!selected) {
      continue;
    }
    if (!processedSet.has(approvalId)) {
      next[approvalId] = true;
    }
  }
  return next;
}

export function ApprovalQueuePanel({ session, onResolve, onBatchResolve, busy }) {
  const [instructionMap, setInstructionMap] = useState({});
  const [selectedMap, setSelectedMap] = useState({});

  const pendingItems = useMemo(() => {
    if (!session || !Array.isArray(session.approvals)) {
      return [];
    }
    return sortByCreatedAtAsc(session.approvals.filter((item) => item.status === 'pending'));
  }, [session]);

  const pendingIdSet = useMemo(() => new Set(pendingItems.map((item) => item.id)), [pendingItems]);

  useEffect(() => {
    setSelectedMap((current) => {
      const next = {};
      for (const [approvalId, selected] of Object.entries(current)) {
        if (selected && pendingIdSet.has(approvalId)) {
          next[approvalId] = true;
        }
      }
      return next;
    });
  }, [pendingIdSet]);

  const grouped = useMemo(() => {
    const map = new Map();
    for (const item of pendingItems) {
      const key = String(item.workerId || '-').trim() || '-';
      if (!map.has(key)) {
        map.set(key, []);
      }
      map.get(key).push(item);
    }
    return Array.from(map.entries()).map(([workerId, items]) => ({ workerId, items }));
  }, [pendingItems]);

  const selectedItems = useMemo(() => pendingItems.filter((item) => !!selectedMap[item.id]), [pendingItems, selectedMap]);
  const selectedCount = selectedItems.length;
  const allSelected = pendingItems.length > 0 && selectedCount === pendingItems.length;

  const updateInstruction = (approvalId, value) => {
    setInstructionMap((current) => ({
      ...current,
      [approvalId]: value,
    }));
  };

  const toggleItemSelect = (approvalId, checked) => {
    const id = String(approvalId || '').trim();
    if (!id) {
      return;
    }
    setSelectedMap((current) => {
      if (!checked) {
        const { [id]: _removed, ...rest } = current;
        return rest;
      }
      return {
        ...current,
        [id]: true,
      };
    });
  };

  const toggleAllSelect = (checked) => {
    if (!checked) {
      setSelectedMap({});
      return;
    }
    const next = {};
    for (const item of pendingItems) {
      next[item.id] = true;
    }
    setSelectedMap(next);
  };

  const toggleGroupSelect = (items, checked) => {
    const ids = items.map((item) => item.id);
    setSelectedMap((current) => {
      if (!checked) {
        const next = { ...current };
        for (const id of ids) {
          delete next[id];
        }
        return next;
      }

      const next = { ...current };
      for (const id of ids) {
        next[id] = true;
      }
      return next;
    });
  };

  const submitSingle = async (item, choice) => {
    const instruction = String(instructionMap[item.id] || '').trim();
    await onResolve({
      approvalId: item.id,
      choice,
      instruction,
    });
    if (choice === 3) {
      setInstructionMap((current) => ({
        ...current,
        [item.id]: '',
      }));
    }
    setSelectedMap((current) => nextSelectionAfterBatch(current, [item.id]));
  };

  const submitBatch = async (items, choice) => {
    const actions = items.map((item) => ({
      approvalId: item.id,
      choice,
      instruction: '',
    }));
    await onBatchResolve(actions);
    setSelectedMap((current) => nextSelectionAfterBatch(current, items.map((item) => item.id)));
  };

  return (
    <section className="panel approval-panel">
      <div className="approval-header-row">
        <h2>待处理确认队列</h2>
        <span className="approval-count">{pendingItems.length} 条</span>
      </div>
      {!session && <p className="muted">请先创建或选择会话。</p>}
      {session && pendingItems.length === 0 && (
        <p className="muted">当前没有待处理项。</p>
      )}

      {pendingItems.length > 0 && (
        <section className="approval-batch-global">
          <div className="approval-select-row">
            <label>
              <input
                type="checkbox"
                checked={allSelected}
                onChange={(event) => toggleAllSelect(event.target.checked)}
                disabled={busy}
              />
              <span>全选当前会话待处理项</span>
            </label>
            <span>已选 {selectedCount} 条</span>
          </div>

          <span>批量处理（当前会话）</span>
          <div className="approval-actions">
            <button type="button" onClick={() => submitBatch(pendingItems, 1)} disabled={busy}>全部选 1</button>
            <button type="button" onClick={() => submitBatch(pendingItems, 2)} disabled={busy}>全部选 2</button>
            <button
              type="button"
              onClick={() => submitBatch(selectedItems, 1)}
              disabled={busy || selectedCount === 0}
            >
              所选项选 1
            </button>
            <button
              type="button"
              onClick={() => submitBatch(selectedItems, 2)}
              disabled={busy || selectedCount === 0}
            >
              所选项选 2
            </button>
          </div>
        </section>
      )}

      {grouped.map((group) => {
        const groupSelectedCount = group.items.filter((item) => !!selectedMap[item.id]).length;
        const allGroupSelected = group.items.length > 0 && groupSelectedCount === group.items.length;
        return (
          <section key={group.workerId} className="approval-worker-group">
            <header className="approval-worker-header">
              <div>
                <strong>{group.workerId}</strong>
                <span className="muted">{group.items.length} 条待处理</span>
              </div>
              <div className="approval-select-row">
                <label>
                  <input
                    type="checkbox"
                    checked={allGroupSelected}
                    onChange={(event) => toggleGroupSelect(group.items, event.target.checked)}
                    disabled={busy}
                  />
                  <span>全选本窗口</span>
                </label>
                <span>已选 {groupSelectedCount}</span>
              </div>
              <div className="approval-actions">
                <button type="button" onClick={() => submitBatch(group.items, 1)} disabled={busy}>本窗口全选 1</button>
                <button type="button" onClick={() => submitBatch(group.items, 2)} disabled={busy}>本窗口全选 2</button>
                <button
                  type="button"
                  onClick={() => submitBatch(group.items.filter((item) => !!selectedMap[item.id]), 1)}
                  disabled={busy || groupSelectedCount === 0}
                >
                  本窗口所选项选 1
                </button>
                <button
                  type="button"
                  onClick={() => submitBatch(group.items.filter((item) => !!selectedMap[item.id]), 2)}
                  disabled={busy || groupSelectedCount === 0}
                >
                  本窗口所选项选 2
                </button>
              </div>
            </header>

            {group.items.map((item) => {
              const noInstruction = String(instructionMap[item.id] || '').trim().length === 0;
              const checked = !!selectedMap[item.id];

              return (
                <article key={item.id} className="approval-card">
                  <header className="approval-item-header">
                    <label className="approval-item-meta">
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={(event) => toggleItemSelect(item.id, event.target.checked)}
                        disabled={busy}
                      />
                      <strong>{item.workerId}</strong>
                    </label>
                    <span className="muted">{toTimeLabel(item.createdAt)}</span>
                  </header>
                  <pre>{item.sourceText || '提示内容为空'}</pre>
                  <div className="approval-actions">
                    <button type="button" onClick={() => submitSingle(item, 1)} disabled={busy}>1. yes</button>
                    <button type="button" onClick={() => submitSingle(item, 2)} disabled={busy}>2. yes and don't ask again</button>
                  </div>
                  <label className="approval-input-block">
                    <span>3. no, 并告诉主管改成什么做法</span>
                    <textarea
                      rows={3}
                      value={instructionMap[item.id] || ''}
                      onChange={(event) => updateInstruction(item.id, event.target.value)}
                      placeholder="例如：不要改公共接口，先补测试并给出迁移步骤"
                    />
                    <button type="button" onClick={() => submitSingle(item, 3)} disabled={busy || noInstruction}>提交 3 方案</button>
                  </label>
                </article>
              );
            })}
          </section>
        );
      })}
    </section>
  );
}
