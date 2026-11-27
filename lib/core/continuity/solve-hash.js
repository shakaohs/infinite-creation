// 求解输入 Hash（D02-06 §9.2.1 A/B，SH-4~SH-6）
//
// 这是**唯一**一份求解输入 Hash 实现：既供给 `shot_states.meta.__solver.hash`（A），
// 也供给 `qc_reports.hits.__solver_input.detail.qc_input_hash`（B）。
// 写两份的后果是 A 与 B 永远对不上，`hash_relation` 直接失效（SH-10）。
//
// 三条边界（违反任何一条，这个 Hash 就不再是"输入的函数"）：
//   ① 只覆盖**求解器实际读**的字段（QC-only 字段不进：景别、台词、运镜、画面内容）；
//   ② 不 hash 整行（id / created_at / updated_at / qc_status 一律不进）；
//   ③ 纯函数：不读库、不读时钟、不读 `process.env`、不依赖对象键序。
import { createHash } from 'node:crypto';
import { cmpStr } from '../hash/cmp-str.js';
import { canonicalStringify } from '../hash/canonical-stringify.js';

/** 求解器版本：进 Hash，换实现即换 Hash（SH-4） */
export const SOLVER_VERSION = 'stage3.1';

function sha256(s) {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

const arr = (v) => {
  if (Array.isArray(v)) return v;
  if (typeof v !== 'string' || !v.trim()) return [];
  try {
    const x = JSON.parse(v);
    return Array.isArray(x) ? x : [];
  } catch { return []; }
};
const pick = (row, keys) => {
  const out = {};
  for (const k of keys) out[k] = row?.[k] === undefined ? null : row[k];
  return out;
};

/**
 * 参与求解的 `shot.meta` 条目字段（P6-R1）。
 *
 * 求解器只从 `meta` 读三样东西，所以只把这三样纳入 Hash —— 多纳入一个不参与计算的键，
 * 就会造出"Hash 变了但结果没变"的假失效；少纳入一个真参与计算的键，就会造出
 * "结果变了但 Hash 没变"的假新鲜（这条是本轮修的缺口）。
 *
 * | 字段 | 求解器怎么用 |
 * |---|---|
 * | `rel` | `posRel()` 的五级优先级（显式 `unknown` 能一票否决坐标齐全） |
 * | `src` | 继承链起点 `originOf()`（`carried:sh_40` 的追溯） |
 * | `conf` | 沿用上镜时的衰减基数（`conf × 0.9`） |
 *
 * **`ver` 不纳入**：Step 1 会用本镜 `spec_version` 无条件覆写它，它不是输入。
 * **`__solver` 不纳入**：它是求解器的输出元数据，纳入会让 Hash 自引用（改一次变一次，永远对不上）。
 */
export const SOLVE_META_FIELDS = Object.freeze(['rel', 'src', 'conf']);

/**
 * `shots[].meta` 的稳定规范化（求解器与求解 Hash **共用这一份**）。
 *
 * 先明确这条通道到底是什么（P6-R1 / U-P6-8，结论见 D02-16 §三）：
 *  · **`story_shots` 没有 `meta` 列**（48 列实测），数据库里不存在"镜头的 meta"；
 *  · **`shot_states.meta`** 才是正式持久化的可靠性标注，类型 `TEXT`、默认 `'{}'`，
 *    内容是字段级 JSON 对象串（D01-04 §5.2）；
 *  · 求解器输入里的 **`shots[].meta` 是调用方附加到复合镜头对象上的可选字段**，
 *    与 `blockings` / `actions` 同一种做法 —— 它没有表、没有列，只能由调用方显式给出。
 *
 * 所以本函数处理的是"调用方给的值可能是对象、也可能是从 `shot_states.meta` 直接搬来的
 * JSON 字符串"，**不是"读库"**。早期版本对字符串直接返回 `{}`：Hash 与求解器双双当成
 * "没有标注"，两边还很一致，看起来完全正常 —— 这种一致是假象，不是正确性。
 *
 * 两处共用是刻意的：如果 Hash 归一化与求解器读取各写一套，两者迟早分叉，
 * 而"Hash 覆盖了什么"就只能靠人工比对 —— 那正是 P6-R1 这类缺口的成因。
 *
 * 因此解析只在这一处发生，且**解析失败必须抛**：静默降级成 `{}` 等于把"输入坏了"
 * 伪装成"没有标注"，而这两件事在 Hash 上长得一模一样。
 *
 * @param {object|string|null} meta 对象，或承载同一内容的 JSON 字符串；`null`/缺省表示"无标注"
 * @returns {object} 键按 `cmpStr` 排序、每项只留 {@link SOLVE_META_FIELDS}、`__solver` 已剔除
 * @throws {Error} `SOLVE_META_INVALID_JSON` / `SOLVE_META_NOT_OBJECT`
 */
export function normalizeShotMeta(meta) {
  const src = parseShotMeta(meta);
  const out = {};
  for (const k of Object.keys(src).sort(cmpStr)) {
    if (k === '__solver') continue;
    const entry = src[k];
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const one = {};
    for (const f of SOLVE_META_FIELDS) one[f] = entry[f] === undefined ? null : entry[f];
    // 三样都为空 → 这条对求解器没有任何信息量（例如只写了 `ver`），整条剔除：
    // 保留它会让"多挂一个空条目"也算输入变化，造出假失效。
    if (SOLVE_META_FIELDS.every((f) => one[f] === null)) continue;
    out[k] = one;
  }
  return out;
}

function metaError(code, message, extra = {}) {
  const e = new Error(message);
  e.code = code;
  Object.assign(e, extra);
  return e;
}

/**
 * `meta` 的边界安全解析（P6-R1）：把调用方给的"对象或 JSON 字符串"统一成对象。
 *
 * 只在这里发生一次，求解器与 Hash 都走 {@link normalizeShotMeta} 间接调用它，
 * 保证"Hash 覆盖的 meta" 与 "求解器读到的 meta" 是**同一个对象**。
 *
 * 需要它，是因为同一条通道有两种合法来源：调用方直接构造的对象，以及从
 * `shot_states.meta`（`TEXT DEFAULT '{}'`）取出的 JSON 串 —— 后者若被当成对象处理，
 * 会静默变成 `{}`。注意：**`story_shots` 没有 `meta` 列**，本函数不为它服务。
 *
 * `null` / `undefined` / 空白串 / `'{}'` / `'null'` → `{}`（合法的"没有标注"）；
 * 其余无法解析或解析出非对象 → 抛，不降级。
 *
 * @param {object|string|null} meta
 * @returns {object}
 */
export function parseShotMeta(meta) {
  if (meta === null || meta === undefined) return {};
  if (typeof meta === 'object' && !Array.isArray(meta)) return meta;
  if (typeof meta === 'string') {
    const s = meta.trim();
    if (!s) return {};
    let parsed;
    try {
      parsed = JSON.parse(s);
    } catch {
      throw metaError(
        'SOLVE_META_INVALID_JSON',
        `shot.meta 不是合法 JSON（前 40 字符：${s.slice(0, 40)}）—— `
        + '静默当成空标注会让"输入里有效、Hash 与求解器都看不见"',
        { preview: s.slice(0, 40) },
      );
    }
    if (parsed === null) return {};
    if (typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw metaError('SOLVE_META_NOT_OBJECT', `shot.meta 解析结果必须是对象（收到 ${Array.isArray(parsed) ? 'array' : typeof parsed}）`);
    }
    return parsed;
  }
  throw metaError('SOLVE_META_NOT_OBJECT', `shot.meta 必须是对象或 JSON 字符串（收到 ${typeof meta}）`);
}

/** 参与求解的 `scene_states` 列（§7.8.1 前七行） */
export const SOLVE_SCENE_FIELDS = Object.freeze([
  'coord_system', 'fixtures', 'entries', 'axis_lock', 'power_geometry', 'crowd_switch', 'time_of_day',
]);

/** 参与求解的 `story_shots` 列（§7.8.1.2 的「CIS + QIS」组） */
export const SOLVE_SHOT_FIELDS = Object.freeze([
  'id', 'global_no', 'scene_key', 'time_jump', 'spec_source', 'spec_version', 'fill_confidence',
]);

/** 参与求解的 `shot_assets` 角色（求解只认这两类，§7.8.1 末段） */
export const SOLVE_ASSET_ROLES = Object.freeze(['character', 'prop']);

/**
 * 求解输入 Hash（SH-4）。
 *
 * 输入集**只**包含求解器真正读的东西：
 *  · 场次基线七列；
 *  · 每镜的顺序/来源/时间跳跃/置信度（顺序键是 `global_no`，进 Hash —— 改顺序等于换链）；
 *  · 每镜站位行、动作行、`role ∈ {character, prop}` 的资产引用。
 *
 * @param {{projectId?:string, sceneKey:string, shots:Array, sceneState?:object}} p
 * @returns {string} `sha256:<hex>`
 */
export function solverInputHash({ projectId, sceneKey, shots, sceneState } = {}) {
  const list = arr(shots)
    .filter((s) => s && typeof s === 'object')
    .slice()
    .sort((a, b) => (Number(a.global_no) - Number(b.global_no)) || cmpStr(a.id, b.id));

  const payload = {
    solver_version: SOLVER_VERSION,
    project_id: projectId ?? null,
    scene_key: sceneKey ?? null,
    // 场次只取参与求解的七列；`state_rev` 不进（它是版本戳，不是几何）
    scene: pick(sceneState && typeof sceneState === 'object' ? sceneState : null, SOLVE_SCENE_FIELDS),
    shots: list.map((shot) => ({
      ...pick(shot, SOLVE_SHOT_FIELDS),
      // 本镜自带的可靠性标注（P6-R1）：它会改变求解结果（显式 unknown 一票否决坐标），
      // 因此必须进 Hash —— 否则"改了 shot.meta、结果变了、Hash 没变"，读侧会拿旧状态当当前结论。
      meta: normalizeShotMeta(shot.meta),
      // 站位行按 `character_id` 排序：DB 返回顺序不是业务语义
      blockings: arr(shot.blockings)
        .filter((b) => b && typeof b === 'object')
        .slice()
        .sort((a, b) => cmpStr(a.character_id, b.character_id) || cmpStr(a.shot_id, b.shot_id))
        .map((b) => ({
          character_id: b.character_id ?? null,
          in_frame: b.in_frame ?? null,
          norm_x: b.norm_x ?? null,
          norm_y: b.norm_y ?? null,
          norm_z: b.norm_z ?? null,
          position_abs: b.position_abs ?? null,
          position_track: arr(b.position_track),
          posture: b.posture ?? null,
          facing: b.facing ?? null,
          hand_state: b.hand_state ?? null,
          gaze_target: b.gaze_target ?? null,
          anchor_object: b.anchor_object ?? null,
          behind_object: b.behind_object ?? null,
          occlusion: b.occlusion ?? null,
          power_level: b.power_level ?? null,
          instance_anchor: b.instance_anchor ?? null,
          current_task: b.current_task ?? null,
          distance_to_camera: b.distance_to_camera ?? null,
          norm_confidence: b.norm_confidence ?? null,
        })),
      // 动作行按 id 排序（动作语义与行序无关）
      actions: arr(shot.actions)
        .filter((a) => a && typeof a === 'object')
        .slice()
        .sort((a, b) => cmpStr(a.id, b.id))
        .map((a) => ({
          id: a.id ?? null,
          actor_id: a.actor_id ?? null,
          action_type: a.action_type ?? null,
          tier: a.tier ?? null,
          is_primary: a.is_primary ?? null,
          cog: a.cog ?? null,
          t_from: a.t_from ?? null,
          t_to: a.t_to ?? null,
          path_json: a.path_json ?? a.path ?? null,
          result_json: a.result_json ?? a.result ?? null,
          end_state: a.end_state ?? a.end_state_json ?? null,
          trigger_json: a.trigger_json ?? a.trigger ?? null,
          contact_json: a.contact_json ?? a.contact ?? null,
          sync_json: a.sync_json ?? a.sync ?? null,
          body_parts: arr(a.body_parts),
          init_state: a.init_state ?? null,
        })),
      // 只用 character/prop 两类引用：其余 role 不影响求解（§7.8.1）
      assets: arr(shot.shotAssets ?? shot.assets)
        .filter((r) => r && SOLVE_ASSET_ROLES.includes(String(r.role ?? '')))
        .slice()
        .sort((a, b) => cmpStr(a.role, b.role) || cmpStr(a.asset_id, b.asset_id))
        .map((r) => ({ asset_id: r.asset_id ?? null, role: r.role ?? null, variant_of: r.variant_of ?? null })),
    })),
  };

  return 'sha256:' + sha256(canonicalStringify(payload));
}
