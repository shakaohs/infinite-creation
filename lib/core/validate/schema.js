// Schema 基础校验（P4）—— D02-06 §6.1 / V-01、V-13、V-19、V-20、V-22
//
// 范围只有五件事：S 级必填、字段类型与范围、空镜台词、Meta 键路径、时间切片、静默修改。
// **不含** P5 的 action/blocking/camera/asset/continuity 规则，也不写 QC 报告（`qc_reports` 归 P9）。
//
// 四条不许越界：
//   ① **S 级只能由数据算**（D01-04 §7）。调用方传 `level` 一律忽略并留痕，防止"全标 S0 逃避校验"。
//   ② **缺数据不等于缺内容**：S3 的 `state_in/out` 由求解器产生，Schema 不得补默认值、不得伪造状态。
//   ③ **不得对 `unknown` 判 FAIL**（S-20）：缺 Meta 的类 B 字段按"未知"处理，不按"错"处理。
//   ④ **纯函数**：不读库、不读时钟、不看 `process.env`、不改入参；结果按 `(field, code)` 排序。
import { cmpStr } from '../hash/cmp-str.js';

const FAIL = 'fail';
const WARN = 'warn';
const INFO = 'info';

/** S 级由低到高（顺序即优先级，用于"逐级提升"取最大值） */
export const LEVELS = Object.freeze(['S0', 'S1', 'S2', 'S3', 'S4']);
const LEVEL_RANK = Object.freeze({ S0: 0, S1: 1, S2: 2, S3: 3, S4: 4 });

/**
 * 各级额外必填（D01-04 §7；S0 的四项另算）。
 * S1 还要求场次 `axis_lock`，S3 还要求 `state_in/state_out`，S4 还要求场次 `crowd_switch` 与逐动作 `contact` ——
 * 这几项不在 blocking 行上，单独处理。
 */
export const S_REQUIRED = Object.freeze({
  S0: Object.freeze(['character_id', 'position_abs', 'facing', 'posture', 'in_frame']),
  S1: Object.freeze(['anchor_object', 'behind_object', 'gaze_target', 'hand_state', 'current_task']),
  S2: Object.freeze(['norm_x', 'norm_y', 'norm_z', 'distance_to_camera', 'occlusion', 'power_level']),
  S3: Object.freeze(['position_track']),
  // `crowd_switch` 是**场次**字段（`scene_states` 第 11 列），不在 blocking 行上 —— 单独判
  S4: Object.freeze(['instance_anchor']),
});

/** `state`（`state_in` / `state_out`）四顶层键与各自允许的字段（D01-04 §5.2） */
export const STATE_FIELDS = Object.freeze({
  chars: Object.freeze(['pos', 'posture', 'facing', 'hand', 'gaze']),
  props: Object.freeze(['state', 'owner', 'hand', 'surface', 'condition']),
  env: Object.freeze(['light', 'time', 'door']),
});

/** 允许的保留 Meta 键（只有这一个；其他 `__` 前缀一律不放行） */
export const META_RESERVED = Object.freeze(['__solver']);

// ── 基础工具 ────────────────────────────────────────────────────────────

function hit(level, code, field, expected, detail = {}) {
  // 约定字段**最后写**：detail 里放 `level`/`code`/`field` 会覆盖级别（例如把 S 级的名字当成 level）
  return { ...detail, level, code, field, expected };
}

/** 值的"存在性"：`0` / `false` 是存在的值，`''`/`[]`/`{}`/`null` 不是 */
function isPresent(v) {
  if (v === undefined || v === null || v === '') return false;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === 'object') return Object.keys(v).length > 0;
  return true;
}

const isFiniteNum = (v) => typeof v === 'number' && Number.isFinite(v);
const isBlank = (v) => v === undefined || v === null || v === '';

/** 数组字段可能来自 DB 的 TEXT 列（`'[]'`），这里统一成数组；解析失败当空数组 */
function toArray(v) {
  if (Array.isArray(v)) return v;
  if (typeof v !== 'string' || !v.trim()) return [];
  try {
    const x = JSON.parse(v);
    return Array.isArray(x) ? x : [];
  } catch { return []; }
}

