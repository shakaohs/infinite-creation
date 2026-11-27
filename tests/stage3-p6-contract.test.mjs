// P6 最终验收前补强 · 接口契约专项（R4 收紧 + R1 数据类型）
//
// 本轮只做两件事，但两件都是"**不报错、结论却对不上**"的类型：
//   R4：`normalizeNextShot` 原先「有 state_out 或 conflicts 也算状态行」，而 A-06 只读
//       `state_in` —— 只带 state_out 的行照样通过校验，投影出来仍是 null，契约等于没生效。
//   R1：`shot.meta` 在库里是 TEXT（`DEFAULT '{}'`），`SELECT *` 读回来是**字符串**；
//       `normalizeShotMeta` 早期对字符串返回 `{}` —— Hash 与求解器双双丢数据且彼此一致，
//       这种一致是假象。本轮在边界统一解析，解析失败**抛**而不降级。
//
// 判据写法与 D02-14 一致：成对断言（该变的必须变、不该变的必须不变），不用"没抛错"。
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import { solveContinuity } from '../lib/core/continuity/solve-continuity.js';
import {
  solverInputHash, normalizeShotMeta, parseShotMeta, SOLVE_META_FIELDS,
} from '../lib/core/continuity/solve-hash.js';
import {
  buildQcDependencyContext, qcRuleDependencyHash, qcDependencyHash, LAST_SHOT,
} from '../lib/core/qc/deps/index.js';
import { RULE_IDS } from '../lib/core/qc/deps/rule-deps.js';
import { stage1DdlInOrder } from '../lib/core/schema/tables.js';
import * as F from './helpers/continuity-fixture.mjs';
import * as Q from './helpers/qc-fixture.mjs';

// ══ R4 nextShotState 契约收紧 ════════════════════════════════════════════

const depsCtx = (over = {}) => buildQcDependencyContext({
  shot: { ...Q.baseShot, ...(over.shot ?? {}) },
  states: over.states ?? Q.st(),
  blockings: over.blockings ?? [Q.b()],
  actions: over.actions ?? [Q.a()],
  shotAssets: over.shotAssets ?? [{ asset_id: 'c1', role: 'character', order_no: 1 }],
  assets: over.assets ?? [{ id: 'c1', category: 'character', name: '哈罗德', parent_id: '' }],
  sceneState: over.sceneState === undefined ? Q.scene() : over.sceneState,
  chapterShots: over.chapterShots ?? Q.chapter(3),
  nextShot: over.nextShot === undefined
    ? { id: 'sh_02', state_in: { chars: { c1: { pos: [0.7, 0.5, 0] } } } }
    : over.nextShot,
});
const ruleHash = (id, ctx) => qcRuleDependencyHash(id, ctx);

test('R4-a `{state_in: null}` 合法通过（状态未知 ≠ 字段缺失）', () => {
  const ctx = depsCtx({ nextShot: { state_in: null } });
  assert.equal(ctx.nextShot.state_in, null);
  // 与末镜哨兵必须可区分：末镜=无下镜，state_in=null 是"有下镜但状态未知"
  assert.notEqual(ruleHash('A-06', ctx), ruleHash('A-06', depsCtx({ nextShot: null })));
  assert.equal(LAST_SHOT, '__last__');
});

test('R4-b `{state_in: {...}}` 合法通过，且内容进 A-06 的 Hash', () => {
  const a = depsCtx({ nextShot: { state_in: { chars: { c1: { pos: [0.7, 0.5, 0] } } } } });
  const b = depsCtx({ nextShot: { state_in: { chars: { c1: { pos: [0.2, 0.2, 0] } } } } });
  assert.notEqual(ruleHash('A-06', a), ruleHash('A-06', b));
});

test('R4-c 只给 `{state_out}` → 拒绝（A-06 读不到任何东西，放行等于契约失效）', () => {
  assert.throws(() => depsCtx({ nextShot: { state_out: { chars: { c1: { pos: [0.7, 0.5, 0] } } } } }),
    (e) => e.code === 'QC_DEPS_NEXT_SHOT_NOT_STATE');
});

test('R4-d 只给 `{conflicts: []}` → 拒绝', () => {
  assert.throws(() => depsCtx({ nextShot: { conflicts: [] } }),
    (e) => e.code === 'QC_DEPS_NEXT_SHOT_NOT_STATE');
});

