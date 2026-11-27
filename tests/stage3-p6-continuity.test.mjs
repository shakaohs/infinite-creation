// P6 · 连续性求解器（D01-06 §2.1 / D01-04 §5.5 / D02-06 §7.2~§7.10）
//
// 覆盖：四镜算例（§7.10 四条断言）、C-1~C-7、冲突码逐个命中、确定性、纯函数性。
// 判据口径：**FAIL 只在"两侧都 known"时产生** —— 这条比任何单条用例都重要，
// 因为"用未知去判创作者有罪"会逼人把不知道的坐标填成猜测值来消红灯。
import test from 'node:test';
import assert from 'node:assert/strict';

import { solveContinuity, BREAK_CODES, POS_JUMP_MIN, TELEPORT_MIN, CARRY_DECAY, REL_CONF } from '../lib/core/continuity/solve-continuity.js';
import * as F from './helpers/continuity-fixture.mjs';

const solve = (shots, sceneState = F.scene()) => solveContinuity({ projectId: 'p1', sceneKey: 'S1_病房', shots, sceneState });
const codesOf = (one) => [...one.conflicts.map((c) => c.code), ...one.diagnostics.map((c) => c.code)];

// ── §7.10 四镜传播算例（D01-04 §5.7 逐字）───────────────────────────────
test('四镜算例 · 四条断言', () => {
  const r = solve(F.fourShots());

  // ① sh_41 不报 POSITION_JUMP（本镜没给坐标 → rel=unknown → 无法求差）
  assert.equal(r.states.sh_41.conflicts.some((c) => c.code === 'POSITION_JUMP'), false);
  assert.equal(r.states.sh_41.conflicts.some((c) => c.code === 'TELEPORT'), false);
  assert.ok(r.states.sh_41.diagnostics.some((c) => c.code === 'STATE_UNKNOWN' && c.field === 'chars.c1.pos'));

  // ② sh_42 不报 POSTURE_JUMP（posture=null → 类 B 缺值）
  assert.equal(r.states.sh_42.conflicts.some((c) => c.code === 'POSTURE_JUMP'), false);
  assert.ok(r.states.sh_42.diagnostics.some((c) => c.code === 'STATE_UNKNOWN' && c.field === 'chars.c1.posture'));

  // ③ sh_43 报 INCONSISTENT_INFERRED，且**不改** posture（推断值不写入 state_out）
  assert.ok(r.states.sh_43.diagnostics.some((c) => c.code === 'INCONSISTENT_INFERRED' && c.field === 'chars.c1.posture'));
  assert.equal(r.states.sh_43.out.chars.c1.posture, 'standing');

  // ④ meta.src 与 D01 的预期输出逐字一致
  assert.deepEqual(r.states.sh_41.meta['chars.c1.pos'], { rel: 'known', src: 'carried:sh_40', conf: 0.855, ver: 2 });
  assert.deepEqual(r.states.sh_41.meta['chars.c1.posture'], { rel: 'known', src: 'prev_shot:sh_40', conf: 0.95, ver: 2 });
  assert.equal(r.states.sh_42.meta['chars.c1.posture'].src, 'carried:sh_40');
  assert.equal(r.states.sh_43.meta['chars.c1.pos'].rel, 'unknown');
});

test('四镜算例 · 系数与规范一致（0.95 / 0.40 / ×0.9）', () => {
  assert.equal(REL_CONF.known, 0.95);
  assert.equal(REL_CONF.inferred, 0.4);
  assert.equal(CARRY_DECAY, 0.9);
  const r = solve(F.fourShots());
  // 0.95 × 0.9 = 0.855（D01-04 §5.7 原文给的数字）
  assert.equal(r.states.sh_41.meta['chars.c1.pos'].conf, 0.855);
  // 四镜全程无 FAIL：算例里没有任何一条"两侧都 known 且真的不一致"
  for (const id of ['sh_40', 'sh_41', 'sh_42', 'sh_43']) assert.deepEqual(r.states[id].conflicts, []);
});

