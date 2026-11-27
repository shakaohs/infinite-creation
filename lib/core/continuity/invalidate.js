// 双层失效计算（P6 · D02-06 §7.8.0 / §7.8.1 / §7.8.2 / §7.8.3）
//
// 这一层只回答两个**互相独立**的问题，并把答案分别装进两个集合：
//   · `continuityInvalidationSet`（CIS）：哪些镜的 `shot_states` 要重新求解；
//   · `qcInvalidationSet`（QIS）：哪些镜的**哪些**规则要重新执行。
//
// 为什么必须拆成两个集合（V3 只有一个 `qcOnlyShots` 布尔，已被 §7.8.0 明文作废）：
// 改一句台词 → 状态不用重算，但 V-09/V-13 必须重出；改 `axis_lock` → 状态整场重算，QC 随之；
// 改 `shot_size` → 本镜状态不动，但同章的 V-06/V-07/V-08 分母变了，只重出本镜会留下"过期但看起来通过"的章级结论。
// 漏判的后果是**静默的**：源数据改了，状态还是旧结论、QC 还显示上一轮 PASS，没有任何报错。
//
// 边界（§7.8.5）：
//   · **纯函数**：不读库、不写库、不读时钟、不读 `process.env`（L-3/L-4）；
//   · 只做编排，不求解、不跑规则（L-6：本模块**不得**出现在求解器内部）；
//   · 未分类字段 **抛错**，不静默按"不触发"处理（§7.8.3 步①）。
import { cmpStr } from '../hash/cmp-str.js';
import { RULE_DEPS, RULE_IDS, SCOPE_OF } from '../qc/deps/rule-deps.js';

// ── 字段分类（§7.8.1.2 逐列，与 DDL 一一对应）────────────────────────────

/** `story_shots` 48 列：6（CIS+QIS）+ 22（仅 QIS）+ 20（无失效）= 48 */
export const SHOT_COLUMNS = Object.freeze({
  cis_qc: Object.freeze(['scene_key', 'global_no', 'time_jump', 'spec_source', 'spec_version', 'fill_confidence']),
  qc: Object.freeze([
    'shot_no', 'shot_size', 'cam_direction', 'cam_height', 'cam_roll_deg', 'cam_pos', 'cam_target',
    'cam_distance_m', 'lens_mm', 'fov_deg', 'movement', 'movement_amp', 'cam_path', 'composition_rule',
    'cam_note', 'story_duration', 'time_slices', 'speed_ramp', 'visual_content', 'dialogue', 'speakers', 'voice_ids',
  ]),
  none: Object.freeze([
    'id', 'project_id', 'chapter_id', 'scene_id', 'beat_key', 'prev_shot_id', 'purpose', 'dramatic_value',
    'info_delta', 'dialogue_function', 'is_insert', 'composition', 'lighting', 'narration', 'sfx', 'music_cue',
    'is_cut_point', 'qc_status', 'created_at', 'updated_at',
  ]),
});

/** `scene_states` 14 列：7（CIS+QIS）+ 1（仅 QIS）+ 1（换场）+ 5（无失效） */
export const SCENE_COLUMNS = Object.freeze({
  cis_qc: Object.freeze([
    'coord_system', 'fixtures', 'entries', 'axis_lock', 'power_geometry', 'crowd_switch', 'time_of_day',
  ]),
  qc: Object.freeze(['scene_id']),
  /** 改它等同"换场"：原 key 与新 key 都失效（§7.8.2） */
  sceneKey: Object.freeze(['scene_key']),
  none: Object.freeze(['id', 'project_id', 'state_rev', 'created_at', 'updated_at']),
});

/** `assets` 被读取的列 → CIS+QIS；其余列无失效（§7.8.1 末行） */
export const ASSET_COLUMNS = Object.freeze({
  cis_qc: Object.freeze(['name', 'category', 'parent_id']),
  none: Object.freeze([
    'id', 'project_id', 'description', 'image_path', 'thumb_path', 'created_at', 'updated_at',
  ]),
});

/** `shot_assets` 的 role → 求解是否依赖（character/prop 进求解，其余只进 QC） */
export const ASSET_ROLES_SOLVER = Object.freeze(['character', 'prop']);

