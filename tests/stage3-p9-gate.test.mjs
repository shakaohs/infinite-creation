// P9-D：自动门禁（D02-21 §八）
//
// 两条必须同时成立才叫"接上了"：
//  · 真实链路：跑一场戏 → 报告 → 门禁；普通情况自动通过，出现 `fail` 才暂停；
//  · 判定口径：门禁吃的是**报告级结论**，不是某一条规则的结果；`applicable:false` 与
//    `__` 元数据条目都不许阻断（否则"判不了"会被当成"没过"，门禁会变得又吵又不可信）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-p9-gate-'));
process.env.IC_DATA_DIR = TMP;
delete process.env.IC_DB_SQLITE_PATH;
delete process.env.IC_DB;
delete process.env.DATABASE_URL;

const { getDb, Chapters } = await import('../lib/core/db.js');
const { createUserProject } = await import('../lib/core/project-create.js');
const { upsertSceneStates } = await import('../lib/core/scene-state.js');
const { insertStoryShot } = await import('../lib/core/render/global-no.js');
const { runSceneQuality, gateOf, GATE_PASS, GATE_PAUSE } = await import('../lib/core/index.js');

const db = getDb();
const SCENE = 'S01_病房';
let seq = 0;

function seedScene({ shots = 2 } = {}) {
  seq += 1;
  const p = createUserProject({ name: `P9-门禁-${seq}` });
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
    // 每镜给一个主动作：A-01 要求 ≥1 个 is_primary=1（纯空镜除外），没有它门禁必然 fail
    db.prepare(
      'INSERT INTO shot_actions (id, shot_id, actor_id, action_type, is_primary, tier, t_from, t_to, body_parts)'
      + ' VALUES (?,?,?,?,?,?,?,?,?)',
    ).run(`act_${seq}_${i}`, r.id, 'c1', 'expression', 1, 'T1', 0, 2, '[]');
  }
  return { p, ids };
}

const entry = (o = {}) => ({
  rule_id: 'V-02', code: 'ENUM_INVALID', level: 'fail', applicable: true,
  source: 'run', carried_from: '', field: 'shot.purpose', fields: ['shot.purpose'], expected: 'enum', detail: {},
  ...o,
});

test('G1 真实链路：正常数据自动通过（警告不阻断）', () => {
  const { p, ids } = seedScene({ shots: 2 });
  const out = runSceneQuality({ projectId: p.id, sceneKey: SCENE });
  assert.equal(out.gate.decision, GATE_PASS, `不该暂停：${JSON.stringify(out.gate.blocking)}`);
  assert.deepEqual(out.gate.blocking, []);
  assert.equal(out.gate.counts.reports, ids.length);
  assert.ok(out.gate.reasons.length >= 1);
});

test('G2 真实链路：出现 fail 自动暂停，且能指到镜头 / 规则 / 字段', () => {
  const { p, ids } = seedScene({ shots: 2 });
  db.prepare('UPDATE story_shots SET purpose = ? WHERE id = ?').run('NOT_A_PURPOSE', ids[1]);

  const out = runSceneQuality({ projectId: p.id, sceneKey: SCENE });
  assert.equal(out.gate.decision, GATE_PAUSE);
  assert.equal(out.gate.level, 'fail');
  const hit = out.gate.blocking.find((b) => b.rule_id === 'V-02');
  assert.ok(hit, `阻断理由里没有 V-02：${JSON.stringify(out.gate.blocking)}`);
  assert.equal(hit.shot_id, ids[1]);
  assert.equal(hit.field, 'shot.purpose');
  assert.ok(hit.code);
  // 理由是人能读的，且必须含镜头与规则
  assert.ok(out.gate.reasons.some((r) => r.includes('V-02') && r.includes(ids[1])), out.gate.reasons.join(' / '));
});

test('G3 没有报告不默认放行：空报告集合直接暂停', () => {
  const g = gateOf([]);
  assert.equal(g.decision, GATE_PAUSE);
  assert.match(g.reasons.join(' '), /QC_REPORT_MISSING/);
});

