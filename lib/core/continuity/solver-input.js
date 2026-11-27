// 求解器输入契约（P8 组装层与 `solveContinuity` 共用的唯一入口）
//
// 这个模块回答一个问题：**什么可以进 `solveContinuity`，什么必须被挡在门外。**
//
// 判据来自 D02-17 的实测，而不是"看起来合理"：
//  · `rel` 会决定"沿用还是改写"——回搬一份 `rel:'known'` 能把 carried 变成写入；
//  · `src` 会决定 `originOf()` ——回搬 `carried:sh_99` 能伪造一个不存在的继承起点；
//  · `conf` 是 `conf × 0.9` 的衰减基数——回搬会把它换基（0.855 变 0.5），
//    于是"衰减了一次还是三次"再没人说得清。
// 三者都是真输入，所以**"只留 rel"是错的**（Hash 会漏掉另外两个真输入）。
// 真正的问题不是字段多少，而是**来源**：这三个字段在 `shot_states.meta` 里是求解结果，
// 在 `shots[].meta` 里却被当成输入。同一个 JSON、两种含义，这才是冲突的根。
//
// 因此本模块只做两件事：
//  ① 结构校验（`id` / `global_no` / `scene_key`）——缺一项就拒绝，不让它静默按 0 排序或跨场串链；
//  ② 来源校验（`src` 前缀）——求解器产出的 src 一律拒收，只接受 `manual:` 开头的输入标注。
import { solveError } from './solver-error.js';

/**
 * 输入标注的 `src` 前缀（**唯一**允许从 `shots[].meta` 进来的来源）。
 * 人工 / 适配层标注必须显式带上它，否则无法与求解结果区分。
 */
export const ANNOTATION_SRC_PREFIX = 'manual:';

/**
 * 求解器产出的 `src` 前缀。出现在 `shots[].meta` 里即为"结果回搬"，一律拒收。
 *
 * | 前缀 | 谁写的 | 含义 |
 * |---|---|---|
 * | `blocking:` | `applyField` 写值分支 | 取自本镜 `shot_blockings` |
 * | `carried:` | 沿用分支 | 沿用自某个起点镜 |
 * | `prev_shot:` | Step 1 版本戳 | 上一镜自己填的（非跨镜沿用） |
 * | `action:` | 动作覆盖 | 由动作 `result` 给出 |
 * | `rule:` | 无值占位 | `rule:no_value` |
 * | `scene_baseline` | 首镜基线 | 场次基线生成 |
 */
export const RESULT_SRC_PREFIXES = Object.freeze([
  'blocking:', 'carried:', 'prev_shot:', 'action:', 'rule:', 'scene_baseline',
]);

/** `src` 是否由求解器产出（→ 不得作为输入） */
export function isResultSrc(src) {
  const s = String(src ?? '');
  if (!s) return false;
  return RESULT_SRC_PREFIXES.some((p) => (p.endsWith(':') ? s.startsWith(p) : s === p));
}

/** 规范化后的 `src` 是否为合法的输入标注（缺省 = 未声明来源，按"裸标注"放行） */
export function isAnnotationSrc(src) {
  if (src === null || src === undefined || src === '') return true;
  return String(src).startsWith(ANNOTATION_SRC_PREFIX);
}

/**
 * 结构校验：元素形状 + `id` / `global_no` / `scene_key`。
 *
 * 顺序是刻意的（形状 → `id` → `global_no` → 重复号 → `scene_key`）：`{global_no: 1}` 这种
 * "只填了号"的坏输入应当先报"缺少 id"，而不是先报场次不符 —— 报错要指向最根本的缺失。
 *
 * **不得用 `filter()` 静默丢弃非法元素**（D02-18 R3）：一条 `null` 被丢掉，剩下三条照样
 * 求解成功，报告看起来完好，但缺的那一镜的下游继承链已经错了。宁可整批拒绝。
 *
 * @param {{shots:Array, sceneKey:string}} p
 * @throws {Error} `CONTINUITY_SOLVER_FAILED`，`reason` 区分 `SHOT_INPUT_INVALID` /
 *   `SHOT_ID_MISSING` / `SHOT_GLOBAL_NO_NOT_NUMBER` / `SHOT_GLOBAL_NO_INVALID` /
 *   `SHOT_GLOBAL_NO_DUPLICATED` / `SHOT_SCENE_MISMATCH`
 */
