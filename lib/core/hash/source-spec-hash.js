// sourceSpecHash（D01-06 §4.2）：只覆盖"导演语义"
//
// 三条底线：
//  1. **不 hash 整行**。数据库行里有 id / created_at / qc_status，它们变了下游不该变。
//     一律走白名单（bodyOf / 字段映射），新增临时字段不会意外漏进来。
//  2. **同源证明**：同一份分镜切成 Seedance 与 H3 两套单元，sourceSpecHash 必须逐字相同。
//     所以 track / profile_ver / unit_duration / seam / t_from / t_to 一律不进 payload。
//  3. **可靠性与值必须都在**。只放值 → "把 unknown 悄悄改成 known"不改变 hash，同源证明形同虚设；
//     只放 rel → 改坐标不改 hash。两者都要（D01-04 §5.2.2 末）。
import { createHash } from 'node:crypto';
import { cmpStr } from './cmp-str.js';
import { canonicalStringify, canonical, canonState, canonMeta, arr, num, numOrNull } from './canonical-stringify.js';

function sha256(s) {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

/** 从 TEXT 列解析数组（DB 里是 '[]' 这类字符串）；解析失败当空数组 */
export function jsonArr(v) {
  if (Array.isArray(v)) return v;
  if (typeof v !== 'string' || !v.trim()) return [];
  try {
    const x = JSON.parse(v);
    return Array.isArray(x) ? x : [];
  } catch { return []; }
}

/** 从 TEXT 列解析对象；解析失败当空对象 */
export function jsonObj(v) {
  if (v && typeof v === 'object' && !Array.isArray(v)) return v;
  if (typeof v !== 'string' || !v.trim()) return {};
  try {
    const x = JSON.parse(v);
    return x && typeof x === 'object' && !Array.isArray(x) ? x : {};
  } catch { return {}; }
}

/**
 * 可靠性判定（D01-04 §5.2.2）：五级优先级，顺序不可调换。
 *   ① not_applicable（显式，**先于缺失检查**）
 *   ② unknown（显式）
 *   ③ 三分量任一缺失 / 非有限数 → unknown（显式 known 也不能翻案）
 *   ④ known / inferred（显式，值完整才采信）
 *   ⑤ 无 meta → 按来源：manual→known / legacy→unknown / 其他→inferred
 */
export function posRel({ x, y, z, metaEntry, specSource } = {}) {
  const explicit = metaEntry?.rel;
  if (explicit === 'not_applicable') return 'not_applicable';
  if (explicit === 'unknown') return 'unknown';
  if (x == null || y == null || z == null) return 'unknown';
  if (![x, y, z].every(Number.isFinite)) return 'unknown';
  if (explicit === 'known' || explicit === 'inferred') return explicit;
  if (specSource === 'manual') return 'known';
  if (specSource === 'legacy') return 'unknown';
  return 'inferred';
}

/** 同 posRel，额外回报矛盾告警（矩阵第 12 条 NA 却有值 / 第 8 条 known 但坐标不全） */
export function posRelDetail({ x, y, z, metaEntry, specSource } = {}) {
  const rel = posRel({ x, y, z, metaEntry, specSource });
  const warnings = [];
  const full = x != null && y != null && z != null && [x, y, z].every(Number.isFinite);
  if (metaEntry?.rel === 'not_applicable' && full) warnings.push('COORD_NA_WITH_VALUE');
  if (metaEntry?.rel === 'known' && !full) warnings.push('META_VALUE_MISMATCH');
  return { rel, warnings };
}

/** trigger：只剥 ref，其余（kind / text / 未来新增字段）原样保留 */
export function stripRefTrigger(json) {
  const { ref, ...rest } = json || {};
  return rest;
}

/** sync：只剥 parallel_with，其余原样保留 */
export function stripRefSync(json) {
  const { parallel_with, ...rest } = json || {};
  return rest;
}

/**
 * 动作的纯语义体（白名单 20 个业务字段）。
 * 白名单而非黑名单：漏一个语义字段会在 R-01（改任一字段 hash 必变）当场暴露；
 * 黑名单漏一个临时字段则是静默污染，没有任何报错。
 */
export function bodyOf(a) {
  return {
    actor: a.actor_id,
    type: a.action_type,
    primary: !!a.is_primary,
    tier: a.tier,
    init: jsonObj(a.init_state),
    trigger: stripRefTrigger(jsonObj(a.trigger_json)),
    path: jsonObj(a.path_json),
    force: jsonObj(a.force_json),
    speed: jsonObj(a.speed_json),
    power: num(a.power),
    cog: a.cog,
    parts: jsonArr(a.body_parts),
    contact: jsonObj(a.contact_json),
    result: jsonObj(a.result_json),
    follow: a.follow_through,
    recovery: a.recovery,
    end: jsonObj(a.end_state),
    sync: stripRefSync(jsonObj(a.sync_json)),
    tFrom: num(a.t_from),
    tTo: num(a.t_to),
  };
}

/** 动作语义体的指纹（不含任何 id） */
export function contentHashOfBody(body) {
  return sha256(canonicalStringify(body));
}

/**
 * 动作的规范序（五项全序：tFrom → actor → tTo → type → contentHash）。
 * 与输入数组顺序无关——这是 R-26 的要求，也是"数据库返回顺序变了 hash 不能变"的唯一保证。
 */
export function canonicalActions(shot) {
  const raw = (shot.actions || []).map((a) => ({
    id: a.id,                                        // 仅用于建映射，绝不进 hash
    ref: jsonObj(a.trigger_json).ref || '',
    par: jsonArr(jsonObj(a.sync_json).parallel_with),
    body: bodyOf(a),
    ch: null,
  }));
  for (const r of raw) r.ch = contentHashOfBody(r.body);

  raw.sort((p, q) =>
    (p.body.tFrom - q.body.tFrom) ||
    cmpStr(p.body.actor, q.body.actor) ||
    (p.body.tTo - q.body.tTo) ||
    cmpStr(p.body.type, q.body.type) ||
    cmpStr(p.ch, q.ch));

  const refMap = new Map(raw.map((r) => [r.id, r.ch]));
  return raw.map((r) => ({
    ...r.body,
    triggerRef: r.ref ? (refMap.get(r.ref) ?? `ext:${r.ref}`) : null,
    parallelWith: r.par.map((t) => refMap.get(t) ?? `ext:${t}`).sort(cmpStr),
  }));
}

/** 摄影机向量：cam_pos 可能是 JSON 字符串 / 数组 / null */
function vecOf(v) {
  if (v == null || v === '') return null;
  const a = typeof v === 'string' ? jsonArr(v) : v;
  if (!Array.isArray(a) || a.length === 0) return null;
  return a.map((n) => (Number.isFinite(Number(n)) ? Number(n) : null));
}

const SCENE_FIELDS = [
  'scene_id', 'scene_key', 'coord_system', 'fixtures', 'entries',
  'axis_lock', 'power_geometry', 'crowd_switch', 'time_of_day', 'lighting_base',
];

/**
 * 构造 payload。与 hash 计算分离，便于测试直接断言"某个字段在不在 payload 里"
 * （只测 hash 变不变，无法区分"字段进 payload 了"与"字段碰巧影响了别的字段"）。
 */
export function buildSourcePayload({ scenes = [], shots = [], assets = {} } = {}) {
  return {
    hashKind: 'd01.source',
    specVersion: 3,

    scenes: scenes
      .map((sc) => canonical(sc, SCENE_FIELDS))
      .sort((a, b) => cmpStr(a.scene_key, b.scene_key)),

    shots: shots
      .slice()
      .sort((a, b) => num(a.global_no) - num(b.global_no))
      .map((s) => ({
        no: num(s.global_no),
        shotNo: num(s.shot_no),
        sceneKey: s.scene_key,
        prevShotNo: s.prev_shot_no ?? null,

        purpose: s.purpose,
        dramaticValue: num(s.dramatic_value),
        infoDelta: s.info_delta,
        dialogueFunction: s.dialogue_function,
        isInsert: !!s.is_insert,

        visual: s.visual_content,
        composition: s.composition,
        lighting: s.lighting,

        size: s.shot_size,
        dir: s.cam_direction,
        height: s.cam_height,
        roll: num(s.cam_roll_deg),
        camPos: vecOf(s.cam_pos),
        camTarget: s.cam_target,
        camDist: numOrNull(s.cam_distance_m),
        lens: num(s.lens_mm),
        fov: numOrNull(s.fov_deg),
        movement: s.movement,
        amp: s.movement_amp,
        camPath: jsonArr(s.cam_path),
        compRule: s.composition_rule,
        camNote: s.cam_note,

        // 音色不进这里：唯一权威是 shot_assets(role='voice')，见下方 assets
        dialogue: s.dialogue,
        speakers: jsonArr(s.speakers),
        narration: s.narration,
        sfx: s.sfx,
        musicCue: s.music_cue,

        duration: num(s.story_duration),
        slices: jsonArr(s.time_slices),
        ramp: s.speed_ramp,
        cut: !!s.is_cut_point,
        timeJump: !!s.time_jump,

        blockings: (s.blockings || [])
          .map((b) => ({
            char: b.character_id,
            pos: b.position_abs,
            xy: [numOrNull(b.norm_x), numOrNull(b.norm_y), numOrNull(b.norm_z)],
            posTrack: jsonArr(b.position_track),
            anchor: b.anchor_object,
            behind: b.behind_object,
            facing: b.facing,
            gaze: b.gaze_target,
            posture: b.posture,
            dist: numOrNull(b.distance_to_camera),
            occ: b.occlusion,
            hand: b.hand_state,
            task: b.current_task,
            inFrame: !!b.in_frame,
            power: b.power_level,
            anchorObj: b.instance_anchor,
            // 必须由 posRel 求，不能直接读 b.rel：
            // 直接读会把 not_applicable 吞成 unknown，也会漏掉三分量整体性判定
            rel: posRel({
              x: numOrNull(b.norm_x), y: numOrNull(b.norm_y), z: numOrNull(b.norm_z),
              metaEntry: b.meta, specSource: s.spec_source,
            }),
          }))
          .sort((a, b) => cmpStr(a.char, b.char)),

        actions: canonicalActions(s),

        stateIn: canonState(s.state_in),
        stateInMeta: canonMeta(s.state_in_meta),
        stateOut: canonState(s.state_out),
        stateOutMeta: canonMeta(s.state_out_meta),

        assets: (s.assets || [])
          .map((x) => ({
            id: x.asset_id,
            role: x.role,
            order: num(x.order_no),
            variant: x.variant_of,
            fp: assets[x.asset_id]?.fingerprint || '',
            fpLevel: assets[x.asset_id]?.fpLevel || 'meta',
          }))
          .sort((a, b) => cmpStr(a.role, b.role) || cmpStr(a.id, b.id)),
      })),
  };
}

/**
 * @param {object} p
 * @param {Array} p.scenes  scene_states 行
 * @param {Array} p.shots   story_shots 行（每行可带 actions / blockings / assets）
 * @param {object} p.assets { assetId: {fingerprint, fpLevel} }
 * @returns {string} 'sha256:<hex>'
 */
export function sourceSpecHash(args) {
  return 'sha256:' + sha256(canonicalStringify(buildSourcePayload(args)));
}
