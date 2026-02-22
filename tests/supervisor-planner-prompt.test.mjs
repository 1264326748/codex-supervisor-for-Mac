import test from 'node:test';
import assert from 'node:assert/strict';
import { SupervisorPlannerService } from '../electron/orchestrator/supervisor-planner-service.js';

function createService(runtimeManager = null) {
  return new SupervisorPlannerService({
    runtimeManager: runtimeManager || {
      readRecentLines: () => ({ ok: true, lines: [] }),
    },
    sessionStore: {
      appendEvent: () => {},
    },
    onEvent: () => {},
  });
}

test('规划提示为单行文本，避免多行草稿卡住', () => {
  const service = createService();
  const prompt = service.buildPlanPrompt({
    objective: '创建一个\n学习音标应用',
    workerCount: 2,
    attempt: 1,
    totalAttempts: 3,
  });

  assert.equal(prompt.includes('\n'), false);
  assert.match(prompt, /<task_plan_json>/);
  assert.match(prompt, /tasks 数量必须等于 2/);
  assert.match(prompt, /只.*JSON 标签块|不要额外说明/);
});

test('格式修复提示为单行文本', () => {
  const service = createService();
  const prompt = service.buildFormatRepairPrompt({
    workerCount: 3,
    reason: '字段缺失',
  });

  assert.equal(prompt.includes('\n'), false);
  assert.match(prompt, /tasks 必须正好 3 条/);
  assert.match(prompt, /上一轮解析失败原因：字段缺失/);
});

test('主管就绪检测：识别已加载界面', async () => {
  const runtime = {
    readRecentLines: () => ({
      ok: true,
      lines: [
        '╭──────────────────────────────╮',
        '│ >_ OpenAI Codex (v0.104.0)   │',
        '│ model:     gpt-5.3-codex     │',
        '╰──────────────────────────────╯',
        '',
        '› Implement {feature}',
        '',
        '  ? for shortcuts                                            100% context left',
      ],
    }),
  };

  const service = createService(runtime);
  const result = await service.waitSupervisorReady({
    sessionId: 'test',
    timeoutMs: 2400,
  });

  assert.equal(result.ok, true);
});

