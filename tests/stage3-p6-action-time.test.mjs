// P6 · 动作时间分析（D02-06 §7.12 / D01-03 §5.6）
//
// 四个算例逐项实现（§5.6.1~§5.6.4）。这组用例的价值全在"两个数不能混"：
//   · `spanRequired` = 所有动作 `t_to` 的最大值 —— 镜头**至少要多久**；
//   · `unionMax`     = 按人分组、组内区间并集的最大长度 —— 谁**最忙**。
// 混用会得出"动作只占 2 秒，镜长 6 秒很宽松"这种结论，而实际上 5.0 秒的动作根本放不下。
//
// 实现只有一份（`validate/action.js`），P6 通过 `continuity/action-time.js` 转出。
import test from 'node:test';
import assert from 'node:assert/strict';

import { analyzeActionTime as fromContinuity } from '../lib/core/continuity/action-time.js';
import { analyzeActionTime as fromValidate } from '../lib/core/validate/action.js';

/** 算例统一从这个别名走（值来自 P6 的转出入口） */
const analyzeActionTime = fromContinuity;

const act = (id, actor, from, to, parts = []) => ({
  id, actor_id: actor, t_from: from, t_to: to,
  body_parts: parts.map((p) => ({ part: p, act: 'x' })),
});

test('唯一实现：P6 的转出与 P5 的函数是同一个引用（不复制第二份）', () => {
  assert.equal(fromContinuity, fromValidate);
});

// §5.6.1 输入顺序不影响结果（E4 回归）
test('§5.6.1 三种传入顺序结果逐字相同；spanRequired=3.0、unionMax=2.6、冲突是 ac_1↔ac_3', () => {
  const A1 = act('ac_1', 'harold', 0, 1.6, ['right_arm', 'lower', 'trunk']);
  const A2 = act('ac_2', 'roxanne', 1.2, 2.0, ['trunk']);
  const A3 = act('ac_3', 'harold', 1.4, 2.6, ['right_arm']);
  const A4 = act('ac_4', 'kaisen', 2.0, 3.0, ['head']);
  const orders = [[A1, A2, A3, A4], [A4, A3, A2, A1], [A3, A1, A4, A2]];
  const out = orders.map((actions) => analyzeActionTime({ actions, storyDuration: 4.5 }));

  assert.deepEqual(out[0], out[1]);
  assert.deepEqual(out[1], out[2]);
  const r = out[0];
  assert.equal(r.spanRequired, 3.0);
  assert.equal(r.unionMax, 2.6);
  assert.equal(r.perActor.harold.unionLen, 2.6, '重叠 0.2s 必须合并，不是 1.6+1.2=2.8');
  assert.equal(r.perActor.roxanne.unionLen, 0.8);
  assert.equal(r.perActor.kaisen.unionLen, 1.0);
  assert.equal(r.conflicts.length, 1);
  assert.equal(r.conflicts[0].code, 'ACTION_PART_CONFLICT');
  assert.deepEqual([r.conflicts[0].a, r.conflicts[0].b].sort(), ['ac_1', 'ac_3'], '必须报 ac_1↔ac_3，不是 ac_1↔ac_2');
  // 部位在输出里是**分组名**（D01-03 §5.6.1 的预期是 `arm_r`，不是 `right_arm`）
  assert.deepEqual(r.conflicts[0].parts, ['arm_r']);
  assert.deepEqual(r.conflicts[0].overlap, [1.4, 1.6]);
});

// §5.6.2 并集 ≠ 时间轴需求（E5 回归）
test('§5.6.2 同人 0–1.0 与 4.0–5.0：spanRequired=5.0（不是 2.0）、unionLen=2.0、gaps=[[1,4]]', () => {
  const r = analyzeActionTime({
    actions: [act('ac_5', 'harold', 0, 1.0, ['right_arm']), act('ac_6', 'harold', 4.0, 5.0, ['left_arm'])],
    storyDuration: 6.0,
  });
  assert.equal(r.spanRequired, 5.0);
  assert.equal(r.unionMax, 2.0);
  assert.equal(r.perActor.harold.unionLen, 2.0);
  assert.equal(r.perActor.harold.coverage, 0.333);
  assert.deepEqual(r.perActor.harold.gaps, [[1, 4]]);
  assert.deepEqual(r.conflicts, []);
});

