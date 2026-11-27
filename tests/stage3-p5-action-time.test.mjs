// 阶段 3 · P5：`analyzeActionTime` 四个算例（D01-03 §5.6.1~§5.6.4 + D02-06 §7.12）
//
// 这四条是"区间模型"的地基，任何一条错都会直接反映成"合法镜头被判死"：
//   §5.6.1 输入顺序不影响结果（E4：区间数组与动作对象不能各自排序）
//   §5.6.2 并集 ≠ 时间轴需求（E5：`unionLen` 不能当 `spanRequired`）
//   §5.6.3 左右手独立、同部位冲突（把 `body_parts` 当整体就会误报）
//   §5.6.4 多人并行不增加时间需求（跨人相加是 V1/V2 的错误）
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-p5-atime-'));
process.env.IC_DATA_DIR = TMP;
delete process.env.IC_DB_SQLITE_PATH;
delete process.env.IC_DB;
delete process.env.DATABASE_URL;

const { analyzeActionTime, checkLipsync, checkPartConflict } = await import('../lib/core/validate/action.js');

/** 动作行最小形状：只给区间与部位 */
const act = (id, actor, from, to, parts = []) => ({
  id, actor_id: actor, t_from: from, t_to: to, body_parts: parts.map((p) => ({ part: p })),
});

test('§5.6.1 顺序无关：三种传入顺序结果逐字相同；冲突报 ac_1↔ac_3', () => {
  const A1 = act('ac_1', 'as_char_harold', 0, 1.6, ['right_arm', 'right_foot', 'torso']);
  const A2 = act('ac_2', 'as_char_roxanne', 1.2, 2.0, ['torso']);
  const A3 = act('ac_3', 'as_char_harold', 1.4, 2.6, ['right_arm']);
  const A4 = act('ac_4', 'as_char_kaisen', 2.0, 3.0, ['head']);

  const r1 = analyzeActionTime({ storyDuration: 4.5, actions: [A1, A2, A3, A4] });
  const r2 = analyzeActionTime({ storyDuration: 4.5, actions: [A4, A3, A2, A1] });
  const r3 = analyzeActionTime({ storyDuration: 4.5, actions: [A3, A1, A4, A2] });
  assert.deepEqual(r1, r2, '顺序 [4,3,2,1] 必须与 [1,2,3,4] 逐字相同');
  assert.deepEqual(r1, r3, '顺序 [3,1,4,2] 必须与 [1,2,3,4] 逐字相同');

  assert.equal(r1.spanRequired, 3.0, '镜头至少要 3.0s（ac_4 的 t_to）');
  assert.equal(r1.unionMax, 2.6, 'unionMax = 各人并集最大值（哈罗德 2.6）');

  const h = r1.perActor.as_char_harold;
  assert.equal(h.unionLen, 2.6, '重叠 0.2s 必须合并，不是 1.6+1.2=2.8');
  assert.equal(h.coverage, 0.578);
  assert.equal(h.count, 2);
  assert.equal(h.lastEnd, 2.6);
  assert.equal(r1.perActor.as_char_roxanne.unionLen, 0.8);
  assert.equal(r1.perActor.as_char_roxanne.coverage, 0.178);
  assert.equal(r1.perActor.as_char_kaisen.unionLen, 1.0);
  assert.equal(r1.perActor.as_char_kaisen.coverage, 0.222);

  assert.equal(r1.conflicts.length, 1);
  assert.equal(r1.conflicts[0].a, 'ac_1');
  assert.equal(r1.conflicts[0].b, 'ac_3', '若报成 ac_1↔ac_2（罗克珊）说明排序错配（E4）仍存在');
  assert.deepEqual(r1.conflicts[0].parts, ['arm_r']);
  assert.deepEqual(r1.conflicts[0].overlap, [1.4, 1.6]);
});

test('§5.6.2 并集 ≠ 时间轴需求：spanRequired=5.0、unionLen=2.0、gaps=[[1,4]]', () => {
  const r = analyzeActionTime({
    storyDuration: 6,
    actions: [act('ac_5', 'as_char_harold', 0, 1), act('ac_6', 'as_char_harold', 4, 5)],
  });
  assert.equal(r.spanRequired, 5.0, '动作最晚结束在 5.0 —— 镜长小于 5 就放不下');
  assert.equal(r.unionMax, 2.0);
  const h = r.perActor.as_char_harold;
  assert.equal(h.unionLen, 2.0, '"动了 2 秒" 不是 "镜头 2 秒够"');
  assert.equal(h.coverage, 0.333);
  assert.deepEqual(h.gaps, [[1, 4]]);
  assert.deepEqual(r.conflicts, []);
});

