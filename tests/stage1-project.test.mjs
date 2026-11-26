// 阶段 1 · 项目开关与项目删除（任务书 §7.6 / §11.6 的"删除流程"）
//
// 删项目最容易出的两个错，这里各有一条用例：
//   · 顺序错 → 留下指向已删资产的孤儿行（无外键，不会报错，只会静默残留）
//   · 事务没包住 → 中途失败留下"项目还在、分镜已删"的半残
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-s1-proj-'));
process.env.IC_DATA_DIR = TMP;
delete process.env.IC_DB_SQLITE_PATH;

const { getDb, Projects } = await import('../lib/core/db.js');
const ss = await import('../lib/core/structured-spec.js');
const db = getDb();

let seq = 0;

/** 造一个"五脏俱全"的项目：21 张新表里凡是有 project_id 的都塞一行 */
function seedProject() {
  seq++;
  const p = Projects.create({ name: 'seed-' + seq, type: 'agent' });
  const pid = p.id;
  const t = Date.now();
  const chId = 'ch_s' + seq; const shId = 'sh_s' + seq; const adId = 'ad_s' + seq;
  const uId = 'u_s' + seq; const taskId = 't_s' + seq; const atId = 'a_s' + seq;
  const pkgId = 'pk_s' + seq; const jobId = 'j_s' + seq;

  db.prepare('INSERT INTO chapters (id,project_id,title,seq,created_at,updated_at) VALUES (?,?,?,?,?,?)')
    .run(chId, pid, '第1章', 1, t, t);
  db.prepare('INSERT INTO scene_states (id,project_id,scene_key) VALUES (?,?,?)').run('sc_s' + seq, pid, 'S1');
  db.prepare('INSERT INTO story_shots (id,project_id,chapter_id,scene_key,shot_no,global_no) VALUES (?,?,?,?,?,?)')
    .run(shId, pid, chId, 'S1', 1, 1);
  db.prepare('INSERT INTO shot_blockings (shot_id,character_id) VALUES (?,?)').run(shId, 'c1');
  db.prepare('INSERT INTO shot_actions (id,shot_id) VALUES (?,?)').run('sa_s' + seq, shId);
  db.prepare('INSERT INTO shot_states (shot_id) VALUES (?)').run(shId);
  db.prepare('INSERT INTO shot_assets (shot_id,asset_id,role,order_no) VALUES (?,?,?,?)').run(shId, 'as_s' + seq, 'character', 1);
  db.prepare(`INSERT INTO render_adaptations (id,project_id,chapter_id,track,profile_ver,adaptation_version,
    profile_max,profile_short_floor,profile_min_slice,profile_tail_hold_max) VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run(adId, pid, chId, 'h3', 'h3.v1', 1, 15, 3, 1, 2);
  db.prepare('INSERT INTO adaptation_locks (adaptation_id,lock_key,lock_value) VALUES (?,?,?)').run(adId, 'mode', 'Ref2VA');
  db.prepare(`INSERT INTO render_units (id,adaptation_id,project_id,chapter_id,track,profile_ver,unit_no,unit_duration)
    VALUES (?,?,?,?,?,?,?,?)`).run(uId, adId, pid, chId, 'h3', 'h3.v1', 1, 14.5);
  db.prepare('INSERT INTO render_unit_shots (id,unit_id,shot_id,order_no,t_from,t_to) VALUES (?,?,?,?,?,?)')
    .run('rus_s' + seq, uId, shId, 1, 0, 4);
  db.prepare('INSERT INTO prompt_packages (id,project_id,unit_id,track) VALUES (?,?,?,?)').run(pkgId, pid, uId, 'h3');
  db.prepare('INSERT INTO render_tasks (id,project_id,unit_id,package_id,track,status) VALUES (?,?,?,?,?,?)')
    .run(taskId, pid, uId, pkgId, 'h3', 'succeeded');
  db.prepare('INSERT INTO jobs (id,project_id,type,status,started_at,updated_at) VALUES (?,?,?,?,?,?)')
    .run(jobId, pid, 'create', 'done', t, t);
  db.prepare('INSERT INTO render_task_jobs (task_id,job_id,created_at) VALUES (?,?,?)').run(taskId, jobId, t);
  db.prepare('INSERT INTO render_attempts (id,task_id,attempt_no,output_path,status) VALUES (?,?,?,?,?)')
    .run(atId, taskId, 1, '/out/' + atId + '.mp4', 'succeeded');
  db.prepare('INSERT INTO render_selections (unit_id,attempt_id,selected_at) VALUES (?,?,?)').run(uId, atId, t);
  db.prepare('INSERT INTO qc_reports (id,project_id,target_type,target_id) VALUES (?,?,?,?)').run('qc_s' + seq, pid, 'video', atId);
  db.prepare('INSERT INTO timelines (id,project_id,chapter_id) VALUES (?,?,?)').run('tl_s' + seq, pid, chId);
  db.prepare('INSERT INTO legacy_artifacts (id,project_id,source_table,source_pk,artifact_kind) VALUES (?,?,?,?,?)')
    .run('la_s' + seq, pid, 'shots', 'x' + seq, 'video_prompt');
  // 既有表也塞一条
  db.prepare('INSERT INTO assets (id,project_id,category,name) VALUES (?,?,?,?)').run('as_s' + seq, pid, 'character', '角色');
  db.prepare("INSERT INTO messages (id,project_id,role,content,created_at) VALUES (?,?,?,?,?)").run('ms_s' + seq, pid, 'user', 'hi', t);

  return { pid, chId, shId, adId, uId, taskId, atId, pkgId, jobId };
}

const NEW_TABLES_WITH_PROJECT = [
  'qc_reports', 'render_selections', 'render_task_jobs', 'render_attempts', 'render_tasks',
  'prompt_packages', 'timelines', 'render_unit_shots', 'render_units', 'adaptation_locks',
  'render_adaptations', 'shot_assets', 'shot_states', 'shot_blockings', 'shot_actions',
  'story_shots', 'scene_states', 'legacy_artifacts',
];

function countRows(table, pid) {
  const cols = db.tableColumns(table);
  if (!cols.includes('project_id')) {
    // 没有 project_id 的表按归属键间接统计
    const map = {
      render_selections: "unit_id IN (SELECT id FROM render_units WHERE project_id=?)",
      render_task_jobs: "task_id IN (SELECT id FROM render_tasks WHERE project_id=?)",
      render_attempts: "task_id IN (SELECT id FROM render_tasks WHERE project_id=?)",
      prompt_packages: "unit_id IN (SELECT id FROM render_units WHERE project_id=?)",
      render_unit_shots: "unit_id IN (SELECT id FROM render_units WHERE project_id=?)",
      render_units: "adaptation_id IN (SELECT id FROM render_adaptations WHERE project_id=?)",
      adaptation_locks: "adaptation_id IN (SELECT id FROM render_adaptations WHERE project_id=?)",
      shot_assets: "shot_id IN (SELECT id FROM story_shots WHERE project_id=?)",
      shot_states: "shot_id IN (SELECT id FROM story_shots WHERE project_id=?)",
      shot_blockings: "shot_id IN (SELECT id FROM story_shots WHERE project_id=?)",
      shot_actions: "shot_id IN (SELECT id FROM story_shots WHERE project_id=?)",
    };
    return db.prepare(`SELECT COUNT(*) n FROM ${table} WHERE ${map[table]}`).get(pid).n;
  }
  return db.prepare(`SELECT COUNT(*) n FROM ${table} WHERE project_id = ?`).get(pid).n;
}

// ── structured_spec ─────────────────────────────────────────────────────
test('P-01 新项目 structured_spec 默认 0（不开新链路）', () => {
  const p = Projects.create({ name: 'flag-default', type: 'agent' });
  assert.equal(ss.isStructuredSpec(p.id), false);
  assert.equal(db.prepare('SELECT structured_spec FROM projects WHERE id=?').get(p.id).structured_spec, 0);
});

test('P-02 setStructuredSpec 只接受布尔', () => {
  const p = Projects.create({ name: 'flag-type', type: 'agent' });
  for (const bad of ['1', 1, 0, null, undefined, {}]) {
    assert.throws(() => ss.setStructuredSpec(p.id, bad), /只接受布尔值/);
  }
});

test('P-03 置 1 后读回 1；同值重复设置幂等且不刷日志', () => {
  const p = Projects.create({ name: 'flag-set', type: 'agent' });
  const r1 = ss.setStructuredSpec(p.id, true);
  assert.equal(r1.changed, true);
  assert.equal(ss.isStructuredSpec(p.id), true);
  const n1 = db.prepare('SELECT COUNT(*) n FROM change_logs WHERE project_id=?').get(p.id).n;
  const r2 = ss.setStructuredSpec(p.id, true);
  assert.equal(r2.changed, false);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM change_logs WHERE project_id=?').get(p.id).n, n1, '同值不刷日志');
});

test('P-04 Projects.update 写 context 不会冲掉开关（这就是否决 context 方案的原因）', () => {
  const p = Projects.create({ name: 'flag-ctx', type: 'agent' });
  ss.setStructuredSpec(p.id, true);
  Projects.update(p.id, { context: { bible: '新圣经' } });
  assert.equal(ss.isStructuredSpec(p.id), true, '开关必须还在');
  // 且 context 里不该出现该键
  const ctx = db.prepare('SELECT context FROM projects WHERE id=?').get(p.id).context;
  assert.equal(String(ctx).includes('structured_spec'), false);
});

test('P-05 开关变更留 project 审计', () => {
  const p = Projects.create({ name: 'flag-audit', type: 'agent' });
  ss.setStructuredSpec(p.id, true);
  const logs = db.prepare("SELECT * FROM change_logs WHERE project_id=? AND entity='project' AND action='update'").all(p.id);
  assert.ok(logs.length >= 1);
  const hit = logs.find((l) => String(l.meta).includes('structured_spec'));
  assert.ok(hit, '审计里应能看出改的是 structured_spec');
});

// ── Projects.remove ─────────────────────────────────────────────────────
test('P-06 删除项目：21 张新表里属于它的行全部清干净', () => {
  const s = seedProject();
  // 删之前每张表都有数据（否则"删干净"无从证明）
  for (const t of NEW_TABLES_WITH_PROJECT) {
    assert.ok(countRows(t, s.pid) > 0, `${t} 建数据失败`);
  }
  Projects.remove(s.pid);
  const left = {};
  for (const t of NEW_TABLES_WITH_PROJECT) left[t] = countRows(t, s.pid);
  const nonZero = Object.entries(left).filter(([, n]) => n > 0);
  assert.deepEqual(nonZero, [], '不应留任何残留行：' + JSON.stringify(left));
  assert.equal(Projects.get(s.pid), null);
});

test('P-07 删除项目不删运维三表（迁移审计必须留下）', () => {
  const s = seedProject();
  db.prepare("INSERT INTO migration_batches (id,name,status) VALUES ('mig-20260101-01','x','committed')").run();
  db.prepare("INSERT INTO migration_items (batch_id,target_table,target_pk) VALUES ('mig-20260101-01','story_shots',?)").run(s.shId);
  db.prepare(`INSERT INTO migration_edges (batch_id,child_table,child_pk,parent_table,parent_pk)
    VALUES ('mig-20260101-01','shot_actions','sa_x','story_shots',?)`).run(s.shId);
  Projects.remove(s.pid);
  assert.ok(db.prepare("SELECT 1 FROM migration_batches WHERE id='mig-20260101-01'").get(), '批次行必须保留');
  assert.ok(db.prepare("SELECT 1 FROM migration_items WHERE batch_id='mig-20260101-01'").get(), '迁移记录必须保留');
  assert.ok(db.prepare("SELECT 1 FROM migration_edges WHERE batch_id='mig-20260101-01'").get(), '依赖边必须保留');
});

test('P-08 删除项目不影响别的项目的数据', () => {
  const a = seedProject();
  const b = seedProject();
  const before = Object.fromEntries(NEW_TABLES_WITH_PROJECT.map((t) => [t, countRows(t, b.pid)]));
  Projects.remove(a.pid);
  for (const t of NEW_TABLES_WITH_PROJECT) {
    assert.equal(countRows(t, b.pid), before[t], `${t} 里 B 项目的数据被误删`);
  }
});

test('P-09 删除过程中途失败 → 整体回滚（不留"项目还在、分镜已删"的半残）', () => {
  const s = seedProject();
  const before = Object.fromEntries(NEW_TABLES_WITH_PROJECT.map((t) => [t, countRows(t, s.pid)]));
  // 在 story_shots 上装一个阻断触发器（模拟"删到一半炸了"）
  db.exec("CREATE TRIGGER IF NOT EXISTS block_sd BEFORE DELETE ON story_shots BEGIN SELECT RAISE(ABORT,'blocked'); END");
  try {
    assert.throws(() => Projects.remove(s.pid), /blocked/);
  } finally {
    db.exec('DROP TRIGGER IF EXISTS block_sd');
  }
  // 项目还在
  assert.ok(Projects.get(s.pid), '失败后项目必须还在');
  // 按顺序在 story_shots 之前被删的表，必须因事务回滚而恢复
  for (const t of ['qc_reports', 'render_selections', 'render_task_jobs', 'render_attempts',
    'render_tasks', 'prompt_packages', 'timelines', 'render_unit_shots', 'render_units',
    'adaptation_locks', 'render_adaptations']) {
    assert.equal(countRows(t, s.pid), before[t], `${t} 应随事务回滚恢复`);
  }
  // 收尾：确认真能删掉（证明不是"永久删不动"）
  Projects.remove(s.pid);
  assert.equal(Projects.get(s.pid), null);
});

test('P-10 空项目也能安全删除（没有新表数据时不报错）', () => {
  const p = Projects.create({ name: 'empty-del', type: 'agent' });
  assert.doesNotThrow(() => Projects.remove(p.id));
  assert.equal(Projects.get(p.id), null);
});
