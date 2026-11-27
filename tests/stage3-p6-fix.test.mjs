// P6 定向复审修复 · 专项测试（P6-R1 ~ P6-R4 + U-P6-4）
//
// 四组问题的共同点：**都不报错，只在某个更晚的时刻以"结论对不上"的形式出现**。
//   R1：求解结果变了、输入 Hash 没变 → 读侧拿旧状态当当前结论；
//   R2：规则只读一个字段，却被判"必须重跑" → 局部重跑退化成全量；
//   R3：缺引用关系 → 返回"无需重算"，而真相是"不知道要重算什么"；
//   R4：把 `story_shots` 行当状态行 → `state_in` 恒 null，A-06 永远"可继承"。
// 所以每组的判据都写成"**两种输入必须得到不同 Hash / 不同集合**"，而不是"没抛错"。
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import { solveContinuity } from '../lib/core/continuity/solve-continuity.js';
import {
  solverInputHash, normalizeShotMeta, SOLVE_META_FIELDS,
} from '../lib/core/continuity/solve-hash.js';
import {
  planInvalidation, checkInvalidationRelations, auditColumnClassification,
} from '../lib/core/continuity/invalidate.js';
import {
  buildQcDependencyContext, qcRuleDependencyHash, qcDependencyHash,
  LAST_SHOT, MISSING_ASSET,
} from '../lib/core/qc/deps/index.js';
import { RULE_DEPS, RULE_IDS } from '../lib/core/qc/deps/rule-deps.js';
import { stage1DdlInOrder } from '../lib/core/schema/tables.js';
import { validateRule } from '../lib/core/validate/index.js';
import * as F from './helpers/continuity-fixture.mjs';
import * as Q from './helpers/qc-fixture.mjs';

// ══ P6-R1 求解输入 Hash 必须覆盖实际求解输入 ══════════════════════════════

const r1Shots = (meta) => [
  F.shot({ id: 'a', global_no: 1, blockings: [F.blk()], meta }),
  F.shot({ id: 'b', global_no: 2, blockings: [F.blk()] }),
];
const r1Hash = (meta) => solverInputHash({ projectId: 'p1', sceneKey: 'S1_病房', shots: r1Shots(meta), sceneState: F.scene() });
const r1Solve = (meta) => solveContinuity({ projectId: 'p1', sceneKey: 'S1_病房', shots: r1Shots(meta), sceneState: F.scene() });

test('R1-1 相同输入 Hash 稳定（两次、以及对象重建后）', () => {
  const a = r1Hash({ 'chars.c1.pos': { rel: 'unknown' } });
  const b = r1Hash({ 'chars.c1.pos': { rel: 'unknown' } });
  assert.equal(a, b);
  assert.match(a, /^sha256:[0-9a-f]{64}$/);
});

test('R1-2 只改 shot.meta 的可靠性标记 → Hash 变（rel / src / conf 三项各自生效）', () => {
  const base = r1Hash(undefined);
  assert.notEqual(base, r1Hash({ 'chars.c1.pos': { rel: 'unknown' } }), 'rel 未进 Hash');
  assert.notEqual(base, r1Hash({ 'chars.c1.pos': { src: 'carried:sh_99' } }), 'src 未进 Hash');
  assert.notEqual(base, r1Hash({ 'chars.c1.pos': { conf: 0.3 } }), 'conf 未进 Hash');
});

test('R1-3 显式 unknown 改变求解结果时，两份 Hash 必须不同（本条是缺口的正面判据）', () => {
  const r1 = r1Solve(undefined);
  const r2 = r1Solve({ 'chars.c1.pos': { rel: 'unknown' } });
  // 结果确实不同：没有 meta 时 pos 采信→known；显式 unknown 时降级
  assert.notEqual(r1.states.a.meta['chars.c1.pos'].rel, r2.states.a.meta['chars.c1.pos'].rel);
  // Hash 必须也能区分（否则"结果变了、Hash 没变"）
  assert.notEqual(r1.hash, r2.hash);
  assert.equal(r1.hash, solverInputHash({ projectId: 'p1', sceneKey: 'S1_病房', shots: r1Shots(undefined), sceneState: F.scene() }));
});

