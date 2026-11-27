// P9：连续性 + QC 闭环（**会写库**）—— D02-21 §三/§四/§八
//
// POST /api/projects/:id/continuity/run
//   body: { sceneKey: string, annotations?: { [shotId]: { source, entries } },
//           plan?: { reportLevelRules: string[] } }
//   200: { solveHash, shotCount, reportLevelRules, states:{written,unchanged,deleted},
//          reports:[{shot_id,report_id,level,reused}], gate:{decision,level,blocking,reasons,!counts},
//          ck2:{total,passed} }
//
// 与 `continuity/solve` 的区别：那条**只读**（P8，测试 `W12` 静态断言它没有任何写入）；
// 这条是 P9 的写入闭环，内部只有一条链路：
//   `runSceneQuality()` → loadSceneInput → solveLoaded → persistSceneStates → buildShotReport → saveReport → gateOf
//
// 门禁结果是**业务结论**，不是 HTTP 错误：`decision='pause'` 时仍返回 200，
// 调用方读 `gate.reasons` 拿到"哪一镜、哪条规则、哪个字段"，修完再打一次即可（幂等）。
import { NextResponse } from 'next/server';
import { Projects } from '@/lib/core/index.js';
import { runSceneQuality } from '@/lib/core/continuity/run-scene.js';

export const dynamic = 'force-dynamic';

/** 入参类错误一律 400（与 `continuity/solve` 同一份口径；这些是"调用方给错了"） */
const INPUT_REASONS = new Set([
  'SCENE_INPUT_PROJECT_REQUIRED', 'SCENE_INPUT_SCENE_REQUIRED', 'SCENE_INPUT_ROWS_REQUIRED',
  'SCENE_INPUT_EMPTY', 'SCENE_INPUT_INVALID_JSON', 'SCENE_INPUT_INVALID_SHAPE',
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
  if (!sceneKey) return NextResponse.json({ error: '缺少 sceneKey（一次只跑一场）' }, { status: 400 });

  try {
    const out = runSceneQuality({
      projectId: id,
      sceneKey,
      annotations: body?.annotations,
      // 增量计划可选：给了就只消费它的 `reportLevelRules`（不重算 QIS）
      plan: body?.plan && typeof body.plan === 'object' ? body.plan : undefined,
    });
    return NextResponse.json(out);
  } catch (e) {
    if (e && e.code === 'CONTINUITY_SOLVER_FAILED' && INPUT_REASONS.has(e.reason)) {
      return NextResponse.json({ error: e.message, reason: e.reason, detail: e.detail ?? null }, { status: 400 });
    }
    if (e && (e.code === 'QC_REPORT_INVALID' || e.code === 'QC_MAPPING_INCONSISTENT')) {
      return NextResponse.json({ error: e.message, reason: e.reason ?? e.code }, { status: 400 });
    }
    throw e;
  }
}