/** 三张镜级子表的全部内容列（保守：任一行任一列变化都可能改 `state_in` 比对结果） */
export const BLOCKING_COLUMNS = Object.freeze([
  'character_id', 'position_abs', 'norm_x', 'norm_y', 'norm_z', 'norm_confidence', 'position_track',
  'anchor_object', 'behind_object', 'facing', 'gaze_target', 'posture', 'hand_state', 'in_frame',
  'distance_to_camera', 'power_level', 'instance_anchor', 'current_task', 'occlusion',
]);
export const ACTION_COLUMNS = Object.freeze([
  'actor_id', 'action_type', 'tier', 'is_primary', 'cog', 't_from', 't_to', 'path_json', 'result_json',
  'end_state', 'trigger_json', 'contact_json', 'sync_json', 'speed_json', 'force_json', 'body_parts',
  'init_state', 'order_no',
]);
export const SHOT_ASSET_COLUMNS = Object.freeze([
  'asset_id', 'role', 'order_no', 'variant_of', 'costume_id', 'age_variant',
]);

/**
 * `§7.8.1.2` 把下列列归入「无失效」，但 P5 的规则**确实读它们** —— 这是规范与代码的实质冲突，
 * 不是实现错误。照表执行会让"改了 `purpose` 却留着上一轮 A-01/V-13 结论"，正是本节要防的静默过期。
 *
 * 处理方式（不擅自改 D01/D02 语义）：
 *   · 声明口径仍按 §7.8.1.2 保留 6 + 22 + 20 = 48（`auditColumnClassification` 用它核对 DDL）；
 *   · 另加这张**显式偏差表**，把这三列**升**为「仅 QIS」并在报告里作为 U-P6 记录；
 *   · `id` 不升：改 `id` 等同"删一行 + 插一行"，走 `shots_added`/`shots_deleted` 结构路径，不是字段变化。
 *
 * **规范修订建议（U-P6-1，提给 D02-06 维护方，本轮不改文档）**：
 *   把 §7.8.1.2「无失效」组的这三列移入「仅 QIS」组，并把该组算术由 20 改为 17、
 *   仅 QIS 组由 22 改为 25（合计仍 48）。理由：`purpose`（A-01 纯空镜 / S-17 权力几何 / V-02 枚举）、
 *   `is_insert`（A-01 / V-13）、`dialogue_function`（V-02 枚举）都是规则输入，标"无失效"与代码事实矛盾。
 */
export const READ_OVERRIDES = Object.freeze({
  purpose: { declared: 'none', effective: 'qc', note: '枚举取值点 + 纯空镜判定 + 权力几何' },
  dialogue_function: { declared: 'none', effective: 'qc', note: '枚举取值点' },
  is_insert: { declared: 'none', effective: 'qc', note: '纯空镜判定（0 个主动作 / 空镜不得开口）' },
});

const SET = { CIS: 'continuity', QC: 'qc' };

function err(code, message, extra = {}) {
  const e = new Error(message);
  e.code = code;
  Object.assign(e, extra);
  return e;
}

const toArr = (v) => (Array.isArray(v) ? v : []);
const str = (v) => (v === null || v === undefined ? '' : String(v));
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

/** 列名 → 分类（'cis_qc' | 'qc' | 'none' | 'sceneKey'），查不到返回 null。已含 `READ_OVERRIDES` 升级 */
export function classifyShotColumn(col) {
  const c = str(col);
  if (SHOT_COLUMNS.cis_qc.includes(c)) return 'cis_qc';
  if (SHOT_COLUMNS.qc.includes(c)) return 'qc';
  if (SHOT_COLUMNS.none.includes(c)) return READ_OVERRIDES[c]?.effective ?? 'none';
  return null;
}

export function classifySceneColumn(col) {
  const c = str(col);
  if (SCENE_COLUMNS.cis_qc.includes(c)) return 'cis_qc';
  if (SCENE_COLUMNS.qc.includes(c)) return 'qc';
  if (SCENE_COLUMNS.sceneKey.includes(c)) return 'sceneKey';
  if (SCENE_COLUMNS.none.includes(c)) return 'none';
  return null;
}

export function classifyAssetColumn(col) {
  const c = str(col);
  if (ASSET_COLUMNS.cis_qc.includes(c)) return 'cis_qc';
  if (ASSET_COLUMNS.none.includes(c)) return 'none';
  return null;
}

/**
 * 表名 → 该表的列分类器。
 * 表名写错同样是缺陷（`INVALIDATION_FIELD_UNCLASSIFIED` 的孪生情形），不静默跳过。
 */
const TABLE_OF = Object.freeze({
  shot_blockings: { columns: BLOCKING_COLUMNS, cis: true },
  shot_actions: { columns: ACTION_COLUMNS, cis: true },
  shot_assets: { columns: SHOT_ASSET_COLUMNS, cis: null }, // 按 role 决定
});

