// P9-R1：规则级 carried + 元数据契约 + 历史复用（D02-22 §R1-1/§R1-3/§R1-4）
//
// 这一组全部走**真实生产链路** `runSceneQuality()`（真实 sqlite + 真实 `planInvalidation` 产物），
// 不在测试里手搓 carried 对象 —— 手搓只能证明"函数能接受这个形状"，证明不了"链路真的会这样产出"。
// 唯一的例外是 QR-10 的反例：它的目的就是证明"错误的 carried 会被拦下"，只能注入。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-p9r1-'));
process.env.IC_DATA_DIR = TMP;
delete process.env.IC_DB_SQLITE_PATH;
delete process.env.IC_DB;
delete process.env.DATABASE_URL;

const { getDb, Chapters } = await import('../lib/core/db.js');
const { createUserProject } = await import('../lib/core/project-create.js');
const { upsertSceneStates } = await import('../lib/core/scene-state.js');
const { insertStoryShot } = await import('../lib/core/render/global-no.js');
const { planInvalidation } = await import('../lib/core/continuity/invalidate.js');
const {
  runSceneQuality, loadSceneInput, latestReport, reportHistory, assertCarriedIntegrity,
  solverInputOf, SOLVER_INPUT_ENTRY,
} = await import('../lib/core/index.js');

const db = getDb();
const SCENE = 'S01_病房';
let seq = 0;

function seedScene({ shots = 2 } = {}) {
  seq += 1;
  const p = createUserProject({ name: `P9R1-${seq}` });
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
      shot_no: i, global_no: i, spec_source: 'ai', story_duration: 4,
      speakers: [{ id: 'c1', type: 'on_screen' }], time_slices: [{ from: 0, to: 4 }],
    });
    ids.push(r.id);
    db.prepare(
      'INSERT INTO shot_blockings (shot_id, character_id, position_abs, norm_x, norm_y, norm_z, norm_confidence,'
      + ' position_track, anchor_object, facing, gaze_target, posture, in_frame) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
    ).run(r.id, 'c1', '画面左', 0.30 + 0.02 * (i - 1), 0.70, 0, 0.95, '[]', 'fx_table', 'W', 'c2', 'standing', 1);
    db.prepare(
      'INSERT INTO shot_actions (id, shot_id, actor_id, action_type, is_primary, tier, t_from, t_to, body_parts)'
      + ' VALUES (?,?,?,?,?,?,?,?,?)',
    ).run(`act_${seq}_${i}`, r.id, 'c1', 'expression', 1, 'T1', 0, 2, '[]');
  }
  return { p, ids, ch };
}

const planFor = (p, shotId, fields) => {
  const loaded = loadSceneInput({ projectId: p.id, sceneKey: SCENE });
  return {
    loaded,
    plan: planInvalidation({
      change: { shots: [{ shot_id: shotId, fields }] },
      shots: loaded.rows,
      sceneStates: loaded.sceneState ? [loaded.sceneState] : [],
      shotAssets: [],
    }),
  };
};

const reportOf = (shotId) => latestReport(shotId);
const ruleHits = (rep) => rep.hits.filter((h) => !String(h.rule_id).startsWith('__'));
const byId = (rep) => new Map(ruleHits(rep).map((h) => [h.rule_id, h]));

test('C1 carried 走生产链路：QIS 内实跑、其余继承上一份报告，来源指向实际报告 id', () => {
  const { p, ids } = seedScene({ shots: 2 });
  const first = runSceneQuality({ projectId: p.id, sceneKey: SCENE });
  const firstReportId = first.reports.find((r) => r.shot_id === ids[1]).report_id;

  // 改一个只影响部分规则的字段
  db.prepare('UPDATE story_shots SET dialogue = ? WHERE id = ?').run('你听见了吗', ids[1]);
  const { plan } = planFor(p, ids[1], ['dialogue']);
  const qis = plan.qcInvalidationSet[ids[1]].rules;
  assert.ok(qis.length > 0, 'QIS 为空说明这个 change 根本没被判为"要重跑"，测不到 carried');

  const second = runSceneQuality({ projectId: p.id, sceneKey: SCENE, plan });
  const rep = reportOf(ids[1]);
  const hits = ruleHits(rep);
  const carried = hits.filter((h) => h.source === 'carried');
  const run = hits.filter((h) => h.source === 'run');

  // QL-6：QIS 内必须实跑
  for (const id of qis) {
    const hit = hits.find((h) => h.rule_id === id);
    assert.ok(hit, `${id} 在 QIS 内却没有条目`);
    assert.equal(hit.source, 'run', `${id} 在 QIS 内却标为 ${hit.source}`);
  }
  // 没变化的规则才允许继承，且来源必须指向上一份报告
  assert.ok(carried.length > 0, '一条都没继承：carried 没有真正发生');
  for (const c of carried) {
    assert.equal(qis.includes(c.rule_id), false, `${c.rule_id} 在 QIS 内却被继承`);
    assert.equal(c.carried_from, firstReportId, `${c.rule_id} 的 carried_from 不是上一份报告`);
  }
  // 报告级三条仍然实跑（U-P6-2 #4：不得 carried）
  const levelRules = hits.filter((h) => h.source === 'report_level').map((h) => h.rule_id).sort();
  assert.deepEqual(levelRules, ['S-20', 'S-21', 'S-25']);
  // 规则总数不变：实跑 + 继承 + 报告级 = 69（不是"继承之后就少了几条"）
  assert.equal(run.length + carried.length + levelRules.length, 69);
  assert.equal(second.reports.find((r) => r.shot_id === ids[1]).reused, false);
});

