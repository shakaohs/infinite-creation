// 阶段 1 · 三张扩展表与选片审计（任务书 §11.6）
//
// 造数据直接写 SQL（阶段 1 没有"建单元/建 task"的业务入口，那是阶段 3/5 的事），
// 但被验证的写入路径全部走产品模块（selection.js / task-jobs.js / adaptation-locks.js）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-s1-rel-'));
process.env.IC_DATA_DIR = TMP;
delete process.env.IC_DB_SQLITE_PATH;

const { getDb, Projects, tx } = await import('../lib/core/db.js');
const sel = await import('../lib/core/render/selection.js');
const tj = await import('../lib/core/render/task-jobs.js');
const locks = await import('../lib/core/render/adaptation-locks.js');
const db = getDb();

// ── 造一条最小链路：project → chapter → shot → adaptation → unit → task → attempt ──
let seq = 0;
function scaffold(projectId = null) {
  seq++;
  const p = projectId ? { id: projectId } : Projects.create({ name: 'rel-' + seq, type: 'agent' });
  const pid = p.id;
  const chId = 'ch_' + seq;
  const shId = 'sh_' + seq;
  const adId = 'ad_' + seq;
  const uId = 'u_' + seq;
  const tId = 't_' + seq;
  db.prepare("INSERT INTO chapters (id,project_id,title,seq,created_at,updated_at) VALUES (?,?,?,?,?,?)")
    .run(chId, pid, '第1章', 1, Date.now(), Date.now());
  db.prepare("INSERT INTO story_shots (id,project_id,chapter_id,scene_key,shot_no,global_no) VALUES (?,?,?,?,?,?)")
    .run(shId, pid, chId, 'S1', 1, 1);
  db.prepare(`INSERT INTO render_adaptations (id,project_id,chapter_id,track,profile_ver,adaptation_version,
      profile_max,profile_short_floor,profile_min_slice,profile_tail_hold_max) VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run(adId, pid, chId, 'h3', 'h3.v1', 1, 15, 3, 1, 2);
  db.prepare(`INSERT INTO render_units (id,adaptation_id,project_id,chapter_id,track,profile_ver,unit_no,unit_duration)
      VALUES (?,?,?,?,?,?,?,?)`).run(uId, adId, pid, chId, 'h3', 'h3.v1', 1, 14.5);
  db.prepare("INSERT INTO render_tasks (id,project_id,unit_id,track,status) VALUES (?,?,?,?,?)")
    .run(tId, pid, uId, 'h3', 'succeeded');
  return { pid, chId, shId, adId, uId, tId };
}

function addAttempt(taskId, over = {}) {
  const id = over.id || 'at_' + Math.random().toString(36).slice(2, 8);
  db.prepare(`INSERT INTO render_attempts (id,task_id,attempt_no,seed,output_path,duration_real,status,error,started_at,finished_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
    id, taskId, over.attempt_no ?? 1, 0, over.output_path ?? '/out/' + id + '.mp4',
    over.duration_real ?? 14.5, over.status ?? 'succeeded', '', Date.now(), Date.now(),
  );
  return id;
}

// ── render_selections ───────────────────────────────────────────────────
test('X-01 选片：正常选中，落库且记一条审计', () => {
  const s = scaffold();
  const a1 = addAttempt(s.tId);
  const r = sel.setSelection(s.uId, a1, { selectedBy: 'user' });
  assert.equal(r.created, true);
  assert.equal(sel.getSelection(s.uId).attempt_id, a1);
  const logs = db.prepare("SELECT * FROM change_logs WHERE entity='render_selection' AND entity_id=?").all(s.uId);
  assert.equal(logs.length, 1);
  assert.equal(logs[0].action, 'create');
  assert.equal(logs[0].project_id, s.pid, '间接归属必须解析出项目');
});

test('X-02 连续选三个 attempt 仍只有一条当前选择（upsert）', () => {
  const s = scaffold();
  const a1 = addAttempt(s.tId, { attempt_no: 1 });
  const a2 = addAttempt(s.tId, { attempt_no: 2 });
  const a3 = addAttempt(s.tId, { attempt_no: 3 });
  sel.setSelection(s.uId, a1);
  sel.setSelection(s.uId, a2);
  sel.setSelection(s.uId, a3);
  const rows = db.prepare('SELECT * FROM render_selections WHERE unit_id=?').all(s.uId);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].attempt_id, a3);
  const logs = db.prepare("SELECT action FROM change_logs WHERE entity='render_selection' AND entity_id=? ORDER BY rowid").all(s.uId);
  assert.deepEqual(logs.map((l) => l.action), ['create', 'update', 'update']);
});