test('R4-e 给 `{state_out, conflicts}` 但无 `state_in` → 仍拒绝', () => {
  assert.throws(() => depsCtx({ nextShot: { state_out: { chars: {} }, conflicts: [] } }),
    (e) => e.code === 'QC_DEPS_NEXT_SHOT_NOT_STATE');
});

test('R4-f `null` 作为末镜通过（哨兵语义不变）', () => {
  const last = depsCtx({ nextShot: null });
  assert.equal(last.nextShot, null);
  assert.equal(last.nextShotState, null);
  assert.notEqual(ruleHash('A-06', last), ruleHash('A-06', depsCtx({})));
});

test('R4-g 非对象入参 → QC_DEPS_NEXT_SHOT_INVALID（与"形状不对"分开报）', () => {
  for (const bad of ['sh_02', 42, [], true]) {
    assert.throws(() => depsCtx({ nextShot: bad }),
      (e) => e.code === 'QC_DEPS_NEXT_SHOT_INVALID', `入参 ${JSON.stringify(bad)} 应被拒`);
  }
});

test('R4-h `nextShot` 与 `nextShotState` 同源：两键指向同一对象', () => {
  const ctx = depsCtx({ nextShot: { state_in: { chars: { c1: { pos: [0.3, 0.3, 0] } } } } });
  assert.equal(ctx.nextShot, ctx.nextShotState);
  // 只填 nextShotState（不填 nextShot）时也必须落到同一处
  const onlyState = buildQcDependencyContext({
    shot: { ...Q.baseShot }, states: Q.st(), blockings: [Q.b()], actions: [Q.a()],
    shotAssets: [{ asset_id: 'c1', role: 'character', order_no: 1 }],
    assets: [{ id: 'c1', category: 'character', name: '哈罗德', parent_id: '' }],
    sceneState: Q.scene(), chapterShots: Q.chapter(3),
    nextShotState: { state_in: { chars: { c1: { pos: [0.3, 0.3, 0] } } } },
  });
  assert.equal(onlyState.nextShot, onlyState.nextShotState);
  assert.notEqual(ruleHash('A-06', onlyState), ruleHash('A-06', depsCtx({})));
});

test('R4-i 只带 id 的创作行（历史写法）不再能通过校验', () => {
  assert.throws(() => depsCtx({ nextShot: { id: 'sh_02' } }),
    (e) => e.code === 'QC_DEPS_NEXT_SHOT_NOT_STATE');
});

// ══ R1 shot.meta 的数据类型与入口一致性 ═══════════════════════════════════

const META = { 'chars.c1.pos': { rel: 'unknown', src: 'manual:sh_40', conf: 0.5 } };
const r1Shots = (meta) => [
  F.shot({ id: 'a', global_no: 1, blockings: [F.blk()], meta }),
  F.shot({ id: 'b', global_no: 2, blockings: [F.blk()] }),
];
const r1Hash = (meta) => solverInputHash({ projectId: 'p1', sceneKey: 'S1_病房', shots: r1Shots(meta), sceneState: F.scene() });
const r1Solve = (meta) => solveContinuity({ projectId: 'p1', sceneKey: 'S1_病房', shots: r1Shots(meta), sceneState: F.scene() });

test('R1-a 对象输入与 JSON 字符串输入：Hash 完全相同', () => {
  assert.equal(r1Hash(META), r1Hash(JSON.stringify(META)));
});

test('R1-b 对象输入与 JSON 字符串输入：求解结果完全相同（state_out + meta + Hash）', () => {
  const a = r1Solve(META);
  const b = r1Solve(JSON.stringify(META));
  assert.deepEqual(b.states, a.states);
  assert.equal(b.hash, a.hash);
});

test('R1-c 序列化输入确实生效：与"无 meta"必须不同（防"两边都空、看起来一致"）', () => {
  const none = r1Solve(undefined);
  assert.notEqual(r1Solve(JSON.stringify(META)).hash, none.hash);
  assert.notDeepEqual(r1Solve(JSON.stringify(META)).states, none.states);
});

