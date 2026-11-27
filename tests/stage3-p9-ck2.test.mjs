// P9-E：R-28 八列映射 + CK-2 双向 diff（D02-21 §六/§七）
//
// 三道证据叠在一起才算"闭环"，缺一条都是自证：
//  ① 结构方向（`ck2Audit`）：清单 ↔ 映射，缺映射 / 孤儿 / 空 fields / 未知字段根 / 非法作用域 / 审计集合；
//  ② 运行时方向（`runCk2` + 电池）：映射 ↔ 规则**实际读取**的 ctx 路径（深层 Proxy 采集）；
//  ③ 生产方向（`runSceneQuality`）：真实跑一场戏，确认自检真的在链路里跑过（返回值带 69/69）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-p9-ck2-'));
process.env.IC_DATA_DIR = TMP;
delete process.env.IC_DB_SQLITE_PATH;
delete process.env.IC_DB;
delete process.env.DATABASE_URL;

const { RULES, ruleCatalog } = await import('../lib/core/validate/index.js');
const { RULE_DEPS, RULE_IDS } = await import('../lib/core/qc/deps/rule-deps.js');
const { ck2Audit, ck2Summary, NO_DEPENDENCY_RULES } = await import('../lib/core/qc/deps/ck2.js');
const { runCk2 } = await import('./helpers/ck2.mjs');
const { BATTERY } = await import('./helpers/ck2-battery.mjs');
const { getDb, Chapters } = await import('../lib/core/db.js');
const { createUserProject } = await import('../lib/core/project-create.js');
const { upsertSceneStates } = await import('../lib/core/scene-state.js');
const { insertStoryShot } = await import('../lib/core/render/global-no.js');
const { runSceneQuality } = await import('../lib/core/index.js');

test('K1 结构方向：69 条规则逐条有映射，diffs 全空', () => {
  const res = ck2Audit();
  assert.equal(res.total, 69);
  assert.equal(res.passed, 69, `未通过：${ck2Summary(res)}`);
  assert.equal(res.ok, true, ck2Summary(res));
  const d = res.diffs;
  assert.deepEqual(d.missingMapping, []);
  assert.deepEqual(d.orphanMapping, []);
  assert.deepEqual(d.emptyFields, []);
  assert.deepEqual(d.unknownRoot, []);
  assert.deepEqual(d.badScope, []);
  assert.deepEqual(d.duplicateCatalog, []);
  assert.deepEqual(d.auditMismatch, { declared: [], mapped: [] });
});

test('K2 检查的就是生产那份映射：逐条 fields/scope 与 RULE_DEPS 完全一致', () => {
  const res = ck2Audit();
  assert.deepEqual(res.rows.map((r) => r.rule_id).sort(), [...RULE_IDS].sort());
  for (const row of res.rows) {
    const prod = RULE_DEPS[row.rule_id];
    assert.ok(prod, `${row.rule_id} 在生产映射里不存在`);
    assert.deepEqual(row.fields, prod.fields, `${row.rule_id} 的 fields 与生产映射不一致（说明看了副本）`);
    assert.equal(row.scope, prod.scope);
  }
  // 映射字段总数与生产对象一致（327 = 69 条声明之和，见 D02-14 §7.4）
  const sum = Object.values(RULE_DEPS).reduce((n, d) => n + d.fields.length, 0);
  assert.equal(sum, 327);
});

test('K3 运行时方向：规则实际读取的字段与映射逐条 diff 为空（69/69）', () => {
  const RES = runCk2({ rules: RULES, deps: RULE_DEPS, battery: BATTERY });
  const bad = RES.rows.filter((r) => r.missing.length || r.extra.length || r.throw);
  const detail = bad.map((r) => `${r.rule_id} missing=[${r.missing.join(',')}] extra=[${r.extra.join(',')}]`).join('\n');
  assert.equal(bad.length, 0, `CK-2 运行时 diff 非空：\n${detail}`);
  assert.equal(RES.total.rules, 69);
  assert.equal(RES.total.passed, 69);
});

test('K4 方向 A（清单 → 映射）：新规则没有映射必须报出来，不静默归空', () => {
  const catalog = [...ruleCatalog(), { rule_id: 'V-99', level: 'FAIL', title: '假规则' }];
  const res = ck2Audit({ catalog });
  assert.equal(res.ok, false);
  assert.deepEqual(res.diffs.missingMapping, ['V-99']);
  assert.equal(res.passed, 69);
});

