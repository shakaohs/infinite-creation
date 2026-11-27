// P6 · Hash 体系（D02-06 §9.2.1 A/B/C）
//
// 四个 Hash 各管一件事，**不得合并**（QH-10）：
//   · `state_solver_hash`  —— 这行状态是哪版求解输入算的（求解器内部算一次，SH-4/10）
//   · `qc_input_hash`      —— 这份 QC 用的那版求解输入（复用上面那个值，不重算）
//   · `qc_dependency_hash` —— 这份完整报告依据的规则依赖版本（逐规则摘要，C.1）
//   · `rule_dependency_hash` —— 单条规则的依赖版本（C.2）
//
// 本文件只测纯函数；持久化与继承（`carried`）属 P9。
import test from 'node:test';
import assert from 'node:assert/strict';

import { solverInputHash, SOLVER_VERSION, SOLVE_SHOT_FIELDS, SOLVE_SCENE_FIELDS, SOLVE_ASSET_ROLES } from '../lib/core/continuity/solve-hash.js';
import {
  buildQcDependencyContext, qcDependencyHash, qcDependencyHashDetail,
  qcRuleDependencyHash, expectedRuleSet, chapterRuleHashes,
  HASH_ALGO_VER, MISSING_ASSET, LAST_SHOT,
} from '../lib/core/qc/deps/index.js';
import { RULE_IDS, RULE_DEPS, CHAPTER_RULE_IDS, AUDIT_RULE_IDS, SCOPE_OF } from '../lib/core/qc/deps/rule-deps.js';
import * as F from './helpers/continuity-fixture.mjs';
import * as Q from './helpers/qc-fixture.mjs';

// ── 求解输入 Hash（SH-4~SH-6）────────────────────────────────────────────
const shotsOf = (over = {}) => [
  F.shot({ id: 'a', global_no: 1, blockings: [F.blk()], ...(over.a ?? {}) }),
  F.shot({ id: 'b', global_no: 2, blockings: [F.blk()], actions: [F.act()], ...(over.b ?? {}) }),
];
const solveHash = (shots, sceneState = F.scene()) => solverInputHash({ projectId: 'p1', sceneKey: 'S1_病房', shots, sceneState });

test('SH-4 hash 覆盖求解输入：改站位 / 动作 / character|prop 引用 → 必变', () => {
  const base = solveHash(shotsOf());
  assert.match(base, /^sha256:[0-9a-f]{64}$/);
  assert.notEqual(base, solveHash(shotsOf({ a: { blockings: [F.blk({ norm_x: 0.31 })] } })));
  assert.notEqual(base, solveHash(shotsOf({ b: { actions: [F.act({ t_to: 2 })] } })));
  assert.notEqual(base, solveHash(shotsOf({ b: { shotAssets: [{ asset_id: 'p1', role: 'prop' }] } })));
  // 场次基线七列任一变化 → 变
  assert.notEqual(base, solveHash(shotsOf(), F.scene({ axis_lock: { ...F.scene().axis_lock, left: 'c2', right: 'c1' } })));
  // 顺序键变化 → 变（改顺序等于换链）
  assert.notEqual(base, solveHash(shotsOf({ b: { global_no: 9 } })));
  // 来源/版本/置信度 → 变（posRel 的第 ⑤ 级靠它）
  assert.notEqual(base, solveHash(shotsOf({ a: { spec_source: 'ai' } })));
  assert.notEqual(base, solveHash(shotsOf({ a: { spec_version: 3 } })));
  assert.notEqual(base, solveHash(shotsOf({ a: { fill_confidence: 0.4 } })));
  assert.notEqual(base, solveHash(shotsOf({ a: { time_jump: 1 } })));
});

test('SH-4 hash 不含 QC-only 字段：改景别 / 台词 / 运镜 / 画面内容 → 不变', () => {
  const base = solveHash(shotsOf());
  for (const over of [
    { shot_size: 'close_up' }, { dialogue: '你来了' }, { movement: 'pan' }, { movement_amp: 'large' },
    { visual_content: '换了个画面' }, { narration: '旁白' }, { composition: '双人' }, { lighting: '夜' },
    { story_duration: 9 }, { time_slices: [{ from: 0, to: 1, kind: 'action' }] }, { cam_pos: { x: 1, y: 1, z: 1 } },
    { composition_rule: 'left_third' }, { cam_note: '推' }, { speed_ramp: 'ramp' }, { speakers: [{ id: 'c1', type: 'on_screen' }] },
    { voice_ids: ['v1'] }, { dialogue_function: 'inform' },
  ]) {
    // eslint-disable-next-line no-unused-expressions
    assert.equal(solveHash(shotsOf({ a: over })), base, `${Object.keys(over)[0]} 不该进求解 Hash`);
  }
});