test('X-03 选别的单元的 attempt 被拒，且表内无变化', () => {
  const s = scaffold();
  const other = scaffold();
  const a = addAttempt(other.tId);
  assert.throws(() => sel.setSelection(s.uId, a), /属于单元/);
  assert.equal(sel.getSelection(s.uId), null);
});

test('X-04 选一条 failed 的 attempt 被拒；选 output_path 为空的被拒', () => {
  const s = scaffold();
  const aFail = addAttempt(s.tId, { status: 'failed' });
  assert.throws(() => sel.setSelection(s.uId, aFail), /succeeded/);
  const aEmpty = addAttempt(s.tId, { output_path: '' });
  assert.throws(() => sel.setSelection(s.uId, aEmpty), /output_path/);
});

test('X-05 孤儿 unit 被拒（SELECTION_ORPHAN_UNIT），不写选择也不写日志', () => {
  const s = scaffold();
  const a = addAttempt(s.tId);
  const n0 = db.prepare("SELECT COUNT(*) n FROM change_logs WHERE entity='render_selection'").get().n;
  try {
    sel.setSelection('no_such_unit', a);
    assert.fail('应当抛错');
  } catch (e) {
    assert.equal(e.code, 'SELECTION_ORPHAN_UNIT');
  }
  assert.equal(sel.getSelection('no_such_unit'), null);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM change_logs WHERE entity='render_selection'").get().n, n0);
});

test('X-06 set / clear / 重选三次都留审计，entity_id 全是 unit_id', () => {
  const s = scaffold();
  const a1 = addAttempt(s.tId, { attempt_no: 1 });
  const a2 = addAttempt(s.tId, { attempt_no: 2 });
  sel.setSelection(s.uId, a1);
  sel.clearSelection(s.uId);
  sel.setSelection(s.uId, a2);
  const logs = db.prepare("SELECT * FROM change_logs WHERE entity='render_selection' AND entity_id=? ORDER BY rowid").all(s.uId);
  assert.equal(logs.length, 3);
  assert.deepEqual(logs.map((l) => l.action), ['create', 'delete', 'create']);
  assert.ok(logs.every((l) => l.entity_id === s.uId));
});

test('X-07 取消选择不删 attempt、不删文件、不改 task 状态', () => {
  const s = scaffold();
  const a = addAttempt(s.tId);
  sel.setSelection(s.uId, a);
  const before = {
    attempts: db.prepare('SELECT COUNT(*) n FROM render_attempts WHERE task_id=?').get(s.tId).n,
    status: db.prepare('SELECT status FROM render_tasks WHERE id=?').get(s.tId).status,
  };
  sel.clearSelection(s.uId);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM render_attempts WHERE task_id=?').get(s.tId).n, before.attempts);
  assert.equal(db.prepare('SELECT status FROM render_tasks WHERE id=?').get(s.tId).status, before.status);
  assert.ok(db.prepare('SELECT output_path FROM render_attempts WHERE id=?').get(a).output_path, '产物路径仍在');
});

test('X-08 被选中的 attempt 不许删（guard 抛出 ATTEMPT_SELECTED）', () => {
  const s = scaffold();
  const a = addAttempt(s.tId);
  sel.setSelection(s.uId, a);
  assert.throws(() => sel.assertAttemptNotSelected(a), /禁止删除/);
  sel.clearSelection(s.uId);
  assert.equal(sel.assertAttemptNotSelected(a), true, '取消选择后允许删除');
});

test('X-09 回滚一条选片日志 → 选择行消失；回滚 clear 日志 → 按 before 复原', async () => {
  const s = scaffold();
  const a1 = addAttempt(s.tId, { attempt_no: 1 });
  const a2 = addAttempt(s.tId, { attempt_no: 2 });
  const r1 = sel.setSelection(s.uId, a1);
  const r2 = sel.setSelection(s.uId, a2);   // update
  const CL = await import('../lib/core/changelog.js');
  const rb = CL.rollbackLogs({ projectId: s.pid, logId: r2.logId });
  assert.equal(rb.applied.length, 1);
  assert.equal(sel.getSelection(s.uId).attempt_id, a1, '回滚重选应恢复上一次的选择');
  const rb2 = CL.rollbackLogs({ projectId: s.pid, logId: r1.logId });
  assert.equal(rb2.applied.length, 1);
  assert.equal(sel.getSelection(s.uId), null, '回滚"选中"应删掉选择行');
});