test('R1-4 `__solver` 自身变化不得改变输入 Hash（避免 Hash 自引用）', () => {
  const base = r1Hash(undefined);
  for (const solver of [
    { hash: 'sha256:deadbeef', solver_version: 'stage3.1' },
    { hash: 'sha256:0000', solver_version: 'stage9' },
  ]) {
    assert.equal(r1Hash({ __solver: solver }), base);
  }
});

test('R1-5 只有 `ver` / 全空条目不进 Hash（那是假失效，不是输入）', () => {
  const base = r1Hash(undefined);
  assert.equal(r1Hash({ 'chars.c1.pos': { ver: 7 } }), base);
  assert.equal(r1Hash({ 'chars.c1.pos': {} }), base);
  assert.equal(r1Hash({ 'chars.c1.pos': { rel: null, src: null, conf: null } }), base);
});

test('R1-6 Hash 与求解器共用同一份归一化（不得各写一套）', () => {
  assert.deepEqual([...SOLVE_META_FIELDS], ['rel', 'src', 'conf']);
  const norm = normalizeShotMeta({
    'chars.c2.posture': { rel: 'known', ver: 3 },
    'chars.c1.pos': { rel: 'unknown', src: 'carried:sh_1', conf: 0.855 },
    __solver: { hash: 'x' },
  });
  // 键按 cmpStr 排序、只留三样、`__solver` 剔除
  assert.deepEqual(Object.keys(norm), ['chars.c1.pos', 'chars.c2.posture']);
  assert.deepEqual(norm['chars.c1.pos'], { rel: 'unknown', src: 'carried:sh_1', conf: 0.855 });
  assert.deepEqual(norm['chars.c2.posture'], { rel: 'known', src: null, conf: null });
  // 合法空值 → 空（"没有标注"是正常状态，不是缺陷）
  for (const empty of [null, undefined, '', '   ', '{}']) assert.deepEqual(normalizeShotMeta(empty), {});
  // 非法值必须抛（P6 最终验收补强）：静默降级成 `{}` 会把"数据坏了"伪装成"没有标注"，
  // 而这两种情况在 Hash 上长得一模一样 —— 正是 R1 要堵的那类缺口。
  for (const bad of ['x', 0, [], '[]', '[1]']) {
    assert.throws(() => normalizeShotMeta(bad),
      (e) => e.code === 'SOLVE_META_INVALID_JSON' || e.code === 'SOLVE_META_NOT_OBJECT', JSON.stringify(bad));
  }
});

test('R1-7 元数据顺序不影响 Hash（不依赖对象键序）', () => {
  const a = r1Hash({ 'chars.c1.pos': { rel: 'unknown' }, 'chars.c2.posture': { rel: 'known' } });
  const b = r1Hash({ 'chars.c2.posture': { rel: 'known' }, 'chars.c1.pos': { rel: 'unknown' } });
  assert.equal(a, b);
});

test('R1-8 求解器仍按同一份归一化读 meta：继承来的 conf 不被空字段抹掉', () => {
  const shots = [
    F.shot({ id: 'a', global_no: 1, blockings: [F.blk()] }),
    // 只标 pos 的 rel，不得把继承来的 posture conf 抹成 0
    F.shot({ id: 'b', global_no: 2, blockings: [F.blk({ posture: null })], meta: { 'chars.c1.pos': { rel: 'unknown' } } }),
  ];
  const r = solveContinuity({ projectId: 'p1', sceneKey: 'S1_病房', shots, sceneState: F.scene() });
  const post = r.states.b.meta['chars.c1.posture'];
  assert.equal(post.rel, 'known');
  assert.equal(post.conf, 0.855, '`posture` 的继承置信度被空字段抹掉了');
  assert.equal(post.src, 'carried:a');
});