test('R1-d 数据库原始行（meta 为 TEXT）与已解析行：Hash 与状态一致', () => {
  // 模拟 `SELECT * FROM story_shots` 的形态：meta 是字符串
  const dbRow = { ...F.shot({ id: 'a', global_no: 1, blockings: [F.blk()] }), meta: JSON.stringify(META) };
  const shots = [dbRow, F.shot({ id: 'b', global_no: 2, blockings: [F.blk()] })];
  const fromDb = solveContinuity({ projectId: 'p1', sceneKey: 'S1_病房', shots, sceneState: F.scene() });
  const parsed = r1Solve(META);
  assert.deepEqual(fromDb.states, parsed.states);
  assert.equal(fromDb.hash, parsed.hash);
});

test('R1-e 空的合法值：null / undefined / 空白串 / `{}` 四者等价于"没有标注"', () => {
  const base = r1Hash(undefined);
  for (const v of [null, '', '   ', '{}', 'null']) {
    assert.equal(r1Hash(v), base, `${JSON.stringify(v)} 应等价于无 meta`);
  }
});

test('R1-f 解析失败必须抛，不得降级成空对象（否则"数据坏了"伪装成"没有数据"）', () => {
  assert.throws(() => r1Hash('{not json'), (e) => e.code === 'SOLVE_META_INVALID_JSON');
  assert.throws(() => r1Hash('[1,2]'), (e) => e.code === 'SOLVE_META_NOT_OBJECT');
  assert.throws(() => r1Hash('123'), (e) => e.code === 'SOLVE_META_NOT_OBJECT');
  assert.throws(() => normalizeShotMeta(42), (e) => e.code === 'SOLVE_META_NOT_OBJECT');
  assert.throws(() => normalizeShotMeta('"a"'), (e) => e.code === 'SOLVE_META_NOT_OBJECT');
});

test('R1-g 字符串输入下 `__solver` 仍被剔除、`ver` 仍不参与（既有口径不被边界解析改变）', () => {
  const withSolver = JSON.stringify({ ...META, __solver: { hash: 'sha256:deadbeef', solver_version: 'x' } });
  assert.equal(r1Hash(withSolver), r1Hash(META));
  const withVer = JSON.stringify({ 'chars.c1.pos': { ...META['chars.c1.pos'], ver: 9 } });
  assert.equal(r1Hash(withVer), r1Hash(META));
  assert.deepEqual(SOLVE_META_FIELDS, ['rel', 'src', 'conf']);
});

test('R1-h `parseShotMeta` 与 `normalizeShotMeta` 口径一致：解析后再归一 = 直接归一', () => {
  assert.deepEqual(normalizeShotMeta(JSON.stringify(META)), normalizeShotMeta(META));
  assert.deepEqual(parseShotMeta(JSON.stringify(META)), META);
  assert.deepEqual(parseShotMeta('{}'), {});
  assert.deepEqual(parseShotMeta(null), {});
});

test('R1-i QC 侧 `shot_states.meta`（同为 TEXT）与求解侧共用同一解析：字符串不丢键', () => {
  const withMeta = (meta) => buildQcDependencyContext({
    shot: { ...Q.baseShot }, states: Q.st({ meta }), blockings: [Q.b()], actions: [Q.a()],
    shotAssets: [{ asset_id: 'c1', role: 'character', order_no: 1 }],
    assets: [{ id: 'c1', category: 'character', name: '哈罗德', parent_id: '' }],
    sceneState: Q.scene(), chapterShots: Q.chapter(3),
    nextShot: { state_in: { chars: { c1: { pos: [0.7, 0.5, 0] } } } },
  });
  const objForm = withMeta({ 'chars.c1.pos': { rel: 'unknown' } });
  const strForm = withMeta(JSON.stringify({ 'chars.c1.pos': { rel: 'unknown' } }));
  // 报告级与规则级都必须一致：只改一侧就会与"V-22 读到内容"分叉
  assert.equal(qcDependencyHash(strForm), qcDependencyHash(objForm));
  for (const id of RULE_IDS) {
    assert.equal(ruleHash(id, strForm), ruleHash(id, objForm), `${id} 在字符串 meta 下应当等价`);
  }
  // 而且不能等于"没有 meta"——否则说明字符串被当成了空对象（这正是要拦的静默丢失）
  assert.notEqual(qcDependencyHash(strForm), qcDependencyHash(withMeta({})));
  assert.notEqual(qcDependencyHash(objForm), qcDependencyHash(withMeta({})));
});

