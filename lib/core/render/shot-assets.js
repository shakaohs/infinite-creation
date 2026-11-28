// 镜头资产引用契约（`shot_assets`）—— D02-06 V7 §4.4.2 / A-03.2 / AS-1~AS-10
//
// 一句话模型：**`shot_assets` 是唯一权威，`story_shots.voice_ids` 是派生**。
//
// 三条不许越界：
//   ① **0 命中必须拒绝**。旧 `set_storyboard` 的 `idsOf()` 命中不到资产名时只回报、照常写入，
//      于是库里出现"有镜、没资产"的镜 —— 等到编译期才发现参考图全缺。新路径一律 `ASSET_NOT_FOUND`。
//   ② **类别即 role**：`role` 只允许六个值，且必须等于资产 `category`；`music`/`sfx`/`video`/`other`
//      不许进 `shot_assets`（它们不参与画面参考图解析，写进来只会让下游把它们当成"会出现在画面里"的资产）。
//   ③ **派生列不许外部写**：`voice_ids` 只由本模块按 `role='voice' ORDER BY order_no` 回填；
//      外部传了就忽略并记 `DERIVED_FIELD_IGNORED`（静默忽略和静默接受一样危险，这里留痕）。
//
// 本模块不创建资产、不写 `scene_states`、不写动作/站位/状态。
import { getDb, txProject, assertProjectLocked } from '../db.js';
import { recordChange, rawGet } from '../changelog.js';
import { now } from '../utils.js';
import { insertStoryShot } from './global-no.js';

/** AS-4：能进 `shot_assets` 的 role（与 `assets.category` 同名） */
export const SHOT_ASSET_ROLES = ['character', 'scene', 'prop', 'costume', 'age', 'voice'];
/** AS-6：每镜最多 3 条 voice（DB `CHECK` 兜底） */
export const MAX_VOICE_PER_SHOT = 3;
/** 变体只能挂在角色下（AS-7） */
const VARIANT_ROLES = ['costume', 'age'];

/** 形态 A 的六个键 → role（与旧工具同名，便于 Skill 复用） */
const FORM_A_KEYS = {
  characters: 'character',
  scenes: 'scene',
  props: 'prop',
  costumes: 'costume',
  ages: 'age',
  voices: 'voice',
};

export function shotAssetError(code, message, detail = {}) {
  const e = new Error(message);
  e.code = code;
  e.detail = detail;
  return e;
}

const norm = (v) => String(v ?? '').trim();

/**
 * 解析并校验镜头资产引用（不做落库）。
 *
 * @param {{projectId:string, sceneKey?:string, input?:object}} p
 * @returns {{rows:Array<{asset_id,role,order_no,variant_of}>, warnings:Array<object>, derived:{voice_ids:string[]}}}
 */
export function resolveShotAssets({ projectId, sceneKey = '', input = {} }) {
  if (!projectId) throw shotAssetError('PROJECT_REQUIRED', '镜头资产引用必须指定 projectId');
  const src = input && typeof input === 'object' ? input : {};
  const warnings = [];

  // AS-9：派生列不接受外部写入
  if (Object.prototype.hasOwnProperty.call(src, 'voice_ids')) {
    warnings.push({
      code: 'DERIVED_FIELD_IGNORED',
      field: 'voice_ids',
      message: 'voice_ids 是派生列：由程序按 role=\'voice\' ORDER BY order_no 回填，外部传入已忽略',
    });
  }

  const formAKeys = Object.keys(FORM_A_KEYS).filter((k) => src[k] !== undefined && src[k] !== null);
  const hasB = src.assets !== undefined && src.assets !== null;
  if (formAKeys.length && hasB) {
    throw shotAssetError('ASSET_INPUT_MIXED', '同一镜内不得混用两种资产输入形态（characters/scenes/… 与 assets[] 只能二选一）', {
      form_a_keys: formAKeys, has_assets: true,
    });
  }

  const refs = [];
  if (hasB) {
    if (!Array.isArray(src.assets)) throw shotAssetError('ASSET_INPUT_INVALID', 'assets 必须是数组');
    src.assets.forEach((a, i) => {
      if (!a || typeof a !== 'object') throw shotAssetError('ASSET_INPUT_INVALID', `assets[${i}] 必须是对象`);
      refs.push({ role: a.role, name: a.name, asset_id: a.asset_id, order_no: a.order_no, __index: i });
    });
  } else {
    for (const key of formAKeys) {
      const arr = src[key];
      if (!Array.isArray(arr)) throw shotAssetError('ASSET_INPUT_INVALID', `${key} 必须是名称数组`);
      arr.forEach((name, i) => refs.push({ role: FORM_A_KEYS[key], name, __index: `${key}[${i}]` }));
    }
  }

  // AR：先解析资产（含 AS-1/2/3/4），再排 order_no（AS-5/6），再定 variant_of（AS-7）
  const resolved = refs.map((ref) => resolveOneAsset(projectId, ref));

  const voiceCount = resolved.filter((r) => r.role === 'voice').length;
  if (voiceCount > MAX_VOICE_PER_SHOT) {
    throw shotAssetError('VOICE_OVERFLOW', `每镜最多 ${MAX_VOICE_PER_SHOT} 条 voice，收到 ${voiceCount} 条`, { count: voiceCount, max: MAX_VOICE_PER_SHOT });
  }

  assignOrderNos(resolved, refs);
  resolved.forEach((r) => { r.variant_of = resolveVariantOf(projectId, r); });
  assertSceneAssetMatches(projectId, sceneKey, resolved);

  return {
    rows: resolved.map((r) => ({ asset_id: r.asset_id, role: r.role, order_no: r.order_no, variant_of: r.variant_of })),
    warnings,
    derived: { voice_ids: resolved.filter((r) => r.role === 'voice').sort((a, b) => a.order_no - b.order_no).map((r) => r.asset_id) },
  };
}

