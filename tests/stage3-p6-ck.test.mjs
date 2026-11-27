// P6 · CK-1 / CK-2 覆盖完整性机检（D02-06 §9.2.1 末表）
//
// CK-2（规则级，V7 新增，比 CK-1 强）：
//   左 = 69 条规则的 8 列依赖映射（`RULE_DEPS[ruleId].fields`）
//   右 = `qcRuleDependencyHash(ruleId, ctx)` 对该规则**实际读取**的字段（深层 Proxy 采集）
//   判据 = 逐规则双向 diff 为空。任一条非空即 R-28 不能闭合。
//
// 为什么必须逐规则：两条规则各漏一个字段、又各多一个，并集能对上 —— R-28 就是这么发生的。
// 电池与审计脚本共用 `tests/helpers/ck2-battery.mjs`，避免"脚本绿、测试红"。
import test from 'node:test';
import assert from 'node:assert/strict';

import { RULES } from '../lib/core/validate/index.js';
import { RULE_DEPS, RULE_IDS, CHAPTER_RULE_IDS, NEIGHBOR_RULE_IDS, AUDIT_RULE_IDS, STATE_RULE_IDS, SCOPE_OF } from '../lib/core/qc/deps/rule-deps.js';
import { runCk2 } from './helpers/ck2.mjs';
import { BATTERY } from './helpers/ck2-battery.mjs';
import { SHOT_COLUMNS, SCENE_COLUMNS, ASSET_COLUMNS } from '../lib/core/continuity/invalidate.js';

const RES = runCk2({ rules: RULES, deps: RULE_DEPS, battery: BATTERY });
const rowOf = (id) => RES.rows.find((r) => r.rule_id === id);

// ── CK-2 ────────────────────────────────────────────────────────────────
test('CK-2 规则级双向 diff：69 条逐条为空（missing=[] 且 extra=[]）', () => {
  const bad = RES.rows.filter((r) => r.missing.length || r.extra.length || r.throw);
  const detail = bad.map((r) => `${r.rule_id} missing=[${r.missing.join(',')}] extra=[${r.extra.join(',')}] throw=${r.throw}`).join('\n');
  assert.equal(bad.length, 0, `CK-2 未通过：\n${detail}`);
  assert.equal(RES.total.rules, 69);
  assert.equal(RES.total.passed, 69);
});

test('CK-2 覆盖规模：映射字段 327、实际读取 660（逐规则均 > 0）', () => {
  assert.equal(RES.total.declaredSum, 327);
  assert.equal(RES.total.actualSum, 660);
  for (const r of RES.rows) {
    // V-12 属阶段 4，恒不应适用 —— 按 §9.2.1 C.2 第 8 条，**不得伪造可执行依赖**，故 0 字段是对的
    if (r.rule_id !== 'V-12') assert.ok(r.declared > 0, `${r.rule_id} 映射字段为 0（等于没定义依赖）`);
    if (r.rule_id !== 'V-12') assert.ok(r.actual > 0, `${r.rule_id} 实际读取为 0（电池没覆盖到，或规则空转）`);
  }
});

test('CK-2 逐条明细可查（每条规则都给出映射数/读取数/双向 diff）', () => {
  // 抽查四条不同作用域，确认形状完整（报告里要逐条列表）
  for (const [id, scope] of [['V-05', 'shot'], ['V-06', 'chapter'], ['A-06', 'neighbor'], ['S-08', 'state']]) {
    const r = rowOf(id);
    assert.ok(r, `${id} 缺失`);
    assert.equal(r.scope, scope);
    assert.deepEqual(r.missing, []);
    assert.deepEqual(r.extra, []);
  }
  // 审计级三条的依赖是"其它规则的产出"，不得伪造输入字段
  for (const id of AUDIT_RULE_IDS) assert.deepEqual(RULE_DEPS[id].fields, ['__audit']);
});

