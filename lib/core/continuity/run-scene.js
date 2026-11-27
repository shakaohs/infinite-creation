// P9 生产闭环：读 → 组装 → 求解 → 状态持久化 → QC → 报告持久化 → 门禁
//
// 这是 P9 的**唯一生产入口**（`POST /api/projects/:id/continuity/run`）。它不重做求解器：
// 求解仍走 P8 的 `loadSceneInput() → solveLoaded()`（内部强制经 `assembleSolverShots()`），
// 本文件只负责"把结果落成事实，并按事实给出门禁结论"。
//
// 四条边界（都是前几轮踩出来的，别再放松）：
//  ① **求解输入不含 `shot_states`**：读库仍在 `loadSceneInput()` 里，它连 `shot_states` 都不读；
//     本轮写进去的状态只喂 QC（V-19/V-22 这类规则本来就该看状态），绝不回灌求解器；
//  ② **一个事务**：状态与报告同属一次 `tx()`。任一步抛错整体回滚 —— "状态写了、报告没写"
//     会让下一次读的人以为这一镜已解且无问题；
//  ③ **幂等靠内容，不靠主键**：状态比内容 Hash（没变不写），报告比 `qc_input_hash` +
//     规则依赖全集（没变不插行）。所以重复提交既不产生新事实，也不吞掉历史；
//  ④ **门禁只认报告级结论**：`gateOf()` 吃的是落库报告的 `level` 与 `fail` 条目，
//     不是"某条规则的结果"，也不是调用方声明。
import { tx } from '../db.js';
import { cmpStr } from '../hash/cmp-str.js';
import { loadSceneInput } from './load-scene.js';
import { solveLoaded } from './solve-scene.js';
import { persistSceneStates } from './persist-state.js';
import { solveError } from './solver-error.js';
import { SOLVER_VERSION } from './solve-hash.js';
import {
  buildShotReport, saveReport, assertReportLevelRules, REPORT_TARGET_TYPE,
} from '../qc/report.js';
import { gateOf } from '../qc/gate.js';
import { ck2Audit, ck2Summary } from '../qc/deps/ck2.js';
import { AUDIT_RULE_IDS } from '../qc/deps/rule-deps.js';

/**
 * 全量重建时的报告级规则集合。
 *
 * 依据 U-P6-2 契约①："非空 ⇔ QIS 非空"。整场重建意味着**每条规则都要跑**，QIS 自然是全集，
 * 审计级三条必在其中。增量的 QIS 由 `planInvalidation()` 给出，那种情况下**只消费它**，
 * 不在这里重算 —— 重算等于绕过 P6 的失效编排（那才是"顺手重构"）。
 */
export function fullRebuildReportLevelRules() {
  return [...AUDIT_RULE_IDS].sort(cmpStr);
}

/** 内存里的状态行（与 `shot_states` 同形），供 QC 读取；不回头查库，避免同一事务里读到别人写的行 */
function stateRowOf(st) {
  return {
    shot_id: String(st.id),
    state_in: st.in,
    state_out: st.out,
    meta: st.meta,
    derived_from: st.derived_from,
    state_source: 'solved',
    conflicts: st.conflicts,
  };
}

/** `nextShotState` 只取 A-06 真正读的三列（形状校验在 `normalizeNextShot` 里，拒绝整行） */
function nextStateOf(st) {
  if (!st) return null;
  return { state_in: st.in, state_out: st.out, conflicts: st.conflicts };
}

/**
 * 跑一场戏的完整闭环。
 *
 * @param {{projectId:string, sceneKey:string, annotations?:object,
 *          plan?:{reportLevelRules:string[], qcInvalidationSet?:object},
 *          updatedAt?:number}} p
 *   `plan`：增量失效计划（`planInvalidation()` 的返回值）。给了就**只用它的 `reportLevelRules`**；
 *   不给 = 全量重建 = 三条审计级。
 * @returns {{projectId:string, sceneKey:string, solveHash:string, solverVersion:string,
 *            shotCount:number, reportLevelRules:string[], ck2:{total:number, passed:number},
 *            states:{written:Array, unchanged:string[], deleted:string[]},
 *            reports:Array<{shot_id:string, report_id:string, level:string, reused:boolean}>,
 *            gate:object, entity:'scene'}}
 */
