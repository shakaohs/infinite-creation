// P8 组装层：求解输入的唯一构造入口（**来源隔离**，D02-18 R1）
//
// 求解器那层只能做"第二道防线"：它看到的是 `shots[].meta`，而 `{rel:'known'}` 这种裸标注
// 究竟来自"人工看了画面标的"还是"从 `shot_states.meta` 抠出来的历史结果"，**从对象本身
// 分辨不出来**。同一个 JSON、两种含义 —— 这正是 D02-16 里那条假失效的根。
//
// 所以来源隔离必须发生在**组装层**，且必须靠"调用方必须自报来源"来实现：
//  · 组装层不接受"一坨 meta"，只接受「某镜 + 某来源 + 若干条字段断言」；
//  · 来源必须是白名单里的 `manual` / `adaptation`；`shot_states` / `solver` / `carried`
//    这类"结果侧"标签一律拒收，且**在字段校验之前**就拒 —— 否则扣掉 `src` 的投影就能混过去；
//  · 每条断言只允许 `rel`：`conf` / `ver` 是求解器算出来的，人工标注没有这两个字段；
//  · 组装后统一盖上 `src='manual:<source>'`，于是"裸标注"在进求解器前就不存在了。
//
// 这套隔离的边界要如实写清：它拦得住**从结果投影**（因为投影方必须自报 `shot_states`），
// 拦不住"有人手抄一份 rel 却谎报 manual"。后者无解，除非给 meta 加 `origin` 位（要 DDL，禁止）。
import { solveError } from './solver-error.js';
import { assertSolverInput, isResultSrc, ANNOTATION_SRC_PREFIX } from './solver-input.js';

/** 允许作为输入标注来源的标签（人工确认 / 适配层规则） */
export const ANNOTATION_SOURCES = Object.freeze(['manual', 'adaptation']);

/**
 * 结果侧标签：出现即拒。列全是为了让报错说得出"你从哪抄的"，
 * 而不是笼统一句"来源非法"。
 */
export const RESULT_SIDE_SOURCES = Object.freeze([
  'shot_states', 'shot_state', 'state', 'state_in', 'state_out',
  'solver', 'solve', 'continuity', 'solved', 'carried', 'qc', 'report',
]);

/** 合法可靠性取值（D01-04 §5.3 四值，不多不少） */
export const ANNOTATION_REL_VALUES = Object.freeze(['known', 'inferred', 'unknown', 'not_applicable']);

/** 允许的字段根（与 `shot_states` 的状态树同构；不是自由 JSON） */
const FIELD_ROOTS = Object.freeze(['chars', 'props', 'costumes', 'env']);

/** 结果侧字段：人工标注不该有这些键 */
const RESULT_SIDE_FIELDS = Object.freeze(['conf', 'ver', 'src']);

/**
 * 校验来源标签。
 *
 * @param {string} source
 * @throws {Error} `ANNOTATION_SOURCE_MISSING` / `ANNOTATION_SOURCE_IS_RESULT` / `ANNOTATION_SOURCE_UNKNOWN`
 */
export function assertAnnotationSource(source) {
  const s = String(source ?? '').trim();
  if (!s) {
    throw solveError(
      '组装输入标注时必须声明来源（manual / adaptation）；'
      + '不声明就无法与 shot_states.meta 的历史结果区分',
      { reason: 'ANNOTATION_SOURCE_MISSING' },
    );
  }
  if (RESULT_SIDE_SOURCES.includes(s)) {
    throw solveError(
      `输入标注来源 ${JSON.stringify(s)} 属于求解结果侧；`
      + '不得从 shot_states.meta 读取并投影到 shots[].meta（哪怕只取 rel / 只取 conf）',
      { reason: 'ANNOTATION_SOURCE_IS_RESULT', source: s },
    );
  }
  if (!ANNOTATION_SOURCES.includes(s)) {
    throw solveError(
      `输入标注来源 ${JSON.stringify(s)} 不在白名单内（${ANNOTATION_SOURCES.join(' / ')}）`,
      { reason: 'ANNOTATION_SOURCE_UNKNOWN', source: s },
    );
  }
  return s;
}

