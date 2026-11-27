// 场次实例的空间基线（`scene_states`）—— D02-06 §4.8 / §4.8.1 / §4.8.2（A-03.3）
//
// 两条铁律：
//   1. **行存在 ≠ 空间已定义**。允许"这场戏存在、但几何还不知道"；**禁止编造几何**
//      （编一个 active_area 会让 S-15/V-21 的米/归一化换算全部算错，且没人看得出来）。
//   2. **只由剧本抽取阶段写**。权限断言不在这里，而在工具处理函数首行（`ctx.toolSet`）——
//      本模块可能被脚本/测试直接调用，它是"落库与校验"，不是权限边界。
//
// 这里只写 `scene_states`：不写 `story_shots`、不写 `shot_blockings` / `shot_actions`、不创建资产。
import { getDb, tx, Assets } from './db.js';
import { uid, now } from './utils.js';

/** 带错误码的业务错误（与 tools.js / 路由的 e.code 约定一致） */
export function sceneStateError(code, message, detail = {}) {
  const e = new Error(message);
  e.code = code;
  e.detail = detail;
  return e;
}

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * `fixtures[].zone` 校验（§4.8.1）：必须是 4 个 `0..1` 数字，且 `x1<x2`、`y1<y2`。
 * 缺 `zone` 是允许的（固定物知道、位置不知道 → 不编造）。
 */
export function assertFixtureZones(fixtures, sceneKey = '') {
  if (fixtures == null) return;
  const at = sceneKey ? `场次「${sceneKey}」的 fixtures` : 'fixtures';
  if (!Array.isArray(fixtures)) {
    throw sceneStateError('FIXTURE_ZONE_INVALID', `${at} 必须是数组`, { sceneKey, got: typeof fixtures });
  }
  fixtures.forEach((f, i) => {
    if (!isObj(f)) {
      throw sceneStateError('FIXTURE_ZONE_INVALID', `${at}[${i}] 必须是对象`, { sceneKey, index: i });
    }
    if (f.zone == null) return;
    const z = f.zone;
    if (!Array.isArray(z) || z.length !== 4 || !z.every(isNum)) {
      throw sceneStateError('FIXTURE_ZONE_INVALID', `${at}[${i}].zone 必须是 4 个数字（x1,y1,x2,y2）`, { sceneKey, index: i, zone: z });
    }
    const [x1, y1, x2, y2] = z;
    if (![x1, y1, x2, y2].every((v) => v >= 0 && v <= 1)) {
      throw sceneStateError('FIXTURE_ZONE_INVALID', `${at}[${i}].zone 的四个值必须都在 0..1 之间`, { sceneKey, index: i, zone: z });
    }
    if (!(x1 < x2)) {
      throw sceneStateError('FIXTURE_ZONE_INVALID', `${at}[${i}].zone 必须 x1 < x2（当前 ${x1} >= ${x2}）`, { sceneKey, index: i, zone: z });
    }
    if (!(y1 < y2)) {
      throw sceneStateError('FIXTURE_ZONE_INVALID', `${at}[${i}].zone 必须 y1 < y2（当前 ${y1} >= ${y2}）`, { sceneKey, index: i, zone: z });
    }
  });
}

/** `scene_id` 非空时必须属于本项目且 `category='scene'`（§4.8.1） */
function assertSceneAsset(projectId, sceneId, sceneKey) {
  const id = String(sceneId || '').trim();
  if (!id) return '';                      // 空 = 纯虚拟场次，允许（D01-04 §2.1）
  const asset = Assets.get(id);
  if (!asset || asset.project_id !== projectId || asset.category !== 'scene') {
    throw sceneStateError(
      'SCENE_ASSET_NOT_FOUND',
      `场次「${sceneKey}」的 scene_id=${id} 不是本项目的场景资产（category 必须是 scene）`,
      { sceneKey, sceneId: id, foundProject: asset ? asset.project_id : null, foundCategory: asset ? asset.category : null },
    );
  }
  return id;
}

/** 几何/轴线的"不完整"判定：只判"缺什么"，绝不补默认值 */
function incompletenessOf(coordSystem, axisLock) {
  const out = {};
  if (isObj(coordSystem)) {
    // basis（坐标基准）与 active_area（有效面积，归一化↔米的唯一依据）缺任一 → 不完整
    out.coord_system = !(coordSystem.basis != null && coordSystem.basis !== '') || !(coordSystem.active_area != null);
  }
  if (isObj(axisLock)) {
    // axis_line 缺失 → 不完整；此时 **不得** 用"画面左右"反推物理左右（D01-04 §5.4）
    out.axis_lock = !(axisLock.axis_line != null && axisLock.axis_line !== '');
  }
  return out;
}