export function runSceneQuality({ projectId, sceneKey, annotations, plan, updatedAt } = {}) {
  // ① 映射自检先跑：映射不全时，任何一条规则的 `rule_dependency_hash` 都不可信。
  //    这一步是纯函数、不写库，放最前面 —— 早失败比"写到一半才发现"便宜得多。
  const ck2 = ck2Audit();
  if (!ck2.ok) {
    throw solveError(
      `QC 规则映射自检未通过（${ck2.passed}/${ck2.total}）：${ck2Summary(ck2) || '见 diffs'}`,
      { reason: 'QC_MAPPING_INCONSISTENT', diffs: ck2.diffs },
    );
  }

  // ② 读 + 求解：仍是 P8 那一条链路，不新增第二条
  const loaded = loadSceneInput({ projectId, sceneKey });
  if (!loaded.shotCount) {
    throw solveError(`场次 ${sceneKey} 没有任何镜头，无法求解（不产出空报告）`, { reason: 'SCENE_INPUT_EMPTY' });
  }
  const solved = solveLoaded({
    projectId, sceneKey, rows: loaded.rows, sceneState: loaded.sceneState, annotations,
  });

  // ③ 报告级规则：消费 plan，或全量重建的三条
  const reportLevelRules = plan
    ? assertReportLevelRules(plan.reportLevelRules, [...AUDIT_RULE_IDS])
    : fullRebuildReportLevelRules();

  const order = Object.keys(solved.states);
  const rowsById = new Map(loaded.rows.map((r) => [String(r.id), r]));
  const missing = order.filter((id) => !rowsById.has(String(id)));
  if (missing.length) {
    throw solveError(`求解结果含未知镜头（${missing.join(',')}），拒绝写入`, { reason: 'STATE_SHOT_UNKNOWN', shotIds: missing });
  }

  // ④ 状态 + 报告：同一事务
  const write = tx(() => {
    const states = persistSceneStates({ projectId, sceneKey, states: solved.states, updatedAt });

    const stateRows = new Map(order.map((id) => [String(id), stateRowOf(solved.states[id])]));
    const reports = [];
    order.forEach((id, i) => {
      const row = rowsById.get(String(id));
      const prevId = i > 0 ? String(order[i - 1]) : '';
      const nextId = i + 1 < order.length ? String(order[i + 1]) : '';
      const prevRow = prevId ? rowsById.get(prevId) : null;

      const { report } = buildShotReport({
        projectId,
        sceneKey,
        shot: row,
        blockings: row.blockings ?? [],
        actions: row.actions ?? [],
        shotAssets: row.shotAssets ?? [],
        assets: [], // 库里没有资产主表（shot_assets 只存引用）；引用不到的资产由 deps 层填 __missing__
        sceneState: loaded.sceneState,
        shotState: stateRows.get(String(id)),
        prevShot: prevRow,
        prevShotState: prevId ? stateRows.get(prevId) : null,
        prevShotAssets: prevRow ? (prevRow.shotAssets ?? []) : [],
        prevActions: prevRow ? (prevRow.actions ?? []) : [],
        nextShot: nextId ? rowsById.get(nextId) : null,
        nextShotState: nextId ? nextStateOf(solved.states[order[i + 1]]) : null,
        chapterShots: loaded.rows,
        reportLevelRules,
        qcInputHash: solved.hash,
        auditIds: [...AUDIT_RULE_IDS],
        createdAt: updatedAt,
      });

      const saved = saveReport(report);
      reports.push({
        shot_id: String(report.target_id),
        report_id: saved.id,
        level: report.level,
        reused: saved.reused,
        report,
      });
    });

    return { states, reports };
  });

  // ⑤ 门禁：吃落库报告（同一份对象，不重新构建 —— 避免"门禁看的和存下的不是一份"）
  const gate = gateOf(write.reports.map((r) => ({
    target_id: r.shot_id, level: r.level, hits: r.report.hits,
  })));

  return {
    entity: 'scene',
    projectId: String(projectId),
    sceneKey: String(sceneKey),
    solveHash: solved.hash,
    solverVersion: SOLVER_VERSION,
    shotCount: order.length,
    reportLevelRules,
    ck2: { total: ck2.total, passed: ck2.passed },
    states: write.states,
    reports: write.reports.map(({ shot_id, report_id, level, reused }) => ({ shot_id, report_id, level, reused })),
    gate,
    targetType: REPORT_TARGET_TYPE,
    sceneConflicts: solved.sceneConflicts,
  };
}
