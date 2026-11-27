// P6 · 双层失效（D02-06 §7.8.0 / §7.8.1 / §7.8.2 / §7.8.3）
//
// 覆盖：A04-T1~A04-T12、R-1~R-4 四条关系、`reasons[]` 可追溯、未分类即抛错、48 列算术。
//
// 这组用例的共同断言方式是"**看两个集合的形状**"，不是"看有没有报错"：
// 双层失效的失效模式是静默的（该重算的没重算、不该重算的整场重算了），不会抛异常。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  planInvalidation,
  checkInvalidationRelations,
  auditColumnClassification,
  classifyShotColumn,
  SHOT_COLUMNS,
  SCENE_COLUMNS,
  READ_OVERRIDES,
  rulesTouchingColumn,
  RULE_SCOPE_EXPORT,
} from '../lib/core/continuity/invalidate.js';

// ── 夹具：ch1 = S1(3 镜) + S2(2 镜)；ch2 = S3(2 镜) ──────────────────────
const SHOTS = [
  { id: 'sh_01', scene_key: 'S1', chapter_id: 'ch1', global_no: 1, shot_no: 1 },
  { id: 'sh_02', scene_key: 'S1', chapter_id: 'ch1', global_no: 2, shot_no: 2 },
  { id: 'sh_03', scene_key: 'S1', chapter_id: 'ch1', global_no: 3, shot_no: 3 },
  { id: 'sh_04', scene_key: 'S2', chapter_id: 'ch1', global_no: 4, shot_no: 4 },
  { id: 'sh_05', scene_key: 'S2', chapter_id: 'ch1', global_no: 5, shot_no: 5 },
  { id: 'sh_06', scene_key: 'S3', chapter_id: 'ch2', global_no: 6, shot_no: 1 },
  { id: 'sh_07', scene_key: 'S3', chapter_id: 'ch2', global_no: 7, shot_no: 2 },
];
const SHOT_ASSETS = [
  { shot_id: 'sh_01', asset_id: 'p1', role: 'prop' },
  { shot_id: 'sh_03', asset_id: 'p1', role: 'prop' },
  { shot_id: 'sh_05', asset_id: 'ct1', role: 'costume' },
];

const plan = (change) => planInvalidation({ change, shots: SHOTS, shotAssets: SHOT_ASSETS });
const cisIds = (p) => Object.values(p.continuityInvalidationSet).flatMap((b) => b.shotIds).sort();
const qisIds = (p) => Object.keys(p.qcInvalidationSet).sort();
const rulesOf = (p, id) => p.qcInvalidationSet[id]?.rules ?? [];
const CIS_RULES = [...RULE_SCOPE_EXPORT.shot, ...RULE_SCOPE_EXPORT.state];

// ── A04-T1 场次基线（axis_lock）──────────────────────────────────────────
test('A04-T1 改 axis_lock：CIS = 该场全部镜；QIS 覆盖每镜的镜级 + 状态级规则', () => {
  const p = plan({ scene_states: [{ scene_key: 'S1', fields: ['axis_lock'] }] });
  assert.deepEqual(cisIds(p), ['sh_01', 'sh_02', 'sh_03']);
  assert.equal(p.continuityInvalidationSet.S1.earliestShotId, 'sh_01');
  assert.equal(p.continuityInvalidationSet.S1.earliestGlobalNo, 1);
  // 别的场次不得被牵连
  assert.deepEqual(qisIds(p), ['sh_01', 'sh_02', 'sh_03']);
  for (const id of ['sh_01', 'sh_02', 'sh_03']) {
    for (const rid of CIS_RULES) assert.ok(rulesOf(p, id).includes(rid), `${id} 缺 ${rid}`);
  }
  assert.deepEqual(checkInvalidationRelations(p, SHOTS.map((s) => s.id)).violations, []);
});