test('CK-2 反向证据：映射里写了但代码从不读 → 立即变红（extra 的用法）', () => {
  // 构造一条"虚假依赖"：把 V-11 的映射多塞一个字段，diff 必须报 extra
  const fake = { ...RULE_DEPS, 'V-11': { ...RULE_DEPS['V-11'], fields: [...RULE_DEPS['V-11'].fields, 'shot.dialogue'] } };
  const res = runCk2({ rules: RULES, deps: fake, battery: BATTERY });
  const r = res.rows.find((x) => x.rule_id === 'V-11');
  assert.deepEqual(r.missing, []);
  assert.deepEqual(r.extra, ['shot.dialogue']);
  assert.equal(res.total.failed, 1);
});

test('CK-2 反向证据：代码读了但映射没写 → missing 非空', () => {
  const fake = { ...RULE_DEPS, 'V-11': { ...RULE_DEPS['V-11'], fields: RULE_DEPS['V-11'].fields.filter((f) => f !== 'shot.movement_amp') } };
  const res = runCk2({ rules: RULES, deps: fake, battery: BATTERY });
  const r = res.rows.find((x) => x.rule_id === 'V-11');
  assert.ok(r.missing.some((m) => m.includes('movement_amp')), JSON.stringify(r.missing));
});

// ── 8 列骨架完整性 ──────────────────────────────────────────────────────
test('8 列骨架逐条填满：69 条规则每条都有 scope/tables/entities/applicability/hashInputs/test/fields', () => {
  for (const id of RULE_IDS) {
    const d = RULE_DEPS[id];
    for (const col of ['scope', 'tables', 'entities', 'applicability', 'hashInputs', 'test', 'fields']) {
      assert.ok(d[col] !== undefined && d[col] !== null && d[col] !== '', `${id} 缺第 ${col} 列`);
    }
    // V-12 恒不适用：空 fields 是规范要求（见上）
    if (id === 'V-12') assert.deepEqual(d.fields, []);
    else assert.ok(Array.isArray(d.fields) && d.fields.length > 0, `${id} 的读取字段为空`);
    assert.ok(Array.isArray(d.tables), `${id} 的 tables 必须是数组`);
    assert.ok(Array.isArray(d.entities), `${id} 的 entities 必须是数组`);
  }
});

test('规则族必须展开：没有一条规则靠"族行"占位（69 条全是独立 rule_id）', () => {
  // 族名（如 `V-04 / V-09 / V-13 / V-23`）不得出现在 RULE_IDS 里
  for (const id of RULE_IDS) assert.match(id, /^[VAS]-\d{2}$/, `${id} 不是单条规则编号`);
  // 三族按前缀计数：V 25 + A 19 + S 25 = 69
  const byPrefix = RULE_IDS.reduce((a, id) => { a[id[0]] = (a[id[0]] || 0) + 1; return a; }, {});
  assert.deepEqual(byPrefix, { V: 25, A: 19, S: 25 });
});

test('作用域分配与 §7.8.1.3 一致：章级 3 / 邻镜级 1 / 状态级 12 / 审计 3', () => {
  assert.deepEqual([...CHAPTER_RULE_IDS].sort(), ['V-06', 'V-07', 'V-08']);
  assert.deepEqual([...NEIGHBOR_RULE_IDS].sort(), ['A-06']);
  assert.deepEqual([...AUDIT_RULE_IDS].sort(), ['S-20', 'S-21', 'S-25']);
  assert.equal(STATE_RULE_IDS.length, 12);
  const shot = RULE_IDS.filter((id) => SCOPE_OF[id] === 'shot');
  assert.equal(shot.length, 49);
  // 合计守恒
  assert.equal(shot.length + 3 + 1 + 12 + 1 + 3, 69);
});

