// P9-C：QC 报告持久化与报告级规则消费（D02-21 §四/§五）
//
// 关注四件事：`hits` 是否符合 D02-06 §8.5（一条规则一条、pass 也入列、带依赖 Hash）、
// `__solver_input` 是否与状态侧同值、`reportLevelRules` 是否**真的**决定跑哪些审计规则、
// 以及"同输入复跑不产新行 / 输入变了保留历史"是否成立。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-p9-report-'));
process.env.IC_DATA_DIR = TMP;
delete process.env.IC_DB_SQLITE_PATH;
delete process.env.IC_DB;
delete process.env.DATABASE_URL;

const { getDb, Chapters } = await import('../lib/core/db.js');
const { createUserProject } = await import('../lib/core/project-create.js');
const { upsertSceneStates } = await import('../lib/core/scene-state.js');
const { insertStoryShot } = await import('../lib/core/render/global-no.js');
const {
  runSceneQuality, latestReport, reportHistory, readReport, REPORT_TARGET_TYPE,
  SOLVER_INPUT_ENTRY,
} = await import('../lib/core/index.js');

const db = getDb();
const SCENE = 'S01_病房';
let seq = 0;

function seedScene({ shots = 2, purpose } = {}) {
  seq += 1;
  const p = createUserProject({ name: `P9-报告-${seq}` });
  const ch = Chapters.list(p.id)[0];
  upsertSceneStates(p.id, ch, [{
    scene_key: SCENE,
    coord_system: { active_area: [8, 5, 3] },
    axis_lock: { pair: ['c1', 'c2'], left: 'c1', right: 'c2', axis_line: [[0.5, 0], [0.5, 1]] },
    time_of_day: '夜',
  }]);
  const ids = [];
  for (let i = 1; i <= shots; i += 1) {
    const r = insertStoryShot({
      project_id: p.id, chapter_id: ch.id, scene_key: SCENE,
      shot_no: i, global_no: i,
      spec_source: i === 1 ? 'manual' : 'ai',
      story_duration: 4,
      speakers: [{ id: 'c1', type: 'on_screen' }],
      time_slices: [{ from: 0, to: 4 }],
      ...(purpose ? { purpose } : {}),
    });
    ids.push(r.id);
    db.prepare(
      'INSERT INTO shot_blockings (shot_id, character_id, position_abs, norm_x, norm_y, norm_z, norm_confidence,'
      + ' position_track, anchor_object, facing, gaze_target, posture, in_frame) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
    ).run(r.id, 'c1', '画面左', 0.30 + 0.02 * (i - 1), 0.70, 0, 0.95, '[]', 'fx_table', 'W', 'c2', 'standing', 1);
  }
  return { p, ids };
}

const reportRows = (shotId) => db.prepare('SELECT * FROM qc_reports WHERE target_id = ? ORDER BY created_at ASC, rowid ASC').all(shotId);

test('R1 报告落库形状：target_type=shot、规则集版本、level 四值之一、hits 一条规则一条', () => {
  const { p, ids } = seedScene({ shots: 2 });
  const out = runSceneQuality({ projectId: p.id, sceneKey: SCENE });

  const rows = reportRows(ids[0]);
  assert.equal(rows.length, 1);
  const row = rows[0];
  assert.equal(row.project_id, p.id);
  assert.equal(row.target_type, REPORT_TARGET_TYPE);
  assert.equal(row.target_type, 'shot');
  assert.equal(row.target_id, ids[0]);
  assert.equal(row.ruleset_ver, 'd01-v7/stage3.1');
  assert.ok(['pass', 'warn', 'fail', 'info'].includes(row.level), `level 非法：${row.level}`);
  assert.equal(out.reports.length, 2);

  const hits = JSON.parse(row.hits);
  const ruleHits = hits.filter((h) => !String(h.rule_id).startsWith('__'));
  assert.equal(ruleHits.length, 69, '69 条规则必须逐条入列（含 pass）');
  const ids2 = ruleHits.map((h) => h.rule_id);
  assert.equal(new Set(ids2).size, ids2.length, '同一报告内 rule_id 必须唯一（QL-1）');
  assert.equal(hits.filter((h) => h.rule_id === SOLVER_INPUT_ENTRY).length, 1, '__solver_input 必须有且仅有一条（QL-5）');
});

