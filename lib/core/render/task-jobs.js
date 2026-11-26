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

function fail(code, message) {
  throw Object.assign(new Error(message), { code });
}

function requireJob(jobId) {
  const j = getDb().prepare('SELECT * FROM jobs WHERE id = ?').get(jobId);
  if (!j) fail('JOB_OR_TASK_NOT_FOUND', 'Job 不存在：' + jobId);
  return j;
}

function requireTask(taskId) {
  const t = getDb().prepare('SELECT * FROM render_tasks WHERE id = ?').get(taskId);
  if (!t) fail('JOB_OR_TASK_NOT_FOUND', 'Task 不存在：' + taskId);
  return t;
}

/**
 * 解析 task 的权威项目归属：**`render_tasks.unit_id → render_units.project_id`**。
 *
 * 【V1.1 B-01 修复】旧实现是 `task.project_id 有值就用它、没有才去查 unit`，于是：
 *   · task.project_id 有值 → 整条 unit 校验被跳过（unit 指向别的项目、unit 不存在都查不出来）；
 *   · job.project_id 为空 → `projOfTask && job.project` 直接短路成"不校验"，跨项目也能写进去。
 * 现在改成：unit 必须存在、unit 归属必须非空、job 归属必须非空、三者一致，否则一律拒绝。
 * **不为了兼容不完整数据而静默放行**——关系表一旦写错，事后只能靠人工分辨。
 */
function resolveTaskProject(task) {
  const unitId = String(task.unit_id || '');
  if (!unitId) fail('TASK_UNIT_NOT_FOUND', `Task ${task.id} 的 unit_id 为空，无法确认项目归属`);
  const unit = getDb().prepare('SELECT id, project_id FROM render_units WHERE id = ?').get(unitId);
  if (!unit) fail('TASK_UNIT_NOT_FOUND', `Task ${task.id} 引用的 unit ${unitId} 不存在`);
  const unitProject = String(unit.project_id || '').trim();
  if (!unitProject) fail('TASK_PROJECT_MISMATCH', `Unit ${unitId} 的 project_id 为空，无法确认项目归属`);
  return { unitId, unitProject };
}

/**
 * 建立关系。**必须与建 task 在同一事务内调用**（J2）。
 *
 * 七项逐项校验（B-01）：
 *   1. Job 存在  2. Task 存在  3. Task.unit_id 能找到真实 render_units 记录
 *   4. unit.project_id 非空  5. job.project_id 非空
 *   6. job.project_id === unit.project_id
 *   7. task.project_id（若非空）=== unit.project_id
 */
export function linkTaskToJob({ taskId, jobId } = {}) {
  if (!taskId || !jobId) fail('JOB_OR_TASK_NOT_FOUND', 'taskId / jobId 必填');
  const job = requireJob(jobId);                  // 1
  const task = requireTask(taskId);               // 2
  const { unitId, unitProject } = resolveTaskProject(task); // 3 / 4

  const jobProject = String(job.project_id || '').trim();
  if (!jobProject) fail('JOB_PROJECT_MISMATCH', `Job ${jobId} 的 project_id 为空，无法确认项目归属`); // 5
  if (jobProject !== unitProject) {
    fail('JOB_PROJECT_MISMATCH', `跨项目关联：job ${jobId} 属于 ${jobProject}，task ${taskId} 的 unit ${unitId} 属于 ${unitProject}`); // 6
  }
  const taskProject = String(task.project_id || '').trim();
  if (taskProject && taskProject !== unitProject) {
    fail('TASK_PROJECT_MISMATCH', `Task ${taskId} 的 project_id (${taskProject}) 与其 unit ${unitId} 的 ${unitProject} 不一致`); // 7
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