function qcNotesOf(incomplete, sceneKey) {
  const notes = [];
  if (incomplete.coord_system) {
    notes.push({ code: 'COORD_SYSTEM_INCOMPLETE', level: 'info', scene_key: sceneKey, note: '坐标系缺 basis 或 active_area，已按已知部分落库（未编造尺寸）' });
  }
  if (incomplete.axis_lock) {
    notes.push({ code: 'AXIS_LOCK_INCOMPLETE', level: 'warn', scene_key: sceneKey, note: '缺 axis_line，已落库但轴线不可判定' });
    notes.push({ code: 'AXIS_UNVERIFIED', level: 'info', scene_key: sceneKey, rules: ['S-05', 'S-06'], note: 'S-05/S-06 输出不可验证（INFO）' });
  }
  return notes;
}

/**
 * 建/更一个场次实例的基线。返回 `{ created, updated, scenes[] }`。
 *
 * 幂等：`(project_id, scene_key)` 唯一（DDL 侧有 `uq_scene_state` 唯一索引兜底）。
 *   · 首次 → INSERT，`state_rev=1`
 *   · 重写 → UPDATE，`state_rev += 1`，**只更新本次显式给出的字段**（没给的不动，避免"改个轴锁把 fixtures 抹了"）
 */
export function upsertSceneStates(projectId, chapter, scenes) {
  if (!projectId) throw sceneStateError('PROJECT_NOT_FOUND', '缺少项目 id');
  if (!chapter || !chapter.id) throw sceneStateError('CHAPTER_NOT_FOUND', '缺少章节');
  if (!Array.isArray(scenes) || !scenes.length) {
    throw sceneStateError('SCENES_REQUIRED', 'scenes 不能为空：一章一次提交，至少一个场次实例');
  }

  // 批内去重：同一个 scene_key 出现两次会让"一次提交"变成两次重写，state_rev 静默 +2
  const seen = new Set();
  for (const s of scenes) {
    const key = String(s && s.scene_key || '').trim();
    if (!key) throw sceneStateError('SCENE_KEY_REQUIRED', '每个场次都必须给 scene_key（项目内唯一）');
    if (seen.has(key)) throw sceneStateError('SCENE_KEY_DUPLICATED', `同一批里 scene_key「${key}」出现了多次`, { sceneKey: key });
    seen.add(key);
  }

  const results = [];
  tx(() => {
    for (const raw of scenes) {
      const sceneKey = String(raw.scene_key).trim();
      // 先做纯校验（不写库）：任何一条不合法，整个 tx 都不落盘
      assertFixtureZones(raw.fixtures, sceneKey);
      const sceneId = assertSceneAsset(projectId, raw.scene_id, sceneKey);
      for (const k of ['coord_system', 'entries', 'axis_lock', 'power_geometry']) {
        if (raw[k] != null && !isObj(raw[k])) {
          throw sceneStateError('SCENE_FIELD_INVALID', `场次「${sceneKey}」的 ${k} 必须是对象`, { sceneKey, field: k });
        }
      }

      const t = now();
      const existing = getDb().prepare('SELECT * FROM scene_states WHERE project_id = ? AND scene_key = ?').get(projectId, sceneKey);

      if (!existing) {
        const id = uid();
        getDb().prepare(
          'INSERT INTO scene_states (id,project_id,scene_key,scene_id,coord_system,fixtures,entries,axis_lock,power_geometry,crowd_switch,time_of_day,state_rev,created_at,updated_at)'
          + ' VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
        ).run(
          id, projectId, sceneKey, sceneId,
          JSON.stringify(isObj(raw.coord_system) ? raw.coord_system : {}),
          JSON.stringify(Array.isArray(raw.fixtures) ? raw.fixtures : []),
          JSON.stringify(isObj(raw.entries) ? raw.entries : {}),
          JSON.stringify(isObj(raw.axis_lock) ? raw.axis_lock : {}),
          JSON.stringify(isObj(raw.power_geometry) ? raw.power_geometry : {}),
          raw.crowd_switch == null ? '' : String(raw.crowd_switch),
          raw.time_of_day == null ? '' : String(raw.time_of_day),
          1, t, t,
        );
        const row = getDb().prepare('SELECT * FROM scene_states WHERE id = ?').get(id);
        const inc = incompletenessOf(raw.coord_system, raw.axis_lock);
        results.push({
          scene_key: sceneKey, id, scene_id: sceneId, state_rev: 1, created: true,
          incomplete: inc, qc_notes: qcNotesOf(inc, sceneKey),
        });
        void row;
        continue;
      }

      // 只更新本次显式给出的字段：未提供的保持原值（局部重写不误删已知几何）
      const sets = [];
      const vals = [];
      const put = (col, v) => { sets.push(col + ' = ?'); vals.push(v); };
      if (raw.scene_id !== undefined) put('scene_id', sceneId);
      if (raw.coord_system !== undefined) put('coord_system', JSON.stringify(isObj(raw.coord_system) ? raw.coord_system : {}));
      if (raw.fixtures !== undefined) put('fixtures', JSON.stringify(Array.isArray(raw.fixtures) ? raw.fixtures : []));
      if (raw.entries !== undefined) put('entries', JSON.stringify(isObj(raw.entries) ? raw.entries : {}));
      if (raw.axis_lock !== undefined) put('axis_lock', JSON.stringify(isObj(raw.axis_lock) ? raw.axis_lock : {}));
      if (raw.power_geometry !== undefined) put('power_geometry', JSON.stringify(isObj(raw.power_geometry) ? raw.power_geometry : {}));
      if (raw.crowd_switch !== undefined) put('crowd_switch', raw.crowd_switch == null ? '' : String(raw.crowd_switch));
      if (raw.time_of_day !== undefined) put('time_of_day', raw.time_of_day == null ? '' : String(raw.time_of_day));
      put('state_rev', Number(existing.state_rev || 0) + 1);
      put('updated_at', t);
      getDb().prepare(`UPDATE scene_states SET ${sets.join(', ')} WHERE id = ?`).run(...vals, existing.id);
      const after = getDb().prepare('SELECT * FROM scene_states WHERE id = ?').get(existing.id);
      const inc = incompletenessOf(
        raw.coord_system !== undefined ? raw.coord_system : JSON.parse(existing.coord_system || '{}'),
        raw.axis_lock !== undefined ? raw.axis_lock : JSON.parse(existing.axis_lock || '{}'),
      );
      results.push({
        scene_key: sceneKey, id: existing.id, scene_id: after.scene_id, state_rev: after.state_rev, created: false,
        incomplete: inc, qc_notes: qcNotesOf(inc, sceneKey),
      });
    }
  });

  return {
    chapter: chapter.title,
    chapter_id: chapter.id,
    created: results.filter((r) => r.created).length,
    updated: results.filter((r) => !r.created).length,
    scenes: results,
  };
}