// ── CK-1（字段级并集）───────────────────────────────────────────────────
test('CK-1 字段级并集：所有实际读取路径的根都在已知容器内，叶子列都在 DDL 里', () => {
  const ROOTS = new Set(['shot', 'blockings', 'actions', 'shotAssets', 'assets', 'sceneState', 'shotState',
    'chapterShots', 'nextShotState', 'targetProfile', '__audit',
    // P5 补充的契约键（上一条镜/决定项），已在 §7.8.1.2 之外单列（D02-12 U-P5-4）
    'prevShot', 'prevShotAssets', 'prevActions', 'costumeChangeAllowed']);
  // U-P6-4 已修：S-15 的 `shot.distance_to_camera` 是历史遗留读取（`story_shots` 无此列），
  // 规则与映射均已移除，因此这里**不再放行任何偏差** —— 允许集若重新变非空，即回归。
  const KNOWN = new Set();
  const shotCols = new Set(Object.values(SHOT_COLUMNS).flat());
  const sceneCols = new Set([...Object.values(SCENE_COLUMNS).flat(), 'scene_key']);
  const assetCols = new Set([...Object.values(ASSET_COLUMNS).flat()]);
  const bad = [];
  for (const r of RES.rows) {
    for (const p of r.actualPaths) {
      const root = String(p).split(/[.[]/)[0];
      if (!ROOTS.has(root)) { bad.push(`${r.rule_id}: 未知容器 ${root} ← ${p}`); continue; }
      // 列名是**第二段**（`shot.speakers.0.type` 的列是 speakers，不是 type）
      const segs = String(p).split('.');
      const leaf = segs.length > 1 ? segs[1] : '';
      if (!leaf) continue; // 只读到容器本身（`shot` / `blockings`）→ 没有列名可校
      if (root === 'shot' && !shotCols.has(leaf) && !KNOWN.has(`shot.${leaf}`)) bad.push(`${r.rule_id}: story_shots 无此列 ${leaf}`);
      if (root === 'sceneState' && !sceneCols.has(leaf) && String(p).includes('.')) bad.push(`${r.rule_id}: scene_states 无此列 ${leaf}`);
      if (root === 'assets' && !assetCols.has(leaf)) bad.push(`${r.rule_id}: assets 无此列 ${leaf}`);
    }
  }
  assert.deepEqual(bad, []);
});

test('CK-1 并集覆盖：§7.8.1.2 的 CIS+QIS 列与仅 QIS 列，全部至少被一条规则读取', () => {
  const read = new Set();
  for (const r of RES.rows) for (const p of r.actualPaths) read.add(String(p));
  const missing = [];
  for (const col of [...SHOT_COLUMNS.cis_qc, ...SHOT_COLUMNS.qc]) {
    const hit = [...read].some((p) => p === `shot.${col}` || p.startsWith(`shot.${col}.`) || p === `chapterShots.${col}`);
    // 允许"只在章级路径出现"（V-06/V-07/V-08）与"经派生容器读"（如 chapters 归一）
    if (!hit) missing.push(col);
  }
  // 这些列由结构列/派生路径承载，不直接读原文，允许缺席（逐项给出理由，不得笼统放过）
  const ALLOW = new Set([
    'global_no',      // 排序键，进 solve-hash 与失效编排，不是规则输入
    'scene_key',      // 场次归属，供 S-01 经 sceneState 判定
    'fill_confidence', // 进 state 的 meta.conf，规则读 meta 而非原列
    'spec_version',   // 同上（缺 meta 时的来源判定）
    // `time_jump`：§7.8.1 标「QC 是」，但没有任何规则**直接**读它 —— 它的效果经求解器落进
    // `shot_states`（`TIME_JUMP_SKIPPED`、不再产生 `TELEPORT`），再由状态级规则读状态。
    // 所以字段级并集里看不到它，属预期；失效路径由 CIS 承担，不是漏判。
    'time_jump',
  ]);
  assert.deepEqual(missing.filter((c) => !ALLOW.has(c)), []);
});