test('C2 QR-11：局部重建的覆盖与继承集合可逐条核对（run ⊇ QIS，carried = 其余且 Hash 相等）', () => {
  const { p, ids } = seedScene({ shots: 2 });
  runSceneQuality({ projectId: p.id, sceneKey: SCENE });
  db.prepare('UPDATE story_shots SET dialogue = ? WHERE id = ?').run('换个说法', ids[0]);
  const { plan } = planFor(p, ids[0], ['dialogue']);
  const qis = plan.qcInvalidationSet[ids[0]].rules;
  runSceneQuality({ projectId: p.id, sceneKey: SCENE, plan });

  const rep = reportOf(ids[0]);
  const hits = ruleHits(rep);
  const runIds = new Set(hits.filter((h) => h.source === 'run').map((h) => h.rule_id));
  const carriedIds = new Set(hits.filter((h) => h.source === 'carried').map((h) => h.rule_id));

  for (const id of qis) assert.ok(runIds.has(id), `QL-7：${id} 在 QIS 内但没实跑`);
  // 两个集合不相交、并集等于非报告级规则全集
  for (const id of carriedIds) assert.equal(runIds.has(id), false);
  const levelIds = new Set(hits.filter((h) => h.source === 'report_level').map((h) => h.rule_id));
  assert.equal(runIds.size + carriedIds.size + levelIds.size, 69);
});

test('C3 单条规则变化不连坐：报告级依赖 Hash 变了，其余规则仍继承', () => {
  const { p, ids } = seedScene({ shots: 2 });
  const first = runSceneQuality({ projectId: p.id, sceneKey: SCENE });
  const beforeReport = first.reports.find((r) => r.shot_id === ids[1]);

  db.prepare('UPDATE story_shots SET dialogue = ? WHERE id = ?').run('新的台词', ids[1]);
  const { plan } = planFor(p, ids[1], ['dialogue']);
  runSceneQuality({ projectId: p.id, sceneKey: SCENE, plan });

  const after = reportOf(ids[1]);
  assert.notEqual(after.solver_input.qc_dependency_hash, beforeReport.qc_dependency_hash,
    '依赖集合摘要没变，说明这条 change 没影响任何规则，用例前提不成立');
  const carried = ruleHits(after).filter((h) => h.source === 'carried');
  assert.ok(carried.length > 0, '报告级 Hash 一变就把所有规则都重跑了（V6 的缺陷）');
  assert.ok(carried.length > 10, `继承的规则太少（${carried.length}），粒度不对`);
});

test('C4 QL-9：继承不改变结论 —— 同样的数据，带 plan 的报告与全量重建逐项一致', () => {
  // 两个项目、同样的镜头数据：A 走"局部 QIS + 继承"，B 走全量重建，结论必须一致。
  // （在同一场景里比对做不到：数据一变，全量重建的输入就不是同一份了。）
  const a = seedScene({ shots: 2 });
  const b = seedScene({ shots: 2 });
  runSceneQuality({ projectId: a.p.id, sceneKey: SCENE });
  runSceneQuality({ projectId: b.p.id, sceneKey: SCENE });

  for (const s of [a, b]) {
    db.prepare('UPDATE story_shots SET dialogue = ? WHERE id = ?').run('同一句台词', s.ids[1]);
  }

  const { plan } = planFor(a.p, a.ids[1], ['dialogue']);
  const withCarried = runSceneQuality({ projectId: a.p.id, sceneKey: SCENE, plan });
  const full = runSceneQuality({ projectId: b.p.id, sceneKey: SCENE });

  const repA = latestReport(a.ids[1]);
  const repB = latestReport(b.ids[1]);
  const hitsA = ruleHits(repA);
  const hitsB = ruleHits(repB);

  assert.ok(hitsA.some((h) => h.source === 'carried'), 'A 侧没有发生继承，用例前提不成立');
  assert.equal(hitsB.filter((h) => h.source === 'carried').length, 0, 'B 侧不该有继承');

  assert.equal(repA.level, repB.level, 'level 被 carried 改变了');
  for (const lv of ['fail', 'warn', 'pass', 'info']) {
    assert.equal(hitsA.filter((h) => h.applicable === true && h.level === lv).length,
      hitsB.filter((h) => h.applicable === true && h.level === lv).length, `${lv} 计数变了`);
  }
  assert.equal(withCarried.gate.decision, full.gate.decision);
});