/**
 * 构造单镜的 `shots[].meta`（输入标注）。
 *
 * @param {{shotId:string, source:string, entries:object}} p
 *   `entries` 形如 `{ 'chars.c1.pos': { rel: 'unknown' } }`；
 *   也接受数组形式 `[{ field: 'chars.c1.pos', rel: 'unknown' }]`。
 * @returns {object} 归一化的 meta，每条都带 `src='manual:<source>'`
 * @throws {Error} `CONTINUITY_SOLVER_FAILED`，`reason` 见各分支
 */
export function buildShotAnnotations({ shotId, source, entries } = {}) {
  const src = assertAnnotationSource(source);
  const id = String(shotId ?? '');
  if (!id) {
    throw solveError('buildShotAnnotations：缺少 shotId', { reason: 'ANNOTATION_SHOT_MISSING' });
  }

  const pairs = Array.isArray(entries)
    ? entries.map((e) => [String(e?.field ?? ''), e ?? {}])
    : Object.entries(entries && typeof entries === 'object' ? entries : {});

  const out = {};
  for (const [field, raw] of pairs) {
    if (!isAnnotationField(field)) {
      throw solveError(
        `镜头 ${id} 的标注字段 ${JSON.stringify(field)} 不是状态字段路径；`
        + `必须以 ${FIELD_ROOTS.join(' / ')} 开头`,
        { reason: 'ANNOTATION_FIELD_INVALID', shot_id: id, field },
      );
    }
    const entry = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    const carried = RESULT_SIDE_FIELDS.filter((f) => entry[f] !== undefined && entry[f] !== null && entry[f] !== '');
    if (carried.length) {
      // `conf`/`ver` 是求解器算的，`src` 若带结果前缀更不用说 —— 一条人工断言不该有这三样
      throw solveError(
        `镜头 ${id} 的标注 ${field} 带了结果侧字段 ${carried.join('/')}；`
        + '人工标注只描述可靠性（rel），置信度与来源版本由求解器生成',
        { reason: 'ANNOTATION_CARRIES_RESULT_FIELDS', shot_id: id, field, fields: carried },
      );
    }
    const rel = String(entry.rel ?? '').trim();
    if (!rel) {
      throw solveError(
        `镜头 ${id} 的标注 ${field} 缺少 rel；`
        + '只给 conf 说明这是从结果里抠出来的（人工标注没有置信度可给）',
        { reason: 'ANNOTATION_REL_REQUIRED', shot_id: id, field },
      );
    }
    if (!ANNOTATION_REL_VALUES.includes(rel)) {
      throw solveError(
        `镜头 ${id} 的标注 ${field} 的 rel=${JSON.stringify(rel)} 不合法（${ANNOTATION_REL_VALUES.join(' / ')}）`,
        { reason: 'ANNOTATION_REL_INVALID', shot_id: id, field },
      );
    }
    out[field] = { rel, src: `${ANNOTATION_SRC_PREFIX}${src}` };
  }

  // 兜底：万一将来有人给 buildShotAnnotations 加旁路，求解器的第二道防线仍要过
  for (const [field, entry] of Object.entries(out)) {
    if (isResultSrc(entry.src)) {
      throw solveError(
        `镜头 ${id} 的标注 ${field} 来源 ${JSON.stringify(entry.src)} 属求解结果`,
        { reason: 'META_IS_RESULT_FEEDBACK', shot_id: id, field },
      );
    }
  }
  return out;
}

/**
 * `global_no` 规范化（R2：**字符串只在组装层被接受一次**）。
 *
 * 求解器要求 `number` 且为正整数；这里负责把"从 JSON / CSV / 前端来的数字字符串"转成数字，
 * 其余一律拒。允许 `'3'` 但拒绝 `'03'` / `' 3'` / `'3.0'`：能通过的形态只有一种，
 * 就不会出现"同一批数据里两种写法都合法、排序却不一样"。
 *
 * @param {*} v
 * @param {string} shotId
 * @returns {number}
 */