// §5.6.3 左右手独立 vs 同部位冲突
test('§5.6.3 左右手同时不报；同部位重叠报 ACTION_PART_CONFLICT', () => {
  const runs = (a, b) => analyzeActionTime({
    actions: [act('A', 'harold', 0, 2, a), act('B', 'harold', 0, 2, b)],
    storyDuration: 4,
  });

  // S1 左手 + 右手 → 合法（这一条是"组划分是否合理"的关键：把 body_parts 当整体就会误报）
  assert.deepEqual(runs(['left_hand'], ['right_hand']).conflicts, []);
  // S2 同一部位 → 报
  assert.equal(runs(['left_arm'], ['left_arm']).conflicts[0].code, 'ACTION_PART_CONFLICT');
  // S3 双手抱胸 vs 右手接电话 → 报（共享 arm_r）
  assert.equal(runs(['left_hand', 'right_hand'], ['right_hand']).conflicts[0].code, 'ACTION_PART_CONFLICT');
  // S4 边走边说 → 合法
  assert.deepEqual(runs(['lower'], ['head']).conflicts, []);
});

// §5.6.4 多人并行不增加时间需求
test('§5.6.4 三人并行：spanRequired = 最大 t_to（4.0），不因人数翻倍', () => {
  const r = analyzeActionTime({
    actions: [act('a', 'harold', 0.5, 3.5, ['right_arm']), act('b', 'roxanne', 0, 2.0, ['head']), act('c', 'kaisen', 1.0, 4.0, ['lower'])],
    storyDuration: 4.0,
  });
  assert.equal(r.spanRequired, 4.0);
  assert.equal(r.unionMax, 3.0);
  assert.equal(r.perActor.harold.unionLen, 3.0);
  assert.equal(r.perActor.roxanne.unionLen, 2.0);
  assert.equal(r.perActor.kaisen.unionLen, 3.0);
  assert.deepEqual(r.conflicts, []);
});

test('量化口径：入口量化到 0.001，严格比较不设 EPS', () => {
  const r = analyzeActionTime({
    actions: [act('a', 'harold', 0.0004, 1.0004, ['right_arm'])],
    storyDuration: 2,
  });
  assert.equal(r.spanRequired, 1);
  assert.equal(r.perActor.harold.unionLen, 1);
  // 相邻但不重叠的两段（1.0 结束、1.0 开始）合并成一段
  const touching = analyzeActionTime({
    actions: [act('a', 'harold', 0, 1, ['right_arm']), act('b', 'harold', 1, 2, ['left_arm'])],
    storyDuration: 3,
  });
  assert.equal(touching.perActor.harold.unionLen, 2);
  assert.deepEqual(touching.perActor.harold.gaps, []);
});

test('空输入与缺 story_duration 不崩：spanRequired=0、perActor 为空', () => {
  const r = analyzeActionTime({});
  assert.equal(r.spanRequired, 0);
  assert.equal(r.unionMax, 0);
  assert.deepEqual(r.perActor, {});
  assert.deepEqual(r.conflicts, []);
});

test('声明 parallel_with 的冲突被放行（A-18 补齐前的免报通道）', () => {
  const withParallel = analyzeActionTime({
    actions: [
      { ...act('A', 'harold', 0, 2, ['right_arm']), sync_json: { parallel_with: ['B'] } },
      act('B', 'harold', 1, 3, ['right_arm']),
    ],
    storyDuration: 4,
  });
  assert.deepEqual(withParallel.conflicts, []);
});