test('A04-T1 扩展：CIS 非空时 QIS 必非空（R-1），且状态级规则只落在 CIS 内', () => {
  const p = plan({ scene_states: [{ scene_key: 'S2', fields: ['fixtures'] }] });
  assert.deepEqual(cisIds(p), ['sh_04', 'sh_05']);
  for (const id of ['sh_04', 'sh_05']) assert.ok(rulesOf(p, id).includes('V-18'));
  // sh_01 不在 CIS → 不得出现状态级规则（省一次重跑，但不能漏）
  assert.equal(rulesOf(p, 'sh_01').includes('V-18'), false);
});

// ── A04-T2 time_jump ────────────────────────────────────────────────────
test('A04-T2 改 time_jump：CIS = 本镜 + 同场后继；前序镜不动', () => {
  const p = plan({ shots: [{ shot_id: 'sh_02', fields: ['time_jump'] }] });
  assert.deepEqual(cisIds(p), ['sh_02', 'sh_03']);
  assert.equal(p.continuityInvalidationSet.S1.earliestShotId, 'sh_02');
  assert.equal(qisIds(p).includes('sh_01'), false);
});

// ── A04-T3 换场 ─────────────────────────────────────────────────────────
test('A04-T3 换场（S1→S2）：原场与新场都失效，两场所在章的 V-06/07/08 也重跑', () => {
  const p = plan({ shots_moved: [{ shot_id: 'sh_03', from: 'S1', to: 'S2' }] });
  // 原场 S1（sh_03 起）与新场 S2（整链）都在 CIS
  assert.ok(cisIds(p).includes('sh_03'));
  assert.ok(cisIds(p).includes('sh_04') && cisIds(p).includes('sh_05'));
  // 两场的章级三条必须实跑（章内镜数与分布变了）
  for (const id of ['sh_03', 'sh_04', 'sh_05']) {
    for (const rid of ['V-06', 'V-07', 'V-08']) assert.ok(rulesOf(p, id).includes(rid), `${id} 缺 ${rid}`);
  }
});

// ── A04-T4 排名互换 ─────────────────────────────────────────────────────
test('A04-T4 改 global_no（排名变化）：CIS 从受影响镜起，邻镜级 A-06 追加下镜', () => {
  const p = plan({ shots: [{ shot_id: 'sh_02', fields: ['global_no'] }] });
  assert.equal(p.continuityInvalidationSet.S1.earliestShotId, 'sh_02');
  // A-06 是邻镜级：本镜 + 同场下一镜
  assert.ok(rulesOf(p, 'sh_03').includes('A-06'));
});

// ── A04-T5 删除一镜 ─────────────────────────────────────────────────────
test('A04-T5 删除中间一镜：原场整链失效（被删镜已无 global_no 可定位，保守取全场）', () => {
  const p = plan({ shots_deleted: [{ shot_id: 'sh_02', scene_key: 'S1' }] });
  assert.deepEqual(cisIds(p), ['sh_01', 'sh_03']);
  // 被删镜不得出现在 QIS（它没有报告可重建）
  assert.equal(qisIds(p).includes('sh_02'), false);
  // 后继镜的状态链必须重算
  assert.ok(cisIds(p).includes('sh_03'));
});

// ── A04-T6 movement_amp（QC-only）───────────────────────────────────────
test('A04-T6 改 movement_amp：CIS 为空（不求解），QIS 只含本镜，V-11 在其中', () => {
  const p = plan({ shots: [{ shot_id: 'sh_02', fields: ['movement_amp'] }] });
  assert.deepEqual(p.continuityInvalidationSet, {});
  assert.deepEqual(qisIds(p), ['sh_02']);
  assert.ok(rulesOf(p, 'sh_02').includes('V-11'));
  // 不得因为 QC-only 就重算整场
  assert.equal(cisIds(p).length, 0);
});

// ── A04-T7 visual_content（QC-only）─────────────────────────────────────
test('A04-T7 改 visual_content：CIS 为空，V-05 实跑，其余镜头不牵连', () => {
  const p = plan({ shots: [{ shot_id: 'sh_02', fields: ['visual_content'] }] });
  assert.deepEqual(p.continuityInvalidationSet, {});
  assert.ok(rulesOf(p, 'sh_02').includes('V-05'));
  assert.equal(qisIds(p).includes('sh_01'), false);
});