/**
 * 逐列核对分类完整性（§7.8.1.2 的"三组之和必须等于实际列数，缺一列即返工"）。
 *
 * 两种输出刻意分开：
 *   · `missing` / `duplicated` / `counts` —— 与**声明口径**（6+22+20）核对 DDL，属硬判据；
 *   · `deviations` —— 「标了无失效但其实被规则读」的列，属**规范与代码的冲突**，不影响 48 的算术，
 *     但必须进报告（`U-P6-1`），且这些列的实际行为按 `READ_OVERRIDES` 升为「仅 QIS」。
 *
 * @param {{storyShots?:string[], sceneStates?:string[]}} actual 用 `PRAGMA table_info` 得到的列名
 * @returns {{ok:boolean, missing:string[], duplicated:string[], deviations:Array, counts:object}}
 */
export function auditColumnClassification(actual = {}) {
  const out = { ok: true, missing: [], duplicated: [], deviations: [], counts: {} };
  for (const [key, spec, name] of [
    ['storyShots', SHOT_COLUMNS, 'story_shots'],
    ['sceneStates', SCENE_COLUMNS, 'scene_states'],
  ]) {
    const cols = toArr(actual[key]).map(str).filter(Boolean);
    const groups = Object.entries(spec).filter(([g]) => g !== 'sceneKey');
    const flat = groups.flatMap(([, v]) => v);
    const dup = flat.filter((c, i) => flat.indexOf(c) !== i);
    out.counts[name] = { groups: Object.fromEntries(groups.map(([g, v]) => [g, v.length])), total: flat.length, actual: cols.length };
    if (dup.length) out.duplicated.push(...dup.map((c) => `${name}.${c}`));
    for (const c of cols) if (!flat.includes(c)) out.missing.push(`${name}.${c}`);
    for (const c of flat) if (cols.length && !cols.includes(c)) out.missing.push(`${name}.${c}(已分类但表里没有)`);
  }
  // 「无失效」组**不得**与任何规则的实际读取相交 —— 相交即记录为偏差（不是静默放过）
  for (const c of SHOT_COLUMNS.none) {
    const rules = rulesTouchingColumn('shots', c);
    if (!rules.length) continue;
    const declared = READ_OVERRIDES[c];
    out.deviations.push({
      column: `story_shots.${c}`,
      declared: 'none',
      effective: declared?.effective ?? (c === 'id' ? 'structural' : 'none'),
      read_by: rules,
      note: declared?.note ?? (c === 'id' ? '改 id 等同删行+插行，走结构路径' : '规范标"无失效"但规则读取，需定案'),
    });
  }
  out.ok = out.missing.length === 0 && out.duplicated.length === 0;
  return out;
}

// ── 字段 → 规则（把列变化映射到读它的规则）──────────────────────────────

/**
 * 依赖声明的根 → 列口径。
 *
 * 映射表里同一列会出现三种根：`shot.X`（本镜）、`chapterShots[*].X`（整章）、
 * `nextShot.X`（邻镜）。它们读的是**同一个列**，改列必须同时命中三者 ——
 * 只按 `shot.` 前缀查会让章级三条（V-06/V-07/V-08）漏掉，那正是 §7.8.1.3 末尾
 * 点名要防的"过期但看起来通过的章级结论"。
 */
const ROOT_OF = Object.freeze({
  shot: 'shots', chapterShots: 'shots', nextShot: 'shots', prevShot: 'shots',
  blockings: 'blockings', actions: 'actions', shotAssets: 'shotAssets',
  sceneState: 'sceneState', assets: 'assets', shotState: 'shotState',
  nextShotState: 'shotState', prevShotState: 'shotState', targetProfile: 'targetProfile',
  __audit: '__audit',
});

/** 依赖声明 → `{root, path, leaf}`；`[*]` 展开去掉 */
function parseDecl(decl) {
  const d = str(decl).replace(/\[\*\]/g, '');
  const segs = d.split('.').filter(Boolean);
  const root = ROOT_OF[segs[0]] ?? segs[0];
  return { root, path: segs.slice(1).join('.'), leaf: segs[segs.length - 1], raw: d };
}

/** 某容器（列口径）下的某列被哪些规则读取 */
export function rulesTouchingColumn(root, col) {
  const out = [];
  const c = str(col);
  for (const id of RULE_IDS) {
    const hit = RULE_DEPS[id].fields.some((decl) => {
      const p = parseDecl(decl);
      // `sceneState` 整行（无子路径）视为"任一场次列"
      if (p.root !== root) return false;
      if (!p.path) return true;
      return p.leaf === c || p.path === c;
    });
    if (hit) out.push(id);
  }
  return out;
}

