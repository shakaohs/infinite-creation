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
// 用户建项目的唯一入口（默认开启结构化模式；低层 Projects.create 默认仍是 0）
export { createUserProject } from './project-create.js';
// 场次实例空间基线（只由剧本抽取阶段写；P2）
export { upsertSceneStates, assertSceneKeysExist, listSceneStates, assertFixtureZones, sceneStateError } from './scene-state.js';
// 确定性校验基础（P4）：只导出模块命名空间，避免 check/isValid 这类通用名污染顶层
export * as enums from './validate/enums.js';
export * as schema from './validate/schema.js';
// P5：69 条规则的统一入口 `validateShot(ctx)`（同样走命名空间，避免 RULES/PASS 这类名字撞车）
export * as validate from './validate/index.js';
// P8：连续性求解的**生产入口**（读库 → 组装 → 求解；只读，不写 shot_states）
// 直接调 `solveContinuity` 会绕过来源隔离，所以对外只暴露这一对函数
export { solveSceneContinuity, solveLoaded } from './continuity/solve-scene.js';
export { loadSceneInput } from './continuity/load-scene.js';
// P9：状态持久化 + QC 闭环（**写入**）。生产入口只有 `runSceneQuality()` 一条；
// 底层 `solveContinuity` 依旧不导出（来源隔离的唯一入口是 solve-scene）。
export { runSceneQuality, fullRebuildReportLevelRules } from './continuity/run-scene.js';
export {
  persistSceneStates, listShotStates, toShotStateRow, stateContentHash, STATE_SOURCE_SOLVED,
  STATE_PAYLOAD_COLUMNS, businessMetaOf, stateSnapshotHashOf, SOLVER_META_KEY,
} from './continuity/persist-state.js';
export {
  buildShotReport, saveReport, latestReport, reportHistory, readReport, solverInputOf,
  assertReportLevelRules, assertCarriedIntegrity, hashRelationOf, HASH_RELATION,
  REPORT_TARGET_TYPE, SOLVER_INPUT_ENTRY, SOURCE_RUN, SOURCE_CARRIED, SOURCE_REPORT_LEVEL,
} from './qc/report.js';
export { gateOf, GATE_PASS, GATE_PAUSE, BLOCKING_LEVEL } from './qc/gate.js';
export { ck2Audit, ck2Summary, dependencyRoots, CK2_SCOPES } from './qc/deps/ck2.js';
// 镜号分配与两阶段重编（P3：shot_no / global_no 共用一份原语）
export {
  NUMBER_FIELDS, globalOrderError, chapterOrder, listAuthoritativeShots, maxShotNo,
  nextAppendGlobalNo, isPureAppend, assertNoDuplicateShotNos, assertChapterSubmitComplete,
  insertStoryShot, renumberTwoPhase, applyTargetOrder, appendStoryShots, assertAppendedLast,
  assertGlobalOrder, renumberCallCount, resetRenumberCallCount,
} from './render/global-no.js';
// 镜头资产引用契约（P3：AS-1~AS-10）
export {
  SHOT_ASSET_ROLES, MAX_VOICE_PER_SHOT, shotAssetError, resolveShotAssets,
  deriveVoiceIds, writeShotAssets, writeStoryShotWithAssets,
} from './render/shot-assets.js';
// 单元选片
export { getSelection, setSelection, clearSelection, assertSelectable, assertAttemptNotSelected, selectionsOfProject } from './render/selection.js';
// Task ↔ Job 关系与 Job 物理删除归档
export { linkTaskToJob, jobOfTask, tasksOfJob, tasksOfProject, archiveJobSummary, deleteJobWithArchive } from './render/task-jobs.js';
// G0 四项锁
export { LOCK_KEYS, getLocks, addLocks, assertLocksComplete, inspectLocks } from './render/adaptation-locks.js';
// P10-A A-07：段输入指纹骨架（`seg-2`）。阶段 A 只交付结构，接线在阶段 D。
export {
  SEG_INPUTHASH_ALGO, PROMPT_BUILD_VER, HASH_PROJECTION_FIELDS, HASH_PROJECTION_ENGINE_FIELDS,
  COVERED_FIELDS, MEDIA_FIELDS, OUTPUT_FIELDS,
  canonicalJson, hashProjectionOf, segmentInputHash, isSegInputHash,
} from './render/input-hash.js';
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