/** 排序：保证同一输入得到逐字相同的结果顺序 */
function sortHits(hits) {
  return hits.slice().sort((a, b) => cmpStr(a.field, b.field) || cmpStr(a.code, b.code) || cmpStr(a.level, b.level));
}

function maxLevel(a, b) {
  return LEVEL_RANK[a] >= LEVEL_RANK[b] ? a : b;
}

// ── V-01：S 级由程序推导 ────────────────────────────────────────────────

/**
 * 由本镜数据推导 S 级（D01-04 §7 / D02-06 §4.7.1）。
 *
 * ```
 * level = S0
 * chars_in_frame >= 2                              → ≥S1
 * chars_in_frame >= 3 || 有 prop 被 ≥2 人接触        → ≥S2
 * 有 locomotion || position_track.length > 1        → ≥S3
 * 有 combat || chars_total >= 5 || crowd_switch=A   → ≥S4
 * ```
 * 四条是**逐级提升**（取最大），不是互斥的 `else if` —— 用 `else if` 会让"3 人 + combat"停在 S2。
 *
 * @param {{blockings?:Array, actions?:Array, sceneState?:object, level?:string}} [ctx]
 *   `blockings`：本镜 `shot_blockings` 行（`in_frame` / `position_track` 从这里读）
 *   `actions`：本镜 `shot_actions` 行（`action_type` / `contact` 从这里读）
 *   `sceneState`：本镜所在场次的 `scene_states` 行（只取 `crowd_switch`）
 *   `level`：调用方/LLM 声明值，**只用于留痕，永不参与计算**
 * @returns {{level:string, basis:object, declared_ignored:boolean}}
 *   `basis` 逐项列出判级依据，便于排障与测试断言
 */
export function computeLevel({ blockings, actions, sceneState, level } = {}) {
  const bl = toArray(blockings);
  const ac = toArray(actions);
  const scene = sceneState && typeof sceneState === 'object' ? sceneState : {};

  const charsInFrame = bl.filter((b) => Number(b?.in_frame) === 1).length;
  const charsTotal = bl.length; // 画画外人物都算（`character_id` 含画外，D01-04 §四）

  // prop 被多人接触：按 contact.target_id 收 distinct actor（`env` 不是人）
  const propActors = new Map();
  for (const a of ac) {
    const c = a?.contact;
    if (!c || typeof c !== 'object') continue;
    if (String(c.target_type ?? '') !== 'prop') continue;
    const tid = String(c.target_id ?? '').trim();
    const actor = String(a.actor_id ?? '').trim();
    if (!tid || !actor || actor === 'env') continue;
    if (!propActors.has(tid)) propActors.set(tid, new Set());
    propActors.get(tid).add(actor);
  }
  const propsMultiTouch = [...propActors.entries()]
    .filter(([, set]) => set.size >= 2)
    .map(([id]) => id)
    .sort(cmpStr);

  const hasLocomotion = ac.some((a) => String(a?.action_type ?? '') === 'locomotion');
  const hasCombat = ac.some((a) => String(a?.action_type ?? '') === 'combat');
  const maxTrackLen = bl.reduce((m, b) => {
    const t = b?.position_track;
    return Math.max(m, Array.isArray(t) ? t.length : 0);
  }, 0);
  const crowdSwitch = String(scene?.crowd_switch ?? '').trim();

  let lv = 'S0';
  if (charsInFrame >= 2) lv = maxLevel(lv, 'S1');
  if (charsInFrame >= 3 || propsMultiTouch.length > 0) lv = maxLevel(lv, 'S2');
  if (hasLocomotion || maxTrackLen > 1) lv = maxLevel(lv, 'S3');
  if (hasCombat || charsTotal >= 5 || crowdSwitch === 'A') lv = maxLevel(lv, 'S4');

  const declared = String(level ?? '').trim();
  return {
    level: lv,
    declared_ignored: !!declared && declared !== lv,
    basis: {
      chars_in_frame: charsInFrame,
      chars_total: charsTotal,
      props_multi_touch: propsMultiTouch,
      has_locomotion: hasLocomotion,
      has_combat: hasCombat,
      max_track_len: maxTrackLen,
      crowd_switch: crowdSwitch,
    },
  };
}

