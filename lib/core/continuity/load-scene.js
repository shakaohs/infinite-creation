// P8 读取层：把一个场次的真实数据读成"求解输入原料"（**只读**，D02-20 R2/R6）
//
// 这一层只做三件事，且刻意只有这三件：
//  ① 从 `story_shots`（按 `global_no` 升序）+ 三张从表读出一场的全部镜头；
//  ② 把 TEXT 型的 JSON 列解析回对象/数组，并**校验形状**（`obj()`/`arr()` 对字符串一律返回空 ——
//     不解析等于把整列丢掉；只解析不校验，等于让 `[]` 冒充对象、让 `{}` 冒充数组）；
//  ③ 从 `scene_states` 取场次基线（复用 P2 的 `listSceneStates()`，不重写解析）。
//
// **不读 `shot_states`**：它是求解结果，不是输入。P8 本轮采用"整场重算"——状态链从场次基线开始
// 逐镜推出，不需要把上一轮结果当上下文喂回去；而一旦读进来，就很容易被"顺手"投影成
// `shots[].meta`（D02-16/17/18/19 反复堵的就是这条路）。所以这里连读都不读，
// 让"结果回搬"在数据层面就不可能发生（`stage3-p8-wiring` 有对应断言）。
//
// 读一致性：多条 SELECT 包在一个 `tx()` 里。`BEGIN`…`COMMIT` 只做读，不写库；
// 作用是让"镜头行 / 站位 / 动作 / 资产"来自同一个快照，避免读到"镜已建、站位还没写"的中间态。
import { getDb, tx } from '../db.js';
import { listSceneStates } from '../scene-state.js';
import { solveError } from './solver-error.js';

/** `story_shots` 里以 TEXT 存 JSON 的列（写入侧见 `render/global-no.js` 的 `JSON_COLUMNS`） */
const SHOT_JSON_ARRAY_COLS = Object.freeze(['speakers', 'time_slices', 'cam_path', 'voice_ids']);
/** `shot_blockings` 的数组列 */
const BLOCKING_JSON_ARRAY_COLS = Object.freeze(['position_track']);
/** `shot_actions` 的 JSON 列（`body_parts` 是数组，其余是对象） */
const ACTION_JSON_OBJ_COLS = Object.freeze([
  'init_state', 'trigger_json', 'path_json', 'force_json', 'speed_json', 'contact_json', 'result_json', 'end_state', 'sync_json',
]);
const ACTION_JSON_ARRAY_COLS = Object.freeze(['body_parts']);

/** 一个值的"形状"名。错误信息必须说清**读到了什么**，只写"不对"等于让人回去翻库 */
function shapeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v; // string / number / boolean / object / undefined
}

/** 记录定位串：表名 + 列名还不够，要能指到具体哪一条（镜头 id / 动作 id + 所属镜头） */
function locatorOf({ key, shot }) {
  const id = key === null || key === undefined || key === '' ? '(空 id)' : String(key);
  const parent = shot === null || shot === undefined || String(shot) === id ? '' : ` · 镜头 ${shot}`;
  return `记录 ${id}${parent}`;
}

/** 形状不符：统一走 `SCENE_INPUT_INVALID_SHAPE`，细节放 `reason` 之外的平铺字段供调用方取用 */
function invalidShape(meta, actual) {
  const { table, column, kind } = meta;
  const want = kind === 'array' ? '数组' : '对象';
  const extra = {
    reason: 'SCENE_INPUT_INVALID_SHAPE',
    table, column, key: meta.key, kind, actual,
  };
  if (meta.shot !== undefined) extra.shot = meta.shot;
  return solveError(
    `${table}.${column} 应为${want}，实际为 ${actual}（${locatorOf(meta)}）`,
    extra,
  );
}