test('G4 warn / info / pass 都不阻断；只有 fail 阻断', () => {
  for (const lv of ['pass', 'warn', 'info']) {
    const g = gateOf([{ target_id: 'sh_1', level: lv, hits: [entry({ level: lv, code: 'X' })] }]);
    assert.equal(g.decision, GATE_PASS, `${lv} 不该阻断`);
    assert.deepEqual(g.blocking, []);
  }
  const bad = gateOf([{ target_id: 'sh_1', level: 'fail', hits: [entry()] }]);
  assert.equal(bad.decision, GATE_PAUSE);
});

test('G5 不适用（applicable=false）的 fail 档不阻断 —— "判不了"不是"没过"', () => {
  const g = gateOf([{
    target_id: 'sh_1',
    level: 'pass',
    hits: [entry({ applicable: false, level: 'fail', code: 'NOT_APPLICABLE' })],
  }]);
  assert.equal(g.decision, GATE_PASS);
  assert.deepEqual(g.blocking, []);
});

test('G6 `__` 元数据条目即使写成 fail 也不阻断（它不是规则结论）', () => {
  const g = gateOf([{
    target_id: 'sh_1',
    level: 'pass',
    hits: [entry({ rule_id: '__solver_input', level: 'fail', applicable: true })],
  }]);
  assert.equal(g.decision, GATE_PASS);
});

test('G7 报告级 level=fail 但没有可定位条目时仍然暂停（保守，不放过）', () => {
  const g = gateOf([{ target_id: 'sh_1', level: 'fail', hits: [entry({ applicable: false, level: 'fail' })] }]);
  assert.equal(g.decision, GATE_PAUSE);
  assert.deepEqual(g.blocking, []);
  assert.match(g.reasons.join(' '), /未定位到具体条目/);
});

test('G8 修复后重试：恢复合法值即放行，且不产生重复状态/重复报告', () => {
  const { p, ids } = seedScene({ shots: 2 });
  db.prepare('UPDATE story_shots SET purpose = ? WHERE id = ?').run('NOT_A_PURPOSE', ids[0]);
  const broken = runSceneQuality({ projectId: p.id, sceneKey: SCENE });
  assert.equal(broken.gate.decision, GATE_PAUSE);

  db.prepare('UPDATE story_shots SET purpose = ? WHERE id = ?').run('advance', ids[0]);
  const fixed = runSceneQuality({ projectId: p.id, sceneKey: SCENE });
  assert.equal(fixed.gate.decision, GATE_PASS, JSON.stringify(fixed.gate.blocking));

  // 每镜仍是 1 行状态、报告各 2 份（坏的那次 + 好的那次），latest 是好的
  for (const id of ids) {
    assert.equal(db.prepare('SELECT COUNT(*) AS c FROM shot_states WHERE shot_id = ?').get(id).c, 1);
  }
  const rows = db.prepare('SELECT COUNT(*) AS c FROM qc_reports WHERE target_id = ?').get(ids[0]).c;
  assert.equal(rows, 2, `报告行数应为 2（历史保留），实际 ${rows}`);
  assert.equal(fixed.reports[0].reused, false);

  // 再跑一次（输入没变）→ 复用，不插第三份
  const again = runSceneQuality({ projectId: p.id, sceneKey: SCENE });
  assert.equal(again.reports[0].reused, true);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM qc_reports WHERE target_id = ?').get(ids[0]).c, 2);
  assert.equal(again.gate.decision, GATE_PASS);
});

test('G9 门禁消费的是报告级结论：同一份 hits 换掉 level 会改变结论', () => {
  const hits = [entry({ applicable: false, level: 'fail' })];
  assert.equal(gateOf([{ target_id: 'a', level: 'pass', hits }]).decision, GATE_PASS);
  assert.equal(gateOf([{ target_id: 'a', level: 'fail', hits }]).decision, GATE_PAUSE);
});