function resolveOneAsset(projectId, ref) {
  const role = norm(ref.role);
  // AS-4 先判：值域之外连查库都不该查（music/sfx/video/other 永不进 shot_assets）
  if (!SHOT_ASSET_ROLES.includes(role)) {
    throw shotAssetError('ASSET_ROLE_INVALID', `role 只能是 ${SHOT_ASSET_ROLES.join('/')}，收到「${role}」（music/sfx/video/other 不得写入 shot_assets）`, {
      role, allowed: SHOT_ASSET_ROLES, at: ref.__index,
    });
  }
  const db = getDb();
  let asset = null;
  const assetId = norm(ref.asset_id);
  if (assetId) {
    asset = db.prepare('SELECT * FROM assets WHERE id = ?').get(assetId);
    if (!asset) throw shotAssetError('ASSET_NOT_FOUND', `资产不存在：${assetId}`, { asset_id: assetId, at: ref.__index });
    // AS-2：项目归属
    if (asset.project_id !== projectId) {
      throw shotAssetError('ASSET_NOT_IN_PROJECT', `资产 ${assetId} 不属于本项目（属于 ${asset.project_id}）`, {
        asset_id: assetId, project_id: projectId, asset_project_id: asset.project_id, at: ref.__index,
      });
    }
    // AS-3：类别 == role
    if (asset.category !== role) {
      throw shotAssetError('ASSET_ROLE_MISMATCH', `资产「${asset.name}」的 category 是 ${asset.category}，与 role=${role} 不一致`, {
        asset_id: assetId, category: asset.category, role, at: ref.__index,
      });
    }
  } else {
    // AS-1：按 (project_id, name, category) 精确匹配（去首尾空白后全等，不做模糊/包含）
    const name = norm(ref.name);
    if (!name) throw shotAssetError('ASSET_NOT_FOUND', `缺少资产名或 asset_id（role=${role}）`, { role, at: ref.__index });
    const hits = db
      .prepare('SELECT * FROM assets WHERE project_id = ? AND category = ? AND TRIM(name) = ?')
      .all(projectId, role, name);
    if (!hits.length) {
      throw shotAssetError('ASSET_NOT_FOUND', `本项目没有 ${role} 名为「${name}」的资产（新路径不允许"缺资产照写"）`, {
        role, name, project_id: projectId, at: ref.__index,
      });
    }
    if (hits.length > 1) {
      throw shotAssetError('ASSET_NAME_AMBIGUOUS', `${role} 名为「${name}」的资产有 ${hits.length} 条，请改传 asset_id`, {
        role, name, candidates: hits.map((h) => h.id), at: ref.__index,
      });
    }
    asset = hits[0];
  }
  return { asset_id: asset.id, role, name: asset.name, parent_id: norm(asset.parent_id), order_no: 0, variant_of: '', explicit_order_no: ref.order_no };
}

/** AS-5：同 (shot_id, role) 内按传入顺序 1..n 连续；显式给的 order_no 必须与推算值一致，否则 `ASSET_ORDER_GAP` */
function assignOrderNos(resolved, refs) {
  const counter = new Map();
  resolved.forEach((r, i) => {
    const n = (counter.get(r.role) || 0) + 1;
    counter.set(r.role, n);
    const explicit = refs[i]?.order_no;
    if (explicit !== undefined && explicit !== null && Number(explicit) !== n) {
      throw shotAssetError('ASSET_ORDER_GAP', `${r.role} 的 order_no 必须从 1 起连续：第 ${n} 条收到 ${explicit}`, {
        role: r.role, expected: n, got: explicit, asset_id: r.asset_id,
      });
    }
    r.order_no = n;
  });
}