test('C5 QR-10：错误标成 carried（Hash 已变）会被拦下，抛 QC_CARRIED_STALE', () => {
  const hits = [{
    rule_id: 'V-01', code: 'PASS', level: 'pass', applicable: true,
    source: 'carried', carried_from: 'rep_old', rule_dependency_hash: 'sha256:stale',
  }];
  assert.throws(
    () => assertCarriedIntegrity(hits, { currentHashes: { 'V-01': 'sha256:fresh' }, qis: [], prevReportId: 'rep_old' }),
    (e) => e.code === 'QC_CARRIED_STALE',
  );
  // 结构性错误另有错误码，不被当成"过期"
  assert.throws(
    () => assertCarriedIntegrity([{ ...hits[0], rule_dependency_hash: 'sha256:fresh' }],
      { currentHashes: { 'V-01': 'sha256:fresh' }, qis: ['V-01'], prevReportId: 'rep_old' }),
    (e) => e.code === 'QC_CARRIED_INVALID',
  );
  assert.throws(
    () => assertCarriedIntegrity([], { currentHashes: {}, qis: ['V-01'], prevReportId: 'rep_old' }),
    (e) => e.code === 'QC_RUN_COVERAGE_MISSING',
  );
});

test('C6 `__solver_input` 六字段 + hash_relation：首次 same，输入变而内容不变时 state_older', () => {
  const { p, ids } = seedScene({ shots: 1 });
  runSceneQuality({ projectId: p.id, sceneKey: SCENE });
  let meta = solverInputOf(reportOf(ids[0]).hits);
  for (const k of ['qc_input_hash', 'state_snapshot_hash', 'qc_dependency_hash', 'ruleset_ver', 'hash_algo_ver', 'solver_version']) {
    assert.ok(meta[k], `缺字段 ${k}`);
  }
  assert.equal(meta.ruleset_ver, 'd01-v7/stage3.1');
  assert.equal(meta.hash_algo_ver, 'qcdep-2');
  assert.equal(meta.solver_version, 'stage3.1');
  assert.match(meta.qc_input_hash, /^sha256:[0-9a-f]{64}$/);
  assert.match(meta.state_snapshot_hash, /^sha256:[0-9a-f]{64}$/);
  assert.match(meta.qc_dependency_hash, /^sha256:[0-9a-f]{64}$/);
  assert.equal(meta.hash_relation, 'same');
  assert.equal(meta.state_snapshot_hash, meta.qc_input_hash);
  // 状态快照必须等于库里那一行的 __solver.hash
  assert.equal(meta.state_snapshot_hash, JSON.parse(db.prepare('SELECT meta FROM shot_states WHERE shot_id = ?').get(ids[0]).meta).__solver.hash);

  // 输入变（power_level 进 Hash）但派生内容不变 → 状态行不重写 → state_older
  db.prepare('UPDATE shot_blockings SET power_level = ? WHERE shot_id = ?').run('high', ids[0]);
  const out = runSceneQuality({ projectId: p.id, sceneKey: SCENE });
  meta = solverInputOf(reportOf(ids[0]).hits);
  assert.equal(meta.hash_relation, 'state_older');
  assert.notEqual(meta.state_snapshot_hash, meta.qc_input_hash);
  assert.equal(meta.qc_input_hash, out.solveHash);
  assert.equal(meta.state_snapshot_hash, out.reports[0].state_snapshot_hash);
});

test('C7 历史报告缺失时不伪造 carried：清空历史 → 全部实跑', () => {
  const { p, ids } = seedScene({ shots: 1 });
  runSceneQuality({ projectId: p.id, sceneKey: SCENE });
  db.prepare('DELETE FROM qc_reports WHERE target_id = ?').run(ids[0]);

  const { plan } = planFor(p, ids[0], ['dialogue']);
  runSceneQuality({ projectId: p.id, sceneKey: SCENE, plan });
  const hits = ruleHits(reportOf(ids[0]));
  assert.equal(hits.filter((h) => h.source === 'carried').length, 0, '没有历史却产出了 carried');
  assert.equal(hits.filter((h) => h.source === 'run').length, 66);
});

