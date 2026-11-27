// P8 生产入口：真实数据 → 组装 → 求解（**唯一的连续性求解生产路径**，D02-20 R2/R3）
//
// 调用链（唯一）：
//   数据库读取（load-scene.js，只读）
//     → 数据转换（同层完成：JSON 列解析、三张从表按镜分组）
//     → annotations 独立构造（调用方显式给出 source；**不从 shot_states 来**）
//     → assembleSolverShots()（来源隔离 + global_no 规范化 + id/号唯一性）
//     → solveContinuity()（纯函数求解）
//
// 为什么要有这一层而不是让路由直接调 `solveContinuity`：
//  · 组装层必须拿到"干净的行"，而"干净"的定义只在这里——路由自己拼行迟早漏一道（D02-19 就是这么漏的）；
//  · 生产调用点必须可枚举：`stage3-p8-wiring` 有一条静态断言，`lib/` 与 `app/` 里除本文件外
//    不得出现 `solveContinuity(`，否则"绕过组装层"会以"某人图省事"的方式回来。
//
// 本轮**不写库**：`shot_states` 的持久化、`carried` 继承、QC 报告都属 P9。
// 这里返回的 `states` 只在内存里，调用方可自行决定是否落盘（P9 才做）。
import { loadSceneInput } from './load-scene.js';
import { assembleSolverShots } from './assemble-input.js';
import { solveContinuity } from './solve-continuity.js';
import { SOLVER_VERSION } from './solve-hash.js';
import { solveError } from './solver-error.js';

/**
 * 解一场（真实数据入口）。
 *
 * @param {{projectId:string, sceneKey:string, annotations?:object}} p
 *   `annotations`：`{ [shotId]: { source: 'manual'|'adaptation', entries: {...} } }`，
 *   必须由调用方显式给出。默认空 —— 空即"本场没有任何人工标注"，不是"随便补点什么"。
 * @returns {{sceneKey:string, shotCount:number, annotatedShotIds:string[], baselineMissing:boolean,
 *            states:object, sceneConflicts:Array, hash:string, solverVersion:string,
 *            annotationSourceNote:string}}
 * @throws {Error} `CONTINUITY_SOLVER_FAILED`（`reason` 前缀 `SCENE_INPUT_*` / `SHOT_*` / `ANNOTATION_*` / `ROWS_*`）
 */
export function solveSceneContinuity({ projectId, sceneKey, annotations } = {}) {
  const loaded = loadSceneInput({ projectId, sceneKey });
  return solveLoaded({ projectId, ...loaded, annotations });
}

/**
 * 已有行数据时的组装+求解（读库与计算分离，供集成测试与"已在外层读好"的调用方使用）。
 *
 * 仍然**强制经过 `assembleSolverShots()`** —— 这不是可选步骤，而是这一层的全部意义。
 *
 * @param {{projectId:string, sceneKey:string, rows:Array, sceneState?:object|null, annotations?:object}} p
 * @returns {object} 同 {@link solveSceneContinuity}
 */
export function solveLoaded({ projectId, sceneKey, rows, sceneState, annotations } = {}) {
  if (!Array.isArray(rows)) {
    throw solveError('solveLoaded：rows 必须是数组（读库结果或等价的行集合）', { reason: 'SCENE_INPUT_ROWS_REQUIRED' });
  }
  const { shots, annotatedShotIds } = assembleSolverShots({ projectId, sceneKey, rows, annotations });
  const { states, sceneConflicts, hash } = solveContinuity({ projectId, sceneKey, shots, sceneState });

  return {
    sceneKey,
    shotCount: shots.length,
    annotatedShotIds,
    baselineMissing: !sceneState,
    states,
    sceneConflicts,
    hash,
    solverVersion: SOLVER_VERSION,
    annotationSourceNote: 'manual/adaptation 标注由调用方显式提供，不从 shot_states.meta 读取',
  };
}
