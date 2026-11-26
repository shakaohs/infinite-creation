// Task ↔ Job 关系与 Job 物理删除归档（D02-03 V3 §四 D-03）
//
// 关系表 `render_task_jobs(task_id PK, job_id)`：一个 task 至多属于一个 job，一个 job 可以有多个 task。
// 不塞进 `render_tasks.params`（那是发给引擎的入参，塞进去会被当渲染色），也不加列（改 D01）。
//
// 四种操作要分清（§四）：
//   ① 取消 job —— 保留记录、保留关系、保留产物
//   ② job 异常结束 —— 同上，task 各自收敛
//   ③ 物理删记录 —— 先归档 job 摘要，再删关系，再删 job；**不删 task / attempt / 产物**
//   ④ 删项目 —— 走 Projects.remove 的整项目顺序（不在这里逐 job 删）
import { getDb } from '../db.js';
import { now, uid } from '../utils.js';
import { logger } from '../logger.js';

function requireJob(jobId) {
  const j = getDb().prepare('SELECT * FROM jobs WHERE id = ?').get(jobId);
  if (!j) throw Object.assign(new Error('Job 不存在：' + jobId), { code: 'JOB_OR_TASK_NOT_FOUND' });
  return j;
}

function requireTask(taskId) {
  const t = getDb().prepare('SELECT * FROM render_tasks WHERE id = ?').get(taskId);
  if (!t) throw Object.assign(new Error('Task 不存在：' + taskId), { code: 'JOB_OR_TASK_NOT_FOUND' });
  return t;
}

/**
 * 建立关系。**必须与建 task 在同一事务内调用**（J2）。
 * 校验：双方存在（J9）+ 同项目（J8）。
 */
export function linkTaskToJob({ taskId, jobId } = {}) {
  if (!taskId || !jobId) throw Object.assign(new Error('taskId / jobId 必填'), { code: 'JOB_OR_TASK_NOT_FOUND' });
  const job = requireJob(jobId);
  const task = requireTask(taskId);

  // 项目归属：task 的 project_id 与 job 的 project_id 必须一致；
  // task 若无 project_id（历史/单测），退而用其 unit 的项目。
  let projOfTask = String(task.project_id || '');
  if (!projOfTask && task.unit_id) {
    const u = getDb().prepare('SELECT project_id FROM render_units WHERE id = ?').get(task.unit_id);
    projOfTask = u ? String(u.project_id || '') : '';
  }
  if (projOfTask && String(job.project_id || '') && projOfTask !== String(job.project_id)) {
    throw Object.assign(
      new Error(`跨项目关联：job 属于 ${job.project_id}，task 属于 ${projOfTask}`),
      { code: 'JOB_PROJECT_MISMATCH' },
    );
  }

  const exists = getDb().prepare('SELECT * FROM render_task_jobs WHERE task_id = ?').get(taskId);
  if (exists) {
    if (String(exists.job_id) === String(jobId)) return { created: false, relation: exists };
    throw Object.assign(new Error(`Task ${taskId} 已属于 Job ${exists.job_id}，不能改属`), { code: 'TASK_ALREADY_LINKED' });
  }

  getDb().prepare('INSERT INTO render_task_jobs (task_id, job_id, created_at) VALUES (?,?,?)').run(taskId, jobId, now());
  return { created: true, relation: { task_id: taskId, job_id: jobId } };
}

/** task 的 job（无关系返回 null） */
export function jobOfTask(taskId) {
  return getDb().prepare('SELECT * FROM render_task_jobs WHERE task_id = ?').get(taskId) || null;
}

/**
 * 某 job 的全部 task。
 * 用 LEFT JOIN 的语义要求是"**未登记关系的 task 仍能列出**"——那是列全部 task 的场景；
 * 这里反过来是"按 job 取 task"，用 INNER JOIN 是正确语义（无关系就不属于这个 job）。
 */
export function tasksOfJob(jobId) {
  if (!jobId) return [];
  return getDb().prepare(`
    SELECT t.* FROM render_tasks t
      JOIN render_task_jobs r ON r.task_id = t.id
     WHERE r.job_id = ?
     ORDER BY t.started_at, t.id`).all(jobId);
}

/** 列出项目下所有 task（含无 job 归属的）——这里必须是 LEFT JOIN */
export function tasksOfProject(projectId) {
  return getDb().prepare(`
    SELECT t.*, r.job_id AS linked_job_id
      FROM render_tasks t
      LEFT JOIN render_task_jobs r ON r.task_id = t.id
     WHERE t.project_id = ?
     ORDER BY t.started_at, t.id`).all(projectId);
}

/**
 * 物理删除 job 前的归档（§四 第 3 步）：把 job 摘要写进 legacy_artifacts。
 * 没有这一步，删完 job 后一个 succeeded 的 task 就再也说不清"它是哪次流水线跑出来的"。
 * 幂等：同 (source_table='jobs', source_pk=jobId, artifact_kind='job_summary') 只写一次。
 */
export function archiveJobSummary(jobId) {
  const job = requireJob(jobId);
  const taskIds = getDb().prepare('SELECT task_id FROM render_task_jobs WHERE job_id = ? ORDER BY task_id')
    .all(jobId).map((r) => r.task_id);
  const body = {
    job: {
      id: job.id, type: job.type, status: job.status, phase: job.phase,
      error: job.error || '', started_at: job.started_at, finished_at: job.finished_at,
    },
    task_ids: taskIds,
  };
  const exists = getDb().prepare(
    "SELECT id FROM legacy_artifacts WHERE source_table='jobs' AND source_pk=? AND artifact_kind='job_summary'",
  ).get(jobId);
  if (exists) return { created: false, id: exists.id };

  const id = 'la_' + uid();
  getDb().prepare(`INSERT INTO legacy_artifacts
    (id, project_id, source_table, source_pk, artifact_kind, resolved_track, resolved_profile_ver, resolve_basis, body, content_hash, note, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    id, String(job.project_id || ''), 'jobs', jobId, 'job_summary', null, null,
    'job_delete', JSON.stringify(body), '', '物理删除 job 前留档', now(),
  );
  return { created: true, id };
}

/**
 * 物理删除 job 的完整三步（归档 → 删关系 → 删 job）。
 * **调用方必须包在 tx() 里**（J10）；文件清理在事务提交后做。
 * 不删 task、不删 attempt、不删产物文件。
 */
export function deleteJobWithArchive(jobId) {
  const job = requireJob(jobId);
  const archived = archiveJobSummary(jobId);
  const rel = getDb().prepare('DELETE FROM render_task_jobs WHERE job_id = ?').run(jobId);
  const rm = getDb().prepare('DELETE FROM jobs WHERE id = ?').run(jobId);
  logger.info?.(`删除 job ${jobId}：归档=${archived.id}，关系 ${rel.changes} 行，job ${rm.changes} 行`);
  return { archivedId: archived.id, relationsDeleted: rel.changes || 0, jobsDeleted: rm.changes || 0, job };
}