// ══ P6-R2 sceneState 字段级投影 ══════════════════════════════════════════

const depsCtx = (over = {}) => buildQcDependencyContext({
  shot: { ...Q.baseShot, ...(over.shot ?? {}) },
  states: over.states ?? Q.st(),
  blockings: over.blockings ?? [Q.b()],
  actions: over.actions ?? [Q.a()],
  shotAssets: over.shotAssets ?? [{ asset_id: 'c1', role: 'character', order_no: 1 }, { asset_id: 'p1', role: 'prop', order_no: 1 }],
  assets: over.assets ?? [
    { id: 'c1', category: 'character', name: '哈罗德', parent_id: '' },
    { id: 'p1', category: 'prop', name: '文件', parent_id: '' },
  ],
  sceneState: over.sceneState === undefined ? Q.scene() : over.sceneState,
  chapterShots: over.chapterShots ?? Q.chapter(3),
  nextShot: over.nextShot === undefined ? { id: 'sh_02', state_in: { chars: { c1: { pos: [0.7, 0.5, 0] } } } } : over.nextShot,
});
const ruleHash = (id, ctx) => qcRuleDependencyHash(id, ctx);
const changedRules = (a, b) => RULE_IDS.filter((id) => ruleHash(id, a) !== ruleHash(id, b));

test('R2-1 `sceneState.axis_lock` 只投影 axis_lock：改 crowd_switch 不再波及 S-07', () => {
  const base = depsCtx();
  const other = depsCtx({ sceneState: Q.scene({ crowd_switch: 'A' }) });
  const hit = changedRules(base, other);
  assert.equal(hit.includes('S-07'), false, 'S-07 不读 crowd_switch，却被判必须重跑');
  assert.equal(hit.includes('S-05'), false);
  assert.equal(hit.includes('S-06'), false);
  // 真正读 crowd_switch 的规则必须变
  assert.ok(hit.includes('S-16'));
});

test('R2-2 `coord_system` / `power_geometry` / `axis_lock` 各自独立生效', () => {
  const base = depsCtx();
  const coord = changedRules(base, depsCtx({ sceneState: Q.scene({ coord_system: { basis: {}, active_area: [8, 5, 3] } }) }));
  // S-05 与 S-07 都真的读 `coord_system`（前者换算侧别、后者解析 cam_target 的归一化位置）
  assert.ok(coord.includes('S-05'), 'S-05 读 coord_system，必须变');
  assert.ok(coord.includes('S-07'), 'S-07 读 coord_system（active_area），必须变');
  assert.equal(coord.includes('S-17'), false, 'S-17 只读 power_geometry，不该受 coord_system 影响');

  const power = changedRules(base, depsCtx({ sceneState: Q.scene({ power_geometry: { start: { holder: 'c1' }, end: { holder: 'c1' } } }) }));
  assert.ok(power.includes('S-17'));
  assert.equal(power.includes('S-16'), false);
  assert.equal(power.includes('S-07'), false, 'S-07 不读 power_geometry，不该变');

  const axis = changedRules(base, depsCtx({ sceneState: Q.scene({ axis_lock: { ...Q.scene().axis_lock, left: 'c2', right: 'c1' } }) }));
  assert.ok(axis.includes('S-07') && axis.includes('S-05') && axis.includes('S-06'));
  assert.equal(axis.includes('S-17'), false);
});

test('R2-3 无关场次字段（time_of_day / entries）只影响"显式声明整个 sceneState"的 S-01', () => {
  const base = depsCtx();
  const hit = changedRules(base, depsCtx({ sceneState: Q.scene({ time_of_day: '日', entries: { main: '侧门' } }) }));
  assert.deepEqual(hit, ['S-01'], `预期只有 S-01（整块声明），实际：${hit.join(',')}`);
  assert.deepEqual(RULE_DEPS['S-01'].fields.filter((f) => f.startsWith('sceneState')), ['sceneState']);
});

