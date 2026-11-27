// P8：连续性求解（只读计算，**不写库**）—— D02-20 R2/R3
//
// POST /api/projects/:id/continuity/solve
//   body: { sceneKey: string, annotations?: { [shotId]: { source, entries } } }
//   200: { sceneKey, shotCount, annotatedShotIds, baselineMissing, states, sceneConflicts,
//          hash, solverVersion, annotationSourceNote }
//
// 这条路由是"生产调用点"：它**只**调 `solveSceneContinuity()`，内部依次是
// 读库 → 组装（`assembleSolverShots`）→ 求解（`solveContinuity`）。
// 不允许在这里直接调 `solveContinuity`：那样就绕过了来源隔离（D02-19 的旁路就是这么来的）。
//
// 读写边界：本路由**没有任何写入**。`shot_states` 的持久化、`carried` 继承、QC 报告都属 P9，
// 因此不需要事务，也不会有"半成品状态"。`annotations` 只影响本次计算，不落库。
import { NextResponse } from 'next/server';
import { Projects } from '@/lib/core/index.js';
import { solveSceneContinuity } from '@/lib/core/continuity/solve-scene.js';

export const dynamic = 'force-dynamic';

/** 入参类错误一律 400：这些 reason 都是"调用方给的东西不对"，不是服务端故障 */
const INPUT_REASONS = new Set([
  'SCENE_INPUT_PROJECT_REQUIRED', 'SCENE_INPUT_SCENE_REQUIRED', 'SCENE_INPUT_ROWS_REQUIRED',
  'SCENE_INPUT_INVALID_JSON', 'SCENE_INPUT_INVALID_SHAPE',
  'SHOT_INPUT_INVALID', 'SHOT_ID_MISSING', 'SHOT_ID_DUPLICATED',
  'SHOT_GLOBAL_NO_INVALID', 'SHOT_GLOBAL_NO_NOT_NUMBER', 'SHOT_GLOBAL_NO_DUPLICATED', 'SHOT_SCENE_MISMATCH',
  'ANNOTATION_SOURCE_MISSING', 'ANNOTATION_SOURCE_IS_RESULT', 'ANNOTATION_SOURCE_UNKNOWN',
  'ANNOTATION_SHOT_MISSING', 'ANNOTATION_SHOT_NOT_FOUND', 'ANNOTATION_FIELD_INVALID',
  'ANNOTATION_CARRIES_RESULT_FIELDS', 'ANNOTATION_REL_REQUIRED', 'ANNOTATION_REL_INVALID',
  'ROWS_META_NOT_ALLOWED',
  'META_IS_RESULT_FEEDBACK', 'META_SRC_UNKNOWN', 'SOLVE_META_INVALID_JSON', 'SOLVE_META_NOT_OBJECT',
]);

export async function POST(req, { params }) {
  const { id } = await params;
  if (!Projects.get(id)) return NextResponse.json({ error: '项目不存在' }, { status: 404 });

  const body = await req.json().catch(() => ({}));
  const sceneKey = String(body?.sceneKey ?? '').trim();
  if (!sceneKey) return NextResponse.json({ error: '缺少 sceneKey（一次只解一场）' }, { status: 400 });

  try {
    const out = solveSceneContinuity({ projectId: id, sceneKey, annotations: body?.annotations });
    return NextResponse.json(out);
  } catch (e) {
    if (e && e.code === 'CONTINUITY_SOLVER_FAILED' && INPUT_REASONS.has(e.reason)) {
      return NextResponse.json({ error: e.message, reason: e.reason, detail: e.detail ?? null }, { status: 400 });
    }
    throw e;
  }
}