test('R2 hits 结构完整：pass 也入列（QL-2）、source=run、applicable 为布尔', () => {
  const { p, ids } = seedScene({ shots: 1 });
  runSceneQuality({ projectId: p.id, sceneKey: SCENE });
  const hits = JSON.parse(reportRows(ids[0])[0].hits);

  const passEntries = hits.filter((h) => h.applicable === true && h.level === 'pass');
  assert.ok(passEntries.length > 0, '全通过时也必须有 pass 条目，否则 verifiable_ratio 不可算');
  for (const h of passEntries) assert.equal(h.code, 'PASS');
  for (const h of hits) {
    if (String(h.rule_id).startsWith('__')) continue;
    assert.equal(typeof h.applicable, 'boolean', `${h.rule_id} 的 applicable 不是布尔`);
    assert.ok(['run', 'report_level'].includes(h.source), `${h.rule_id} 的 source 非法：${h.source}`);
    assert.equal(typeof h.carried_from, 'string');
    assert.ok(Array.isArray(h.fields));
  }
  // 不适用的条目：level 必须为空串（QL-3），不能伪装成 pass
  for (const h of hits.filter((x) => x.applicable === false && !String(x.rule_id).startsWith('__'))) {
    assert.equal(h.level, '');
  }
});

test('R3 每条适用规则都带 rule_dependency_hash（QL-8），不适用为空串', () => {
  const { p, ids } = seedScene({ shots: 1 });
  runSceneQuality({ projectId: p.id, sceneKey: SCENE });
  const hits = JSON.parse(reportRows(ids[0])[0].hits).filter((h) => !String(h.rule_id).startsWith('__'));
  const applicable = hits.filter((h) => h.applicable === true);
  assert.ok(applicable.length > 0);
  for (const h of applicable) {
    assert.match(String(h.rule_dependency_hash), /^sha256:[0-9a-f]{64}$/, `${h.rule_id} 缺依赖 Hash`);
  }
  for (const h of hits.filter((x) => x.applicable === false)) assert.equal(h.rule_dependency_hash, '');
});

test('R4 __solver_input 的 qc_input_hash 与 shot_states.meta.__solver.hash 同值（SH-4/SH-10）', () => {
  const { p, ids } = seedScene({ shots: 2 });
  const out = runSceneQuality({ projectId: p.id, sceneKey: SCENE });
  const hit = JSON.parse(reportRows(ids[0])[0].hits).find((h) => h.rule_id === SOLVER_INPUT_ENTRY);
  assert.equal(hit.detail.qc_input_hash, out.solveHash);
  assert.equal(hit.detail.solver_version, out.solverVersion);
  assert.match(String(hit.detail.rule_dependency_set), /^sha256:[0-9a-f]{64}$/);

  for (const id of ids) {
    const meta = JSON.parse(db.prepare('SELECT meta FROM shot_states WHERE shot_id = ?').get(id).meta);
    assert.equal(meta.__solver.hash, hit.detail.qc_input_hash, '状态侧与报告侧的输入 Hash 不一致');
  }
});

test('R5 reportLevelRules 被真实消费：默认三条、传空则一条审计规则都不跑、传一条只跑那一条', () => {
  const all = seedScene({ shots: 1 });
  const a = runSceneQuality({ projectId: all.p.id, sceneKey: SCENE });
  assert.deepEqual(a.reportLevelRules, ['S-20', 'S-21', 'S-25']);
  let hits = JSON.parse(reportRows(all.ids[0])[0].hits);
  for (const id of ['S-20', 'S-21', 'S-25']) {
    const one = hits.filter((h) => h.rule_id === id);
    assert.equal(one.length, 1, `${id} 在报告里出现了 ${one.length} 次（QL-1 违规）`);
    assert.equal(one[0].source, 'report_level');
  }

  const none = seedScene({ shots: 1 });
  const b = runSceneQuality({ projectId: none.p.id, sceneKey: SCENE, plan: { reportLevelRules: [] } });
  assert.deepEqual(b.reportLevelRules, []);
  hits = JSON.parse(reportRows(none.ids[0])[0].hits);
  for (const id of ['S-20', 'S-21', 'S-25']) {
    assert.equal(hits.some((h) => h.rule_id === id), false, `${id} 不在 reportLevelRules 里却被执行了`);
  }
  assert.equal(hits.filter((h) => !String(h.rule_id).startsWith('__')).length, 66);

  const one = seedScene({ shots: 1 });
  const c = runSceneQuality({ projectId: one.p.id, sceneKey: SCENE, plan: { reportLevelRules: ['S-20'] } });
  assert.deepEqual(c.reportLevelRules, ['S-20']);
  hits = JSON.parse(reportRows(one.ids[0])[0].hits);
  assert.equal(hits.filter((h) => h.rule_id === 'S-20').length, 1);
  assert.equal(hits.some((h) => h.rule_id === 'S-21'), false);
  assert.equal(hits.some((h) => h.rule_id === 'S-25'), false);
});