// ── C-1~C-7 ────────────────────────────────────────────────────────────
test('C-1 换场隔离：两场各自用自己的基线，S1 末镜不串进 S2 首镜', () => {
  const s1 = [F.shot({ id: 'a1', global_no: 1, blockings: [F.blk({ norm_x: 0.1, norm_y: 0.1 })] })];
  const s2 = [F.shot({ id: 'b1', global_no: 2, scene_key: 'S2_走廊', blockings: [F.blk({ norm_x: 0.9, norm_y: 0.9 })] })];
  const r1 = solveContinuity({ projectId: 'p1', sceneKey: 'S1_病房', shots: s1, sceneState: F.scene() });
  const r2 = solveContinuity({ projectId: 'p1', sceneKey: 'S2_走廊', shots: s2, sceneState: F.scene({ scene_key: 'S2_走廊' }) });
  assert.equal(r1.states.a1.derived_from, 'scene_baseline');
  assert.equal(r2.states.b1.derived_from, 'scene_baseline');
  // S2 首镜的 state_in 取自自己的站位，不是 S1 末镜的 0.1
  assert.deepEqual(r2.states.b1.in.chars.c1.pos, [0.9, 0.9, 0]);
});

test('C-2 排序按 global_no，不按 shot_no', () => {
  // ch2 的镜 shot_no=1 但 global_no=7；ch1 的镜 shot_no=3 但 global_no=3
  const shots = [
    F.shot({ id: 'late', chapter_id: 'ch2', global_no: 7, shot_no: 1, blockings: [F.blk({ norm_x: 0.4, norm_y: 0.4 })] }),
    F.shot({ id: 'early', chapter_id: 'ch1', global_no: 3, shot_no: 3, blockings: [F.blk({ norm_x: 0.4, norm_y: 0.4 })] }),
  ];
  const r = solve(shots);
  assert.equal(r.states.early.derived_from, 'scene_baseline');
  assert.equal(r.states.late.derived_from, 'prev_shot:early');
});

test('C-3 改中间镜只影响其后继（CIS 起点）', () => {
  const shots = Array.from({ length: 5 }, (_, i) => F.shot({
    id: `s${i + 1}`, global_no: i + 1, shot_no: i + 1,
    blockings: [F.blk({ norm_x: 0.1 * (i + 1), norm_y: 0.5 })],
  }));
  // 求解本身是整场；"只写 global_no >= earliest" 由 planInvalidation 决定（另测）
  const r = solve(shots);
  assert.deepEqual(Object.keys(r.states), ['s1', 's2', 's3', 's4', 's5']);
  assert.equal(r.states.s5.derived_from, 'prev_shot:s4');
});

test('C-4 is_cut_point=1 不重置连续性', () => {
  const shots = [
    F.shot({ id: 'k1', global_no: 1, is_cut_point: 1, blockings: [F.blk({ norm_x: 0.3, norm_y: 0.3 })] }),
    F.shot({ id: 'k2', global_no: 2, is_cut_point: 1, blockings: [F.blk({ norm_x: 0.3, norm_y: 0.3 })] }),
  ];
  const r = solve(shots);
  // 若把 cut_point 当重置点，k2 会 derived_from=scene_baseline
  assert.equal(r.states.k2.derived_from, 'prev_shot:k1');
  assert.deepEqual(r.states.k2.in.chars.c1.pos, r.states.k1.out.chars.c1.pos);
});

test('C-5 time_jump=1：不报 TELEPORT，只报 TIME_JUMP_SKIPPED(info)，状态照常更新', () => {
  const shots = [
    F.shot({ id: 'j1', global_no: 1, blockings: [F.blk({ norm_x: 0.1, norm_y: 0.1 })] }),
    F.shot({ id: 'j2', global_no: 2, time_jump: 1, blockings: [F.blk({ norm_x: 0.9, norm_y: 0.9 })] }),
  ];
  const r = solve(shots);
  assert.deepEqual(r.states.j2.conflicts, []);
  assert.ok(r.states.j2.diagnostics.some((c) => c.code === 'TIME_JUMP_SKIPPED'));
  assert.deepEqual(r.states.j2.out.chars.c1.pos, [0.9, 0.9, 0]);
});