test('R1-j 同一份 meta 经两种形态进入求解器，逐字段可靠性标注一致（不是"碰巧 Hash 相同"）', () => {
  const key = 'chars.c1.pos';
  const a = r1Solve(META);
  const b = r1Solve(JSON.stringify(META));
  assert.deepEqual(b.states.a.meta[key], a.states.a.meta[key]);
  assert.deepEqual(b.states.b.meta[key], a.states.b.meta[key]);

  // 显式 unknown 必须真的被认（不是被丢掉后"碰巧算得一样"）：
  // 无标注时该字段是 `known / blocking`，给了显式 unknown 后必须降级且沿链衰减。
  const plain = r1Solve(undefined);
  assert.equal(plain.states.a.meta[key].rel, 'known');
  assert.equal(a.states.a.meta[key].rel, 'unknown');
  assert.ok(a.states.a.meta[key].conf < plain.states.a.meta[key].conf, '显式 unknown 的置信度必须更低');
  // 继承链起点不得丢失：第二镜的 src 必须指回起点镜（D01-04 §5.7 / D02-14 R1-8 同口径）
  assert.equal(a.states.b.meta[key].src, 'carried:a');
});

// ── R1 的数据类型事实（机器断言，防止"以为库里有 meta 列"）─────────────────
//
// 实测：`story_shots` **48 列，没有 `meta` 列**；`meta` 只存在于 `shot_states`（TEXT，`DEFAULT '{}'`）。
// 所以求解器的 `shots[].meta` 不是 DB 列，而是**调用方附加的复合字段**（与 `blockings`/`actions`
// 同一种做法）。把这条事实写成断言有两个作用：
//   ① 任何人再提"数据库里的 meta"时必须先看到本断言；
//   ② 将来若真的给 `story_shots` 加 `meta` 列，本测试会失败 → 强制重新决策是否纳入求解输入。

test('R1-k 事实断言：`story_shots` 无 `meta` 列；`shot_states.meta` 为 TEXT 且默认 `{}`', () => {
  const db = new DatabaseSync(':memory:');
  for (const ddl of stage1DdlInOrder()) db.exec(ddl);
  const shotCols = db.prepare('PRAGMA table_info(story_shots)').all();
  assert.equal(shotCols.length, 48, 'story_shots 列数变化 → 本断言与 DDL 需同步复核');
  assert.equal(shotCols.some((c) => c.name === 'meta'), false, 'story_shots 不应有 meta 列（求解器的 shot.meta 是调用方附加字段）');

  const stateMeta = db.prepare('PRAGMA table_info(shot_states)').all().find((c) => c.name === 'meta');
  assert.ok(stateMeta, 'shot_states.meta 必须存在（D01-04 §5.2 要求落库）');
  assert.equal(stateMeta.type, 'TEXT');
  assert.equal(stateMeta.dflt_value, "'{}'");
  db.close();
});

test('R1-l 入口契约：求解器接受"DB 行 + 附加 blockings/actions/meta"的复合镜头对象', () => {
  // 生产侧目前 0 个调用方（P6 是纯函数层），P8/P9 接线时只能按这个形状传。
  const dbShaped = {
    ...F.shot({ id: 'a', global_no: 1, blockings: [F.blk()] }),
    // 模拟 `SELECT *` 后附加的子表行：blockings/actions 已是对象数组，meta 可能是字符串
    meta: JSON.stringify(META),
  };
  const r = solveContinuity({
    projectId: 'p1', sceneKey: 'S1_病房',
    shots: [dbShaped, F.shot({ id: 'b', global_no: 2, blockings: [F.blk()] })],
    sceneState: F.scene(),
  });
  assert.match(r.hash, /^sha256:[0-9a-f]{64}$/);
  assert.equal(r.states.a.meta['chars.c1.pos'].rel, 'unknown');
  // 同一份输入（对象形态）必须得到同一个 Hash —— 即"复合对象 + 串 meta" 与 "复合对象 + 对象 meta" 等价
  assert.equal(r.hash, r1Solve(META).hash);
});