test('R6 非法 reportLevelRules 被拒：非审计级 / 逆序 / 重复', () => {
  const { p } = seedScene({ shots: 1 });
  for (const bad of [['V-01'], ['S-25', 'S-20'], ['S-20', 'S-20'], 'S-20', [42]]) {
    assert.throws(
      () => runSceneQuality({ projectId: p.id, sceneKey: SCENE, plan: { reportLevelRules: bad } }),
      (e) => e.code === 'QC_REPORT_INVALID',
      `应拒绝：${JSON.stringify(bad)}`,
    );
  }
  // 拒绝发生在写库之前：报告一行都不该有
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM qc_reports WHERE project_id = ?').get(p.id).c, 0);
});

test('R7 同输入重复执行：复用同一份报告，不插新行', () => {
  const { p, ids } = seedScene({ shots: 2 });
  const first = runSceneQuality({ projectId: p.id, sceneKey: SCENE });
  const second = runSceneQuality({ projectId: p.id, sceneKey: SCENE });

  for (const [i, id] of ids.entries()) {
    assert.equal(second.reports[i].reused, true);
    assert.equal(second.reports[i].report_id, first.reports[i].report_id);
    assert.equal(reportRows(id).length, 1, '同输入不该产生第二份报告');
  }
});

test('R8 输入变化：落新报告、旧报告保留为历史，latest 指向新的', () => {
  const { p, ids } = seedScene({ shots: 1 });
  const first = runSceneQuality({ projectId: p.id, sceneKey: SCENE });
  db.prepare('UPDATE shot_blockings SET posture = ? WHERE shot_id = ?').run('sitting', ids[0]);
  const second = runSceneQuality({ projectId: p.id, sceneKey: SCENE });

  assert.notEqual(second.solveHash, first.solveHash, '输入变了，Hash 必须变');
  assert.equal(second.reports[0].reused, false);
  assert.notEqual(second.reports[0].report_id, first.reports[0].report_id);

  const history = reportHistory(ids[0]);
  assert.equal(history.length, 2, '旧报告不得被覆盖');
  assert.equal(history[0].id, second.reports[0].report_id, '历史按时间倒序，最新的在最前');
  assert.equal(latestReport(ids[0]).id, second.reports[0].report_id);
  assert.equal(latestReport(ids[0]).solver_input.qc_input_hash, second.solveHash);

  // 旧报告仍可按 id 取回，且它的输入 Hash 是旧的 —— 不会被当成本轮结论
  const old = readReport(first.reports[0].report_id);
  assert.equal(old.solver_input.qc_input_hash, first.solveHash);
  assert.notEqual(old.solver_input.qc_input_hash, latestReport(ids[0]).solver_input.qc_input_hash);
});

test('R9 统计口径：rules_total=69，报告级三条单列，pass 计数与 applicable 一致', () => {
  const { p, ids } = seedScene({ shots: 1 });
  const out = runSceneQuality({ projectId: p.id, sceneKey: SCENE });
  assert.equal(out.shotCount, 1);
  const hits = JSON.parse(reportRows(ids[0])[0].hits).filter((h) => !String(h.rule_id).startsWith('__'));
  const applicable = hits.filter((h) => h.applicable === true);
  assert.equal(hits.length, 69);
  assert.equal(applicable.length + hits.filter((h) => h.applicable === false).length, 69);
  assert.equal(hits.filter((h) => h.source === 'report_level').length, 3);
  // 每条命中都带 rule_id 与 code，便于定位
  for (const h of hits) {
    assert.ok(h.rule_id && typeof h.code === 'string');
  }
});

test('R10 报告与镜头一一对应：不同镜各自一份，target_id 不串', () => {
  const { p, ids } = seedScene({ shots: 3 });
  const out = runSceneQuality({ projectId: p.id, sceneKey: SCENE });
  assert.deepEqual(out.reports.map((r) => r.shot_id).sort(), [...ids].sort());
  for (const id of ids) {
    const rows = reportRows(id);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].target_id, id);
    assert.equal(JSON.parse(rows[0].hits).find((h) => h.rule_id === SOLVER_INPUT_ENTRY).detail.qc_input_hash, out.solveHash);
  }
});