// ── V-01：各级必填 ──────────────────────────────────────────────────────

/**
 * 按 S 级检查必填（D01-04 §7 / D02-06 §4.7.1）。
 *
 * @param {{level:string, blockings?:Array, sceneState?:object, shotState?:object, actions?:Array}} p
 *   `shotState`：`{ state_in, state_out }`（求解器产物，S3 必填；缺失只报缺，不补默认值）
 * @returns {Array<object>} `BLOCKING_FIELD_MISSING`（S0 四项）/ `SCHEMA_INVALID`（S1+）
 */
export function checkRequired({ level, blockings, sceneState, shotState, actions } = {}) {
  const lv = LEVELS.includes(level) ? level : 'S0';
  const rank = LEVEL_RANK[lv];
  const bl = toArray(blockings);
  const ac = toArray(actions);
  const scene = sceneState && typeof sceneState === 'object' ? sceneState : {};
  const st = shotState && typeof shotState === 'object' ? shotState : {};
  const hits = [];

  for (let i = 0; i < bl.length; i += 1) {
    const b = bl[i] || {};
    for (const s of LEVELS) {
      if (LEVEL_RANK[s] > rank) break;
      for (const f of S_REQUIRED[s]) {
        if (isPresent(b[f])) continue;
        hits.push(hit(
          FAIL,
          s === 'S0' ? 'BLOCKING_FIELD_MISSING' : 'SCHEMA_INVALID',
          `shot_blockings[${i}].${f}`,
          `${s} 必填（当前 ${lv}）`,
          { shot_index: i, required_by: s },
        ));
      }
    }
  }

  if (rank >= LEVEL_RANK.S1 && !isPresent(scene.axis_lock)) {
    hits.push(hit(FAIL, 'SCHEMA_INVALID', 'scene_states.axis_lock', 'S1 必填：场次轴线锁'));
  }
  if (rank >= LEVEL_RANK.S3) {
    for (const f of ['state_in', 'state_out']) {
      if (isPresent(st[f])) continue;
      // 状态由求解器产生：这里只报缺，绝不生成默认状态（D02-06 §4.7.1 表注）
      hits.push(hit(FAIL, 'SCHEMA_INVALID', `shot_states.${f}`, 'S3 必填：由求解器产生的状态（Schema 不代造）'));
    }
  }
  if (rank >= LEVEL_RANK.S4) {
    if (!isPresent(scene.crowd_switch)) {
      hits.push(hit(FAIL, 'SCHEMA_INVALID', 'scene_states.crowd_switch', 'S4 必填：群像开关 A/B/C（场次级）'));
    }
    for (let i = 0; i < ac.length; i += 1) {
      if (isPresent(ac[i]?.contact)) continue;
      hits.push(hit(FAIL, 'SCHEMA_INVALID', `shot_actions[${i}].contact`, 'S4 必填：逐动作接触点'));
    }
  }
  return hits;
}

// ── 类型与范围（只做 D01 明写的范围）───────────────────────────────────

const BOOLISH = (v) => v === 0 || v === 1 || v === true || v === false;

/**
 * 字段类型与范围检查。
 * **只做 D01 明写的范围**：没写范围的字段只查类型，不发明上下界（多一条范围就多一种误判）。
 *
 * @param {object} shot `story_shots` 行（或同形状对象）
 * @returns {Array<object>} `SCHEMA_INVALID`
 */