// ── A04-T8 shot_size（章级扩散）──────────────────────────────────────────
test('A04-T8 改 shot_size：本镜镜级 + 同章全部镜的 V-06/V-07/V-08，别章不牵连', () => {
  const p = plan({ shots: [{ shot_id: 'sh_02', fields: ['shot_size'] }] });
  assert.deepEqual(p.continuityInvalidationSet, {});
  // 同章（ch1）四镜都要重跑章级三条
  for (const id of ['sh_01', 'sh_02', 'sh_03', 'sh_04', 'sh_05']) {
    for (const rid of ['V-06', 'V-07', 'V-08']) {
      if (rid === 'V-06') continue; // V-06 读 cam_direction/cam_height/cam_roll_deg，不读 shot_size
      assert.ok(rulesOf(p, id).includes(rid), `${id} 缺 ${rid}`);
    }
  }
  // ch2 不受影响（除审计级三条）
  assert.equal(rulesOf(p, 'sh_06').some((r) => ['V-06', 'V-07', 'V-08'].includes(r)), false);
  // 本镜有自己的镜级规则，其他镜没有
  assert.ok(rulesOf(p, 'sh_02').includes('V-05'));
  assert.equal(rulesOf(p, 'sh_01').includes('V-05'), false);
});

// ── A04-T9 完全无关字段 ──────────────────────────────────────────────────
test('A04-T9 改 narration / purpose 之外的无关字段：两集合都空（R-4，零写入）', () => {
  for (const col of ['narration', 'sfx', 'music_cue', 'composition', 'lighting', 'is_cut_point', 'dramatic_value', 'beat_key']) {
    const p = plan({ shots: [{ shot_id: 'sh_02', fields: [col] }] });
    assert.equal(p.bothEmpty, true, `${col} 不该触发任何重算`);
    assert.deepEqual(p.reasons, []);
  }
});

test('A04-T9 反例：purpose / is_insert / dialogue_function 被规则读 → 必须进 QIS（规范"无失效"与此冲突）', () => {
  for (const [col, expect] of [['purpose', 'A-01'], ['is_insert', 'V-13'], ['dialogue_function', 'V-02']]) {
    const p = plan({ shots: [{ shot_id: 'sh_02', fields: [col] }] });
    assert.equal(p.bothEmpty, false, `${col} 必须触发 QC`);
    assert.ok(rulesOf(p, 'sh_02').includes(expect), `${col} 应命中 ${expect}`);
  }
  assert.equal(READ_OVERRIDES.purpose.effective, 'qc');
  assert.equal(classifyShotColumn('purpose'), 'qc');
  assert.equal(classifyShotColumn('narration'), 'none');
});

// ── A04-T10 两类同时发生 ────────────────────────────────────────────────
test('A04-T10 同时改 blockings 与 movement_amp：两集合都非空且正确合并', () => {
  const p = plan({
    tables: [{ shot_id: 'sh_02', table: 'shot_blockings', fields: ['norm_x'] }],
    shots: [{ shot_id: 'sh_02', fields: ['movement_amp'] }],
  });
  assert.ok(cisIds(p).length > 0);
  assert.ok(Object.keys(p.qcInvalidationSet).length > 0);
  // QIS ⊇ CIS 内全规则 ∪ 本镜镜级规则
  for (const rid of CIS_RULES) assert.ok(rulesOf(p, 'sh_02').includes(rid));
  assert.ok(rulesOf(p, 'sh_02').includes('V-11'));
  // 同一规则不得重复（用 Set 存，天然去重）
  const rules = rulesOf(p, 'sh_02');
  assert.equal(new Set(rules).size, rules.length);
});