test('R2-4 其他根路径既有语义不变：`shot.<列>` 仍只投影该列', () => {
  const base = depsCtx();
  const hit = changedRules(base, depsCtx({ shot: { dialogue: '你来了。我们走吧。' } }));
  // 只有真读 dialogue 的规则变（V-04/V-09/V-13/V-23），与 `shot_size` 无关的规则不得牵连
  assert.ok(hit.includes('V-09') || hit.includes('V-13'));
  assert.equal(hit.includes('V-11'), false);
  assert.equal(hit.includes('S-22'), false);
  // 报告级整体仍然变（任一规则变 → 摘要变）
  assert.notEqual(qcDependencyHash(base), qcDependencyHash(depsCtx({ shot: { dialogue: '你来了。我们走吧。' } })));
});

test('R2-5 投影取值精确：`sceneState.axis_lock` 取到的是对象本身而不是整行', () => {
  // 用"只有 axis_lock 一条声明"的规则视角验证：同 axis_lock、不同 fixtures → 该规则 Hash 不变
  const a = depsCtx({ sceneState: Q.scene() });
  const b = depsCtx({ sceneState: Q.scene({ fixtures: [] }) });
  assert.equal(ruleHash('S-07', a), ruleHash('S-07', b));
  // 而 S-02（读 fixtures）必须变
  assert.notEqual(ruleHash('S-02', a), ruleHash('S-02', b));
});

// ══ P6-R3 资产失效上下文必须 fail-closed ═════════════════════════════════

const R3_SHOTS = [
  { id: 'sh_01', scene_key: 'S1', chapter_id: 'ch1', global_no: 1, shot_no: 1 },
  { id: 'sh_02', scene_key: 'S1', chapter_id: 'ch1', global_no: 2, shot_no: 2 },
  { id: 'sh_03', scene_key: 'S2', chapter_id: 'ch1', global_no: 3, shot_no: 3 },
];
const R3_REFS = [{ shot_id: 'sh_01', asset_id: 'p1', role: 'prop' }];
const planAssets = (change, shotAssets) => planInvalidation({ change, shots: R3_SHOTS, shotAssets });

test('R3-1 change.assets 非空但缺 shotAssets → 抛 INVALIDATION_ASSETS_CONTEXT_MISSING（不得返回空集合）', () => {
  for (const shotAssets of [undefined, null, 'x', {}]) {
    assert.throws(
      () => planAssets({ assets: [{ asset_id: 'p1', fields: ['category'] }] }, shotAssets),
      (e) => e.code === 'INVALIDATION_ASSETS_CONTEXT_MISSING',
      `shotAssets=${String(shotAssets)} 未拒绝`,
    );
  }
});

test('R3-2 引用镜不在快照里 → 抛 INVALIDATION_ASSET_REF_UNKNOWN 并列出 id', () => {
  assert.throws(
    () => planAssets({ assets: [{ asset_id: 'p1', fields: ['category'] }] }, [{ shot_id: 'sh_zz', asset_id: 'p1', role: 'prop' }]),
    (e) => e.code === 'INVALIDATION_ASSET_REF_UNKNOWN' && e.shot_ids.includes('sh_zz'),
  );
});

test('R3-3 正向：有上下文时引用镜与其后继都进 CIS，且可追溯到资产字段', () => {
  const p = planAssets({ assets: [{ asset_id: 'p1', fields: ['category'] }] }, R3_REFS);
  assert.deepEqual(p.continuityInvalidationSet.S1.shotIds, ['sh_01', 'sh_02'], '引用镜的后继漏了');
  assert.ok(p.reasons.some((r) => r.set === 'continuity' && r.field === 'category'));
  // S2 没有引用 p1 → 不得牵连
  assert.equal('S2' in p.continuityInvalidationSet, false);
  assert.deepEqual(checkInvalidationRelations(p, R3_SHOTS.map((s) => s.id)).violations, []);
});