/** AS-7：仅 costume/age 且资产有 `parent_id` 时写父资产；父必须在本项目，否则 `ASSET_VARIANT_ORPHAN` */
function resolveVariantOf(projectId, r) {
  if (!VARIANT_ROLES.includes(r.role)) return '';
  if (!r.parent_id) return '';
  const parent = getDb().prepare('SELECT id, project_id FROM assets WHERE id = ?').get(r.parent_id);
  if (!parent || parent.project_id !== projectId) {
    throw shotAssetError('ASSET_VARIANT_ORPHAN', `变体资产「${r.name}」的父资产 ${r.parent_id} 不存在或不属于本项目`, {
      asset_id: r.asset_id, parent_id: r.parent_id, project_id: projectId,
    });
  }
  return r.parent_id;
}

/**
 * AS-8：本镜若有 `role='scene'` 的资产，其 `asset_id` 必须等于 `scene_key` 对应 `scene_states.scene_id`。
 * 虚拟场次（`scene_states.scene_id = ''`）两侧都空时跳过；一侧空一侧不空 → 不一致。
 * 没有场次基线行时判 `SCENE_STATE_MISSING`：这时 AS-8 无从比对，放行等于把"无法验证"当成"验证通过"。
 */
function assertSceneAssetMatches(projectId, sceneKey, resolved) {
  const scenes = resolved.filter((r) => r.role === 'scene');
  if (!scenes.length) return;
  const key = norm(sceneKey);
  const st = key
    ? getDb().prepare('SELECT scene_id FROM scene_states WHERE project_id = ? AND scene_key = ?').get(projectId, key)
    : null;
  if (!st) {
    throw shotAssetError('SCENE_STATE_MISSING', `镜引用了场景资产，但场次「${key || '(空)'}」没有基线行，无法校验场景一致性（先建立场次基线）`, {
      project_id: projectId, scene_key: key, scene_assets: scenes.map((s) => s.asset_id),
    });
  }
  const expected = norm(st.scene_id);
  for (const s of scenes) {
    const got = norm(s.asset_id);
    if (!expected && !got) continue;
    if (expected !== got) {
      throw shotAssetError('SCENE_ASSET_MISMATCH', `场次「${key}」的基线场景资产是 ${expected || '(虚拟场次)'}，镜里引用的是 ${got || '(空)'}`, {
        scene_key: key, expected, got,
      });
    }
  }
}

/** AS-9：派生 `voice_ids` = `role='voice' ORDER BY order_no` 的 asset_id 列表 */
export function deriveVoiceIds(shotId) {
  return getDb()
    .prepare("SELECT asset_id FROM shot_assets WHERE shot_id = ? AND role = 'voice' ORDER BY order_no ASC")
    .all(shotId)
    .map((r) => r.asset_id);
}

/**
 * 差集键：**只用 `(role, asset_id)`**（D02-40 §6.4 / D02-34 §3.3）。
 *
 * 为什么不用物理主键 `(shot_id, role, asset_id)` 当键：`shot_id` 在同一个镜内恒定，
 * 把它放进键等于给每一行加一个常量前缀，键退化成 `(role, asset_id)`，却让人以为
 * "物理主键不一样所以算 added+removed" —— 那正是"整组删除重建"的假日志来源。
 * 为什么不用 `order_no`：它是位置，不是身份；换顺序必须记成 update，而不是 delete+create。
 */
const diffKeyOf = (r) => String(r.role) + '\u0000' + String(r.asset_id);

/**
 * 计算 before/after 差集（纯函数，不写库）。
 * @returns {{added:Array, removed:Array, changed:Array<{before:object, after:object}>}}
 */
export function diffShotAssets(beforeRows, afterRows) {
  const before = new Map((beforeRows || []).map((r) => [diffKeyOf(r), r]));
  const after = new Map((afterRows || []).map((r) => [diffKeyOf(r), r]));
  const added = [];
  const removed = [];
  const changed = [];
  for (const [k, r] of after) if (!before.has(k)) added.push(r);
  for (const [k, r] of before) if (!after.has(k)) removed.push(r);
  for (const [k, r] of after) {
    const b = before.get(k);
    if (!b) continue;
    // `order_no` / `variant_of` 变化 = 同一引用的位置或变体改了 ⇒ update（不是换了资产）
    if (Number(b.order_no) !== Number(r.order_no) || String(b.variant_of || '') !== String(r.variant_of || '')) {
      changed.push({ before: b, after: r });
    }
  }
  return { added, removed, changed };
}

/**
 * 写入某镜的资产引用（**整组替换**，不是增量追加），并回填 `story_shots.voice_ids`。
 *
 * 事务与审计（B-03）：整组在 `txProject(projectId)` 内；进事务先 `assertProjectLocked`。
 * 物理写入仍是 DELETE 全组 + INSERT 全组（不改）；但审计**必须先在同一事务内算差集再逐条记**：
 * 按物理 SQL 记日志会把"只改了 order_no"写成整组 delete+create，看起来像换了全套参考图。
 */