// ── A04-T11 保守分类（power_geometry / crowd_switch）─────────────────────
test('A04-T11 改 power_geometry：CIS 非空（保守），S-17 进 QIS；crowd_switch → S-16', () => {
  const pg = plan({ scene_states: [{ scene_key: 'S1', fields: ['power_geometry'] }] });
  assert.deepEqual(cisIds(pg), ['sh_01', 'sh_02', 'sh_03']);
  assert.ok(rulesOf(pg, 'sh_01').includes('S-17'));

  const cs = plan({ scene_states: [{ scene_key: 'S1', fields: ['crowd_switch'] }] });
  assert.ok(cisIds(cs).length > 0);
  assert.ok(rulesOf(cs, 'sh_01').includes('S-16'));
});

// ── A04-T12 未分类字段 + 48 列算术 ──────────────────────────────────────
test('A04-T12 未分类字段必须抛 INVALIDATION_FIELD_UNCLASSIFIED（不得静默跳过）', () => {
  for (const change of [
    { shots: [{ shot_id: 'sh_02', fields: ['foo_bar'] }] },
    { scene_states: [{ scene_key: 'S1', fields: ['no_such_column'] }] },
    { tables: [{ shot_id: 'sh_02', table: 'no_such_table' }] },
    { tables: [{ shot_id: 'sh_02', table: 'shot_blockings', fields: ['bogus'] }] },
    { assets: [{ asset_id: 'p1', fields: ['bogus'] }] },
  ]) {
    assert.throws(() => plan(change), (e) => e.code === 'INVALIDATION_FIELD_UNCLASSIFIED');
  }
});

test('A04-T12 列分类：6 + 22 + 20 = 48，与 DDL 一致；14 列场次表同样核平', () => {
  const a = auditColumnClassification({});
  assert.deepEqual(a.counts.story_shots.groups, { cis_qc: 6, qc: 22, none: 20 });
  assert.equal(a.counts.story_shots.total, 48);
  assert.deepEqual(a.counts.scene_states.groups, { cis_qc: 7, qc: 1, none: 5 });
  // scene_states 另有 `scene_key` 一个特殊列（换场语义）→ 7+1+1+5 = 14
  assert.equal(a.counts.scene_states.total + SCENE_COLUMNS.sceneKey.length, 14);
  assert.equal(a.ok, true, JSON.stringify(a.missing.concat(a.duplicated)));
});

test('A04-T12 偏差表：标"无失效"却被规则读的列必须显式记录（不得静默放过）', () => {
  const a = auditColumnClassification({});
  const byCol = new Map(a.deviations.map((d) => [d.column, d]));
  for (const col of ['purpose', 'dialogue_function', 'is_insert']) {
    const d = byCol.get(`story_shots.${col}`);
    assert.ok(d, `${col} 未登记偏差`);
    assert.equal(d.effective, 'qc');
    assert.ok(d.read_by.length > 0);
  }
  // `id` 是结构列（删行+插行），不当字段变化
  assert.equal(byCol.get('story_shots.id').effective, 'structural');
});

// ── R-1~R-4 关系自检 ────────────────────────────────────────────────────
test('R-1~R-4：四集合关系逐条成立', () => {
  const ids = SHOTS.map((s) => s.id);
  // R-1
  const cisOnly = plan({ scene_states: [{ scene_key: 'S1', fields: ['axis_lock'] }] });
  assert.ok(Object.keys(cisOnly.continuityInvalidationSet).length > 0);
  assert.ok(Object.keys(cisOnly.qcInvalidationSet).length > 0);
  // R-2：QIS 非空不蕴含 CIS 非空
  const qcOnly = plan({ shots: [{ shot_id: 'sh_02', fields: ['movement_amp'] }] });
  assert.deepEqual(qcOnly.continuityInvalidationSet, {});
  assert.ok(Object.keys(qcOnly.qcInvalidationSet).length > 0);
  // R-4：双空 → bothEmpty
  const none = plan({ shots: [{ shot_id: 'sh_02', fields: ['narration'] }] });
  assert.equal(none.bothEmpty, true);
  for (const p of [cisOnly, qcOnly, none]) {
    assert.deepEqual(checkInvalidationRelations(p, ids).violations, []);
  }
});