export function assertSolverInput({ shots, sceneKey } = {}) {
  if (!Array.isArray(shots)) return; // 数组校验在 solveContinuity 里先做，抛的是同码

  // ① 元素形状：必须是**普通对象**。`null` / 字符串 / 数组 / 函数混进来即整批拒绝。
  shots.forEach((s, i) => {
    if (!s || typeof s !== 'object' || Array.isArray(s)) {
      throw solveError(
        `shots[${i}] 不是镜头对象（收到 ${describeValue(s)}）；`
        + '非法元素不得被丢弃后继续求解 —— 少一镜会静默改变下游继承链',
        { reason: 'SHOT_INPUT_INVALID', index: i, received: describeValue(s) },
      );
    }
  });
  const rows = shots;

  // ② `id`：继承链、`carried:<id>` 追溯、QIS 定位全靠它
  for (const s of rows) {
    if (!s.id) {
      throw solveError('镜头缺少 id', { reason: 'SHOT_ID_MISSING' });
    }
  }

  // ②-b `id` 唯一性（D02-19 R2）：`states` 以 id 为键，重复 id 会让后一镜**覆盖**前一镜，
  // 于是"少了一镜"却没有任何报错 —— 与 R3 的 `filter` 丢弃是同一类静默失真。
  assertUniqueShotIds(rows);

  // ③ `global_no`：**必须是正整数**（D02-18 R2 契约）
  //
  // | 输入 | 结论 | 理由 |
  // |---|---|---|
  // | `1` / `99` | 接受 | DDL `INTEGER NOT NULL` + `uq_ss_gn(project_id, global_no)` |
  // | `0` / `-3` | 拒绝 | 权威序从 1 起；0 会被当成"缺失"的兜底值 |
  // | `1.5` | 拒绝 | 小数让"第 2 镜"没有定义，且 `sort` 结果依赖浮点比较 |
  // | `null` / `''` / `undefined` | 拒绝 | 会被 `?? 0` 静默排到最前 |
  // | `'3'`（数字字符串） | **拒绝**（求解器层） | 类型契约统一为 number；字符串由组装层
  //   `assembleSolverShots()` 规范化后再进来（`normalizeGlobalNo`）。两层各让一步，
  //   就会出现"某个调用方传串也能过"，于是没人说得清哪层负责 |
  for (const s of rows) {
    const raw = s.global_no;
    if (raw === null || raw === undefined) {
      // 缺失单独一档：它最容易被 `?? 0` 兜底成"第 0 镜"，危害与"非法值"同，但原因更根本
      throw solveError(
        `镜头 ${s.id} 缺少 global_no；缺失时会被静默按 0 排到最前，整条继承链的顺序随之失真`,
        { reason: 'SHOT_GLOBAL_NO_INVALID', shot_id: String(s.id), received: 'missing' },
      );
    }
    if (typeof raw !== 'number') {
      throw solveError(
        `镜头 ${s.id} 的 global_no 必须是数字（收到 ${describeValue(raw)}）；`
        + '数字字符串请先在组装层用 normalizeGlobalNo() 规范化',
        { reason: 'SHOT_GLOBAL_NO_NOT_NUMBER', shot_id: String(s.id), received: describeValue(raw) },
      );
    }
    // 缺失时 `sort` 会用 `?? 0` 把它排到最前 —— 等于静默改变整条链的顺序，必须拦
    if (!Number.isInteger(raw) || raw < 1) {
      throw solveError(
        `镜头 ${s.id} 的 global_no 必须是正整数（收到 ${JSON.stringify(raw)}）；`
        + '0/负数会被静默排到最前，小数让"第几镜"失去定义，整条继承链的顺序随之失真',
        { reason: 'SHOT_GLOBAL_NO_INVALID', shot_id: String(s.id) },
      );
    }
  }

  // ④ 同一批次内 `global_no` 不得重复：DDL 有 `uq_ss_gn(project_id, global_no)`，
  //    能出现重复只说明调用方传的是**拼接出来的临时集**（真实库不可能有）。
  //    重复时 `sort` 的次序由 `cmpStr(id)` 兜底 —— 那是"稳定但无意义"的序。
  const byNo = new Map();
  for (const s of rows) {
    const k = String(s.global_no);
    if (!byNo.has(k)) byNo.set(k, []);
    byNo.get(k).push(String(s.id));
  }
  const dup = [...byNo.entries()].filter(([, ids]) => ids.length > 1);
  if (dup.length) {
    throw solveError(
      `同一求解批次内 global_no 重复：${dup.slice(0, 3).map(([n, ids]) => `${n}→${ids.join('/')}`).join('，')}；`
      + '重复号的先后由 id 字典序兜底，等于让"第几镜"由 id 决定',
      { reason: 'SHOT_GLOBAL_NO_DUPLICATED', duplicated: dup.map(([n, ids]) => ({ global_no: Number(n), shot_ids: ids })) },
    );
  }

  // ⑤ 场次：求解器**不按 scene_key 过滤**（D01-04 §5.5 要求前镜同场），混传会静默跨场串链
  const badScene = rows.filter((s) => String(s.scene_key ?? '') !== String(sceneKey ?? '')).map((s) => String(s.id));
  if (badScene.length) {
    throw solveError(
      `有 ${badScene.length} 个镜头不属于场次 ${JSON.stringify(sceneKey)}：${badScene.slice(0, 5).join(',')}；`
      + '求解器不按 scene_key 过滤，混传会静默跨场串链',
      { reason: 'SHOT_SCENE_MISMATCH', shot_ids: badScene },
    );
  }
}