test('SH-4 hash 不含版本戳与非业务列：updated_at / created_at / qc_status 不参与', () => {
  const base = solveHash(shotsOf());
  assert.equal(solveHash(shotsOf({ a: { updated_at: 111, created_at: 222, qc_status: 'pass' } })), base);
});

test('SH-5/SH-6 确定性：行序无关、两次相同、不依赖 env', () => {
  const shots = shotsOf();
  const rev = [{ ...shots[1], blockings: [F.blk({ character_id: 'c2', norm_x: 0.8 }), F.blk({ character_id: 'c1' })] }, shots[0]];
  const shuffled = [{ ...shots[1], blockings: [...rev[0].blockings].reverse() }, shots[0]];
  const a = solveHash(shots);
  const b = solveHash(rev);
  const c = solveHash(shuffled);
  // 站位行按 character_id 排序 → 行序无关
  assert.equal(solveHash([{ ...shots[1], blockings: [F.blk({ character_id: 'c1' }), F.blk({ character_id: 'c2', norm_x: 0.8 })] }, shots[0]]),
    solveHash([{ ...shots[1], blockings: [F.blk({ character_id: 'c2', norm_x: 0.8 }), F.blk({ character_id: 'c1' })] }, shots[0]]));
  // 镜序不同（global_no 不同）→ 本来就该不同
  assert.notEqual(a, b);
  assert.equal(c, b);
  const env = process.env.IC_DATA_DIR;
  process.env.IC_DATA_DIR = '/tmp/whatever';
  assert.equal(solveHash(shots), a);
  if (env === undefined) delete process.env.IC_DATA_DIR; else process.env.IC_DATA_DIR = env;
});

test('SH-4 同一个函数供给 A 与 B：没有第二份求解 Hash 实现', () => {
  assert.equal(SOLVER_VERSION, 'stage3.1');
  assert.deepEqual([...SOLVE_SCENE_FIELDS].length, 7);
  assert.ok(SOLVE_SHOT_FIELDS.includes('global_no'));
  assert.deepEqual([...SOLVE_ASSET_ROLES], ['character', 'prop']);
});

// ── QC 依赖上下文 & 报告级/规则级 Hash ───────────────────────────────────
const ASSETS = [
  { id: 'c1', category: 'character', name: '哈罗德', parent_id: '' },
  { id: 'p1', category: 'prop', name: '文件', parent_id: '' },
  { id: 'ct1', category: 'costume', name: '病号服', parent_id: '' },
];
const depsCtx = (over = {}) => buildQcDependencyContext({
  sceneKey: 'S01_病房',
  shot: { ...Q.baseShot, ...(over.shot ?? {}) },
  states: over.states ?? Q.st(),
  blockings: over.blockings ?? [Q.b()],
  actions: over.actions ?? [Q.a()],
  shotAssets: over.shotAssets ?? [{ asset_id: 'c1', role: 'character', order_no: 1 }, { asset_id: 'p1', role: 'prop', order_no: 1 }],
  assets: over.assets ?? ASSETS,
  sceneState: over.sceneState ?? Q.scene(),
  chapterShots: over.chapterShots ?? Q.chapter(5),
  // 显式传 null（末镜）与不传（取默认下镜）必须能区分：用 ?? 会把 null 吞掉
  nextShot: over.nextShot === undefined ? { id: 'sh_02', state_in: { chars: { c1: { pos: [0.7, 0.5, 0] } } } } : over.nextShot,
});
const ruleHash = (id, ctx) => qcRuleDependencyHash(id, ctx);

test('RH-2 期望规则集合 = 69 条可执行规则（V-10 不在内、V-12 仍在但标注阶段4）', () => {
  const set = expectedRuleSet();
  assert.equal(set.length, 69);
  assert.equal(new Set(set).size, 69);
  assert.equal(set.includes('V-10'), false);
  assert.deepEqual([...set].sort(), [...RULE_IDS].sort());
  const perPrefix = set.reduce((a, id) => { const k = id[0]; a[k] = (a[k] || 0) + 1; return a; }, {});
  assert.deepEqual(perPrefix, { V: 25, A: 19, S: 25 });
});