test('reasons[] 必须能回答"为什么这一镜被重算/重出"（字段 × 镜 × 场次 × 集合）', () => {
  const p = plan({ scene_states: [{ scene_key: 'S1', fields: ['axis_lock'] }] });
  const cisReasons = p.reasons.filter((r) => r.set === 'continuity');
  assert.ok(cisReasons.length >= 3);
  for (const r of cisReasons) {
    assert.equal(r.field, 'axis_lock');
    assert.equal(r.sceneKey, 'S1');
    assert.ok(['sh_01', 'sh_02', 'sh_03'].includes(r.shotId));
  }
  const qcReasons = p.reasons.filter((r) => r.set === 'qc');
  assert.ok(qcReasons.some((r) => r.ruleId === 'S-07' && r.field === 'axis_lock'));
  // `__cis` 这类内部标记不得泄漏成"字段"
  assert.equal(p.reasons.some((r) => String(r.field).startsWith('__') && r.set === 'qc'), true);
});

test('资产内容变化：只失效引用它的镜与其后继，且可追溯到 asset 字段（AR-6/AR-7）', () => {
  const p = plan({ assets: [{ asset_id: 'p1', fields: ['category'] }] });
  // p1 被 sh_01 与 sh_03 引用 → 两处各自"引用镜 + 同场后继"
  assert.ok(cisIds(p).includes('sh_01') && cisIds(p).includes('sh_03'));
  // 没引用 p1 的 sh_05 / sh_06 不得因此失效
  assert.equal(cisIds(p).includes('sh_06'), false);
  assert.ok(p.reasons.some((r) => r.field === 'category' && r.set === 'continuity'));
  // 无关列（description）→ 无失效
  const none = plan({ assets: [{ asset_id: 'p1', fields: ['description'] }] });
  assert.equal(none.bothEmpty, true);
});

test('shot_assets 的 role 决定是否进 CIS：costume 只进 QIS', () => {
  const prop = plan({ tables: [{ shot_id: 'sh_01', table: 'shot_assets', fields: ['asset_id'], role: 'prop' }] });
  assert.ok(cisIds(prop).length > 0);
  const costume = plan({ tables: [{ shot_id: 'sh_05', table: 'shot_assets', fields: ['asset_id'], role: 'costume' }] });
  assert.equal(cisIds(costume).length, 0);
  assert.ok(Object.keys(costume.qcInvalidationSet).length > 0);
});

test('确定性：同输入两次结果逐字相同，且不修改入参', () => {
  const change = { scene_states: [{ scene_key: 'S1', fields: ['axis_lock', 'fixtures'] }] };
  const before = JSON.stringify({ change, SHOTS, SHOT_ASSETS });
  const a = plan(change);
  const b = plan(change);
  assert.deepEqual(a, b);
  assert.equal(JSON.stringify({ change, SHOTS, SHOT_ASSETS }), before);
});

test('分类函数与规则反查：列 → 规则集合（同一列不得两处口径）', () => {
  assert.ok(rulesTouchingColumn('shots', 'shot_size').includes('V-05'));
  assert.ok(rulesTouchingColumn('blockings', 'norm_x').includes('S-24'));
  assert.ok(rulesTouchingColumn('sceneState', 'axis_lock').includes('S-07'));
  assert.ok(rulesTouchingColumn('assets', 'category').includes('V-03'));
  // 无失效列不得查出任何规则（除 READ_OVERRIDES 显式升级的那三个）
  assert.deepEqual(rulesTouchingColumn('shots', 'narration'), []);
});

test('分类表覆盖：story_shots 48 列、scene_states 14 列均无重复', () => {
  const flatShot = Object.values(SHOT_COLUMNS).flat();
  assert.equal(flatShot.length, 48);
  assert.equal(new Set(flatShot).size, 48);
  const flatScene = [...Object.values(SCENE_COLUMNS).flat()];
  assert.equal(new Set(flatScene).size, flatScene.length);
});