/** 报错里用的值描述（`typeof null === 'object'` 这类坑不留给读错误信息的人） */
function describeValue(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return `array(${v.length})`;
  if (typeof v === 'string') return `string ${JSON.stringify(v.slice(0, 20))}`;
  if (typeof v === 'object') return 'object';
  return `${typeof v} ${String(v)}`;
}

/**
 * 镜头 `id` 唯一性（组装层与求解器共用的**同一份**判据，D02-19 R2）。
 *
 * 为什么必须单独校验、且不能靠 `Map` / 对象键：求解器输出 `states` 是 `{ [shotId]: state }`，
 * 重复 id 时后写覆盖前写，结果"看着完整"但少了一镜；`annotations` 按 id 查找同理会张冠李戴。
 * 这类失真的共同特征是**不报错**，所以只有显式拒绝才拦得住。
 *
 * @param {Array} rows 已通过形状校验的镜头数组
 * @throws {Error} `SHOT_ID_DUPLICATED`
 */
export function assertUniqueShotIds(rows = []) {
  const seen = new Map();
  for (const s of rows) {
    const id = String(s.id);
    if (!seen.has(id)) seen.set(id, 0);
    seen.set(id, seen.get(id) + 1);
  }
  const dup = [...seen.entries()].filter(([, n]) => n > 1).map(([id]) => id);
  if (dup.length) {
    throw solveError(
      `同一批次内镜头 id 重复：${dup.slice(0, 5).join(',')}；`
      + 'states 以 id 为键，重复会让后一镜覆盖前一镜（结果看着完整，实际少一镜）',
      { reason: 'SHOT_ID_DUPLICATED', shot_ids: dup },
    );
  }
}

/**
 * 来源校验：`shots[].meta` 只接受输入标注，不接受求解结果回搬。
 *
 * `state_in` 那种"整份状态行"是最典型的误用：它同时带 `rel/src/conf`，
 * 一旦原样塞进来，值会被改写、继承链起点会被伪造、置信度会被换基（见文件头）。
 *
 * @param {string} shotId
 * @param {object} seed 已 `normalizeShotMeta` 归一化的输入标注
 * @throws {Error} `CONTINUITY_SOLVER_FAILED`，`reason = 'META_IS_RESULT_FEEDBACK'`
 */
export function assertAnnotationOnly(shotId, seed = {}) {
  for (const key of Object.keys(seed)) {
    const src = seed[key]?.src;
    if (isResultSrc(src)) {
      throw solveError(
        `镜头 ${shotId} 的 shots[].meta.${key} 带求解结果来源 src=${JSON.stringify(src)}；`
        + 'shots[].meta 只接受输入标注（src 以 manual: 开头或缺省），'
        + '不得把 shot_states.meta 整体回搬（D02-17 §四）',
        { reason: 'META_IS_RESULT_FEEDBACK', shot_id: String(shotId), field: key },
      );
    }
    if (!isAnnotationSrc(src)) {
      throw solveError(
        `镜头 ${shotId} 的 shots[].meta.${key} 的 src=${JSON.stringify(src)} 不是可识别的输入来源；`
        + `输入标注必须以 ${ANNOTATION_SRC_PREFIX} 开头`,
        { reason: 'META_SRC_UNKNOWN', shot_id: String(shotId), field: key },
      );
    }
  }
}