test('X-10 审计失败 → 业务整体回滚（构造 recordChange 返回 null 的场景）', () => {
  // 用 project 归属解析失败来触发：把 render_units 的项目字段清空，projectOf 返回 '' 会抛
  const s = scaffold();
  const a = addAttempt(s.tId);
  db.prepare("UPDATE render_units SET project_id='' WHERE id=?").run(s.uId);
  assert.throws(() => sel.setSelection(s.uId, a), /无法解析所属项目|孤儿/);
  assert.equal(sel.getSelection(s.uId), null, '业务写必须随审计失败一起回滚');
  db.prepare("UPDATE render_units SET project_id=? WHERE id=?").run(s.pid, s.uId);
});

// ── render_task_jobs ────────────────────────────────────────────────────
function addJob(projectId, over = {}) {
  const id = over.id || 'j_' + Math.random().toString(36).slice(2, 8);
  db.prepare("INSERT INTO jobs (id,project_id,type,status,started_at,updated_at) VALUES (?,?,?,?,?,?)")
    .run(id, projectId, 'create', 'done', Date.now(), Date.now());
  return id;
}

test('J-01 建关系成功；重复绑第二个 job 被拒', () => {
  const s = scaffold();
  const j1 = addJob(s.pid);
  const j2 = addJob(s.pid);
  assert.equal(tj.linkTaskToJob({ taskId: s.tId, jobId: j1 }).created, true);
  assert.throws(() => tj.linkTaskToJob({ taskId: s.tId, jobId: j2 }), /已属于 Job/);
  // 同 job 重复绑定 → 幂等
  assert.equal(tj.linkTaskToJob({ taskId: s.tId, jobId: j1 }).created, false);
});

test('J-02 跨项目关系被拒（JOB_PROJECT_MISMATCH）', () => {
  const s = scaffold();
  const other = scaffold();
  const jOther = addJob(other.pid);
  assert.throws(() => tj.linkTaskToJob({ taskId: s.tId, jobId: jOther }), /跨项目关联/);
});

test('J-03 不存在的 job / task 被拒', () => {
  const s = scaffold();
  const j = addJob(s.pid);
  assert.throws(() => tj.linkTaskToJob({ taskId: 'no_task', jobId: j }), /Task 不存在/);
  assert.throws(() => tj.linkTaskToJob({ taskId: s.tId, jobId: 'no_job' }), /Job 不存在/);
});

test('J-04 一个 job 多个 task；无关系的 task 在项目列表里仍可见（LEFT JOIN）', () => {
  const s = scaffold();
  const j = addJob(s.pid);
  const t2 = 't2_' + Math.random().toString(36).slice(2, 8);
  db.prepare("INSERT INTO render_tasks (id,project_id,unit_id,track,status) VALUES (?,?,?,?,?)").run(t2, s.pid, s.uId, 'h3', 'succeeded');
  tj.linkTaskToJob({ taskId: s.tId, jobId: j });
  tj.linkTaskToJob({ taskId: t2, jobId: j });
  assert.equal(tj.tasksOfJob(j).length, 2);
  const listed = tj.tasksOfProject(s.pid);
  assert.equal(listed.length, 2);
  assert.ok(listed.every((t) => t.linked_job_id === j));
  // 再来一个不绑 job 的
  const t3 = 't3_' + Math.random().toString(36).slice(2, 8);
  db.prepare("INSERT INTO render_tasks (id,project_id,unit_id,track,status) VALUES (?,?,?,?,?)").run(t3, s.pid, s.uId, 'h3', 'pending');
  const listed2 = tj.tasksOfProject(s.pid);
  assert.equal(listed2.length, 3, '无 job 归属的 task 不得从列表消失');
  assert.ok(listed2.find((t) => t.id === t3 && t.linked_job_id === null));
});

