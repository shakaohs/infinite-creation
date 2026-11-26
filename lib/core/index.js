export * from './config.js';
export * from './render-gate.js';
export * from './utils.js';
export * from './logger.js';
export * from './llm.js';
export * from './music-caption.js';
export * from './comfyui.js';
export * from './runninghub.js';
export * from './backend.js';
export * from './ffmpeg.js';
export * from './db.js';
export * from './script-assets.js';
export * from './changelog.js';
export * from './launch.js';
export * from './shot-write.js';
export * from './storyboard-import.js';
export * from './xlsx-read.js';
export * from './srt.js';
export * from './subtitle.js';
export * from './refs.js';
export * from './prompts.js';
export * from './workflow-runner.js';
export * from './workflow-specs.js';
export * from './novel.js';
export * from './skill-check.js';
export * from './engine-http.js';
export * from './engine-runner.js';
export * from './engine-presets.js';

// ── 阶段 1 新增能力（显式导出，避免 export * 撞名）─────────────────────────
// 项目级结构化开关（唯一读写入口）
export { isStructuredSpec, setStructuredSpec, listStructuredProjects } from './structured-spec.js';
// 单元选片
export { getSelection, setSelection, clearSelection, assertSelectable, assertAttemptNotSelected, selectionsOfProject } from './render/selection.js';
// Task ↔ Job 关系与 Job 物理删除归档
export { linkTaskToJob, jobOfTask, tasksOfJob, tasksOfProject, archiveJobSummary, deleteJobWithArchive } from './render/task-jobs.js';
// G0 四项锁
export { LOCK_KEYS, getLocks, addLocks, assertLocksComplete, inspectLocks } from './render/adaptation-locks.js';
// 迁移登记模型
export {
  createMigrateStore, migrateStore, batchIdFor,
  assertRollbackTransition, assertBatchTransition,
  ROLLBACK_STATES, ROLLBACK_TERMINAL, ROLLBACK_TRANSITIONS,
  BATCH_STATES, BATCH_TRANSITIONS, MIGRATION_STATUSES, ROLLBACK_STATUS_MACHINE,
} from './migrate/index.js';
// 三种 Hash 与规范化序列化
export {
  cmpStr, canonicalStringify, canonical, canonState, canonMeta, num, numOrNull, normStr, numStr,
  sourceSpecHash, buildSourcePayload, bodyOf, contentHashOfBody, canonicalActions,
  stripRefTrigger, stripRefSync, posRel, posRelDetail, jsonArr, jsonObj,
  adaptationHash, buildAdaptationPayload, compiledHash, buildCompiledPayload, COMPILER_PARAM_FIELDS,
} from './hash/index.js';
