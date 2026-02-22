import test from 'node:test';
import assert from 'node:assert/strict';
import { ApprovalBrokerService } from '../electron/orchestrator/approval-broker-service.js';
import { buildPromptFingerprint } from '../electron/orchestrator/prompt-detector.js';

function createSession() {
  return {
    sessionId: 'session-test',
    supervisor: {
      workerId: 'supervisor',
      status: 'running',
      lastLine: '',
      lastLines: [],
    },
    workers: [
      {
        workerId: 'worker-1',
        status: 'running',
        lastLine: '',
        lastLines: [],
      },
    ],
    approvals: [],
    dontAskRules: [],
  };
}

test('继续执行建议会进入待处理队列', () => {
  const session = createSession();
  const runtime = {
    readRecentLines: ({ targetId }) => {
      if (targetId === 'worker-1') {
        return {
          ok: true,
          lines: [
            '当前环境已检查完成。',
            '如果你要，我下一步可以继续补齐项目目录并开始联调。',
          ],
          lastLine: '如果你要，我下一步可以继续补齐项目目录并开始联调。',
        };
      }
      return {
        ok: true,
        lines: ['主管空闲中'],
        lastLine: '主管空闲中',
      };
    },
    sendInput: () => ({ ok: true }),
  };
  const appendedEvents = [];
  const broker = new ApprovalBrokerService({
    runtimeManager: runtime,
    sessionStore: {
      appendEvent: (_sessionId, event) => appendedEvents.push(event),
    },
    plannerService: {
      requestReplanForNoChoice: async () => ({ ok: true }),
    },
  });

  const changed = broker.scanAndQueue({ session });
  assert.equal(changed, true);
  assert.equal(session.approvals.length, 1);
  assert.equal(session.approvals[0].kind, 'continue_suggestion');
  assert.equal(session.workers[0].status, 'waiting_user_input');
  assert.ok(appendedEvents.some((item) => item.type === 'approval_created'));
});

test('主管继续建议默认自动继续，不进入待处理队列', () => {
  const session = createSession();
  const sendCalls = [];
  const events = [];
  const runtime = {
    readRecentLines: ({ targetId }) => {
      if (targetId === 'supervisor') {
        return {
          ok: true,
          lines: ['如果你要，我下一步可以继续推进分配执行。'],
          lastLine: '如果你要，我下一步可以继续推进分配执行。',
        };
      }
      return {
        ok: true,
        lines: ['worker idle'],
        lastLine: 'worker idle',
      };
    },
    sendInput: (payload) => {
      sendCalls.push(payload);
      return { ok: true };
    },
  };
  const broker = new ApprovalBrokerService({
    runtimeManager: runtime,
    sessionStore: {
      appendEvent: (_sessionId, event) => events.push(event),
    },
    plannerService: {
      requestReplanForNoChoice: async () => ({ ok: true }),
    },
  });

  const changed = broker.scanAndQueue({ session });
  assert.equal(changed, true);
  assert.equal(session.approvals.length, 0);
  assert.equal(sendCalls.length, 1);
  assert.equal(sendCalls[0].targetId, 'supervisor');
  assert.equal(session.supervisor.status, 'running');
  assert.ok(events.some((event) => event.type === 'approval_auto_continued'));
});

test('主管遗留继续建议待确认会自动解阻塞', () => {
  const session = createSession();
  session.approvals.push({
    id: 'supervisor-pending-1',
    sessionId: session.sessionId,
    workerId: 'supervisor',
    sourceText: '如果你要，我下一步可以继续。',
    fingerprint: buildPromptFingerprint('如果你要，我下一步可以继续。'),
    kind: 'continue_suggestion',
    options: [1, 2, 3],
    status: 'pending',
    createdAt: new Date(Date.now() - 60 * 1000).toISOString(),
  });

  const sendCalls = [];
  const runtime = {
    readRecentLines: ({ targetId }) => ({
      ok: true,
      lines: targetId === 'supervisor' ? ['继续处理中'] : ['worker idle'],
      lastLine: targetId === 'supervisor' ? '继续处理中' : 'worker idle',
    }),
    sendInput: (payload) => {
      sendCalls.push(payload);
      return { ok: true };
    },
  };
  const broker = new ApprovalBrokerService({
    runtimeManager: runtime,
    sessionStore: {
      appendEvent: () => {},
    },
    plannerService: {
      requestReplanForNoChoice: async () => ({ ok: true }),
    },
  });

  const changed = broker.scanAndQueue({ session });
  assert.equal(changed, true);
  assert.equal(sendCalls.length, 1);
  assert.equal(sendCalls[0].targetId, 'supervisor');
  assert.equal(session.approvals[0].status, 'resolved');
  assert.equal(session.supervisor.status, 'running');
});

