import React, { useState } from 'react';

export function SessionCreatePanel({ onCreate, loading }) {
  const [objective, setObjective] = useState('');
  const [workerCount, setWorkerCount] = useState(4);
  const [workspacePath, setWorkspacePath] = useState('/Users/ywlukiya/Projects');

  const submit = async (event) => {
    event.preventDefault();
    await onCreate({
      objective: objective.trim(),
      workerCount: Number(workerCount),
      workspacePath: workspacePath.trim(),
    });
  };

  return (
    <section className="panel panel-create">
      <h2>新建执行会话</h2>
      <p className="muted">输入目标和窗口数量后，系统会先走主管规划，再自动下发到执行窗口。</p>
      <form className="create-form" onSubmit={submit}>
        <label>
          <span>目标描述</span>
          <textarea
            required
            rows={4}
            value={objective}
            onChange={(event) => setObjective(event.target.value)}
            placeholder="例如：重构登录模块并补齐自动化测试"
          />
        </label>

        <div className="field-row">
          <label>
            <span>执行窗口数量</span>
            <input
              required
              type="number"
              min={1}
              step={1}
              value={workerCount}
              onChange={(event) => setWorkerCount(event.target.value)}
            />
          </label>

          <label>
            <span>工作目录</span>
            <input
              required
              type="text"
              value={workspacePath}
              onChange={(event) => setWorkspacePath(event.target.value)}
            />
          </label>
        </div>

        <div className="button-row">
          <button className="primary" type="submit" disabled={loading}>
            {loading ? '正在创建...' : '创建并执行'}
          </button>
        </div>
      </form>
    </section>
  );
}