test('C-6 无场次基线：首镜 state_in 全 unknown + STATE_UNKNOWN，不伪造坐标', () => {
  const shots = [F.shot({ id: 'n1', global_no: 1, spec_source: 'ai', blockings: [{ character_id: 'c1', in_frame: 1 }] })];
  const r = solveContinuity({ projectId: 'p1', sceneKey: 'S1_病房', shots, sceneState: null });
  assert.equal(r.states.n1.out.chars.c1.pos, null);
  assert.equal(r.states.n1.meta['chars.c1.pos'].rel, 'unknown');
  assert.ok(r.states.n1.diagnostics.some((c) => c.code === 'STATE_UNKNOWN'));
});

test('C-7 同输入两次：hash 相同、内容逐字相同', () => {
  const a = solve(F.fourShots());
  const b = solve(F.fourShots());
  assert.equal(a.hash, b.hash);
  assert.deepEqual(a.states, b.states);
  assert.match(a.hash, /^sha256:[0-9a-f]{64}$/);
});

// ── 冲突码逐个命中（不得把连续性问题简化成一个通用冲突）─────────────────
test('POSITION_JUMP：两侧 known 且超过阈值、无位移动作', () => {
  const shots = [
    F.shot({ id: 'p1', global_no: 1, blockings: [F.blk({ norm_x: 0.1, norm_y: 0.1 })] }),
    F.shot({ id: 'p2', global_no: 2, blockings: [F.blk({ norm_x: 0.1 + POS_JUMP_MIN + 0.05, norm_y: 0.1 })] }),
  ];
  const r = solve(shots);
  assert.equal(r.states.p2.conflicts[0].code, 'POSITION_JUMP');
  assert.equal(r.states.p2.conflicts[0].level, 'fail');
});

test('TELEPORT：位移超过 TELEPORT_MIN', () => {
  const shots = [
    F.shot({ id: 't1', global_no: 1, blockings: [F.blk({ norm_x: 0, norm_y: 0 })] }),
    F.shot({ id: 't2', global_no: 2, blockings: [F.blk({ norm_x: Math.min(TELEPORT_MIN, 0.9), norm_y: 0 })] }),
  ];
  const r = solve(shots);
  assert.equal(r.states.t2.conflicts[0].code, 'TELEPORT');
});

test('POSTURE_JUMP / HAND_JUMP / FACING_FLIP 三码各自可触发', () => {
  const base = [F.shot({ id: 'x1', global_no: 1, blockings: [F.blk({ posture: 'standing', hand_state: '自然下垂', facing: 'W' })] })];
  const mk = (id, over) => [...base, F.shot({ id, global_no: 2, blockings: [F.blk(over)] })];

  assert.equal(solve(mk('x2', { posture: 'sitting' })).states.x2.conflicts[0].code, 'POSTURE_JUMP');
  assert.equal(solve(mk('x3', { hand_state: '举枪' })).states.x3.conflicts[0].code, 'HAND_JUMP');
  // facing 是枚举、没有角度 → 只 WARN，不 FAIL
  const f = solve(mk('x4', { facing: 'E' }));
  assert.equal(f.states.x4.conflicts.length, 0);
  assert.ok(f.states.x4.diagnostics.some((c) => c.code === 'FACING_FLIP' && c.level === 'warn'));
});

test('CHAR_POP：前镜在画、本镜没有该人', () => {
  const shots = [
    F.shot({ id: 'c1s', global_no: 1, blockings: [F.blk({ character_id: 'c1' })] }),
    F.shot({ id: 'c2s', global_no: 2, blockings: [F.blk({ character_id: 'c2', norm_x: 0.8 })] }),
  ];
  const r = solve(shots);
  assert.ok(r.states.c2s.conflicts.some((c) => c.code === 'CHAR_POP' && c.character_id === 'c1'));
});