test('§5.6.3 左右手独立 vs 同部位冲突（S1~S4）', () => {
  const cases = [
    // S1 左手拿手机 + 右手握手 → 合法
    { name: 'S1', a: ['left_hand'], b: ['right_hand'], conflict: false },
    // S2 左手抬 + 左手放下 → arm_l 冲突
    { name: 'S2', a: ['left_arm'], b: ['left_arm'], conflict: true },
    // S3 双手抱胸 vs 右手接电话 → arm_r 冲突
    { name: 'S3', a: ['left_hand', 'right_hand'], b: ['right_hand'], conflict: true },
    // S4 边走（下肢）vs 说话（头面）→ 合法
    { name: 'S4', a: ['left_leg'], b: ['head'], conflict: false },
  ];
  for (const c of cases) {
    const r = analyzeActionTime({
      storyDuration: 3,
      actions: [act('x1', 'c1', 0, 2, c.a), act('x2', 'c1', 1, 3, c.b)],
    });
    assert.equal(r.conflicts.length, c.conflict ? 1 : 0, `${c.name} 期望 conflict=${c.conflict}`);
  }
  // 不同 actor 永不比较部位
  const cross = analyzeActionTime({
    storyDuration: 3,
    actions: [act('y1', 'c1', 0, 2, ['right_arm']), act('y2', 'c2', 0, 2, ['right_arm'])],
  });
  assert.deepEqual(cross.conflicts, [], '不同 actor 不比较部位');
});

test('§5.6.4 多人并行不增加时间需求：spanRequired=4.0、unionMax=3.0、无冲突', () => {
  const r = analyzeActionTime({
    storyDuration: 4,
    actions: [
      act('h1', 'as_char_harold', 0.5, 3.5),
      act('r1', 'as_char_roxanne', 0, 2.0),
      act('k1', 'as_char_kaisen', 1.0, 4.0),
    ],
  });
  assert.equal(r.spanRequired, 4.0, '三人时长之和 8.0 与镜长无关；需求是最大 t_to');
  assert.equal(r.unionMax, 3.0);
  assert.equal(r.perActor.as_char_harold.coverage, 0.75);
  assert.equal(r.perActor.as_char_roxanne.coverage, 0.5);
  assert.equal(r.perActor.as_char_kaisen.coverage, 0.75);
  assert.deepEqual(r.conflicts, []);
});

test('§5.6.3 S5 摇头（headface, power=9）与台词区间重叠 → A-14 口型冲突 WARN', () => {
  const shot = { id: 'sh_01', speakers: [{ type: 'on_screen', id: 'c1' }] };
  const actions = [
    act('ac_1', 'c1', 0.5, 2.0, ['head']),
    { ...act('ac_2', 'c1', 2.2, 3.5, ['torso']), sync_json: { dialogue_span: [0, 3] } },
  ];
  actions[0].power = 9;
  const hits = checkLipsync({ shot, actions });
  assert.equal(hits.applicable, true);
  assert.equal(hits.findings.length, 1);
  assert.equal(hits.findings[0].code, 'ACTION_MOUTH_CONFLICT');
  assert.equal(hits.findings[0].level, 'warn');

  // 同部位但 power<8 → 不算口型冲突
  const quiet = checkLipsync({ shot, actions: [{ ...actions[0], power: 3 }, actions[1]] });
  assert.equal(quiet.findings.length, 0, 'power<8 的头部动作不判口型冲突');
});

test('§5.6.3 S2/S3 由 A-12 规则报同一冲突码（analyzeActionTime 与规则共用一份判定）', () => {
  const shot = { id: 'sh_01', story_duration: 3 };
  const res = checkPartConflict({
    shot,
    actions: [act('x1', 'c1', 0, 2, ['left_arm']), act('x2', 'c1', 1, 3, ['left_arm'])],
  });
  assert.equal(res.findings.length, 1);
  assert.equal(res.findings[0].code, 'ACTION_PART_CONFLICT');
  assert.equal(res.findings[0].level, 'fail');
});