test('R3-4 无引用的资产（脏数据/无关资产）→ 两集合为空，且**不是**抛错', () => {
  const p = planAssets({ assets: [{ asset_id: 'ct9', fields: ['category'] }] }, R3_REFS);
  assert.equal(p.bothEmpty, true);
  assert.deepEqual(p.reasons, []);
});

test('R3-5 资产无关列（description）仍不触发任何失效（AR-5 未被 fail-closed 误伤）', () => {
  const p = planAssets({ assets: [{ asset_id: 'p1', fields: ['description'] }] }, R3_REFS);
  assert.equal(p.bothEmpty, true);
});

test('R3-6 不传 change.assets 时不得因缺 shotAssets 而抛（fail-closed 只针对资产变更）', () => {
  const p = planInvalidation({ change: { shots: [{ shot_id: 'sh_01', fields: ['shot_size'] }] }, shots: R3_SHOTS });
  assert.equal(p.bothEmpty, false);
  assert.ok(Object.keys(p.qcInvalidationSet).length > 0);
});

// ══ P6-R4 A-06 邻镜状态 Hash 上下文 ══════════════════════════════════════

test('R4-1 下镜 state_in 变化 → A-06 规则级 Hash 必须变', () => {
  const a = depsCtx({ nextShot: { id: 'sh_02', state_in: { chars: { c1: { pos: [0.7, 0.5, 0] } } } } });
  const b = depsCtx({ nextShot: { id: 'sh_02', state_in: { chars: { c1: { pos: [0.2, 0.2, 0] } } } } });
  assert.notEqual(ruleHash('A-06', a), ruleHash('A-06', b));
  // 下镜 id 变化不算依赖（映射只声明 state_in）→ 不应因此失效
  const c = depsCtx({ nextShot: { id: 'sh_99', state_in: { chars: { c1: { pos: [0.7, 0.5, 0] } } } } });
  assert.equal(ruleHash('A-06', a), ruleHash('A-06', c));
});

test('R4-2 末镜哨兵 `__last__` 保留：末镜与非末镜必须算出不同 Hash', () => {
  assert.equal(LAST_SHOT, '__last__');
  const withNext = depsCtx({ nextShot: { state_in: { chars: { c1: { pos: [0.7, 0.5, 0] } } } } });
  const last = depsCtx({ nextShot: null });
  assert.notEqual(ruleHash('A-06', withNext), ruleHash('A-06', last));
  // 哨兵必须真的进了投影，而不是两边都投影成 null
  assert.equal(last.nextShot, null);
  assert.notEqual(ruleHash('A-06', last), ruleHash('A-06', depsCtx({ nextShot: { state_in: null } })));
});

test('R4-3 传 story_shots 行（创作行）→ 抛 QC_DEPS_NEXT_SHOT_NOT_STATE，不得静默放过', () => {
  const storyShot = { id: 'sh_02', global_no: 2, shot_size: 'medium', cam_pos: { x: 1, y: 1, z: 1 }, scene_key: 'S1' };
  assert.throws(
    () => depsCtx({ nextShot: storyShot }),
    (e) => e.code === 'QC_DEPS_NEXT_SHOT_NOT_STATE',
  );
  // 形状不对但不是对象 → 另一个码
  for (const bad of ['sh_02', 42, []]) {
    assert.throws(() => depsCtx({ nextShot: bad }), (e) => e.code === 'QC_DEPS_NEXT_SHOT_INVALID');
  }
});