test('PROP_APPEAR / PROP_REVIVE：道具凭空出现与复活', () => {
  const appear = solve([
    F.shot({ id: 'q1', global_no: 1 }),
    F.shot({ id: 'q2', global_no: 2, actions: [F.act({ id: 'a1', contact_json: { target_type: 'prop', target_id: 'p2' } })] }),
  ]);
  assert.ok(appear.states.q2.conflicts.some((c) => c.code === 'PROP_APPEAR' && c.prop_id === 'p2'));

  const revive = solve([
    F.shot({ id: 'r1', global_no: 1, actions: [F.act({ id: 'a1', result_json: { prop_delta: [{ prop_id: 'p1', to: { state: 'broken' } }] } })] }),
    F.shot({ id: 'r2', global_no: 2, actions: [F.act({ id: 'a2', contact_json: { target_type: 'prop', target_id: 'p1' } })] }),
  ]);
  assert.ok(revive.states.r2.conflicts.some((c) => c.code === 'PROP_REVIVE'));
});

test('TRACK_ENDS_MISMATCH：轨迹终点与 state_out 不一致（WARN，不是 FAIL）', () => {
  const shots = [F.shot({
    id: 'k1', global_no: 1,
    blockings: [F.blk({ norm_x: 0.3, norm_y: 0.3, position_track: [{ t: 0, x: 0.3, y: 0.3, z: 0 }, { t: 1, x: 0.8, y: 0.8, z: 0 }] })],
  })];
  const r = solve(shots);
  const d = r.states.k1.diagnostics.find((c) => c.code === 'TRACK_ENDS_MISMATCH');
  assert.ok(d);
  assert.equal(d.level, 'warn');
});

test('INCONSISTENT_INFERRED：推断值与已知继承值不符 → WARN，不改值', () => {
  const shots = [
    F.shot({ id: 'i1', global_no: 1, spec_source: 'manual', blockings: [F.blk({ posture: 'standing' })] }),
    F.shot({ id: 'i2', global_no: 2, spec_source: 'ai', blockings: [F.blk({ posture: 'sitting' })] }),
  ];
  const r = solve(shots);
  assert.equal(r.states.i2.conflicts.length, 0);
  assert.ok(r.states.i2.diagnostics.some((c) => c.code === 'INCONSISTENT_INFERRED'));
  assert.equal(r.states.i2.out.chars.c1.posture, 'standing');
});

// ── 边界与纯度 ─────────────────────────────────────────────────────────
test('BREAK_CODES 只含 P5 断链路由认识的七个码', () => {
  assert.deepEqual([...BREAK_CODES].sort(), ['CHAR_POP', 'HAND_JUMP', 'POSITION_JUMP', 'POSTURE_JUMP', 'PROP_APPEAR', 'PROP_REVIVE', 'TELEPORT']);
});

test('W3-E 求解不修改入参（整行 JSON 前后一致）', () => {
  const shots = F.fourShots();
  const before = JSON.stringify(shots);
  const sceneState = F.scene();
  const sceneBefore = JSON.stringify(sceneState);
  solveContinuity({ projectId: 'p1', sceneKey: 'S1_病房', shots, sceneState });
  assert.equal(JSON.stringify(shots), before);
  assert.equal(JSON.stringify(sceneState), sceneBefore);
});

test('异常不得静默：非数组 / 缺 sceneKey / 缺 id 一律抛 CONTINUITY_SOLVER_FAILED', () => {
  for (const bad of [
    { sceneKey: 'S1', shots: undefined },
    { sceneKey: '', shots: [] },
    { sceneKey: 'S1', shots: [{ global_no: 1 }] },
  ]) {
    assert.throws(() => solveContinuity({ projectId: 'p1', ...bad }), (e) => e.code === 'CONTINUITY_SOLVER_FAILED');
  }
});

test('states 是对象不是 Map，sceneConflicts 是数组，hash 带 sha256: 前缀', () => {
  const r = solve(F.fourShots());
  assert.equal(r.states instanceof Map, false);
  assert.equal(Object.prototype.toString.call(r.states), '[object Object]');
  assert.ok(Array.isArray(r.sceneConflicts));
  assert.match(r.hash, /^sha256:/);
});