/**
 * 解析并校验一个 TEXT 型 JSON 列。
 *
 * 两类失败**都必须抛**：
 *  · 语法坏（`'[{"from":0,'`）→ `SCENE_INPUT_INVALID_JSON`；
 *  · 语法好但形状错（对象列写 `'[]'`/`'"x"'`/`'42'`/`'true'`/`'null'`，数组列写 `'{}'`）→ `SCENE_INPUT_INVALID_SHAPE`。
 * 后者比前者更危险：`JSON.parse` 成功会让人以为"数据没问题"，但下游拿到的是
 * `[]` 或字符串，`.filter()`、`??`、属性读取全都会静默走空分支 —— 空输入算出空结论，
 * 看起来一切正常。所以形状必须是**契约**，不是"调用方自觉"。
 *
 * 缺省语义保持原样，且只针对**原始值**：`null` / `undefined` / `''` → `null`
 * （该列确实没有内容，由调用方补 `[]`/`{}`）。解析出来的 `null`（列里存的是文本 `'null'`）
 * 属于形状错误：对象必须是"非 null、非数组的对象"，数组必须是数组。
 *
 * @param {*} raw 数据库原值（字符串 / null / 已被上游解析过的数组或对象）
 * @param {{table:string, column:string, key:string, shot?:string, kind:'array'|'object'}} meta
 * @returns {Array|Object|null}
 */
export function parseJsonColumn(raw, meta) {
  const { table, column, key, kind } = meta;
  if (raw === null || raw === undefined || raw === '') return null;

  let v;
  if (typeof raw === 'object') {
    // 已被上游解析过（测试夹具或其它调用方）。**形状照样要校验**：
    // 直接放行等于把"这条是不是对象"交给调用方自觉，而 `typeof [] === 'object'`
    // 恰好会让数组冒充对象一路走到求解器里。
    v = raw;
  } else {
    try {
      v = JSON.parse(String(raw));
    } catch (e) {
      throw solveError(
        `${table}.${column} 不是合法 JSON（${locatorOf(meta)}，前 40 字符：${String(raw).slice(0, 40)}）`,
        { reason: 'SCENE_INPUT_INVALID_JSON', table, column, key },
      );
    }
  }

  if (kind === 'object') {
    // `v === null` 必须显式拒：`typeof null === 'object'` 且 `Array.isArray(null)` 为 false，
    // 少了这一个条件，JSON 文本 `'null'`（`JSON.stringify(null)` 的写法）会被当成合法对象放行。
    // 缺省语义只对**原始值** null / undefined / '' 生效（入口已拦），解析出来的 null 属于形状错误。
    if (v === null || typeof v !== 'object' || Array.isArray(v)) throw invalidShape(meta, shapeOf(v));
    return v;
  }
  if (!Array.isArray(v)) throw invalidShape(meta, shapeOf(v));
  return v;
}

/** `story_shots` 行 → 求解器镜头对象（不做任何"补默认值"） */
function toSolverShot(row) {
  const out = { ...row };
  for (const c of SHOT_JSON_ARRAY_COLS) {
    const v = parseJsonColumn(row[c], { table: 'story_shots', column: c, key: row.id, kind: 'array' });
    out[c] = v === null ? [] : v;
  }
  return out;
}

function toSolverBlocking(row) {
  const out = { ...row };
  for (const c of BLOCKING_JSON_ARRAY_COLS) {
    const v = parseJsonColumn(row[c], { table: 'shot_blockings', column: c, key: row.shot_id, kind: 'array' });
    out[c] = v === null ? [] : v;
  }
  return out;
}

function toSolverAction(row) {
  const out = { ...row };
  // 动作行有自己的 id，报错时只给动作 id 找不到它在哪一镜 —— 一并带上 `shot`
  const meta = (c, k) => ({ table: 'shot_actions', column: c, key: row.id, shot: row.shot_id, kind: k });
  for (const c of ACTION_JSON_OBJ_COLS) {
    const v = parseJsonColumn(row[c], meta(c, 'object'));
    out[c] = v === null ? {} : v;
    // 求解器读 `a.result_json ?? a.result`；给个同名别名让两套写法都能工作
    if (c === 'result_json') out.result = out[c];
    if (c === 'contact_json') out.contact = out[c];
  }
  for (const c of ACTION_JSON_ARRAY_COLS) {
    const v = parseJsonColumn(row[c], meta(c, 'array'));
    out[c] = v === null ? [] : v;
  }
  return out;
}