test('R4-4 状态行的合法形状：**必须自带 state_in**（只给 state_out / conflicts 一律拒绝）', () => {
  // 合法：带 `state_in`（值可以是 null —— 状态未知，与"末镜无下镜"不是一回事）
  for (const ns of [{ state_in: {} }, { state_in: null }, { id: 'sh_02', state_in: {}, state_out: {}, conflicts: [] }]) {
    assert.match(ruleHash('A-06', depsCtx({ nextShot: ns })), /^sha256:[0-9a-f]{64}$/, JSON.stringify(ns));
  }
  // 非法：A-06 只读 `state_in`，其余列齐备也补不上"读不到东西"这个事实
  for (const ns of [{ state_out: {} }, { conflicts: [] }, { state_out: {}, conflicts: [] }]) {
    assert.throws(() => depsCtx({ nextShot: ns }),
      (e) => e.code === 'QC_DEPS_NEXT_SHOT_NOT_STATE', JSON.stringify(ns));
  }
});

test('R4-5 A-06 的 Hash 不含下镜的创作列（改了不该失效）', () => {
  const a = depsCtx({ nextShot: { id: 'sh_02', state_in: { chars: { c1: { pos: [0.7, 0.5, 0] } } } } });
  const b = depsCtx({ nextShot: { id: 'sh_02', shot_size: 'close_up', cam_pos: { x: 9, y: 9, z: 9 }, state_in: { chars: { c1: { pos: [0.7, 0.5, 0] } } } } });
  assert.equal(ruleHash('A-06', a), ruleHash('A-06', b));
});

// ══ U-P6-2 `reportLevelRules` 接口契约（P9 必须消费）══════════════════════

test('U-P6-2a 双空时 `reportLevelRules` 必须为空（P9 不得跑任何规则）', () => {
  const p = planInvalidation({ change: { shots: [{ shot_id: 'sh_01', fields: ['narration'] }] }, shots: R3_SHOTS });
  assert.equal(p.bothEmpty, true);
  assert.deepEqual(p.reportLevelRules, []);
});

test('U-P6-2b QIS 非空时恰好给出三条审计规则（升序），且**不进** QIS', () => {
  const p = planInvalidation({ change: { shots: [{ shot_id: 'sh_01', fields: ['movement_amp'] }] }, shots: R3_SHOTS });
  assert.deepEqual(p.reportLevelRules, ['S-20', 'S-21', 'S-25']);
  // 按镜集合里不得出现它们（否则 P9 会按镜跑 N 次）
  for (const v of Object.values(p.qcInvalidationSet)) {
    assert.equal(v.rules.some((r) => ['S-20', 'S-21', 'S-25'].includes(r)), false);
  }
  // 有一条 `scope:'report'` 的 reason 可追溯
  assert.ok(p.reasons.some((r) => r.scope === 'report' && r.field === '__audit'));
});

test('U-P6-2c 审计规则的作用域标记为 `audit`（P9 靠它决定"整份跑一次"）', () => {
  for (const id of ['S-20', 'S-21', 'S-25']) {
    assert.equal(RULE_DEPS[id].scope, 'audit');
    assert.deepEqual(RULE_DEPS[id].fields, ['__audit']);
  }
});

// ══ U-P6-4 S-15 历史遗留读取 ═════════════════════════════════════════════

test('R4-6 两个键名指向同一行：规则读的 `nextShotState` 与 Hash 投影的 `nextShot` 同源', () => {
  const ctx = depsCtx({ nextShot: { id: 'sh_02', state_in: { chars: { c1: { pos: [0.7, 0.5, 0] } } } } });
  assert.equal(ctx.nextShot, ctx.nextShotState, '两个键不是同一对象 → 规则与 Hash 会各看一份');
  // 只填其中一个键也必须可用（否则调用方只传一个，另一侧恒 null）
  const onlyState = buildQcDependencyContext({
    shot: { ...Q.baseShot }, states: Q.st(), blockings: [Q.b()], actions: [Q.a()],
    shotAssets: [], assets: [], sceneState: Q.scene(), chapterShots: Q.chapter(2),
    nextShotState: { state_in: { chars: { c1: { pos: [0.1, 0.1, 0] } } } },
  });
  const onlyNext = buildQcDependencyContext({
    shot: { ...Q.baseShot }, states: Q.st(), blockings: [Q.b()], actions: [Q.a()],
    shotAssets: [], assets: [], sceneState: Q.scene(), chapterShots: Q.chapter(2),
    nextShot: { state_in: { chars: { c1: { pos: [0.1, 0.1, 0] } } } },
  });
  assert.equal(qcRuleDependencyHash('A-06', onlyState), qcRuleDependencyHash('A-06', onlyNext));
});

