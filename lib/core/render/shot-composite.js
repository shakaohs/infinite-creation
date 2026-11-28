// 结构化项目的复合创建 / PATCH 分流（P10-A 阶段 C · C-06 / D02-40 §4.6）
//
// 把「三步同事务」从 HTTP 路由里抽出来，理由有两条：
//   ① 路由层没法在 node:test 里直接跑（NextResponse / NextRequest），抽出来才测得到真行为；
//   ② 同样的三步也会被 Agent 或脚本调用，逻辑留在路由里就会各写一份、慢慢分叉。
//
// 三步（D02-40 §4.6，写死）：
//   ① insertStoryShot      写 Stage 3 镜头（A 组内容）
//   ② projectRenderUnits   建段 + 回写 segment_id
//   ③ ShotParams.update    写段级生成参数（B 组）
// 任一步失败 ⇒ 整体回滚：不允许「镜建了段没建」，也不允许留下无归属的段。
import { getDb, txProject } from '../db.js';
import { insertStoryShot } from './global-no.js';
import { projectSceneUnits } from './project-units.js';
import { ShotParams } from './unit-params.js';
import { groupOfShotField } from '../writer.js';

function httpError(code, message, detail) {
  const e = new Error(message);
  e.code = code;
  if (detail) e.detail = detail;
  return e;
}

/** 把 A 组（shots 列名）映射到 story_shots 的列名。没有落点的字段必须报错，不静默丢。 */
const A_TO_STORY = Object.freeze({
  visual: 'visual_content', camera: 'cam_note', dialogue: 'dialogue', narration: 'narration', duration: 'story_duration',
});

export const STORY_MAPPED_FIELDS = Object.freeze(Object.keys(A_TO_STORY));

/**
 * 结构化项目：一次请求建「镜 + 段 + 段级参数」。
 *
 * @param {{projectId:string, chapterId:string, chapterTitle:string, sceneKey:string, sceneUid?:string, patch:object}} p
 * @returns {{segment_id:string, story_shot_id:string, shot:object}}
 */
export function createStructuredShot({ projectId, chapterId, chapterTitle, sceneKey, sceneUid = '', patch = {} } = {}) {
  const denied = Object.keys(patch).filter((k) => ['C', 'D', 'E'].includes(groupOfShotField(k)) && k !== 'updated_at');
  if (denied.length) {
    throw httpError('HTTP_SHOT_FIELD_DENIED',
      '结构化项目不接受这些字段：' + denied.join(', ') + '（产物归生成侧、快照归项目参数）', { fields: denied });
  }
  const aFields = Object.keys(patch).filter((k) => groupOfShotField(k) === 'A');
  const bFields = Object.keys(patch).filter((k) => groupOfShotField(k) === 'B');
  for (const k of aFields) {
    if (!A_TO_STORY[k] && !['idx', 'chapter', 'scene_name'].includes(k)) {
      throw httpError('STAGE3_FIELD_NOT_MAPPED', `字段 ${k} 在 story_shots 没有对应列，拒绝静默丢弃`, { field: k });
    }
  }

  return txProject(projectId, () => {
    const db = getDb();
    const maxRow = db.prepare('SELECT COALESCE(MAX(global_no),0) AS g FROM story_shots WHERE project_id = ?').get(projectId);
    const globalNo = Number(maxRow?.g || 0) + 1;
    const storyFields = {
      project_id: projectId, chapter_id: chapterId, scene_key: sceneKey,
      scene_uid: String(sceneUid || ''), global_no: globalNo,
      shot_no: patch.idx != null ? Number(patch.idx) : globalNo,
    };
    for (const k of aFields) {
      const col = A_TO_STORY[k];
      if (col) storyFields[col] = patch[k];
    }
    const row = insertStoryShot(storyFields);

    // 整段重投影（同一场次）：让段行与 Stage 3 权威立刻一致
    projectSceneUnits({ projectId, chapterId, sceneUid: String(sceneUid || ''), writer: 'projection' });
    const segId = db.prepare('SELECT segment_id FROM story_shots WHERE id = ?').get(row.id)?.segment_id || '';
    if (!segId) throw httpError('PROJECTION_MISSING_SEGMENT', '投影后仍未拿到 segment_id：拒绝返回半成品');

    if (bFields.length) {
      const bf = {};
      for (const k of bFields) bf[k] = patch[k];
      ShotParams.update(segId, bf, { origin: 'POST /shots' });
    }
    return { segment_id: segId, story_shot_id: row.id, shot: null, chapterTitle };
  });
}

/**
 * PATCH 三分流（纯函数，便于单测）：返回 { kind, fields }。
 * kind ∈ 'stage3' | 'denied' | 'params' | 'empty'。互斥：混组一律按"更严"的那一类拒。
 */
export function classifyStructuredPatch(patch = {}) {
  const by = { A: [], B: [], C: [], D: [], E: [] };
  for (const k of Object.keys(patch)) {
    const g = groupOfShotField(k);
    if (g) by[g].push(k);
  }
  if (by.A.length) return { kind: 'stage3', fields: by.A };
  const bad = [...by.C, ...by.E, ...by.D];
  if (bad.length) return { kind: 'denied', fields: bad };
  if (by.B.length) return { kind: 'params', fields: by.B };
  return { kind: 'empty', fields: [] };
}
