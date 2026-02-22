import test from 'node:test';
import assert from 'node:assert/strict';
import { TaskDispatchService } from '../electron/orchestrator/task-dispatch-service.js';

test('任务下发内容会压成单行，避免卡在多行草稿', async () => {
  const sentPayloads = [];
  const service = new TaskDispatchService({
    runtimeManager: {
      sendInput(payload) {
        sentPayloads.push(payload);
        return { ok: true };
      },
    },
    sessionStore: {
      appendEvent: () => {},
    },
    onEvent: () => {},
  });

  const result = await service.dispatchPlan({
    sessionId: 'session-test',
    plan: {
      tasks: [
        {
          workerId: 'worker-1',
          title: '初始化目录',
          dependsOn: [],
          instruction: '先创建 src 目录\n再写 README',
        },
      ],
    },
  });

  assert.equal(result.length, 1);
  assert.equal(result[0].ok, true);
  assert.equal(sentPayloads.length, 1);
  assert.equal(sentPayloads[0].pressEnter, true);
  assert.equal(sentPayloads[0].text.includes('\n'), false);
  assert.match(sentPayloads[0].text, /你是 worker-1/);
  assert.match(sentPayloads[0].text, /先创建 src 目录 再写 README/);
});