/**
 * 场次基线前置检查（§4.8.2）：镜要引用的 `scene_key` 必须已在 `scene_states` 有行。
 *
 * **不自动建空行**：自动建行会把"场次存在但空间未知"退化成"场次已定义"，下游（连续性、编译）
 * 会以为有基线可用 —— 这正是审核点名的"为了满足外键随意创建空场景基线"。
 *
 * P2 只交付这个判定本身；接进 `set_storyboard`（抛 `SCENE_STATE_MISSING` 且只拒该镜）属 P8。
 */
export function assertSceneKeysExist(projectId, sceneKeys) {
  const wanted = [...new Set((sceneKeys || []).map((k) => String(k || '').trim()).filter(Boolean))];
  if (!wanted.length) return { ok: true, missing: [] };
  const rows = getDb().prepare('SELECT scene_key FROM scene_states WHERE project_id = ?').all(projectId).map((r) => r.scene_key);
  const have = new Set(rows);
  const missing = wanted.filter((k) => !have.has(k));
  if (missing.length) {
    throw sceneStateError(
      'SCENE_STATE_MISSING',
      '以下场次还没有空间基线（scene_states 无行），拒绝写入引用它们的镜：' + missing.join('、'),
      { projectId, missing },
    );
  }
  return { ok: true, missing: [] };
}

/** 读回（供工具/后续 P11 只读接口复用；不含任何写逻辑） */
export function listSceneStates(projectId) {
  return getDb().prepare('SELECT * FROM scene_states WHERE project_id = ? ORDER BY scene_key ASC').all(projectId).map((r) => ({
    ...r,
    coord_system: JSON.parse(r.coord_system || '{}'),
    fixtures: JSON.parse(r.fixtures || '[]'),
    entries: JSON.parse(r.entries || '{}'),
    axis_lock: JSON.parse(r.axis_lock || '{}'),
    power_geometry: JSON.parse(r.power_geometry || '{}'),
    incomplete: incompletenessOf(JSON.parse(r.coord_system || '{}'), JSON.parse(r.axis_lock || '{}')),
  }));
}