test('主管确认提示会进入待处理队列并可回填', async () => {
  const session = createSession();
  const runtime = {
    readRecentLines: ({ targetId }) => {
      if (targetId === 'supervisor') {
        return {
          ok: true,
          lines: [
            '需要确认',
            '1. yes',
            "2. yes and don't ask again",
            '3. no,and tell codex what to do',
          ],
          lastLine: '3. no,and tell codex what to do',
        };
      }
      return {
        ok: true,
        lines: ['worker idle'],
        lastLine: 'worker idle',
      };
    },
    sendInput: () => ({ ok: true }),
  };
  const broker = new ApprovalBrokerService({
    runtimeManager: runtime,
    sessionStore: {
      appendEvent: () => {},
    },
    plannerService: {
      requestReplanForNoChoice: async () => ({ ok: true }),
    },
  });

  const changed = broker.scanAndQueue({ session });
  assert.equal(changed, true);
  assert.equal(session.approvals.length, 1);
  assert.equal(session.approvals[0].workerId, 'supervisor');
  assert.equal(session.supervisor.status, 'waiting_user_input');

  const sendCalls = [];
  const brokerForResolve = new ApprovalBrokerService({
    runtimeManager: {
      readRecentLines: () => ({ ok: true, lines: [], lastLine: '' }),
      sendInput: (payload) => {
        sendCalls.push(payload);
        return { ok: true };
      },
    },
    sessionStore: {
      appendEvent: () => {},
    },
    plannerService: {
      requestReplanForNoChoice: async () => ({ ok: true }),
    },
  });

  const result = await brokerForResolve.resolve({
    session,
    approvalId: session.approvals[0].id,
    choice: 1,
    instruction: '',
  });
  assert.equal(result.ok, true);
  assert.equal(sendCalls.length, 1);
  assert.equal(sendCalls[0].targetId, 'supervisor');
  assert.equal(session.supervisor.status, 'running');
});

test('继续执行建议选 1 时向执行窗口发送继续指令', async () => {
  const session = createSession();
  session.approvals.push({
    id: 'approval-1',
    sessionId: session.sessionId,
    workerId: 'worker-1',
    sourceText: '如果你要，我下一步可以继续。',
    fingerprint: 'fp-1',
    kind: 'continue_suggestion',
    options: [1, 2, 3],
    status: 'pending',
    createdAt: new Date().toISOString(),
  });

  const sendCalls = [];
  const broker = new ApprovalBrokerService({
    runtimeManager: {
      readRecentLines: () => ({ ok: true, lines: [], lastLine: '' }),
      sendInput: (payload) => {
        sendCalls.push(payload);
        return { ok: true };
      },
    },
    sessionStore: {
      appendEvent: () => {},
    },
    plannerService: {
      requestReplanForNoChoice: async () => ({ ok: true }),
    },
  });

  const result = await broker.resolve({
    session,
    approvalId: 'approval-1',
    choice: 1,
    instruction: '',
  });

  assert.equal(result.ok, true);
  assert.equal(sendCalls.length, 1);
  assert.equal(sendCalls[0].targetId, 'worker-1');
  assert.match(sendCalls[0].text, /继续执行你刚才提出的下一步/);
  assert.equal(session.approvals[0].status, 'resolved');
});

test('继续执行建议选 3 时转交主管处理', async () => {
  const session = createSession();
  session.approvals.push({
    id: 'approval-2',
    sessionId: session.sessionId,
    workerId: 'worker-1',
    sourceText: '如果你要，我下一步可以继续。',
    fingerprint: 'fp-2',
    kind: 'continue_suggestion',
    options: [1, 2, 3],
    status: 'pending',
    createdAt: new Date().toISOString(),
  });

  const sendCalls = [];
  let plannerCalled = false;
  const broker = new ApprovalBrokerService({
    runtimeManager: {
      readRecentLines: () => ({ ok: true, lines: [], lastLine: '' }),
      sendInput: (payload) => {
        sendCalls.push(payload);
        return { ok: true };
      },
    },
    sessionStore: {
      appendEvent: () => {},
    },
    plannerService: {
      requestReplanForNoChoice: async () => {
        plannerCalled = true;
        return { ok: true };
      },
    },
  });

  const result = await broker.resolve({
    session,
    approvalId: 'approval-2',
    choice: 3,
    instruction: '不要补目录，先补测试',
  });

  assert.equal(result.ok, true);
  assert.equal(plannerCalled, false);
  assert.equal(sendCalls.length, 1);
  assert.equal(sendCalls[0].targetId, 'supervisor');
  assert.match(sendCalls[0].text, /dispatch_json/);
});

test('同指纹在短时间内已处理后不应重复入队', () => {
  const session = createSession();
  const text = '如果你要，我下一步可以继续。';
  const fingerprint = buildPromptFingerprint(text);
  session.approvals.push({
    id: 'approval-old',
    sessionId: session.sessionId,
    workerId: 'worker-1',
    sourceText: text,
    fingerprint,
    kind: 'continue_suggestion',
    options: [1, 2, 3],
    status: 'resolved',
    createdAt: new Date(Date.now() - 10 * 1000).toISOString(),
    resolvedAt: new Date(Date.now() - 5 * 1000).toISOString(),
    resolvedChoice: 1,
    instruction: '',
  });

  const runtime = {
    readRecentLines: ({ targetId }) => {
      if (targetId === 'worker-1') {
        return {
          ok: true,
          lines: [text],
          lastLine: text,
        };
      }
      return {
        ok: true,
        lines: ['idle'],
        lastLine: 'idle',
      };
    },
    sendInput: () => ({ ok: true }),
  };

  const broker = new ApprovalBrokerService({
    runtimeManager: runtime,
    sessionStore: {
      appendEvent: () => {},
    },
    plannerService: {
      requestReplanForNoChoice: async () => ({ ok: true }),
    },
  });

  const changed = broker.scanAndQueue({ session });
  assert.equal(changed, false);
  assert.equal(session.approvals.length, 1);
});