export function checkShotFields(shot = {}) {
  const s = shot && typeof shot === 'object' ? shot : {};
  const hits = [];
  const bad = (field, expected, got) => hits.push(hit(FAIL, 'SCHEMA_INVALID', field, expected, { got }));

  for (const f of ['shot_no', 'global_no']) {
    if (isBlank(s[f])) continue; // 存在性由 P3/P8 的写入侧负责
    if (!Number.isInteger(s[f]) || s[f] < 1) bad(f, '≥1 的整数', s[f]);
  }
  if (!isBlank(s.dramatic_value) && (!Number.isInteger(s.dramatic_value) || s.dramatic_value < -10 || s.dramatic_value > 10)) {
    bad('dramatic_value', '-10 ~ +10 的整数（D01-02 §二）', s.dramatic_value);
  }
  if (!isBlank(s.info_delta) && typeof s.info_delta === 'string' && [...s.info_delta].length > 80) {
    bad('info_delta', '≤80 字（D01-02 §二）', [...s.info_delta].length);
  }
  if (!isBlank(s.cam_roll_deg) && (!isFiniteNum(s.cam_roll_deg) || Math.abs(s.cam_roll_deg) > 20)) {
    bad('cam_roll_deg', '-20 ~ +20（D01-02 §四 D4）', s.cam_roll_deg);
  }
  if (!isBlank(s.cam_distance_m) && (!isFiniteNum(s.cam_distance_m) || s.cam_distance_m < 0.3 || s.cam_distance_m > 30)) {
    bad('cam_distance_m', '0.3 ~ 30 米（D01-02 §四 D7）', s.cam_distance_m);
  }
  if (!isBlank(s.lens_mm)) {
    // `0` = 未设置（D01-02 §四 D8 的默认值），不是非法值
    const v = s.lens_mm;
    if (!Number.isInteger(v) || (v !== 0 && (v < 8 || v > 300))) bad('lens_mm', '0（未设置）或 8 ~ 300（D01-02 §四 D8）', v);
  }
  if (!isBlank(s.fov_deg) && (!isFiniteNum(s.fov_deg) || s.fov_deg < 5 || s.fov_deg > 120)) {
    bad('fov_deg', '5 ~ 120（D01-02 §四 D9）', s.fov_deg);
  }
  if (isBlank(s.story_duration)) {
    // 必填但缺失的判定归 S 级/写入侧；这里只在"给了值"时查合法性
  } else if (!isFiniteNum(s.story_duration) || s.story_duration <= 0) {
    bad('story_duration', '> 0 的秒数（D01-02 §十）', s.story_duration);
  }
  for (const f of ['is_insert', 'is_cut_point', 'time_jump']) {
    if (!isBlank(s[f]) && !BOOLISH(s[f])) bad(f, '0/1（D01-02 §二 §十）', s[f]);
  }
  return hits;
}

/**
 * 站位行（`shot_blockings`）类型与范围检查。
 * @param {object} b 单行
 * @param {number} [index] 用于 field 前缀
 * @returns {Array<object>} `SCHEMA_INVALID` / `COORD_PARTIAL`（S-24 的写入侧口径）
 */
export function checkBlockingFields(b = {}, index = 0) {
  const x = b && typeof b === 'object' ? b : {};
  const p = (f) => `shot_blockings[${index}].${f}`;
  const hits = [];
  const bad = (field, expected, got) => hits.push(hit(FAIL, 'SCHEMA_INVALID', field, expected, { got }));

  if (!isBlank(x.norm_confidence) && (!isFiniteNum(x.norm_confidence) || x.norm_confidence < 0 || x.norm_confidence > 1)) {
    bad(p('norm_confidence'), '0 ~ 1（D01-04 §四）', x.norm_confidence);
  }
  if (!isBlank(x.in_frame) && !BOOLISH(x.in_frame)) bad(p('in_frame'), '0/1（D01-04 §四）', x.in_frame);
  for (const f of ['norm_x', 'norm_y', 'norm_z', 'distance_to_camera']) {
    if (isBlank(x[f])) continue;
    if (!isFiniteNum(x[f])) bad(p(f), '有限数或 NULL（D01-04 §四）', x[f]);
  }
  // S-24：三者同有或同空（部分为空 = 写入侧错误，不是创作错误）
  const coords = ['norm_x', 'norm_y', 'norm_z'].map((f) => isPresent(x[f]));
  if (coords.some(Boolean) && !coords.every(Boolean)) {
    hits.push(hit(FAIL, 'COORD_PARTIAL', p('norm_x'), 'norm_x/norm_y/norm_z 同有或同空（D01-04 §5.2.2 S-24）', {
      got: { norm_x: x.norm_x, norm_y: x.norm_y, norm_z: x.norm_z },
    }));
  }
  if (!isBlank(x.position_track) && !Array.isArray(x.position_track)) {
    bad(p('position_track'), '数组（D01-04 §4.1）', typeof x.position_track);
  }
  return hits;
}

// ── V-13：空镜台词规则 ─────────────────────────────────────────────────