test('K5 方向 B（映射 → 清单）：孤儿映射必须报出来', () => {
  const mapping = { ...RULE_DEPS, 'V-98': { ...RULE_DEPS['V-01'] } };
  const res = ck2Audit({ mapping });
  assert.equal(res.ok, false);
  assert.deepEqual(res.diffs.orphanMapping, ['V-98']);
});

test('K6 空 fields：未登记的新规则算缺陷，V-12 因显式声明而豁免', () => {
  // V-12 的 fields 为空是设计（阶段 4 前恒不适用），必须"显式登记"而不是靠恰好为空
  assert.ok(Object.prototype.hasOwnProperty.call(NO_DEPENDENCY_RULES, 'V-12'));
  const v12 = ck2Audit().rows.find((r) => r.rule_id === 'V-12');
  assert.equal(v12.ok, true);
  assert.equal(v12.declared_no_dependency, true);
  assert.deepEqual(v12.fields, []);

  const mapping = { ...RULE_DEPS, 'V-01': { ...RULE_DEPS['V-01'], fields: [] } };
  const res = ck2Audit({ mapping });
  assert.equal(res.ok, false);
  assert.deepEqual(res.diffs.emptyFields, ['V-01']);
});

test('K7 未知字段根：映射写了上下文里不存在的根 → 报错（否则 Hash 恒为 null）', () => {
  const mapping = { ...RULE_DEPS, 'V-01': { ...RULE_DEPS['V-01'], fields: ['no_such_root.x'] } };
  const res = ck2Audit({ mapping });
  assert.equal(res.ok, false);
  assert.deepEqual(res.diffs.unknownRoot, [{ rule_id: 'V-01', field: 'no_such_root.x' }]);
});

test('K8 非法作用域：scope 不在枚举内必须报错', () => {
  const mapping = { ...RULE_DEPS, 'V-01': { ...RULE_DEPS['V-01'], scope: 'universe' } };
  const res = ck2Audit({ mapping });
  assert.equal(res.ok, false);
  assert.deepEqual(res.diffs.badScope, [{ rule_id: 'V-01', scope: 'universe' }]);
});

test('K9 审计集合必须逐字相等：少一条或多一条都算不一致', () => {
  const res = ck2Audit({ auditIds: ['S-20', 'S-21'] });
  assert.equal(res.ok, false);
  assert.deepEqual(res.diffs.auditMismatch, { declared: ['S-20', 'S-21'], mapped: ['S-20', 'S-21', 'S-25'] });
});

test('K10 重复规则声明：清单里同一 id 出现两次必须报出来', () => {
  const catalog = [...ruleCatalog(), ruleCatalog().find((r) => r.rule_id === 'V-01')];
  const res = ck2Audit({ catalog });
  assert.equal(res.ok, false);
  assert.deepEqual(res.diffs.duplicateCatalog, ['V-01']);
});

test('K11 生产链路真的跑了自检：runSceneQuality 返回 ck2=69/69', () => {
  const db = getDb();
  const p = createUserProject({ name: 'P9-CK2-链路' });
  const ch = Chapters.list(p.id)[0];
  upsertSceneStates(p.id, ch, [{
    scene_key: 'S1', coord_system: { active_area: [8, 5, 3] },
    axis_lock: { pair: ['c1', 'c2'], left: 'c1', right: 'c2', axis_line: [[0.5, 0], [0.5, 1]] }, time_of_day: '夜',
  }]);
  const r = insertStoryShot({
    project_id: p.id, chapter_id: ch.id, scene_key: 'S1', shot_no: 1, global_no: 1,
    spec_source: 'manual', story_duration: 4, speakers: [{ id: 'c1', type: 'on_screen' }],
    time_slices: [{ from: 0, to: 4 }],
  });
  db.prepare(
    'INSERT INTO shot_blockings (shot_id, character_id, position_abs, norm_x, norm_y, norm_z, norm_confidence,'
    + ' position_track, anchor_object, facing, gaze_target, posture, in_frame) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
  ).run(r.id, 'c1', '画面左', 0.3, 0.7, 0, 0.95, '[]', 'fx_table', 'W', 'c2', 'standing', 1);

  const out = runSceneQuality({ projectId: p.id, sceneKey: 'S1' });
  assert.deepEqual(out.ck2, { total: 69, passed: 69 }, '自检没有在真实链路上跑（或没跑全）');
  // 报告确实基于这份映射算出了 rule_dependency_hash
  const hit = JSON.parse(db.prepare('SELECT hits FROM qc_reports WHERE target_id = ?').get(r.id).hits)
    .filter((h) => !String(h.rule_id).startsWith('__') && h.applicable === true);
  assert.ok(hit.length > 0);
  for (const h of hit) assert.match(String(h.rule_dependency_hash), /^sha256:/);
});