/**
 * 读一个场次的求解输入原料。
 *
 * @param {{projectId:string, sceneKey:string}} p
 * @returns {{sceneKey:string, rows:Array, sceneState:object|null, baselineMissing:boolean,
 *            shotCount:number, annotationSourceNote:string}}
 * @throws {Error} `CONTINUITY_SOLVER_FAILED`（`reason` 前缀 `SCENE_INPUT_*`）
 */
export function loadSceneInput({ projectId, sceneKey } = {}) {
  if (!projectId) throw solveError('loadSceneInput：缺少 projectId', { reason: 'SCENE_INPUT_PROJECT_REQUIRED' });
  const key = String(sceneKey ?? '').trim();
  if (!key) throw solveError('loadSceneInput：缺少 sceneKey（一次只解一场）', { reason: 'SCENE_INPUT_SCENE_REQUIRED' });

  return tx(() => {
    const db = getDb();
    // 权威序：`global_no` 升序（不是 shot_no / created_at / prev_shot_id，ORD-1）。
    // `id` 作为并列时的兜底，保证同一份库文件每次读出同样的顺序。
    const shotRows = db.prepare(
      'SELECT * FROM story_shots WHERE project_id = ? AND scene_key = ? ORDER BY global_no ASC, id ASC',
    ).all(projectId, key);

    // 三张从表跟着镜头的权威序取，避免"行序即顺序"的隐式依赖（AR-2 同口径）
    const blockRows = db.prepare(
      'SELECT b.* FROM shot_blockings b JOIN story_shots s ON s.id = b.shot_id'
      + ' WHERE s.project_id = ? AND s.scene_key = ? ORDER BY s.global_no ASC, b.character_id ASC',
    ).all(projectId, key);
    const actionRows = db.prepare(
      'SELECT a.* FROM shot_actions a JOIN story_shots s ON s.id = a.shot_id'
      + ' WHERE s.project_id = ? AND s.scene_key = ? ORDER BY s.global_no ASC, a.t_from ASC, a.id ASC',
    ).all(projectId, key);
    const assetRows = db.prepare(
      'SELECT x.* FROM shot_assets x JOIN story_shots s ON s.id = x.shot_id'
      + ' WHERE s.project_id = ? AND s.scene_key = ? ORDER BY s.global_no ASC, x.role ASC, x.order_no ASC, x.asset_id ASC',
    ).all(projectId, key);

    // 场次基线：复用 P2 的读回（它已做 JSON 解析与 incomplete 标记），按 scene_key 挑一条
    const sceneState = listSceneStates(projectId).find((r) => r.scene_key === key) ?? null;

    const groupBy = (list, keyOf, map) => {
      const m = new Map();
      for (const r of list) {
        const k = String(r[keyOf] ?? '');
        if (!m.has(k)) m.set(k, []);
        m.get(k).push(map(r));
      }
      return m;
    };
    const blocks = groupBy(blockRows, 'shot_id', toSolverBlocking);
    const actions = groupBy(actionRows, 'shot_id', toSolverAction);
    const assets = groupBy(assetRows, 'shot_id', (r) => ({ ...r }));

    const rows = shotRows.map((r) => ({
      ...toSolverShot(r),
      blockings: blocks.get(String(r.id)) ?? [],
      actions: actions.get(String(r.id)) ?? [],
      shotAssets: assets.get(String(r.id)) ?? [],
      // ⚠ 这里**不得**出现 `meta`：`assembleSolverShots()` 见到 `meta` 会整批拒绝（D02-19 R1），
      // 而 `story_shots` 本来也没有 `meta` 列 —— 两件事一起保证"结果不可能从读取层漏进来"。
    }));

    return {
      sceneKey: key,
      rows,
      sceneState,
      baselineMissing: sceneState === null,
      shotCount: rows.length,
      // 如实说明：当前库里没有"人工标注"的持久化位置（`shot_states.meta` 是结果，
      // 不是输入；新增标注表要 DDL，本轮禁止）。所以标注只能由调用方在请求里显式给出。
      annotationSourceNote: 'manual/adaptation 标注由调用方显式提供（annotations 参数），不从数据库读取',
    };
  });
}