/**
 * V-13 空镜台词规则（D01-02 §2.1）。
 *
 * 只在 `is_insert=1` 时有约束：空镜里**不可能有在场人开口**。
 *  · `on_screen` 且该角色 `in_frame=1` → FAIL
 *  · `off_screen` 但该角色 `in_frame=1` → FAIL（声明"画外"却写在画内）
 *  · `dialogue` 与 `speakers` 都空 → 合法（纯空镜）
 *  · 带台词但 `speakers` 缺省 → 不判（说话人归属是 V-04 的职责，不在这里猜）
 *
 * `shot_assets` 只用来判断"这个角色本镜是否登记过"：**没登记也不判 FAIL**——
 * 缺失是未知，未知不得判错（S-20）。真正的"资产引用缺失"是 V-03（P5）。
 *
 * @param {{is_insert?:number|boolean, dialogue?:string, speakers?:Array,
 *          blockings?:Array, shot_assets?:Array}} [p]
 * @returns {Array<object>} `EMPTY_SHOT_ONSCREEN_SPEAKER` / `EMPTY_SHOT_INFRAME_SPEAKER`
 */
export function checkEmptyShot({ is_insert, dialogue, speakers, blockings, shot_assets } = {}) {
  const insert = Number(is_insert) === 1 || is_insert === true;
  if (!insert) return [];
  const sp = toArray(speakers);
  if (!sp.length) return []; // 纯空镜：允许带台词（画外音/旁白/回忆），D01 原文如此

  const bl = toArray(blockings);
  const assets = toArray(shot_assets);
  const inFrame = new Map();
  for (const b of bl) {
    if (!b) continue;
    inFrame.set(String(b.character_id ?? ''), Number(b.in_frame));
  }
  const registered = new Set(assets.filter((a) => String(a?.role ?? '') === 'character').map((a) => String(a.asset_id ?? '')));

  const hits = [];
  sp.forEach((x, i) => {
    const type = String(x?.type ?? '').trim();
    const id = String(x?.id ?? '').trim();
    if (!id) return; // phone 的声源在 `source`，不在 `id`
    const frame = inFrame.has(id) ? inFrame.get(id) : undefined;
    if (type === 'on_screen' && frame === 1) {
      hits.push(hit(FAIL, 'EMPTY_SHOT_ONSCREEN_SPEAKER', `speakers[${i}].id`, '空镜（is_insert=1）里不得有画内人物开口', {
        speaker_id: id, registered_asset: registered.has(id),
      }));
    }
    if (type === 'off_screen' && frame === 1) {
      hits.push(hit(FAIL, 'EMPTY_SHOT_INFRAME_SPEAKER', `speakers[${i}].id`, '声明 off_screen 的角色 in_frame 必须为 0', {
        speaker_id: id, registered_asset: registered.has(id),
      }));
    }
    // 既无 blocking 也无 character 资产 → `in_frame` 未知 → 不判（未知不判错，S-20）
  });
  return hits;
}

// ── V-19：Meta 键路径 ──────────────────────────────────────────────────

function splitPath(key) {
  return String(key).split('.');
}

/**
 * 解析一条 Meta 键，返回 `{ ok, top, id, field }` 或 `{ ok:false, code, detail }`。
 * 只在内部使用（`checkMetaKeys` 与 `checkSilentChange` 共用同一套解析，避免两处口径漂移）。
 */