test('J-05 物理删 job：先归档 job_summary，再删关系与 job；task/attempt/产物全留', () => {
  const s = scaffold();
  const j = addJob(s.pid);
  tj.linkTaskToJob({ taskId: s.tId, jobId: j });
  const a = addAttempt(s.tId);
  tx(() => tj.deleteJobWithArchive(j));
  // job 与关系没了
  assert.equal(db.prepare('SELECT COUNT(*) n FROM jobs WHERE id=?').get(j).n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM render_task_jobs WHERE job_id=?').get(j).n, 0);
  // task / attempt / 产物都在
  assert.ok(db.prepare('SELECT 1 FROM render_tasks WHERE id=?').get(s.tId));
  assert.ok(db.prepare('SELECT 1 FROM render_attempts WHERE id=?').get(a));
  // 归档一行，body 里能查出这批 task
  const arch = db.prepare("SELECT * FROM legacy_artifacts WHERE source_table='jobs' AND source_pk=? AND artifact_kind='job_summary'").get(j);
  assert.ok(arch, '必须有 job_summary 归档');
  const body = JSON.parse(arch.body);
  assert.deepEqual(body.task_ids, [s.tId]);
  assert.equal(body.job.id, j);
});

test('J-06 取消 job 不删关系（只删记录的那种操作才删关系）', () => {
  const s = scaffold();
  const j = addJob(s.pid);
  tj.linkTaskToJob({ taskId: s.tId, jobId: j });
  db.prepare("UPDATE jobs SET status='cancelled' WHERE id=?").run(j);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM render_task_jobs WHERE job_id=?').get(j).n, 1, '取消不改变历史归属');
});

test('J-07 归档幂等：重复归档不产生第二行', () => {
  const s = scaffold();
  const j = addJob(s.pid);
  const a1 = tj.archiveJobSummary(j);
  const a2 = tj.archiveJobSummary(j);
  assert.equal(a1.created, true);
  assert.equal(a2.created, false);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM legacy_artifacts WHERE source_pk=? AND artifact_kind='job_summary'").get(j).n, 1);
});

// ── adaptation_locks ────────────────────────────────────────────────────
test('L-01 恰好 4 行、四个键齐全；缺一或多一都抛', () => {
  const s = scaffold();
  const v = locks.addLocks(s.adId, { mode: 'Ref2VA', aspect: '9:16', base: 'BASE_LIVE', assetMode: 'M2' });
  assert.deepEqual(Object.keys(v).sort(), ['aspect', 'assetMode', 'base', 'mode']);
  assert.throws(() => locks.addLocks(s.adId, { mode: 'x', aspect: 'y', base: 'z' }), /不全/);
  locks.assertLocksComplete(s.adId);

  const s2 = scaffold();
  assert.throws(() => locks.addLocks(s2.adId, { mode: 'a', aspect: 'b', base: 'c', assetMode: 'd', extra: 'e' }), /非 G0 锁键/);
});

test('L-02 锁不可变：同方案再写一次被拒（改锁必须新建版本）', () => {
  const s = scaffold();
  locks.addLocks(s.adId, { mode: 'Ref2VA', aspect: '9:16', base: 'BASE_LIVE', assetMode: 'M2' });
  assert.throws(() => locks.addLocks(s.adId, { mode: 'T2VA', aspect: '16:9', base: 'BASE_LIVE', assetMode: 'M2' }), /锁不可变/);
  assert.equal(locks.getLocks(s.adId).aspect, '9:16');
});

test('L-03 巡检能发现缺锁 / 多锁 / 错关联 / 空值', () => {
  const s = scaffold();
  // 缺锁（只写 1 行，绕过 addLocks）
  db.prepare("INSERT INTO adaptation_locks (adaptation_id,lock_key,lock_value) VALUES (?,?,?)").run(s.adId, 'mode', 'Ref2VA');
  // 错误关联（adaptation 不存在）
  db.prepare("INSERT INTO adaptation_locks (adaptation_id,lock_key,lock_value) VALUES ('ad_ghost','mode','X')").run();
  // 空值
  const s2 = scaffold();
  for (const k of locks.LOCK_KEYS) {
    db.prepare("INSERT INTO adaptation_locks (adaptation_id,lock_key,lock_value) VALUES (?,?,?)")
      .run(s2.adId, k, k === 'base' ? '' : 'v');
  }
  const r = locks.inspectLocks();
  assert.equal(r.ok, false);
  assert.ok(r.wrongCount.some((x) => x.adaptation_id === s.adId), '缺锁应被发现');
  assert.ok(r.orphanAdaptation.some((x) => x.adaptation_id === 'ad_ghost'), '错关联应被发现');
  assert.ok(r.emptyValue.some((x) => x.adaptation_id === s2.adId), '空值应被发现');
});

test('L-04 完整性断言在锁不全时抛 G0_LOCKS_INCOMPLETE', () => {
  const s = scaffold();
  db.prepare("INSERT INTO adaptation_locks (adaptation_id,lock_key,lock_value) VALUES (?,?,?)").run(s.adId, 'mode', 'Ref2VA');
  try {
    locks.assertLocksComplete(s.adId);
    assert.fail('应抛错');
  } catch (e) {
    assert.equal(e.code, 'G0_LOCKS_INCOMPLETE');
    assert.deepEqual(e.missing.sort(), ['aspect', 'assetMode', 'base']);
  }
});
