import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseSupervisorPlanFromText,
  parseDispatchInstructionFromText,
  parseSupervisorDispatchActionsFromText,
} from '../shared/parsers.js';

test('解析主管计划 JSON 标签块', () => {
  const text = [
    '思考中...',
    '<task_plan_json>',
    JSON.stringify({
      planSummary: '拆分完成',
      tasks: [
        { workerIndex: 1, title: 'A', instruction: 'Do A', dependsOn: [] },
        { workerIndex: 2, title: 'B', instruction: 'Do B', dependsOn: [1] },
      ],
    }),
    '</task_plan_json>',
  ].join('\n');

  const result = parseSupervisorPlanFromText(text);
  assert.equal(result.ok, true);
  assert.equal(result.plan.tasks.length, 2);
  assert.equal(result.plan.tasks[1].workerIndex, 2);
});

test('可容错解析 fenced json 中的计划字段漂移', () => {
  const text = [
    '这里先解释一段内容',
    '```json',
    JSON.stringify({
      summary: '新的规划摘要',
      subtasks: [
        { worker: 'worker-1', name: '拆A', prompt: '处理 A' },
        { worker: 2, name: '拆B', description: '处理 B', deps: 'depends on 1' },
      ],
    }),
    '```',
  ].join('\n');

  const result = parseSupervisorPlanFromText(text);
  assert.equal(result.ok, true);
  assert.equal(result.plan.planSummary, '新的规划摘要');
  assert.equal(result.plan.tasks.length, 2);
  assert.equal(result.plan.tasks[1].dependsOn[0], 1);
});

test('计划解析可清理 ANSI 控制字符', () => {
  const text = [
    '\u001b[32m输出开始\u001b[0m',
    '<task_plan_json>',
    '{"planSummary":"ok","tasks":[{"workerIndex":1,"title":"A","instruction":"Do A","dependsOn":[]}]}',
    '</task_plan_json>',
  ].join('\n');

  const result = parseSupervisorPlanFromText(text);
  assert.equal(result.ok, true);
  assert.equal(result.plan.tasks[0].instruction, 'Do A');
});

test('计划解析可容错 tmux 窗口硬换行导致的 JSON 断行', () => {
  const text = [
    '• <task_plan_json>',
    '{"planSummary":"ok","tasks":[{"workerIndex":1,"title":"A","instruction":"这是一段很长的',
    '  指令内容，会被终端窗口硬换行","dependsOn":[]},{"workerIndex":2,"title":"B","instruction":"第二段也',
    '  会被断行","dependsOn":[1]}]}',
    '</task_plan_json>',
  ].join('\n');

  const result = parseSupervisorPlanFromText(text);
  assert.equal(result.ok, true);
  assert.equal(result.plan.tasks.length, 2);
  assert.match(result.plan.tasks[0].instruction, /终端窗口硬换行/);
});

test('解析回传修订指令', () => {
  const text = '<dispatch_json>{"workerId":"worker-2","instruction":"先补测试再改代码"}</dispatch_json>';
  const result = parseDispatchInstructionFromText(text);
  assert.equal(result.ok, true);
  assert.equal(result.dispatch.workerId, 'worker-2');
});

test('回传修订支持 target + message 别名', () => {
  const text = '```json\\n{"target":"2","message":"改为先写测试"}\\n```';
  const result = parseDispatchInstructionFromText(text);
  assert.equal(result.ok, true);
  assert.equal(result.dispatch.workerId, 'worker-2');
  assert.equal(result.dispatch.instruction, '改为先写测试');
});

test('解析主管批量分配标签并去重', () => {
  const text = [
    '<dispatch_json>{"workerId":"worker-1","instruction":"继续任务 A"}</dispatch_json>',
    '<dispatch_batch_json>{"tasks":[{"workerId":"worker-2","instruction":"继续任务 B"},{"workerId":"worker-2","instruction":"继续任务 B"}]}</dispatch_batch_json>',
    '<dispatch_all_json>{"instruction":"同步日报","workerIds":["worker-1","worker-3"]}</dispatch_all_json>',
  ].join('\n');

  const result = parseSupervisorDispatchActionsFromText(text, {
    workerIds: ['worker-1', 'worker-2', 'worker-3'],
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.actions, [
    { workerId: 'worker-1', instruction: '继续任务 A' },
    { workerId: 'worker-2', instruction: '继续任务 B' },
    { workerId: 'worker-1', instruction: '同步日报' },
    { workerId: 'worker-3', instruction: '同步日报' },
  ]);
});