function parseMetaKey(key, state) {
  const seg = splitPath(key);
  const top = seg[0];
  const st = state && typeof state === 'object' ? state : {};

  if (top === 'chars' || top === 'props') {
    if (seg.length !== 3 || !seg[1] || !seg[2]) return { ok: false, code: 'META_KEY_UNRESOLVED' };
    const bucket = st[top];
    if (!bucket || typeof bucket !== 'object' || !Object.prototype.hasOwnProperty.call(bucket, seg[1])) {
      return { ok: false, code: 'META_ENTITY_NOT_FOUND', top, id: seg[1] };
    }
    if (!STATE_FIELDS[top].includes(seg[2])) return { ok: false, code: 'META_FIELD_UNKNOWN', top, id: seg[1], field: seg[2] };
    return { ok: true, top, id: seg[1], field: seg[2], value: bucket[seg[1]]?.[seg[2]] };
  }
  if (top === 'costumes') {
    // `costumes.<char_id>` = 该角色当前服装（值本身就是资产 id，没有第三段）
    if (seg.length !== 2 || !seg[1]) return { ok: false, code: 'META_KEY_UNRESOLVED' };
    const inChars = st.chars && typeof st.chars === 'object' && Object.prototype.hasOwnProperty.call(st.chars, seg[1]);
    const inCostumes = st.costumes && typeof st.costumes === 'object' && Object.prototype.hasOwnProperty.call(st.costumes, seg[1]);
    if (!inChars && !inCostumes) return { ok: false, code: 'META_ENTITY_NOT_FOUND', top, id: seg[1] };
    return { ok: true, top, id: seg[1], field: '', value: st.costumes?.[seg[1]] };
  }
  if (top === 'env') {
    if (seg.length !== 2 || !seg[1]) return { ok: false, code: 'META_KEY_UNRESOLVED' };
    if (!STATE_FIELDS.env.includes(seg[1])) return { ok: false, code: 'META_FIELD_UNKNOWN', top, id: '', field: seg[1] };
    return { ok: true, top, id: '', field: seg[1], value: st.env?.[seg[1]] };
  }
  return { ok: false, code: 'META_KEY_UNRESOLVED', top };
}

/**
 * V-19：`state_in_meta` / `state_out_meta` 的键必须是**可解析且真实存在**的字段路径。
 *
 * 键格式（D01-04 §5.2）：`chars.<id>.<field>` / `props.<id>.<field>` / `costumes.<id>` / `env.<field>`。
 * 只查字符串形状是不够的 —— `chars.as_x.invalid_field` 形状合法但字段不存在，必须拒。
 *
 * `__solver` 是求解器元数据，**不是字段可靠性条目**：明确放行、遍历时跳过、不计入可靠性检查。
 * **不能**把所有 `__` 前缀都放行（`__bad` 必须拒），否则拼错的保留键会被静默接受。
 *
 * @param {object} meta `shot_states.meta`（键为路径，值为 `{rel,src,conf,ver}`）
 * @param {object} state 对应的 `state_in` / `state_out`（实体存在性从它判断）
 * @returns {Array<object>} `META_INVALID` / `META_KEY_RESERVED` / `META_KEY_UNRESOLVED` /
 *                          `META_ENTITY_NOT_FOUND` / `META_FIELD_UNKNOWN`
 */
export function checkMetaKeys(meta, state) {
  if (meta === undefined || meta === null) return [];
  if (typeof meta !== 'object' || Array.isArray(meta)) {
    return [hit(FAIL, 'META_INVALID', 'meta', '对象（键为字段路径）')];
  }
  const hits = [];
  for (const key of Object.keys(meta).sort(cmpStr)) {
    if (META_RESERVED.includes(key)) continue;          // 唯一放行的保留键
    if (key.startsWith('__')) {
      hits.push(hit(FAIL, 'META_KEY_RESERVED', `meta.${key}`, `只有 ${META_RESERVED.join('/')} 是保留键`, { key }));
      continue;
    }
    const r = parseMetaKey(key, state);
    if (r.ok) continue;
    const expected = 'chars.<id>.<field> / props.<id>.<field> / costumes.<id> / env.<field>';
    hits.push(hit(FAIL, r.code, `meta.${key}`, expected, { key, top: r.top, id: r.id, field: r.field }));
  }
  return hits;
}

/** 只统计"字段可靠性条目"的条数（排除 `__solver`）；给 P5/P6 复算用，也用于测试断言 */
export function countReliabilityEntries(meta) {
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return 0;
  let n = 0;
  for (const key of Object.keys(meta)) {
    if (META_RESERVED.includes(key)) continue;
    if (key.startsWith('__')) continue;
    n += 1;
  }
  return n;
}

// ── V-20：时间切片 ──────────────────────────────────────────────────────