test('U-P6-4a 事实核对：story_shots 48 列里没有 distance_to_camera（在 shot_blockings 里）', () => {
  const db = new DatabaseSync(':memory:');
  for (const ddl of stage1DdlInOrder()) db.exec(ddl);
  const shotCols = db.prepare('PRAGMA table_info(story_shots)').all().map((c) => c.name);
  const blkCols = db.prepare('PRAGMA table_info(shot_blockings)').all().map((c) => c.name);
  db.close();
  assert.equal(shotCols.length, 48);
  assert.equal(shotCols.includes('distance_to_camera'), false);
  assert.equal(blkCols.includes('distance_to_camera'), true);
});

test('U-P6-4b S-15 的距离只来自站位行；创作行上的同名键不再被读', () => {
  // 两名画内人物、跨度 0.6m；24mm 在 2.49m 处可容纳约 3.7m → 装得下
  const pair = (dist) => [
    Q.b({ norm_x: 0.7, distance_to_camera: dist }),
    Q.b({ character_id: 'c2', norm_x: 0.8, distance_to_camera: dist }),
  ];
  const base = {
    shot: { ...Q.baseShot, lens_mm: 24, distance_to_camera: 0.1 },
    blockings: pair(2.49),
    sceneState: Q.scene(),
  };
  // 创作行上的 `distance_to_camera: 0.1` 若仍被采信，会换算成 0.15m 可容纳宽度 → 判"装不下"
  const withLegacy = validateRule('S-15', base);
  assert.notEqual(withLegacy.code, 'FRAMING_TOO_TIGHT', '仍在读 shot.distance_to_camera');
  // 站位行距离变小 → 真的装不下 → WARN（依赖仍有效）
  const near = validateRule('S-15', { ...base, blockings: pair(0.3) });
  assert.equal(near.code, 'FRAMING_TOO_TIGHT');
});

test('U-P6-4c 映射同步：S-15 不再声明 shot.distance_to_camera，blockings 依赖保留', () => {
  const f = RULE_DEPS['S-15'].fields;
  assert.equal(f.includes('shot.distance_to_camera'), false);
  assert.equal(f.includes('blockings[*].distance_to_camera'), true);
  assert.equal(f.includes('shot.lens_mm'), true);
  // 规则级 Hash 对站位距离敏感、对"创作行上那个不存在的键"不敏感
  const a = depsCtx({ blockings: [Q.b({ distance_to_camera: 2.49 })] });
  const b = depsCtx({ blockings: [Q.b({ distance_to_camera: 0.3 })] });
  assert.notEqual(ruleHash('S-15', a), ruleHash('S-15', b));
  const c = depsCtx({ shot: { ...Q.baseShot, distance_to_camera: 0.1 } });
  assert.equal(ruleHash('S-15', a), ruleHash('S-15', c));
});

test('U-P6-4d 列分类不受影响：48 列算术仍成立', () => {
  const audit = auditColumnClassification({});
  assert.deepEqual(audit.counts.story_shots.groups, { cis_qc: 6, qc: 22, none: 20 });
  assert.equal(audit.ok, true);
  // `assets` 的 `description` 仍不进 Hash（MISSING_ASSET 哨兵值同时确认可用）
  assert.equal(typeof MISSING_ASSET, 'string');
});
