// 写者身份与字段组权限（P10-A 阶段 C · C-03 / C-04）
//
// D02-40 §4.1 把 `shots` 的 35 列分成五组；§4.2 规定「哪个 writer 能写哪几组」。
// 本模块是这套矩阵的**唯一实现**，`Shots.*` 与 `legacyShotWrite` 都只调它，不再各自判。
//
// 为什么需要「写者身份」而不是只看 source 字符串：
//   `withWriteContext(source, fn)` 里的 source 是**审计标签**（'PATCH /api/...'），谁都能随便传。
//   用它当授权凭据等于「填个字符串就能写」——D02-40 §4.4 规则 6 明确禁止。
//   所以 writer 走独立通道（AsyncLocalStorage），只由 `withWriter` / `legacyShotWrite` 设置，
//   并且**没有任何默认值**：取不到就抛，不回落 creative（§4.4 规则 1）。
import { AsyncLocalStorage } from 'node:async_hooks';

/** 三个正式 writer（D02-40 §4.2）。顺序即报告里的列顺序。 */
export const WRITERS = Object.freeze(['creative', 'render', 'system']);

/** D02-40 §4.1 字段分组，逐字。`references` 是 `refs` 的 JS 别名，见 COLUMN_OF。 */
export const SHOT_GROUPS = Object.freeze({
  A: Object.freeze([
    'idx', 'chapter', 'scene_name', 'camera', 'visual', 'dialogue', 'narration', 'sub_shots', 'blocking',
    'duration', 'character_ids', 'scene_ids', 'prop_ids', 'costume_ids', 'age_ids', 'audio_ids', 'refs',
  ]),
  B: Object.freeze(['video_prompt', 'mode', 'first_frame_path', 'last_frame_path', 'reference_image_path']),
  C: Object.freeze(['video_prompt_used', 'video_path', 'seed', 'status', 'error', 'prompt_id']),
  D: Object.freeze(['id', 'project_id', 'created_at', 'updated_at']),
  E: Object.freeze(['resolution', 'aspect_ratio', 'parent_shot_id']),
});

/** JS 字段名 → 数据库列名。目前只有一处别名（`references` ↔ `refs`）。 */
export const COLUMN_OF = Object.freeze({ references: 'refs' });

const FIELD_GROUP = new Map();
for (const g of ['A', 'B', 'C', 'D', 'E']) {
  for (const f of SHOT_GROUPS[g]) FIELD_GROUP.set(f, g);
}
FIELD_GROUP.set('references', 'A');   // 别名与 refs 同组

/** 字段属于哪一组；未知字段返回 null（未知即拒绝，不静默丢）。 */
export function groupOfShotField(field) {
  return FIELD_GROUP.get(String(field)) || null;
}

/**
 * §4.2 矩阵：writer × 组。
 * `creative` 的 A/B 两格在结构化项目上另有约束（见 assertShotWrite），本表只表达 writer 维度。
 */
export const WRITER_GROUPS = Object.freeze({
  creative: Object.freeze({ A: true, B: true, C: false, D: true, E: false }),
  render: Object.freeze({ A: false, B: false, C: true, D: true, E: false }),
  system: Object.freeze({ A: false, B: false, C: false, D: true, E: true }),
});

function writerError(code, message, detail) {
  const e = new Error(message);
  e.code = code;
  if (detail) e.detail = detail;
  return e;
}

export function assertWriterName(writer) {
  if (!writer) throw writerError('WRITER_REQUIRED', '写入必须显式指定 writer（creative / render / system），不接受默认值');
  const w = String(writer);
  if (!WRITERS.includes(w)) {
    throw writerError('WRITER_INVALID', `未知 writer：${w}（只允许 ${WRITERS.join(' / ')}）`, { writer: w });
  }
  return w;
}

// ── writer 上下文（ALS）────────────────────────────────────────────────────
const als = new AsyncLocalStorage();

/** 在指定 writer 下执行；嵌套时内层覆盖外层（投影/参数入口各自显式声明）。 */
export function withWriter(writer, fn) {
  assertWriterName(writer);
  return als.run({ writer: String(writer) }, fn);
}

/** 当前 writer；事务外或未声明时为 null（调用方必须自己 fail-closed）。 */
export function currentWriter() {
  const s = als.getStore();
  return s ? s.writer : null;
}

/**
 * 字段级放行判断（唯一判据）。
 *
 * @param {{writer:string, structured:boolean, fields:string[], op:'create'|'update'|'insertAt'}} p
 * @returns {{write:string[], skip:string[]}}  write=允许写、skip=值为 undefined 需跳过（由调用方过滤）
 * @throws WRITER_* / SHOT_FIELD_UNKNOWN / SHOT_FIELD_DENIED / STRUCTURED_LEGACY_WRITE_FORBIDDEN / STRUCTURED_PARAM_WRITE_REQUIRED
 */
export function assertShotWrite({ writer, structured, fields, op }) {
  const w = assertWriterName(writer);
  const allow = WRITER_GROUPS[w];
  const write = [];
  for (const f of fields) {
    const g = groupOfShotField(f);
    if (!g) {
      throw writerError('SHOT_FIELD_UNKNOWN', `shots 没有字段 ${f}（拼错或越权都按未知处理）`, { field: f, writer: w });
    }
    // 结构化项目的 A/B 组一律拒绝：A 转 Stage 3、B 转参数入口（§4.3）
    if (structured && (g === 'A' || g === 'B')) {
      if (op === 'create' || op === 'insertAt') {
        throw writerError('STRUCTURED_LEGACY_WRITE_FORBIDDEN',
          `结构化项目不允许通过 legacy 入口写 ${f}（段行只由投影建立）`, { field: f, group: g, op });
      }
      if (g === 'B') {
        throw writerError('STRUCTURED_PARAM_WRITE_REQUIRED',
          `结构化项目的段级生成参数（${f}）必须走 ShotParams.update`, { field: f, group: g });
      }
      throw writerError('STRUCTURED_LEGACY_WRITE_FORBIDDEN',
        `结构化项目的创作字段（${f}）必须走 Stage 3 写入入口，不得经 legacy shots`, { field: f, group: g });
    }
    if (!allow[g]) {
      throw writerError('SHOT_FIELD_DENIED',
        `writer=${w} 无权写 ${f}（属 ${g} 组；${w} 允许的组：${Object.keys(allow).filter((k) => allow[k]).join('/')}）`,
        { field: f, group: g, writer: w });
    }
    // D 组只有 updated_at 可写（id/project_id/created_at 由服务层掌管，任何 writer 都不接受）
    if (g === 'D' && f !== 'updated_at') {
      throw writerError('SHOT_FIELD_DENIED', `${f} 由服务层掌管，不接受外部写入`, { field: f, group: 'D', writer: w });
    }
    write.push(f);
  }
  return { write };
}