/**
 * V-20：`time_slices` 无空洞（D01-02 §10）。
 *
 * 排序后必须满足：首片 `from = 0`、末片 `to = story_duration`、相邻 `prev.to === next.from`。
 * **零容差**：所有边界都是同一套秒值，加 EPS 会把真实空洞放行（D01-02 §10 的 TQ/SNAP_TOL/PAD_TOL 都不用于此处）。
 *
 * @param {Array<{from:number,to:number,what?:string,kind?:string}>} slices
 * @param {number} storyDuration 镜时长（秒）
 * @returns {Array<object>} `TIME_SLICES_EMPTY`(info) / `TIME_SLICE_INVALID` / `TIME_SLICE_OUT_OF_RANGE` /
 *                          `TIME_SLICE_GAP` / `TIME_SLICE_OVERLAP`
 */
export function checkTimeSlices(slices, storyDuration) {
  const list = Array.isArray(slices) ? slices : [];
  const hits = [];
  if (!list.length) {
    // D02-06 V-20：数据不足 → INFO，既不伪造 PASS 也不判 FAIL
    return [hit(INFO, 'TIME_SLICES_EMPTY', 'time_slices', '空切片：无法判定是否覆盖整镜（数据不足）')];
  }
  if (!isFiniteNum(storyDuration) || storyDuration <= 0) {
    return [hit(FAIL, 'SCHEMA_INVALID', 'story_duration', '> 0 的秒数（判定切片覆盖范围的前提）', { got: storyDuration })];
  }

  list.forEach((s, i) => {
    const f = s?.from;
    const t = s?.to;
    if (!isFiniteNum(f) || !isFiniteNum(t)) {
      hits.push(hit(FAIL, 'TIME_SLICE_INVALID', `time_slices[${i}]`, 'from/to 必须是有限数（秒）', { got: s }));
      return;
    }
    if (f < 0 || t <= f) {
      hits.push(hit(FAIL, 'TIME_SLICE_INVALID', `time_slices[${i}]`, '0 ≤ from < to', { got: [f, t] }));
      return;
    }
    if (t > storyDuration) {
      hits.push(hit(FAIL, 'TIME_SLICE_OUT_OF_RANGE', `time_slices[${i}].to`, `≤ story_duration(${storyDuration})`, { got: t }));
    }
  });
  if (hits.length) return hits; // 结构都不合法时不再谈"连续性"，避免二次误导

  // 稳定排序：按 from 升序，同 from 保持原序（JS 排序稳定）
  const sorted = list.slice().sort((a, b) => a.from - b.from);
  if (sorted[0].from !== 0) {
    hits.push(hit(FAIL, 'TIME_SLICE_GAP', 'time_slices[0].from', '0（首片必须从 0 开始）', { got: sorted[0].from }));
  }
  for (let i = 1; i < sorted.length; i += 1) {
    const prev = sorted[i - 1];
    const cur = sorted[i];
    if (prev.to === cur.from) continue;
    if (prev.to < cur.from) {
      hits.push(hit(FAIL, 'TIME_SLICE_GAP', `time_slices[${i}].from`, `= 上一片 to(${prev.to})，不允许空洞`, { got: cur.from }));
    } else {
      hits.push(hit(FAIL, 'TIME_SLICE_OVERLAP', `time_slices[${i}].from`, `= 上一片 to(${prev.to})，不允许重叠`, { got: cur.from }));
    }
  }
  const last = sorted[sorted.length - 1];
  if (last.to !== storyDuration) {
    hits.push(hit(FAIL, 'TIME_SLICE_GAP', `time_slices[${sorted.length - 1}].to`, `= story_duration(${storyDuration})`, { got: last.to }));
  }
  return hits;
}

// ── V-22：静默修改 ──────────────────────────────────────────────────────

/**
 * V-22：`unknown` 字段被写入确定值，但 `meta` 未更新（D01-02 §十三 / D01-04 §5.2.1）。
 *
 * 判据是**可靠性语义**，不是"meta 对象在不在"：
 *  · `meta` 整个缺失 → 按 D01 属"N/A"（类 B 有值无 meta 是合法形态，只给 `inferred`），返回 INFO
 *  · 某字段 `rel='unknown'` 却有确定值 → WARN `SILENT_CHANGE`
 *  · `rel='not_applicable'`（不适用）与缺失值 → 不判（不适用不是"被偷偷改值"）
 *
 * 检测过程**不写 `meta`**，也不修正任何值 —— 它只报告。
 *
 * @param {{state?:object, meta?:object, specSource?:string}} [p]
 * @returns {Array<object>} `SILENT_CHANGE_NA`(info) / `SILENT_CHANGE`(warn)
 */
