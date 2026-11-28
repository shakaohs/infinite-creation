// 生成输入指纹骨架（P10-A A-07 · D-30-09 v4 + D02-40 §5.2/§5.3）
//
// 本文件在阶段 A 只交付**结构与键集**：算法名、规范化 JSON、白名单投影、`seg-2` 组装。
// 真正把它接到渲染链（`prepareShotForRender` 内一次读取即定指纹、候选落库带 `input_hash`）
// 是阶段 D 的事（IMP-01~04 与 D-30-05/10）。**没接线之前不得对外宣称"过期判定已生效"。**
//
// 三条硬规则（D02-40 §5.3 H1~H6）：
//   1. 白名单**逐字段显式赋值**。禁止 `{...exec}`、禁止 `delete p.apiKey` ——
//      黑名单会让新增字段静默进指纹，指纹版本就再也对不上了。
//   2. 构造函数体内**不得读取 `apiKey`**：秘密进指纹 = 秘密进库（`input_hash` 是落库值）。
//   3. 新增字段默认**不进**；要进必须同时改白名单与 `SEG_INPUTHASH_ALGO`（升版本）。
//
// 语义边界（§5.7，不得松口）：`input_hash` 是「渲染时刻的段输入版本」，**不是**「模型输入
// 字节证明」。`covered` 是超集，只在 fallback 提示词路径下才真正成为模型输入。
import { createHash } from 'node:crypto';
import { cmpStr } from '../hash/cmp-str.js';

/** 段输入指纹算法版本。键集或规范化方式一改就必须升这里（旧指纹因此自然过期）。 */
export const SEG_INPUTHASH_ALGO = 'seg-2';

/** 提示词构建器版本（进指纹：同一段输入换了提示词模板，产物就不再等价）。 */
export const PROMPT_BUILD_VER = 'pb-1';

/** HashProjection 的顶层键（冻结列表，单测逐字比对；新增字段必须先改这里并升 algo 版本） */
export const HASH_PROJECTION_FIELDS = [
  'backend', 'provider', 'hardware', 'endpoint',
  'engine', 'specId', 'specKind', 'promptFormat', 'specSha256',
];

/** engine 子结构键（`engine` 为 null 时整块不出现） */
export const HASH_PROJECTION_ENGINE_FIELDS = [
  'id', 'family', 'model', 'baseUrlSha256', 'submitPath',
  'outputUrlPath', 'templateSha256', 'extraHeadersSha256', 'syncMode',
];

/** `covered` 条目的键（A 组 15 列 + 镜号/时长；`idx`/`chapter`/`scene_name`/`refs` 明确不进） */
export const COVERED_FIELDS = [
  'id', 'globalNo', 'duration', 'dialogue', 'narration', 'visual', 'camera',
  'subShots', 'blocking', 'characterIds', 'sceneIds', 'propIds', 'costumeIds', 'ageIds', 'audioIds',
];

/** `media` 条目的键 */
export const MEDIA_FIELDS = ['i', 'type', 'role', 'ref', 'sha256', 'bytes'];

/** `output` 条目的键 */
export const OUTPUT_FIELDS = ['resolution', 'workflowResolution', 'aspectRatio', 'width', 'height', 'scale'];

/**
 * 规范化 JSON：键按 `cmpStr` 升序、数组保持原序、无多余空白、不做 NFC 归一。
 * `undefined` 的键**不出现**（区别于显式 `''`/`null` —— 后者要如实写出来）。
 */
export function canonicalJson(value) {
  if (value === null) return 'null';
  const t = typeof value;
  if (t === 'number') {
    if (!Number.isFinite(value)) throw Object.assign(new Error('canonicalJson: 非有限数不能进指纹'), { code: 'BAD_JSON_VALUE' });
    return JSON.stringify(value);
  }
  if (t === 'boolean') return value ? 'true' : 'false';
  if (t === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map((v) => canonicalJson(v)).join(',') + ']';
  if (t === 'object') {
    const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort(cmpStr);
    return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalJson(value[k])).join(',') + '}';
  }
  throw Object.assign(new Error('canonicalJson: 不支持的值类型 ' + t), { code: 'BAD_JSON_VALUE' });
}

/** 白名单拷贝：只把 fields 里存在且非 undefined 的键搬过去（显式赋值，不 spread） */
function whitelist(obj, fields) {
  const out = {};
  if (!obj || typeof obj !== 'object') return out;
  for (const f of fields) {
    if (obj[f] !== undefined) out[f] = obj[f];
  }
  return out;
}

/**
 * `ExecConfig` → `HashProjection`（白名单投影）。
 * ExecConfig 有 21 个语义槽 + 后端判别 + 秘密；这里只取 9 个进指纹的槽与后端判别。
 * **本函数不读 `apiKey`**，也不接受它（传进来的对象里有没有都不影响结果）。
 */
export function hashProjectionOf(exec) {
  const e = exec || {};
  const out = {
    backend: e.backend,
    provider: e.provider,
    hardware: e.hardware,
    endpoint: e.endpoint,
    engine: null,
    specId: e.specId,
    specKind: e.specKind,
    promptFormat: e.promptFormat,
    specSha256: e.specSha256,
  };
  // engine 要么整块为 null（没有外接引擎），要么只带 9 个白名单键
  if (e.engine && typeof e.engine === 'object') {
    out.engine = whitelist(e.engine, HASH_PROJECTION_ENGINE_FIELDS);
  }
  // 去掉值为 undefined 的顶层键（"缺失键不出现"）
  for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k];
  return out;
}

const round1 = (n) => Math.round(Number(n || 0) * 10) / 10;

function mediaOf(list) {
  if (!Array.isArray(list)) return [];
  return list.map((m) => {
    const row = whitelist(m, MEDIA_FIELDS);
    // 缺失文件必须能表达出来（§5.4）：哨兵 'missing'，不能变成"这条不存在"
    if (row.sha256 === undefined) row.sha256 = 'missing';
    return row;
  });
}

function coveredOf(list) {
  if (!Array.isArray(list)) return [];
  return list
    .map((c) => whitelist(c, COVERED_FIELDS))
    .sort((a, b) => Number(a.globalNo || 0) - Number(b.globalNo || 0) || cmpStr(a.id, b.id));
}

/**
 * 段输入指纹：`seg-2:<64 hex>`。
 * @param {object} snapshot 一次读取得到的冻结快照
 *   { exec, prompt, promptBuild?, output, timing:{seconds}, mode, media[], covered[] }
 */
export function segmentInputHash(snapshot) {
  const s = snapshot || {};
  const body = {
    algo: SEG_INPUTHASH_ALGO,
    exec: hashProjectionOf(s.exec),
    promptBuild: s.promptBuild || PROMPT_BUILD_VER,
    prompt: String(s.prompt ?? ''),
    output: whitelist(s.output, OUTPUT_FIELDS),
    timing: { seconds: round1(s.timing && s.timing.seconds) },
    mode: String(s.mode ?? ''),
    media: mediaOf(s.media),
    covered: coveredOf(s.covered),
  };
  const hex = createHash('sha256').update(canonicalJson(body), 'utf8').digest('hex');
  return SEG_INPUTHASH_ALGO + ':' + hex;
}

/** 判断一个已落库的 `input_hash` 是否是本算法产出（阶段 D 的判定入口会用） */
export function isSegInputHash(v) {
  return typeof v === 'string' && /^seg-2:[0-9a-f]{64}$/.test(v);
}