export function normalizeGlobalNo(v, shotId = '') {
  if (typeof v === 'number') {
    if (Number.isInteger(v) && v >= 1) return v;
    throw solveError(
      `镜头 ${shotId || '?'} 的 global_no 必须是正整数（收到 ${JSON.stringify(v)}）`,
      { reason: 'SHOT_GLOBAL_NO_INVALID', shot_id: String(shotId) },
    );
  }
  if (typeof v === 'string' && /^[1-9]\d*$/.test(v)) {
    const n = Number(v);
    if (Number.isSafeInteger(n)) return n;
  }
  throw solveError(
    `镜头 ${shotId || '?'} 的 global_no 不是可规范化的正整数（收到 ${JSON.stringify(v)}）；`
    + '只接受 number 或无前导零的十进制字符串',
    { reason: typeof v === 'string' ? 'SHOT_GLOBAL_NO_INVALID' : 'SHOT_GLOBAL_NO_NOT_NUMBER', shot_id: String(shotId) },
  );
}

/**
 * 组装一整批求解输入（**P8 唯一应该调用的入口**）。
 *
 * 输入只收"镜头行 + 分镜级的输入标注"，**不收任何形式的 `shot_states.meta` blob**：
 * 想从结果里投影，就必须给 `source` 填 `shot_states`，而那一栏会被拒。
 *
 * @param {{projectId?:string, sceneKey:string, rows:Array, annotations?:Object}} p
 *   `annotations`：`{ [shotId]: { source: 'manual'|'adaptation', entries: {...} } }`
 * @returns {{shots:Array, annotatedShotIds:string[]}}
 * @throws {Error} `CONTINUITY_SOLVER_FAILED`
 */
export function assembleSolverShots({ projectId, sceneKey, rows, annotations } = {}) {
  if (!Array.isArray(rows)) {
    throw solveError('assembleSolverShots：rows 必须是数组', { reason: 'SHOT_INPUT_INVALID' });
  }
  rows.forEach((r, i) => {
    if (!r || typeof r !== 'object' || Array.isArray(r)) {
      throw solveError(
        `rows[${i}] 不是镜头行；组装层同样不得丢弃非法元素（少一镜会静默改变下游继承链）`,
        { reason: 'SHOT_INPUT_INVALID', index: i },
      );
    }
  });

  const ann = annotations && typeof annotations === 'object' ? annotations : {};
  const knownIds = new Set(rows.map((r) => String(r.id ?? '')));
  // 标注挂在不存在的镜上 → 一定是"镜 ID 对不上"（改号、删镜、投影错了批次）。
  // 静默丢弃会让标注消失而无人察觉，所以拒绝。
  const orphan = Object.keys(ann).filter((id) => !knownIds.has(id));
  if (orphan.length) {
    throw solveError(
      `以下标注找不到对应的镜：${orphan.slice(0, 5).join(',')}；`
      + '标注被静默丢弃时，求解结果会"正常"但少了本该生效的可靠性断言',
      { reason: 'ANNOTATION_SHOT_NOT_FOUND', shot_ids: orphan },
    );
  }

  const shots = rows.map((row) => {
    const id = String(row.id ?? '');
    const next = {
      ...row,
      // 不修改入参：`global_no` 规范化后写进副本
      global_no: normalizeGlobalNo(row.global_no, id),
    };
    const a = ann[id];
    if (a) {
      next.meta = buildShotAnnotations({ shotId: id, source: a.source, entries: a.entries });
    }
    return next;
  });

  // 最后一道：结构/排序/场次契约（与求解器同一个门，组装层先撞上就是组装层的错）
  assertSolverInput({ shots, sceneKey });

  return { shots, annotatedShotIds: Object.keys(ann).sort() };
}

function isAnnotationField(field) {
  if (!field || typeof field !== 'string') return false;
  const root = field.split('.')[0];
  return FIELD_ROOTS.includes(root) && field.split('.').length >= 2;
}