// ── 作用域展开（§7.8.1.3）────────────────────────────────────────────────

const SHOT_SCOPE_RULES = RULE_IDS.filter((id) => SCOPE_OF[id] === 'shot');
const STATE_SCOPE_IDS = RULE_IDS.filter((id) => SCOPE_OF[id] === 'state');
const AUDIT_SCOPE_IDS = RULE_IDS.filter((id) => SCOPE_OF[id] === 'audit');

/**
 * 索引：本场按 `global_no` 升序（ORD-1）、章内按 `shot_no` 升序。
 * 排序一律走 `cmpStr` / 数值比较，**不碰 `localeCompare`**。
 */
function buildIndex(shots) {
  const rows = toArr(shots)
    .filter((s) => s && typeof s === 'object' && str(s.id))
    .map((s) => ({
      id: str(s.id),
      scene_key: str(s.scene_key),
      chapter_id: str(s.chapter_id),
      global_no: num(s.global_no),
      shot_no: num(s.shot_no),
    }));
  const byId = new Map(rows.map((r) => [r.id, r]));
  const byScene = new Map();
  const byChapter = new Map();
  for (const r of rows.slice().sort((a, b) => a.global_no - b.global_no || cmpStr(a.id, b.id))) {
    if (!byScene.has(r.scene_key)) byScene.set(r.scene_key, []);
    byScene.get(r.scene_key).push(r);
  }
  for (const r of rows.slice().sort((a, b) => cmpStr(a.chapter_id, b.chapter_id) || a.shot_no - b.shot_no || cmpStr(a.id, b.id))) {
    if (!byChapter.has(r.chapter_id)) byChapter.set(r.chapter_id, []);
    byChapter.get(r.chapter_id).push(r);
  }
  return { rows, byId, byScene, byChapter };
}

/** 同场"本镜及后继"（含本镜）；找不到本镜 → 只返回给定 id（保守：调用方数据不全时不静默放行） */
function fromShotOnward(idx, shotId) {
  const r = idx.byId.get(str(shotId));
  if (!r) return [str(shotId)];
  const scene = idx.byScene.get(r.scene_key) ?? [];
  return scene.filter((s) => s.global_no >= r.global_no).map((s) => s.id);
}

/** 同场下一镜（邻镜级规则用） */
function nextInScene(idx, shotId) {
  const r = idx.byId.get(str(shotId));
  if (!r) return [];
  const scene = idx.byScene.get(r.scene_key) ?? [];
  const at = scene.findIndex((s) => s.id === r.id);
  return at >= 0 && at + 1 < scene.length ? [scene[at + 1].id] : [];
}

/** 规则按作用域展开成"要重跑的镜" */
function expandRule(ruleId, shotId, idx, cisShots) {
  const scope = SCOPE_OF[ruleId];
  if (scope === 'shot') return [str(shotId)];
  if (scope === 'chapter') {
    const r = idx.byId.get(str(shotId));
    const chap = r ? (idx.byChapter.get(r.chapter_id) ?? []) : [];
    return [...new Set([str(shotId), ...chap.map((s) => s.id)])];
  }
  if (scope === 'neighbor') return [...new Set([str(shotId), ...nextInScene(idx, shotId)])];
  // 状态级：只有落在 CIS 里的镜才重跑（状态没变就不重跑，§7.8.1.3）
  if (scope === 'state') return cisShots.has(str(shotId)) ? [str(shotId)] : [];
  // 审计级：扫整份报告的规则产出，任何一处重跑都要重算（成本见 U-P6-6）
  if (scope === 'audit') return idx.rows.map((s) => s.id);
  return [];
}

// ── 主入口 ───────────────────────────────────────────────────────────────

/**
 * 失效编排（§7.8.3 步①~⑤，纯函数）。
 *
 * `change` 结构（写入用例显式构造，**不得**由触发器/轮询产生，L-4）：
 * ```js
 * {
 *   shots:         [{ shot_id, fields: ['shot_size', ...] }],
 *   scene_states:  [{ scene_key, fields: ['axis_lock', ...] }],
 *   tables:        [{ shot_id, table: 'shot_blockings'|'shot_actions'|'shot_assets', fields?: [], role?: 'prop' }],
 *   assets:        [{ asset_id, fields: ['category', ...] }],
 *   shots_added:   [{ shot_id }],
 *   shots_deleted: [{ shot_id }],
 *   shots_moved:   [{ shot_id, from, to }],
 * }
 * ```
 *
 * @param {{change:object, shots:Array, sceneStates?:Array, shotAssets?:Array}} p
 * @returns {{continuityInvalidationSet:object, qcInvalidationSet:object, bothEmpty:boolean, reasons:Array}}
 * @throws {Error} `INVALIDATION_FIELD_UNCLASSIFIED`（系统类）
 */