export function writeShotAssets({ projectId, shotId, sceneKey, input }) {
  return txProject(projectId, () => {
    assertProjectLocked(projectId);
    const db = getDb();
    const shot = db.prepare('SELECT * FROM story_shots WHERE id = ?').get(shotId);
    if (!shot) throw shotAssetError('SHOT_NOT_FOUND', `镜不存在：${shotId}`, { shot_id: shotId });
    if (shot.project_id !== projectId) {
      throw shotAssetError('SHOT_NOT_IN_PROJECT', `镜 ${shotId} 不属于项目 ${projectId}`, { shot_id: shotId, project_id: projectId, shot_project_id: shot.project_id });
    }
    const key = sceneKey === undefined ? shot.scene_key : sceneKey;
    const { rows, warnings } = resolveShotAssets({ projectId, sceneKey: key, input });

    // ① 差集必须在物理写入**之前**算：DELETE 之后就再也读不到 before 了
    const beforeRows = db.prepare('SELECT * FROM shot_assets WHERE shot_id = ? ORDER BY role ASC, order_no ASC').all(shotId);
    const afterRows = rows.map((r) => ({
      shot_id: shotId, asset_id: r.asset_id, role: r.role, order_no: r.order_no, variant_of: r.variant_of,
    }));
    const diff = diffShotAssets(beforeRows, afterRows);

    // ② 物理写入：整组替换（不变）
    db.prepare('DELETE FROM shot_assets WHERE shot_id = ?').run(shotId);
    const ins = db.prepare('INSERT INTO shot_assets (shot_id, asset_id, role, order_no, variant_of) VALUES (?,?,?,?,?)');
    for (const r of rows) ins.run(shotId, r.asset_id, r.role, r.order_no, r.variant_of);

    // ③ 审计：removed → delete、added → create、changed → update（before/after 全行）
    //    条数上界 = added + removed + changed ≤ 真实变化行数，绝不会因为"整组重写"而放大。
    for (const r of diff.removed) {
      recordChange({ entity: 'shot_asset', action: 'delete', before: r, entityId: composite(r), meta: { origin: 'writeShotAssets' } });
    }
    for (const r of diff.added) {
      recordChange({ entity: 'shot_asset', action: 'create', after: rawGet('shot_asset', [r.shot_id, r.role, r.asset_id]) || r, entityId: composite(r), meta: { origin: 'writeShotAssets' } });
    }
    for (const c of diff.changed) {
      recordChange({ entity: 'shot_asset', action: 'update', before: c.before, after: rawGet('shot_asset', [c.after.shot_id, c.after.role, c.after.asset_id]) || c.after, entityId: composite(c.after), meta: { origin: 'writeShotAssets' } });
    }

    // ④ 派生列回填：voice_ids 属 VOLATILE.story_shot ⇒ 只改它不会产生内容日志（AS-9/A2 两不误）
    const voiceIds = deriveVoiceIds(shotId);
    db.prepare('UPDATE story_shots SET voice_ids = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(voiceIds), now(), shotId);
    recordChange({
      entity: 'story_shot', action: 'update', before: shot, after: rawGet('story_shot', shotId),
      entityId: shotId, meta: { origin: 'writeShotAssets.voice_ids' },
    });

    return { shot_id: shotId, assets: rows, voice_ids: voiceIds, warnings, audit: auditCounts(diff) };
  });
}

/** 复合主键的 `entity_id`（与 `changelog.compositeIdOf` 同一编码：JSON 数组串） */
function composite(r) {
  return JSON.stringify([String(r.shot_id ?? ''), String(r.role ?? ''), String(r.asset_id ?? '')]);
}

function auditCounts(diff) {
  return { added: diff.added.length, removed: diff.removed.length, changed: diff.changed.length };
}

/**
 * 低层组合入口：插一镜 + 写它的资产引用，**同一事务**（AS-10）。
 * 任何资产校验/写入失败都不得留下半个镜（否则会写出"有镜、没资产"的孤儿）。
 * 注意：这里不做排序判定；号由调用方按 §4.4.1.2 决定（P8 的 `set_storyboard` 负责）。
 */
export function writeStoryShotWithAssets({ projectId, chapterId, shot = {}, assets, sceneKey }) {
  return txProject(projectId, () => {
    assertProjectLocked(projectId);
    const row = insertStoryShot({ ...shot, project_id: projectId, chapter_id: chapterId });
    const written = writeShotAssets({ projectId, shotId: row.id, sceneKey: sceneKey === undefined ? row.scene_key : sceneKey, input: assets });
    return { shot: row, ...written };
  });
}
