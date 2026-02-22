import test from 'node:test';
import assert from 'node:assert/strict';
import { detectApprovalPrompt, buildPromptFingerprint } from '../electron/orchestrator/prompt-detector.js';

test('检测三选项确认提示', () => {
  const lines = [
    '准备执行危险操作',
    '1. yes',
    "2. yes and don't ask again",
    '3. no,and tell codex what to do',
  ];
  const result = detectApprovalPrompt(lines);
  assert.equal(result.hit, true);
  assert.equal(result.kind, 'three_choice');
  assert.deepEqual(result.options, [1, 2, 3]);
  assert.ok(result.fingerprint.length > 0);
});

test('不同动态数字应得到相同指纹', () => {
  const p1 = buildPromptFingerprint('Path /tmp/abc123 and code 9001');
  const p2 = buildPromptFingerprint('Path /tmp/xyz567 and code 7444');
  assert.equal(p1, p2);
});

test('检测继续执行建议提示', () => {
  const lines = [
    '收到，开始干活。',
    '我先做了环境探查，当前目录没有发现目标项目。',
    '如果你要，我下一步可以继续补齐初始化结构并开始联调。',
  ];

  const result = detectApprovalPrompt(lines);
  assert.equal(result.hit, true);
  assert.equal(result.kind, 'continue_suggestion');
  assert.deepEqual(result.options, [1, 2, 3]);
});

test('继续建议指纹应忽略工作时长和上下文百分比抖动', () => {
  const t1 = buildPromptFingerprint('如果你要，我下一步可以继续。 • Working (9s) 53% context left');
  const t2 = buildPromptFingerprint('如果你要，我下一步可以继续。 • Working (41s) 47% context left');
  assert.equal(t1, t2);
});