export function planInvalidation({ change, shots, sceneStates, shotAssets } = {}) {
  const idx = buildIndex(shots);
  const ch = change && typeof change === 'object' ? change : {};
  const qc = new Map(); // shotId → Set<ruleId>
  const reasons = [];
  const cis = new Map(); // sceneKey → {earliest, ids:Set}

  const addQc = (shotId, ruleId, field, set) => {
    const id = str(shotId);
    if (!id) return;
    if (!qc.has(id)) qc.set(id, new Set());
    qc.get(id).add(ruleId);
    reasons.push({ field: str(field), sceneKey: idx.byId.get(id)?.scene_key ?? '', shotId: id, ruleId, set });
  };
  const addCis = (shotId, field) => {
    const r = idx.byId.get(str(shotId));
    const sceneKey = r ? r.scene_key : '';
    if (!sceneKey) return;
    if (!cis.has(sceneKey)) cis.set(sceneKey, { earliest: Infinity, ids: new Set() });
    const bucket = cis.get(sceneKey);
    bucket.ids.add(str(shotId));
    bucket.earliest = Math.min(bucket.earliest, r.global_no);
    reasons.push({ field: str(field), sceneKey, shotId: str(shotId), ruleId: '', set: SET.CIS });
  };

  // ── 步① 检测：逐条归类，未分类即抛 ────────────────────────────────────
  const unclassified = (kind, name) => err(
    'INVALIDATION_FIELD_UNCLASSIFIED',
    `失效编排：${kind} 字段 \`${name}\` 未在 §7.8.1/§7.8.1.2 归类（不得静默按"不触发"处理）`,
    { field: str(name), kind },
  );

  // ①-a story_shots 列
  for (const item of toArr(ch.shots)) {
    const shotId = str(item?.shot_id ?? item?.id);
    if (!shotId) throw unclassified('shots', '(缺少 shot_id)');
    for (const col of toArr(item?.fields)) {
      const cls = classifyShotColumn(col);
      if (!cls) throw unclassified('story_shots', col);
      if (cls === 'none') continue;
      if (cls === 'cis_qc') for (const s of fromShotOnward(idx, shotId)) addCis(s, col);
      for (const ruleId of rulesTouchingColumn('shots', col)) {
        for (const s of expandRule(ruleId, shotId, idx, new Set(fromShotOnward(idx, shotId)))) addQc(s, ruleId, col, SET.QC);
      }
    }
  }

  // ①-b scene_states 列
  for (const item of toArr(ch.scene_states)) {
    const sceneKey = str(item?.scene_key ?? item?.sceneKey);
    if (!sceneKey) throw unclassified('scene_states', '(缺少 scene_key)');
    const sceneShots = (idx.byScene.get(sceneKey) ?? []).map((s) => s.id);
    for (const col of toArr(item?.fields)) {
      const cls = classifySceneColumn(col);
      if (!cls) throw unclassified('scene_states', col);
      if (cls === 'none') continue;
      // 场次级"是"列 → CIS 取该场最小镜为起点、shotIds 取该场全部（§7.8.3 步②）
      if (cls === 'cis_qc') for (const s of sceneShots) addCis(s, col);
      for (const ruleId of rulesTouchingColumn('sceneState', col)) {
        for (const s of sceneShots) addQc(s, ruleId, col, SET.QC);
      }
    }
  }

  // ①-c 镜级子表（站位/动作/资产引用）
  for (const item of toArr(ch.tables)) {
    const shotId = str(item?.shot_id);
    const table = str(item?.table);
    const spec = TABLE_OF[table];
    if (!spec) throw unclassified('tables', table || '(缺少 table)');
    const fields = toArr(item?.fields).length ? toArr(item.fields) : spec.columns;
    const role = str(item?.role);
    // `shot_assets` 的求解相关性由 role 决定；未给 role 时按保守处理（当 character/prop）
    const cisRelevant = table === 'shot_assets'
      ? (!role || ASSET_ROLES_SOLVER.includes(role))
      : true;
    for (const col of fields) {
      if (!spec.columns.includes(str(col))) throw unclassified(table, col);
      if (cisRelevant) for (const s of fromShotOnward(idx, shotId)) addCis(s, col);
      const root = table === 'shot_blockings' ? 'blockings' : table === 'shot_actions' ? 'actions' : 'shotAssets';
      for (const ruleId of rulesTouchingColumn(root, col)) {
        for (const s of expandRule(ruleId, shotId, idx, new Set(fromShotOnward(idx, shotId)))) addQc(s, ruleId, col, SET.QC);
      }
      // 资产引用变了 → 章级三条的分母没变，不追加；无需特殊处理
    }
  }

  // ①-d assets 实体内容（§7.8.1 末行：引用该资产的镜中最小 `global_no` 起）
  //
  // **fail-closed（P6-R3）**：资产失效范围完全由"引用关系"决定，没有 `shotAssets` 就推不出任何镜。
  // 这里若按缺省空数组处理，会返回"两集合都空"——调用方读到的是"没有东西需要重算"，
  // 而真相是"我们不知道该重算什么"。这两件事在返回值上长得一样，是最危险的一种静默失败：
  // 资产 `category` 从 `prop` 改成 `costume` 后，`COSTUME_JUMP` / `AS-8` 的结论会变，
  // 但没有人会去重跑它们。所以缺上下文一律抛错，宁可让写入口这次失败。
  if (toArr(ch.assets).length) {
    if (!Array.isArray(shotAssets)) {
      throw err(
        'INVALIDATION_ASSETS_CONTEXT_MISSING',
        '失效编排：change.assets 非空但未提供 shotAssets（无引用关系无法定位受影响镜；不得静默返回空集合）',
        { assets: toArr(ch.assets).map((x) => str(x?.asset_id)).filter(Boolean) },
      );
    }
    const badRefs = toArr(shotAssets)
      .filter((r) => r && typeof r === 'object' && str(r.shot_id) && !idx.byId.has(str(r.shot_id)))
      .map((r) => str(r.shot_id));
    if (badRefs.length) {
      throw err(
        'INVALIDATION_ASSET_REF_UNKNOWN',
        `失效编排：shotAssets 引用了快照里不存在的镜（${[...new Set(badRefs)].sort(cmpStr).join(', ')}）`
        + '——引用关系与镜头快照不一致时无法确定失效范围，不得猜测跳过',
        { shot_ids: [...new Set(badRefs)].sort(cmpStr) },
      );
    }
  }
  for (const item of toArr(ch.assets)) {
    const assetId = str(item?.asset_id);
    if (!assetId) throw unclassified('assets', '(缺少 asset_id)');
    const refs = toArr(shotAssets)
      .filter((r) => r && str(r.asset_id) === assetId)
      .map((r) => str(r.shot_id))
      .filter(Boolean);
    for (const col of toArr(item?.fields)) {
      const cls = classifyAssetColumn(col);
      if (!cls) throw unclassified('assets', col);
      if (cls === 'none') continue;
      for (const sid of refs) {
        for (const s of fromShotOnward(idx, sid)) addCis(s, col);
        for (const ruleId of rulesTouchingColumn('assets', col)) {
          for (const s of expandRule(ruleId, sid, idx, new Set(fromShotOnward(idx, sid)))) addQc(s, ruleId, col, SET.QC);
        }
      }
    }
  }

  // ①-e 结构变化：新增 / 删除 / 换场 / 换号
  for (const item of toArr(ch.shots_added)) {
    const shotId = str(item?.shot_id ?? item?.id);
    if (!idx.byId.has(shotId)) {
      // 新镜还没进快照：只能按"所在场全部失效"处理（保守，宁可多算一场）
      const sceneKey = str(item?.scene_key);
      for (const s of idx.byScene.get(sceneKey) ?? []) addCis(s.id, '__shots_added');
      continue;
    }
    for (const s of fromShotOnward(idx, shotId)) addCis(s, '__shots_added');
  }
  for (const item of toArr(ch.shots_deleted)) {
    const shotId = str(item?.shot_id ?? item?.id);
    // 被删镜已不在快照里：无法用 global_no 定位 → 该场整链失效（保守）
    const sceneKey = str(item?.scene_key) || idx.byId.get(shotId)?.scene_key || '';
    for (const s of idx.byScene.get(sceneKey) ?? []) addCis(s.id, '__shots_deleted');
  }
  for (const item of toArr(ch.shots_moved)) {
    const shotId = str(item?.shot_id ?? item?.id);
    for (const sceneKey of [str(item?.from), str(item?.to)]) {
      if (!sceneKey) continue;
      for (const s of idx.byScene.get(sceneKey) ?? []) addCis(s.id, '__scene_key');
      // 章级三条：两场所在章都重跑
      for (const ruleId of RULE_IDS.filter((id) => SCOPE_OF[id] === 'chapter')) {
        for (const s of idx.byScene.get(sceneKey) ?? []) addQc(s.id, ruleId, '__scene_key', SET.QC);
      }
    }
    for (const ruleId of rulesTouchingColumn('shots', 'scene_key')) {
      const r = idx.byId.get(shotId);
      if (r) for (const s of expandRule(ruleId, shotId, idx, new Set([shotId]))) addQc(s, ruleId, 'scene_key', SET.QC);
    }
  }

  // ── 步② R-1：CIS 非空 → 该镜的镜级 + 状态级规则**全部**进 QIS ───────────
  // 重算后的状态是 QC 的输入，不能只重跑"由变化字段反查出来的那几条"。
  // 另外按 §7.8.2 第一行：**A-06 追加同场下一镜** —— 本镜 `state_out` 变了，
  // 下镜"动作终点 vs state_in"的比对对象就变了（本镜自己那条 A-06 同样要重跑）。
  const cisShots = new Set([...cis.values()].flatMap((b) => [...b.ids]));
  for (const shotId of [...cisShots].sort(cmpStr)) {
    for (const ruleId of [...SHOT_SCOPE_RULES, ...STATE_SCOPE_IDS]) addQc(shotId, ruleId, '__cis', SET.QC);
    for (const s of [shotId, ...nextInScene(idx, shotId)]) addQc(s, 'A-06', '__cis', SET.QC);
  }

  // ── 步②-b 审计级三条（S-20/S-21/S-25）：扫的是"整份报告的规则产出" ────────
  // 它们没有输入字段（依赖是 `__audit`），作用域是**整份报告**，不是"本镜"。
  // 所以**不进** `qcInvalidationSet`（那是"按镜 × 规则"的映射，把报告级规则塞进某个镜
  // 既失真、又会让 1000 镜的项目凭空多跑 3000 次），改为单独出口 `reportLevelRules`。
  //
  // **P9 必须消费的接口契约（U-P6-2）**：
  //   1. 触发条件：`reportLevelRules` 非空 ⇔ QIS 非空。双空时它一定是 `[]`，此时不得跑任何规则。
  //   2. 执行次数：**每次报告重建恰好一次**（用全量 `hits` 作 `ctx.__audit` 跑一条），
  //      **不得**按镜摊开执行 —— 审计规则扫的是"整份报告的命中集合"，摊开会让同一缺陷被计 N 次。
  //   3. 执行顺序：必须在本轮所有 `run`/`carried` 条目都落定之后（审计对象是它们的产出）。
  //   4. 不得 `carried`：它的输入是"本次全量 hits"，与历史报告无关，继承等于拿旧审计结论充当新结论。
  //   5. 输出形态：`string[]`，按 `cmpStr` 升序；元素都是 `SCOPE_OF[id] === 'audit'` 的 `rule_id`。
  //   6. 统计口径：审计规则自身的结果计入报告级 `level` 聚合，但**不进** `verifiable_ratio` 的分母
  //      （它们不是对被摄内容的检验），见 P5 报告 §8.5.3 的 U 桶说明。
  const reportLevelRules = qc.size ? [...AUDIT_SCOPE_IDS].sort(cmpStr) : [];
  if (reportLevelRules.length) {
    reasons.push({ field: '__audit', sceneKey: '', shotId: '', ruleId: '', set: SET.QC, scope: 'report' });
  }

  // ── 步③ 组装两个集合 ─────────────────────────────────────────────────
  // 被删镜没有报告可重建：即便保守地把"整场"算进 CIS，也不得给它产出 QIS 条目。
  const deleted = new Set(toArr(ch.shots_deleted).map((x) => str(x?.shot_id ?? x?.id)).filter(Boolean));
  for (const sceneKey of cis.keys()) {
    const bucket = cis.get(sceneKey);
    for (const id of [...bucket.ids]) if (deleted.has(id)) bucket.ids.delete(id);
    if (!bucket.ids.size) cis.delete(sceneKey);
  }
  for (const id of deleted) qc.delete(id);
  const continuityInvalidationSet = {};
  for (const sceneKey of [...cis.keys()].sort(cmpStr)) {
    const b = cis.get(sceneKey);
    const rows = (idx.byScene.get(sceneKey) ?? []).filter((s) => b.ids.has(s.id));
    const earliest = rows.slice().sort((x, y) => x.global_no - y.global_no || cmpStr(x.id, y.id))[0];
    continuityInvalidationSet[sceneKey] = {
      earliestShotId: earliest ? earliest.id : '',
      earliestGlobalNo: earliest ? earliest.global_no : null,
      shotIds: rows.map((s) => s.id).sort(cmpStr),
      ruleIds: [...SHOT_SCOPE_RULES, ...STATE_SCOPE_IDS].sort(cmpStr),
    };
  }

  const qcInvalidationSet = {};
  for (const shotId of [...qc.keys()].sort(cmpStr)) {
    const rules = [...qc.get(shotId)].sort(cmpStr);
    if (!rules.length) continue;
    qcInvalidationSet[shotId] = {
      rules,
      reason: reasons
        .filter((r) => r.shotId === shotId && r.ruleId)
        .map((r) => ({ field: r.field, set: r.set }))
        .filter((r, i, a) => a.findIndex((x) => x.field === r.field) === i),
    };
  }

  const bothEmpty = Object.keys(continuityInvalidationSet).length === 0 && Object.keys(qcInvalidationSet).length === 0;

  return {
    continuityInvalidationSet,
    qcInvalidationSet,
    // 报告级：本次报告需要整体重跑的审计规则（`S-20`/`S-21`/`S-25`），与 QIS 并列而非混入
    reportLevelRules,
    bothEmpty,
    reasons: dedupeReasons(reasons),
  };
}

