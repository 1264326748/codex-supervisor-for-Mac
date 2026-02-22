import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { SessionOrchestrator } from '../electron/orchestrator/session-orchestrator.js';

class RuntimeMock extends EventEmitter {
  constructor() {
    super();
    this.calls = [];
  }

  sendInput(payload) {
    this.calls.push(payload);
    return { ok: true };
  }
}

function createOrchestrator(runtime, events) {
  return new SessionOrchestrator({
    sessionStore: {
      appendEvent: (_sessionId, event) => events.push(event),
      listSessions: () => [],
      listSessionIds: () => [],
      getSession: () => null,
      readLogTail: () => [],
      saveSession: (session) => session,
    },
    runtimeManager: runtime,
    plannerService: {},
    dispatchService: {},
    approvalBroker: {
      scanAndQueue: () => false,
    },
  });
}

function createStatefulOrchestrator(runtime, events, session) {
  const state = {
    session,
  };
  return new SessionOrchestrator({
    sessionStore: {
      appendEvent: (_sessionId, event) => events.push(event),
      listSessions: () => [],
      listSessionIds: () => [],
      getSession: () => state.session,
      readLogTail: () => [],
      saveSession: (next) => {
        state.session = next;
        return state.session;
      },
      updateSession: (_sessionId, updater) => {
        state.session = updater({ ...state.session });
        return state.session;
      },
    },
    runtimeManager: runtime,
    plannerService: {},
    dispatchService: {},
    approvalBroker: {
      scanAndQueue: () => false,
    },
  });
}

test('主管结构化下发会自动派发且去重', () => {
  const runtime = new RuntimeMock();
  const events = [];
  const orchestrator = createOrchestrator(runtime, events);
  const session = {
    sessionId: 'session-1',
    supervisor: {
      workerId: 'supervisor',
      processedDispatchKeys: [],
    },
    workers: [
      {
        workerId: 'worker-1',
        status: 'waiting_user_input',
      },
    ],
  };

  const first = orchestrator.applySupervisorDispatchActions({
    session,
    actions: [
      { workerId: 'worker-1', instruction: '继续执行阶段 1' },
    ],
  });
  assert.equal(first, true);
  assert.equal(runtime.calls.length, 1);
  assert.equal(runtime.calls[0].targetId, 'worker-1');
  assert.equal(session.workers[0].status, 'running');
  assert.equal(session.supervisor.processedDispatchKeys.length, 1);
  assert.ok(events.some((event) => event.type === 'supervisor_dispatch_applied'));

  const second = orchestrator.applySupervisorDispatchActions({
    session,
    actions: [
      { workerId: 'worker-1', instruction: '继续执行阶段 1' },
    ],
  });
  assert.equal(second, false);
  assert.equal(runtime.calls.length, 1);
});

test('示例占位指令会被严格拦截，不会真正派发', () => {
  const runtime = new RuntimeMock();
  const events = [];
  const orchestrator = createOrchestrator(runtime, events);
  const session = {
    sessionId: 'session-2',
    supervisor: {
      workerId: 'supervisor',
      processedDispatchKeys: [],
    },
    workers: [
      {
        workerId: 'worker-1',
        status: 'running',
      },
    ],
  };

  const applied = orchestrator.applySupervisorDispatchActions({
    session,
    actions: [
      { workerId: 'worker-1', instruction: '具体执行指令' },
    ],
  });

  assert.equal(applied, true);
  assert.equal(runtime.calls.length, 0);
  assert.ok(events.some((event) => event.type === 'supervisor_dispatch_rejected_as_example'));
});

test('主管有待确认时发送指令会产生阻塞提示事件', () => {
  const runtime = new RuntimeMock();
  const events = [];
  const session = {
    sessionId: 'session-3',
    status: 'running',
    approvals: [
      {
        id: 'pending-supervisor-1',
        workerId: 'supervisor',
        status: 'pending',
      },
    ],
    supervisor: {
      workerId: 'supervisor',
      status: 'waiting_user_input',
      lastLine: 'waiting',
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
  };

  const orchestrator = createStatefulOrchestrator(runtime, events, session);
  const result = orchestrator.sendManualInput({
    sessionId: 'session-3',
    targetId: 'supervisor',
    text: '请回复 pong',
    pressEnter: true,
    source: 'manual-ui',
  });

  assert.equal(result.ok, true);
  assert.equal(runtime.calls.length, 1);
  assert.ok(events.some((event) => event.type === 'manual_input_blocked_by_pending'));
});
