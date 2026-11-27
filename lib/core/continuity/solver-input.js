// 求解器输入契约（P8 组装层与 `solveContinuity` 共用的唯一入口）
//
// 这个模块回答一个问题：**什么可以进 `solveContinuity`，什么必须被挡在门外。**
//
// 判据来自 D02-17 的实测，而不是"看起来合理"：
//  · `rel` 会决定"沿用还是改写"——回搬一份 `rel:'known'` 能把 carried 变成写入；
//  · `src` 会决定 `originOf()` ——回搬 `carried:sh_99` 能伪造一个不存在的继承起点；
//  · `conf` 是 `conf × 0.9` 的衰减基数——回搬会把它换基（0.855 变 0.5），
//    于是"衰减了一次还是三次"再没人说得清。
// 三者都是真输入，所以**"只留 rel"是错的**（Hash 会漏掉另外两个真输入）。
// 真正的问题不是字段多少，而是**来源**：这三个字段在 `shot_states.meta` 里是求解结果，
// 在 `shots[].meta` 里却被当成输入。同一个 JSON、两种含义，这才是冲突的根。
//
// 因此本模块只做两件事：
//  ① 结构校验（`id` / `global_no` / `scene_key`）——缺一项就拒绝，不让它静默按 0 排序或跨场串链；
//  ② 来源校验（`src` 前缀）——求解器产出的 src 一律拒收，只接受 `manual:` 开头的输入标注。
import { solveError } from './solver-error.js';

/**
 * 输入标注的 `src` 前缀（**唯一**允许从 `shots[].meta` 进来的来源）。
 * 人工 / 适配层标注必须显式带上它，否则无法与求解结果区分。
 */
export const ANNOTATION_SRC_PREFIX = 'manual:';

/**
 * 求解器产出的 `src` 前缀。出现在 `shots[].meta` 里即为"结果回搬"，一律拒收。
 *
 * | 前缀 | 谁写的 | 含义 |
 * |---|---|---|
 * | `blocking:` | `applyField` 写值分支 | 取自本镜 `shot_blockings` |
 * | `carried:` | 沿用分支 | 沿用自某个起点镜 |
 * | `prev_shot:` | Step 1 版本戳 | 上一镜自己填的（非跨镜沿用） |
 * | `action:` | 动作覆盖 | 由动作 `result` 给出 |
 * | `rule:` | 无值占位 | `rule:no_value` |
 * | `scene_baseline` | 首镜基线 | 场次基线生成 |
 */
export const RESULT_SRC_PREFIXES = Object.freeze([
  'blocking:', 'carried:', 'prev_shot:', 'action:', 'rule:', 'scene_baseline',
]);

/** `src` 是否由求解器产出（→ 不得作为输入） */
export function isResultSrc(src) {
  const s = String(src ?? '');
  if (!s) return false;
  return RESULT_SRC_PREFIXES.some((p) => (p.endsWith(':') ? s.startsWith(p) : s === p));
}

/** 规范化后的 `src` 是否为合法的输入标注（缺省 = 未声明来源，按"裸标注"放行） */
export function isAnnotationSrc(src) {
  if (src === null || src === undefined || src === '') return true;
  return String(src).startsWith(ANNOTATION_SRC_PREFIX);
}

/**
 * 结构校验：`id` / `global_no` / `scene_key`。
 *
 * 顺序是刻意的（`id` → `global_no` → `scene_key`）：`{global_no: 1}` 这种"只填了号"的
 * 坏输入应当先报"缺少 id"，而不是先报场次不符 —— 报错要指向最根本的缺失。
 *
 * @param {{shots:Array, sceneKey:string}} p
 * @throws {Error} `CONTINUITY_SOLVER_FAILED`，`reason` 区分 `SHOT_ID_MISSING` /
 *   `SHOT_GLOBAL_NO_INVALID` / `SHOT_SCENE_MISMATCH`
 */
export function assertSolverInput({ shots, sceneKey } = {}) {
  if (!Array.isArray(shots)) return; // 数组校验在 solveContinuity 里先做，抛的是同码
  const rows = shots.filter((s) => s && typeof s === 'object');
  for (const s of rows) {
    if (!s.id) {
      throw solveError('镜头缺少 id', { reason: 'SHOT_ID_MISSING' });
    }
  }
  for (const s of rows) {
    const n = Number(s.global_no);
    // 缺失时 `sort` 会用 `?? 0` 把它排到最前 —— 等于静默改变整条链的顺序，必须拦
    if (!Number.isFinite(n) || n < 1) {
      throw solveError(
        `镜头 ${s.id} 的 global_no 无效（收到 ${JSON.stringify(s.global_no)}）；`
        + '缺失时会被静默按 0 排到最前，整条继承链的顺序随之失真',
        { reason: 'SHOT_GLOBAL_NO_INVALID', shot_id: String(s.id) },
      );
    }
  }
  const badScene = rows.filter((s) => String(s.scene_key ?? '') !== String(sceneKey ?? '')).map((s) => String(s.id));
  if (badScene.length) {
    // 求解器**不按 scene_key 过滤**（D01-04 §5.5 要求前镜同场），混传会静默跨场串链
    throw solveError(
      `有 ${badScene.length} 个镜头不属于场次 ${JSON.stringify(sceneKey)}：${badScene.slice(0, 5).join(',')}；`
      + '求解器不按 scene_key 过滤，混传会静默跨场串链',
      { reason: 'SHOT_SCENE_MISMATCH', shot_ids: badScene },
    );
  }
}

/**
 * 来源校验：`shots[].meta` 只接受输入标注，不接受求解结果回搬。
 *
 * `state_in` 那种"整份状态行"是最典型的误用：它同时带 `rel/src/conf`，
 * 一旦原样塞进来，值会被改写、继承链起点会被伪造、置信度会被换基（见文件头）。
 *
 * @param {string} shotId
 * @param {object} seed 已 `normalizeShotMeta` 归一化的输入标注
 * @throws {Error} `CONTINUITY_SOLVER_FAILED`，`reason = 'META_IS_RESULT_FEEDBACK'`
 */
export function assertAnnotationOnly(shotId, seed = {}) {
  for (const key of Object.keys(seed)) {
    const src = seed[key]?.src;
    if (isResultSrc(src)) {
      throw solveError(
        `镜头 ${shotId} 的 shots[].meta.${key} 带求解结果来源 src=${JSON.stringify(src)}；`
        + 'shots[].meta 只接受输入标注（src 以 manual: 开头或缺省），'
        + '不得把 shot_states.meta 整体回搬（D02-17 §四）',
        { reason: 'META_IS_RESULT_FEEDBACK', shot_id: String(shotId), field: key },
      );
    }
    if (!isAnnotationSrc(src)) {
      throw solveError(
        `镜头 ${shotId} 的 shots[].meta.${key} 的 src=${JSON.stringify(src)} 不是可识别的输入来源；`
        + `输入标注必须以 ${ANNOTATION_SRC_PREFIX} 开头`,
        { reason: 'META_SRC_UNKNOWN', shot_id: String(shotId), field: key },
      );
    }
  }
}