function dedupeReasons(reasons) {
  const seen = new Set();
  const out = [];
  for (const r of reasons) {
    const k = `${r.set}|${r.field}|${r.sceneKey}|${r.shotId}|${r.ruleId}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(r);
  }
  out.sort((a, b) => cmpStr(a.set, b.set) || cmpStr(a.sceneKey, b.sceneKey) || cmpStr(a.shotId, b.shotId) || cmpStr(a.ruleId, b.ruleId) || cmpStr(a.field, b.field));
  return out;
}

/**
 * 四条关系的自检（§7.8.0 R-1~R-4），供测试与审计脚本调用。
 *
 * @param {object} plan
 * @param {string[]} [allShotIds] R-4 的"零写入"判据只需两个集合为空，此项可省
 * @returns {{ok:boolean, violations:string[]}}
 */
export function checkInvalidationRelations(plan, allShotIds) {
  const v = [];
  const cis = plan?.continuityInvalidationSet ?? {};
  const qis = plan?.qcInvalidationSet ?? {};
  const cisIds = Object.values(cis).flatMap((b) => b.shotIds ?? []);

  // R-1：CIS 非空 → QIS 必非空，且 CIS 内每镜含镜级 + 状态级全部规则
  if (cisIds.length && Object.keys(qis).length === 0) v.push('R-1：CIS 非空但 QIS 为空');
  for (const id of cisIds) {
    const rules = new Set(qis[id]?.rules ?? []);
    for (const rid of [...SHOT_SCOPE_RULES, ...STATE_SCOPE_IDS]) {
      if (!rules.has(rid)) v.push(`R-1：CIS 内 ${id} 缺规则 ${rid}`);
    }
  }
  // R-2：QIS 非空不蕴含 CIS 非空 —— 这是"允许"的关系，只作记录性断言（不得反过来强制）
  if (Object.keys(qis).length && !cisIds.length) {
    // 合法：QC-only 变化。此处不产生 violation。
  }
  // R-4：两集合都空 → 不求解、不重出、不写；`bothEmpty` 必须与两集合真实为空一致
  const empty = cisIds.length === 0 && Object.keys(qis).length === 0;
  if (Boolean(plan?.bothEmpty) !== empty) v.push('R-4：bothEmpty 与实际集合状态不一致');
  // 结构：QIS 的镜必须真实存在
  if (allShotIds) {
    const known = new Set(allShotIds.map(str));
    for (const id of Object.keys(qis)) if (!known.has(id)) v.push(`QIS 含不存在的镜 ${id}`);
    for (const id of cisIds) if (!known.has(id)) v.push(`CIS 含不存在的镜 ${id}`);
  }
  return { ok: v.length === 0, violations: v };
}

export const RULE_SCOPE_EXPORT = Object.freeze({ shot: SHOT_SCOPE_RULES, chapter: ['V-06', 'V-07', 'V-08'], neighbor: ['A-06'], state: STATE_SCOPE_IDS, audit: AUDIT_SCOPE_IDS });