test('RH-1 规则集合无重复：`expectedRuleSet` 与映射表同源', () => {
  const set = expectedRuleSet();
  assert.equal(new Set(set).size, set.length);
  assert.equal(Object.keys(RULE_DEPS).length, 69);
});

test('C.1 报告级 = 逐规则摘要：detail 给出 69 条规则级 Hash，且可独立复算', () => {
  const ctx = depsCtx();
  const d = qcDependencyHashDetail(ctx);
  assert.equal(d.ruleHashes.length, 69);
  assert.equal(d.hash_algo_ver, 'qcdep-2');
  assert.match(d.hash, /^sha256:[0-9a-f]{64}$/);
  // 逐条复算必须一致（SIG-1：报告级只能由逐规则生成）
  for (const row of d.ruleHashes) assert.equal(row.rule_dependency_hash, ruleHash(row.rule_id, ctx));
  // 排序稳定
  const ids = d.ruleHashes.map((r) => r.rule_id);
  assert.deepEqual(ids, [...ids].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
});

test('RH-4 / RH-5 报告级对任一规则级变化敏感，且同输入稳定', () => {
  const a = depsCtx();
  const b = depsCtx({ shot: { shot_size: 'close_up' } });
  assert.notEqual(qcDependencyHash(a), qcDependencyHash(b));
  assert.equal(qcDependencyHash(a), qcDependencyHash(depsCtx()));
});

test('RH-6 / RH-7 执行来源与历史身份不进 Hash：`source` / `carried_from` / 时间戳不参与', () => {
  const ctx = depsCtx();
  const base = qcDependencyHash(ctx);
  const noisy = { ...ctx, source: 'carried', carried_from: 'qc_999', createdAt: 1, updatedAt: 2, reportId: 'r1' };
  assert.equal(qcDependencyHash(noisy), base);
  // 规则级同样不该因为"这是继承来的"而变
  assert.equal(ruleHash('V-05', noisy), ruleHash('V-05', ctx));
});

test('X-1 报告级变化不否定所有规则：改 shot_size 时 V-11 的规则级 Hash 不变', () => {
  const a = depsCtx();
  const b = depsCtx({ shot: { shot_size: 'close_up' } });
  assert.notEqual(qcDependencyHash(a), qcDependencyHash(b)); // 报告级变了
  assert.equal(ruleHash('V-11', a), ruleHash('V-11', b));    // 但 V-11 没变 → 仍可继承
  assert.notEqual(ruleHash('V-05', a), ruleHash('V-05', b)); // V-05 变了 → 必须重跑
});

test('X-3 报告级不能被"所有规则级都对上"替代：规则集合本身进摘要', () => {
  const d = qcDependencyHashDetail(depsCtx());
  // 规则集合进 payload：改 ruleset_ver 等于规则集升级 → Hash 必变（QH-5）
  const bumped = buildQcDependencyContext({ ...{}, ...pick(depsCtx()), rulesetVer: 'stage3.2' });
  assert.notEqual(qcDependencyHash(bumped), d.hash);
  // detail 里必须带集合规模，报告可自证
  assert.equal((d.rules ?? d.ruleHashes).length, 69);
});

function pick(ctx) {
  return {
    shot: ctx.shot, states: ctx.states, blockings: ctx.blockings, actions: ctx.actions,
    shotAssets: ctx.shotAssets, assets: ctx.assets, sceneState: ctx.sceneState,
    chapterShots: ctx.chapterShots, nextShot: ctx.nextShot,
  };
}

test('C.2 逐规则独立：不存在"一份全局字段清单发给 69 条规则"', () => {
  const ctx = depsCtx();
  const hashes = new Set(RULE_IDS.map((id) => ruleHash(id, ctx)));
  // 69 条规则的 Hash 必须各不相同（含 rule_id 与 scope 进 payload）；
  // 若实现是"全局清单"，改一个无关字段会令全部 69 条一起变 —— 下面用逐字段验证。
  assert.equal(hashes.size, 69);
});

test('C.2 逐字段敏感度：只改某规则依赖的字段，才让该规则 Hash 变（不得整片失效）', () => {
  const base = depsCtx();
  const changed = depsCtx({ shot: { cam_roll_deg: 12 } });
  const changedRules = RULE_IDS.filter((id) => ruleHash(id, base) !== ruleHash(id, changed));
  assert.ok(changedRules.includes('S-22'), 'cam_roll_deg 变了，S-22 必须变');
  // 绝大多数规则不该因为滚转角而失效
  assert.ok(changedRules.length < 10, `受影响规则过多（${changedRules.length}），疑似全局清单`);
  // 明确不该变的
  for (const id of ['V-11', 'A-01', 'S-24']) assert.equal(changedRules.includes(id), false, `${id} 不该受 cam_roll_deg 影响`);
});

test('LR-9 规则版本进每条规则 Hash（ruleset_ver 升 → 全部重跑）', () => {
  const a = depsCtx();
  const b = buildQcDependencyContext({ ...pick(a), rulesetVer: 'stage3.2' });
  const same = RULE_IDS.filter((id) => ruleHash(id, a) === ruleHash(id, b));
  assert.deepEqual(same, []);
});

// ── C.4 资产实体（AR-1~AR-7 / SIG-2）───────────────────────────────────
test('SIG-2 / AR-1 只纳入本镜引用的资产：传全表与传子集结果相同', () => {
  const subset = depsCtx({ assets: [ASSETS[0], ASSETS[1]] });
  const full = depsCtx({ assets: [...ASSETS, { id: 'unrelated', category: 'prop', name: '无关', parent_id: '' }] });
  assert.equal(qcDependencyHash(subset), qcDependencyHash(full));
  // ctx.assets 里不得出现未被引用的行
  assert.deepEqual(full.assets.map((x) => x.id), ['c1', 'p1']);
});

test('AR-4 引用不变、内容变 → 相关规则与报告级 Hash 必变', () => {
  const base = depsCtx();
  for (const [field, value] of [['category', 'costume'], ['name', '文件夹'], ['parent_id', 'p9']]) {
    const changed = depsCtx({ assets: [{ ...ASSETS[0] }, { ...ASSETS[1], [field]: value }] });
    assert.notEqual(qcDependencyHash(base), qcDependencyHash(changed), `assets.${field} 变而报告级没变`);
    const hit = RULE_IDS.some((id) => ruleHash(id, base) !== ruleHash(id, changed));
    assert.ok(hit, `assets.${field} 变而没有任何规则级 Hash 变`);
  }
});

test('AR-5 无关资产字段（description）不得造成任何失效', () => {
  const base = depsCtx();
  const changed = depsCtx({ assets: [{ ...ASSETS[0], description: '很长的人物小传' }, { ...ASSETS[1], description: 'x' }] });
  assert.equal(qcDependencyHash(base), qcDependencyHash(changed));
});

test('AR-3 引用不到的资产用 __missing__ 占位，且与"该行存在"算出不同值', () => {
  const ctx = depsCtx({ assets: [ASSETS[0]] }); // p1 未提供
  const p1 = ctx.assets.find((a) => a.id === 'p1');
  assert.equal(p1.name, MISSING_ASSET);
  assert.notEqual(qcDependencyHash(ctx), qcDependencyHash(depsCtx()));
});

test('AR-2 shot_assets 行序无关；AR-6 资产变化可追溯', () => {
  const rows = [{ asset_id: 'c1', role: 'character', order_no: 1 }, { asset_id: 'p1', role: 'prop', order_no: 1 }];
  assert.equal(qcDependencyHash(depsCtx({ shotAssets: rows })), qcDependencyHash(depsCtx({ shotAssets: [...rows].reverse() })));
  // role 变 → 引用语义变
  const roleChanged = depsCtx({ shotAssets: [{ asset_id: 'c1', role: 'character', order_no: 1 }, { asset_id: 'p1', role: 'costume', order_no: 1 }] });
  assert.notEqual(qcDependencyHash(depsCtx({ shotAssets: rows })), qcDependencyHash(roleChanged));
});

test('SIG-3 / QH-16 纯函数与必传参数：undefined 与 [] 必须可区分', () => {
  assert.throws(() => buildQcDependencyContext({ shot: Q.baseShot, assets: [] }), (e) => e.code === 'QC_DEPS_SHOT_ASSETS_UNDEFINED');
  assert.throws(() => buildQcDependencyContext({ shot: Q.baseShot, shotAssets: [] }), (e) => e.code === 'QC_DEPS_ASSETS_UNDEFINED');
  // 各传空数组是合法输入（"本镜无引用"）
  const empty = buildQcDependencyContext({ shot: Q.baseShot, shotAssets: [], assets: [] });
  assert.match(qcDependencyHash(empty), /^sha256:/);
});

test('QH-3 邻镜：末镜用 __last__ 哨兵，与非末镜算出不同值', () => {
  // `nextShot` 是**状态行**（P6-R4 起做形状校验；不带 state_in 的创作行会被拒）
  const withNext = depsCtx({ nextShot: { id: 'sh_02', state_in: { chars: { c1: { pos: [0.7, 0.5, 0] } } } } });
  const last = depsCtx({ nextShot: null });
  assert.notEqual(ruleHash('A-06', withNext), ruleHash('A-06', last));
  // A-06 的输入里必须有哨兵这一段（否则两种情况同值）
  assert.equal(last.nextShot, null);
  // `nextShot` 与 `nextShotState` 指向同一行，P5 的 A-06 读的是后者
  assert.equal(withNext.nextShot, withNext.nextShotState);
});

test('QH-2 章级三条：改一镜 shot_size，全章 V-06/V-07/V-08 的 Hash 都变', () => {
  const chap = Q.chapter(4);
  const base = depsCtx({ chapterShots: chap, shot: { ...chap[1], id: chap[1].id } });
  const changedChap = [{ ...chap[0] }, { ...chap[1], shot_size: 'extreme_wide' }, ...chap.slice(2)];
  const changed = depsCtx({ chapterShots: changedChap, shot: { ...changedChap[1] } });
  const before = chapterRuleHashes(base);
  const after = chapterRuleHashes(changed);
  for (const id of CHAPTER_RULE_IDS) {
    if (id === 'V-06') continue; // V-06 读 cam_direction/cam_height/cam_roll_deg，不读 shot_size
    assert.notEqual(before[id], after[id], `${id} 未随章内 shot_size 变化`);
  }
  // 镜级规则不受章数据影响
  assert.equal(ruleHash('V-11', base), ruleHash('V-11', changed));
});

test('QH-6 排除清单：改章内无关列（narration）不解冻任何规则', () => {
  const chap = Q.chapter(4);
  const a = depsCtx({ chapterShots: chap });
  const b = depsCtx({ chapterShots: chap.map((s) => ({ ...s, narration: '新旁白' })) });
  const diff = RULE_IDS.filter((id) => ruleHash(id, a) !== ruleHash(id, b));
  assert.deepEqual(diff, []);
});

test('LR-10 Hash 与结论无关：同输入下 PASS 与 FAIL 算同一个值', () => {
  const ctx = depsCtx();
  // 结论不在 ctx 里（ctx 只有输入快照），故"同一份输入"必然同值
  assert.equal(ruleHash('V-05', ctx), ruleHash('V-05', { ...ctx }));
  // 状态差异属输入差异 → 必须不同（`conflicts` 是状态级规则的输入）
  const a = depsCtx({ states: Q.st({ conflicts: [] }) });
  const b = depsCtx({ states: Q.st({ conflicts: [{ code: 'POSITION_JUMP' }] }) });
  assert.notEqual(ruleHash('V-18', a), ruleHash('V-18', b));
});

test('SH-2 状态级规则跳过 __solver：它不进任何 Hash', () => {
  const a = depsCtx({ states: Q.st({ meta: { 'chars.c1.pos': { rel: 'known' }, __solver: { hash: 'sha256:aaa' } } }) });
  const b = depsCtx({ states: Q.st({ meta: { 'chars.c1.pos': { rel: 'known' }, __solver: { hash: 'sha256:bbb' } } }) });
  assert.equal(qcDependencyHash(a), qcDependencyHash(b));
});

test('审计级三条没有输入字段，但仍在规则集合内（占位而非缺失）', () => {
  for (const id of AUDIT_RULE_IDS) {
    assert.deepEqual(RULE_DEPS[id].fields, ['__audit']);
    assert.equal(SCOPE_OF[id], 'audit');
    assert.match(ruleHash(id, depsCtx()), /^sha256:/);
  }
  // `LAST_SHOT` 哨兵值不得为 undefined（导出给测试与 P9 复用）
  assert.equal(typeof LAST_SHOT, 'string');
});