export function checkSilentChange({ state, meta } = {}) {
  if (meta === undefined || meta === null || typeof meta !== 'object' || Array.isArray(meta) || !Object.keys(meta).length) {
    return [hit(INFO, 'SILENT_CHANGE_NA', 'meta', '无 meta：按 V-22 不适用（N/A）')];
  }
  const st = state && typeof state === 'object' ? state : {};
  const hits = [];
  for (const key of Object.keys(meta).sort(cmpStr)) {
    if (META_RESERVED.includes(key)) continue;
    if (key.startsWith('__')) continue;                 // 键本身的合法性归 V-19
    const entry = meta[key];
    if (!entry || typeof entry !== 'object') continue;
    if (String(entry.rel ?? '') !== 'unknown') continue; // known/inferred/not_applicable 都不是静默修改
    const r = parseMetaKey(key, st);
    if (!r.ok) continue;                                // 路径非法归 V-19，不在这里重复报
    if (!isPresent(r.value)) continue;                  // 没有值 → 不是"被写入确定值"
    hits.push(hit(WARN, 'SILENT_CHANGE', `meta.${key}`, '值为确定值，但 meta.rel 仍为 unknown（未随值更新）', { key, got: r.value }));
  }
  return hits;
}

// ── 聚合（只聚合本文件的五类检查，不是 P5 的 validateShot）───────────────

/**
 * 本文件五类检查的聚合（P4 范围内的"schema 子集"）。
 *
 * **不是** `validateShot`：不碰 action/blocking/camera/asset/continuity 的其余规则，
 * 不写 `qc_reports`，不聚合规则级 Hash。P5 将在它之上编排。
 *
 * @param {object} ctx
 *   `shot`（`story_shots` 行）、`blockings`、`actions`、`shotState`（`{state_in,state_out,meta}`）、
 *   `sceneState`、`shotAssets`、`timeSlices`、`storyDuration`、`declaredLevel`
 * @returns {{level:string, basis:object, hits:Array<object>}}
 */
export function checkSchema(ctx = {}) {
  const {
    shot = {}, blockings, actions, shotState, sceneState, shotAssets,
    timeSlices, storyDuration, declaredLevel,
  } = ctx;
  const lv = computeLevel({ blockings, actions, sceneState, level: declaredLevel });
  const st = shotState && typeof shotState === 'object' ? shotState : {};
  const hits = [];

  hits.push(...checkRequired({ level: lv.level, blockings: toArray(blockings), sceneState, shotState: st, actions: toArray(actions) }));
  hits.push(...checkShotFields(shot));
  toArray(blockings).forEach((b, i) => hits.push(...checkBlockingFields(b, i)));
  hits.push(...checkEmptyShot({
    is_insert: shot.is_insert,
    dialogue: shot.dialogue,
    speakers: shot.speakers,
    blockings: toArray(blockings),
    shot_assets: toArray(shotAssets),
  }));
  // Meta 键要对着**同一份状态**检查：`state_in` 与 `state_out` 各有自己的 meta（D01-04 §5.2）
  const metaIn = st.meta_in ?? st.state_in_meta;
  const metaOut = st.meta_out ?? st.state_out_meta ?? st.meta;
  hits.push(...checkMetaKeys(metaIn, st.state_in));
  hits.push(...checkMetaKeys(metaOut, st.state_out ?? st.state_in));
  hits.push(...checkTimeSlices(timeSlices ?? shot.time_slices, storyDuration ?? shot.story_duration));
  hits.push(...checkSilentChange({ state: st.state_out ?? st.state_in, meta: metaOut }));

  if (lv.declared_ignored) {
    hits.push(hit(INFO, 'LEVEL_DECLARED_IGNORED', 'level', `按数据推导为 ${lv.level}；调用方声明值不参与判定`, { declared: String(declaredLevel) }));
  }
  return { level: lv.level, basis: lv.basis, hits: sortHits(hits) };
}