test('C8 规则集版本不一致时不继承：旧版本报告不当作可比历史', () => {
  const { p, ids } = seedScene({ shots: 1 });
  runSceneQuality({ projectId: p.id, sceneKey: SCENE });
  const cur = reportOf(ids[0]);
  // 造一份"上一版规则集"的报告（只改 ruleset_ver，内容照抄），并让它成为最新
  db.prepare(
    'INSERT INTO qc_reports (id, project_id, target_type, target_id, ruleset_ver, level, hits, created_at)'
    + ' VALUES (?,?,?,?,?,?,?,?)',
  ).run('rep_old_ruleset', p.id, 'shot', ids[0], 'd01-v7/stage3.0', cur.level, JSON.stringify(cur.hits), Date.now() + 1000);
  assert.equal(reportOf(ids[0]).ruleset_ver, 'd01-v7/stage3.0');

  const { plan } = planFor(p, ids[0], ['dialogue']);
  runSceneQuality({ projectId: p.id, sceneKey: SCENE, plan });
  const hits = ruleHits(reportOf(ids[0]));
  assert.equal(hits.filter((h) => h.source === 'carried').length, 0, '跨规则集版本继承了历史');
});

test('C9 A→B→A（R1-4）：恢复旧输入要新增当前报告，latestReport 不得停在 B', () => {
  const { p, ids } = seedScene({ shots: 1 });
  const a1 = runSceneQuality({ projectId: p.id, sceneKey: SCENE });
  const idA1 = a1.reports[0].report_id;
  const hashA = a1.solveHash;

  // 用**求解输入**里的字段（norm_x 在求解 Hash 内；dialogue 不在，改它 Hash 不变，测不到恢复）
  db.prepare('UPDATE shot_blockings SET norm_x = ? WHERE shot_id = ?').run(0.35, ids[0]);
  const b = runSceneQuality({ projectId: p.id, sceneKey: SCENE });
  const idB = b.reports[0].report_id;
  assert.notEqual(b.solveHash, hashA, 'B 的输入 Hash 应与 A 不同');

  // 恢复成 A
  db.prepare('UPDATE shot_blockings SET norm_x = ? WHERE shot_id = ?').run(0.30, ids[0]);
  const a2 = runSceneQuality({ projectId: p.id, sceneKey: SCENE });
  const idA2 = a2.reports[0].report_id;
  assert.equal(a2.solveHash, hashA, '输入确实恢复了');
  assert.notEqual(idA2, idA1, '恢复旧输入时复用了最早那份报告');
  assert.notEqual(idA2, idB);

  const latest = latestReport(ids[0]);
  assert.equal(latest.id, idA2, 'latestReport 仍停在 B');
  assert.equal(latest.solver_input.qc_input_hash, hashA);
  assert.deepEqual(reportHistory(ids[0]).map((r) => r.id).sort(), [idA1, idA2, idB].sort(), '历史不得被覆盖');

  // 再跑一次同样的 A：与最新那份一致 → 复用，不插第四份
  const a3 = runSceneQuality({ projectId: p.id, sceneKey: SCENE });
  assert.equal(a3.reports[0].reused, true);
  assert.equal(a3.reports[0].report_id, idA2);
  assert.equal(reportHistory(ids[0]).length, 3);
});

test('C10 carried 条目沿用历史结论字段（code/level/field 与来源报告一致）', () => {
  const { p, ids } = seedScene({ shots: 2 });
  runSceneQuality({ projectId: p.id, sceneKey: SCENE });
  const prev = byId(reportOf(ids[1]));

  db.prepare('UPDATE story_shots SET dialogue = ? WHERE id = ?').run('第三版', ids[1]);
  const { plan } = planFor(p, ids[1], ['dialogue']);
  runSceneQuality({ projectId: p.id, sceneKey: SCENE, plan });

  const carried = ruleHits(reportOf(ids[1])).filter((h) => h.source === 'carried');
  assert.ok(carried.length > 0);
  for (const c of carried) {
    const old = prev.get(c.rule_id);
    assert.equal(c.level, old.level, `${c.rule_id} 的档位被继承改写了`);
    assert.equal(c.code, old.code);
    assert.equal(c.field, old.field);
    assert.deepEqual(c.fields, old.fields);
    // 规则级 Hash 等于历史值（Hash 相等才允许继承）
    assert.equal(c.rule_dependency_hash, old.rule_dependency_hash);
  }
});
