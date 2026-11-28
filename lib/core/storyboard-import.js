// 分镜表批量导入：把「人写好的分镜表」（Markdown 表格 / CSV / TSV / JSON）解析成项目分镜，
// 并把表里的角色/场景/道具/服装/年龄/音频名字**解析成真实资产 id**（不中时可自动建资产）。
//
// 设计要点：
// 1. 解析层与写入层分离：parseStoryboardTable() 只产出「规范化行」，方便 dry-run 预览；
//    resolveRows() 才碰数据库（资产匹配/创建），writeShots() 才落分镜。
// 2. 一「行」= 一「分镜」。镜号列有就用，没有就按出现顺序自动编号（章内从 1 起）。
// 3. 资产引用按「列」判断分类，不猜：角色列只匹配 character、场景资产列只匹配 scene……，
//    同名跨类（同名的人和道具）不会互相串。
// 4. 匹配策略三级：规范化全等 → 去括号/标点后全等 → 双向包含（唯一命中才算），都不中才报 missing。
//    宁可报 missing 也不乱绑——绑错资产会让整集参考图挂错人。
import fs from 'node:fs';
// C-03：四个 Shots 方法已要求显式 writer，旧导入路径统一经兼容包装器（writer=creative）。
import { legacyShotWrite } from './shot-write.js';
import path from 'node:path';
import { Assets, Shots, Chapters, Projects, tx } from './db.js';
import { projectDir } from './config.js';
import { pickShotFields, validateShotContent, shotDurationMax } from './shot-write.js';
import { normalizeName } from '../shared/index.js';
import { ensureScriptAssets } from './script-assets.js';

// —— 列名别名表（中文优先，英文兜底）——
const COLUMN_ALIASES = {
  idx: ['段号', '镜号', '分镜号', '镜头号', '编号', '序号', '镜', 'idx', 'shot', 'no', 'number'],
  duration: ['时长', '时长(秒)', '时长（秒）', '秒数', '秒', 'duration', 'seconds', 'sec'],
  scene_name: ['场次', '场次名', '场景名', '场景标题', '场', 'scene_name', 'scene title'],
  // 机位是多列拼出来的：景别 + 焦段 + 运动（专业分镜表的标准拆法，一列只写一个参数）。
  // 只认其中一列会丢掉焦段/运镜，写出来的提示词就没有镜头语言了。
  camera: ['主镜五要素', '景别', '机位', '运镜', '镜头', '景别/机位', '镜头语言', '镜头描述', 'camera', 'shot size', '焦段', '焦段(mm)', '焦距', '运动', '镜头运动', '机位角度', '角度'],
  // 画面同理：起始画面 / 表演动作 / 结束画面 是同一次运镜的首中尾三态，拆开成三列很常见。
  // 光影/色调/状态 是老李九字段里的独立列，框架没有对应栏位 —— 并进 visual（第二段起带原列名），
  // 投喂阶段的【画幅风格】【音效】栏就是从这里取源的（丢了只能让模型自选光色）。
  visual: ['画面', '画面内容', '内容', '描述', '画面描述', '动作', '动作描述', 'visual', 'description', 'action',
    '起始画面', '起幅', '表演动作', '表演', '结束画面', '落幅', '画面细节',
    '光影', '光线', '光位', '色调', '色彩', '色温', '状态', '进镜出镜', '重音', '人声'],
  dialogue: ['台词', '对白', '对话', '台词/对白', 'dialogue', 'lines'],
  narration: ['旁白', '解说', '画外音', 'narration', 'vo', 'voiceover'],
  sub_shots: ['子镜时间轴', '时间轴', '细分镜', '切点', '分镜时间轴', 'sub_shots', 'timeline', 'beats'],
  // 段首站位声明（老李 model-adapters.md §5.0 的「方位唯一权威」）。
  // 分镜表里带这一列时原样落库，投喂阶段直接沿用；不带就只能让模型从画面自行推断——那正是越轴来源。
  blocking: ['段首站位与轴线', '段首站位', '站位声明', '站位表', '站位', '轴线锁定', '轴线', 'blocking'],
  characters: ['角色', '人物', '出场人物', '人物名', '演员', 'characters', 'cast', 'character'],
  scenes: ['场景', '场景资产', '环境', '场地', '地点', 'scenes', 'scene', 'location'],
  props: ['道具', '物件', '道具/物件', 'props', 'prop'],
  costumes: ['服装', '造型', '服饰', 'costume', 'costumes', 'outfit'],
  ages: ['年龄', '时期', '年龄段', 'age', 'ages'],
  audios: ['音频', '音色', '音乐', 'audio', 'audios', 'bgm'],
  // 分镜表里的「声音 / 音效」列是音效/环境音描述，不是音频资产——单独收，后面并进画面尾巴，
  // 让提示词阶段【音效】栏拿到现场声线索（放 audios 会被当成音色资产名去匹配，必然匹配失败）。
  sfx: ['声音', '音效', '音效描述', '环境音', '现场声', 'sfx', 'sound'],
};

// 同一字段被多列命中时的拼接规则：camera 用「·」平铺（本来就是并列参数），
// visual 用「；」并在第二段起带原列名（首/中/尾三态必须能看出是哪一态）。
const JOIN_RULES = {
  camera: { sep: ' · ', label: false },
  visual: { sep: '；', label: true },
};


// 分类 → 资产 category；同一「列」只匹配这一类
const COLUMN_ASSET_CATEGORY = {
  characters: 'character',
  scenes: 'scene',
  props: 'prop',
  costumes: 'costume',
  ages: 'age',
  audios: null, // 音频跨 voice/music/sfx 三类，单独处理
};
const ASSET_ID_FIELD = {
  character: 'character_ids',
  scene: 'scene_ids',
  prop: 'prop_ids',
  costume: 'costume_ids',
  age: 'age_ids',
};

function normHeader(h) {
  return String(h || '')
    .replace(/[*_`]/g, '')
    .replace(/[（(][^）)]*[）)]/g, '')
    .replace(/\s+/g, '')
    .trim()
    .toLowerCase();
}

const ALIAS_INDEX = (() => {
  const m = new Map();
  for (const [field, list] of Object.entries(COLUMN_ALIASES)) {
    for (const a of list) m.set(normHeader(a), field);
  }
  return m;
})();

function headerToField(h) {
  const n = normHeader(h);
  if (!n) return '';
  if (ALIAS_INDEX.has(n)) return ALIAS_INDEX.get(n);
  // 组合表头：「景别/机位/运镜」→ camera；「画面+台词」这种一格多义按第一个命中算
  for (const [alias, field] of ALIAS_INDEX.entries()) {
    if (n.includes(alias)) return field;
  }
  return '';
}

// —— 分隔符解析：Markdown 表格 / CSV / TSV ——
function splitCsvLine(line, delim) {
  const out = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; continue; }
      if (ch === '"') { quoted = false; continue; }
      cur += ch;
      continue;
    }
    if (ch === '"' && !cur.trim()) { quoted = true; continue; }
    if (ch === delim) { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

function sniffDelimiter(lines) {
  const sample = lines.slice(0, 5).join('\n');
  const count = (ch) => (sample.match(new RegExp('\\' + ch, 'g')) || []).length;
  const tabs = count('\t');
  const commas = count(',');
  const semis = count(';');
  if (tabs >= commas && tabs >= semis && tabs > 0) return '\t';
  if (semis > commas) return ';';
  return ',';
}

function isMdSeparator(line) {
  return /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(line) && line.includes('-');
}

function parseMarkdownTable(lines) {
  const rows = [];
  for (const line of lines) {
    const t = line.trim();
    if (!t.includes('|')) continue;
    if (isMdSeparator(t)) continue;
    const cells = t.replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.replace(/\\\|/g, '|').trim());
    if (!cells.length) continue;
    rows.push(cells);
  }
  return rows;
}

// 单元格里的「多值」：支持 、，,;/｜| 与换行；不拆英文里的逗号（"Mr. Smith, Jr."这种不会出现在资产列）
function splitCellList(cell) {
  const raw = String(cell == null ? '' : cell);
  if (!raw.trim()) return [];
  return raw
    .split(/[、,，;；/|｜\n]+/)
    .map((s) => s.replace(/^[@#]/, '').replace(/[（(]\s*(人物|场景|道具|服装|年龄|音频)[^）)]*[）)]/g, '').trim())
    .filter((s) => s && !/^(无|空|none|null|-|—|\/)$/i.test(s));
}

function firstNumber(s) {
  // 必须取 m[0]（整段匹配）：正则里的捕获组是可选的「小数部分」，对 "5" 这种整数它是 undefined，
  // 用 m[1] 会让所有整数取到 NaN（曾导致镜号/时长全变 0）。
  const m = String(s == null ? '' : s).match(/\d+(?:\.\d+)?/);
  return m ? Number(m[0]) : NaN;
}

// 台词单元格归一：`张三|谁？` / `张三 - 谁？` → `张三：谁？`（只处理「短名 + 分隔符 + 内容」）
function normalizeDialogueCell(cell) {
  const raw = String(cell == null ? '' : cell).replace(/\r/g, '').trim();
  if (!raw) return '';
  return raw
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.replace(/^(.{1,12}?)\s*[|｜]\s*(.+)$/, '$1：$2').replace(/^(.{1,12}?)\s+-\s+(.+)$/, '$1：$2'))
    .join('\n');
}

// 解析入口：返回 { format, columns, rows, warnings }
// rows 每项 = { idx, duration, scene_name, camera, visual, dialogue, narration, sub_shots, characters[], scenes[], props[], costumes[], ages[], audios[] }
export function parseStoryboardTable(text) {
  // 去掉 Markdown 代码围栏（用户常把表格整段包在 \`\`\`md 里粘贴过来），否则首行是围栏、
  // 表头识别会整体失败。
  const raw = String(text == null ? '' : text)
    .replace(/^\uFEFF/, '')
    .replace(/^[ \t]*```[a-zA-Z0-9_-]*[ \t]*$/gm, '')
    .replace(/^[ \t]*```[ \t]*$/gm, '')
    .trim();
  const warnings = [];
  if (!raw) throw new Error('分镜表内容为空');

  // ① JSON（数组或 {shots:[...]}）
  if (/^[[{]/.test(raw)) {
    let j;
    try { j = JSON.parse(raw); } catch (e) { throw new Error('JSON 解析失败：' + e.message); }
    const list = Array.isArray(j) ? j : (Array.isArray(j?.shots) ? j.shots : null);
    if (!list) throw new Error('JSON 里没有分镜数组（应为 [...] 或 { "shots": [...] }）');
    const rows = enrichCharacters(list.map((item, i) => rowFromObject(item, i)));
    return { format: 'json', columns: Object.keys(list[0] || {}), rows, warnings };
  }

  const lines = raw.split(/\r?\n/).filter((l) => l.trim());
  // ② Markdown 表格（有 | 且第二行是分隔行）
  const mdLike = lines.filter((l) => l.includes('|')).length;
  if (mdLike >= Math.max(2, lines.length * 0.6) && lines.some((l) => l.includes('|'))) {
    const table = parseMarkdownTable(lines);
    if (table.length >= 2) {
      const header = table[0];
      const body = table.slice(1);
      const columns = header.map(headerToField);
      if (!columns.filter(Boolean).length) throw new Error('表头没认出任何可用列（需要至少一列：镜号/画面/台词/时长/角色…）');
      return { format: 'markdown', columns: header, rows: enrichCharacters(rowsFromCells(columns, body, warnings, header)), warnings };
    }
  }

  // ③ CSV / TSV（用记录级解析：单元格内可含换行）
  const delim = sniffDelimiter(lines);
  const table = parseCsvRecords(raw, delim);
  if (table.length >= 2) {
    const header = table[0];
    const body = table.slice(1);
    const columns = header.map(headerToField);
    if (!columns.filter(Boolean).length) throw new Error('表头没认出任何可用列（需要至少一列：镜号/画面/台词/时长/角色…）');
    return { format: delim === '\t' ? 'tsv' : 'csv', columns: header, rows: enrichCharacters(rowsFromCells(columns, body, warnings, header)), warnings };
  }
  throw new Error('没法识别这份分镜表：支持 Markdown 表格、CSV/TSV（首行表头）、JSON 数组');
}

function rowFromObject(item, i) {
  const o = item || {};
  // 与表格路径共用 assembleRow：键名交给 headerToField 归类，多列命中同字段照样合并
  // （旧版是逐字段硬编码取一列，所以 JSON 输入会丢掉焦段/运动、起始/结束画面）
  const entries = Object.keys(o).map((k) => ({ col: k, val: o[k] }));
  const row = assembleRow(entries);
  row.idx = firstNumber(o.idx ?? o['镜号'] ?? o['序号']) || i + 1;
  return row;
}

// 占位符：分镜表里「本镜无台词/无音效」常写 — / - / 无 / NA，必须清空。
// 不清空会把「—」当成台词存进去，提示词阶段它会变成一句要念出来的独白。
const PLACEHOLDER_RE = /^(?:[-—–－]{1,3}|无|空|n\/?a|none|null|\/|（无）|\(无\))$/i;
function cleanCell(v) {
  const s = String(v == null ? '' : v).trim();
  return PLACEHOLDER_RE.test(s) ? '' : s;
}

// 镜号列常见写法：1 / 1-1-01 / 第3镜 / SC01 / 2.1.5。
// 取最后一段数字当序号参考，前面的部分当「场次标识」（1-1-01 → 场次 1-1）。
// 真正的 idx 由 importStoryboard 统一排（章内必须从 1 连续），这里只负责拆出场次。
function parseShotCode(cell) {
  const s = String(cell == null ? '' : cell).trim();
  if (!s) return { n: NaN, sceneKey: '' };
  const parts = s.split(/[-_./·\s]+/).filter(Boolean);
  if (parts.length >= 2) {
    const n = firstNumber(parts[parts.length - 1]);
    return { n: Number.isFinite(n) ? n : NaN, sceneKey: parts.slice(0, -1).join('-') };
  }
  return { n: firstNumber(s), sceneKey: '' };
}

// 没有角色列时从台词反推说话人：`斯洛恩（画外）：…` / `斯洛恩：…` / `SLOANE (V.O.): …`
// 只认行首「短名 + 可选括注 + 冒号 + 有内容」，避免把英文台词里的冒号误当说话人。
function speakersFromDialogue(text) {
  const out = [];
  for (const line of String(text || '').split(/\n+/)) {
    const m = /^([^：:]{1,16}?)\s*(?:[（(][^）)]{0,12}[）)])?\s*[：:]\s*\S/.exec(line.trim());
    if (!m) continue;
    const name = m[1].replace(/[（(].*$/, '').trim();
    if (!name || /[，。！？、；：""''「」『』]/.test(name)) continue;
    if (/^(旁白|画外音|字幕|备注|os|vo|narrator|bgm)$/i.test(name)) continue;
    if (!out.includes(name)) out.push(name);
  }
  return out;
}

// 数组型字段（资产名清单）
const ARRAY_FIELDS = ['characters', 'scenes', 'props', 'costumes', 'ages', 'audios'];
// 「角色」是分镜表显式给出的列（作者知道谁在场），还是从台词反推出来的？
// 用 Symbol 打标：不进 Object.keys、不进 JSON.stringify，不会被 pickShotFields 当未知字段拒掉。
// 为什么要区分：enrichCharacters 的画内回扫本来是修「台词说话人在画外、却把参考图绑给他」的，
// 但它会把显式列里「画面描述没重复写名字」的在场人物一并删掉（实测：表里写「罗克珊、哈罗德」，
// visual 只写了罗克珊 → 哈罗德被静默丢弃 → 该角色没有参考图 → 出片人脸漂移）。
const EXPLICIT_CHARS = Symbol('explicitCharacters');

// 组装一行：入口统一收 [{ field, col, val }]，表格路径与 JSON 路径共用同一套
// 「多列合并 / 占位符清理 / 场次提取 / 说话人反推」逻辑，避免两条路径口径漂移。
// 真正的 CSV 记录解析：必须支持「引号内换行」与 "" 转义。
// 原先按 \n 切成行再逐行 split，单元格里一有换行（画面描述、子镜时间轴、站位声明都常写成多行）
// 整张表就错行：实测 13 段的补全表按行切完之后，第 2 行起全被判「没有任何画面内容」，
// 子镜时间轴只剩第一句（112 字，正常 500+）。Excel/飞书导出的 CSV 普遍带引号内换行，必须扛住。
function parseCsvRecords(text, delim) {
  const rows = [];
  let row = [];
  let cell = '';
  let inQ = false;
  const src = String(text || '');
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inQ) {
      if (ch === '"') {
        if (src[i + 1] === '"') { cell += '"'; i++; } else inQ = false;
      } else cell += ch;
      continue;
    }
    if (ch === '"') { inQ = true; continue; }
    if (ch === delim) { row.push(cell); cell = ''; continue; }
    if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; continue; }
    if (ch === '\r') continue;
    cell += ch;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((c) => String(c).trim()));
}

function assembleRow(entries) {
  const row = { idx: 0, duration: 0, scene_name: '', camera: '', visual: '', dialogue: '', narration: '', sub_shots: '', blocking: '', characters: [], scenes: [], props: [], costumes: [], ages: [], audios: [] };
  const parts = {};
  let shotCode = null;
  let sceneFromTable = '';
  for (const e of entries || []) {
    const field = e.field || headerToField(e.col);
    const cell = cleanCell(e.val);
    if (!field || !cell) continue;
    const colName = e.col || field;
    // 多列都能当镜号时（如「段号 + 源镜号」并存）取第一个：段号在前时用它，源镜号只作参考；
    // 后者覆盖前者会让第 2 段的源镜号 1-1-06 变成 idx=6，整章编号错位。
    if (field === 'idx') { if (!shotCode) shotCode = parseShotCode(cell); continue; }
    if (field === 'duration') { row.duration = firstNumber(cell) || 0; continue; }
    if (field === 'dialogue') { row.dialogue = normalizeDialogueCell(cell); continue; }
    if (field === 'scene_name') { sceneFromTable = cell; continue; }
    if (field === 'sfx') { (parts.sfx = parts.sfx || []).push({ col: colName, val: cell }); continue; }
    if (ARRAY_FIELDS.includes(field)) { row[field] = splitCellList(cell); if (field === 'characters') row[EXPLICIT_CHARS] = true; continue; }
    (parts[field] = parts[field] || []).push({ col: colName, val: cell });
  }
  for (const [field, list] of Object.entries(parts)) {
    if (field === 'sfx') continue;
    if (list.length === 1) { row[field] = list[0].val; continue; }
    const rule = JOIN_RULES[field] || { sep: '；', label: true };
    row[field] = list[0].val + list.slice(1).map((x) => rule.sep + (rule.label ? x.col + '：' : '') + x.val).join('');
  }
  // 声音列并进画面尾巴：提示词阶段的【音效】栏要读它，单独存又没有对应字段
  if (parts.sfx && parts.sfx.length) {
    const sfx = parts.sfx.map((x) => x.val).join('；');
    row.visual = row.visual ? row.visual + '；声音：' + sfx : '声音：' + sfx;
  }
  // 场次：表里有场次列用它；否则从镜号前缀取（1-1-01 → 1-1），保证同场分镜能连成一段
  if (sceneFromTable) row.scene_name = sceneFromTable;
  else if (shotCode && shotCode.sceneKey) row.scene_name = shotCode.sceneKey;
  // 表里只给了「场景」列（命中 scenes 数组、不是 scene_name）时，用第一个场景名兜底显示名，
  // 否则同场景的前后两段识别不出「同场景」，转场判断与段缝策略全部失效。
  else if (row.scenes && row.scenes.length) row.scene_name = row.scenes[0];
  // 没有角色列时从台词反推（导入后自动建/匹配资产，不然镜头没有参考图）
  if (!row.characters.length && row.dialogue) row.characters = speakersFromDialogue(row.dialogue);
  // 场次号（1-1 / 2-1）单独存一份：scene_name 后面会被推断出的资产名覆盖，
  // 一旦覆盖，「同场次」的分组就散了，邻居继承会跨场次串味（实测玄关戏继承不到客厅）。
  if (shotCode && shotCode.sceneKey) row.scene_key = shotCode.sceneKey;
  // 镜号列有就用（此前 parseShotCode 的结果只用来取场次前缀，镜号本身被丢掉，
  // 表格路径的 idx 一直是 0，全靠后续按顺序编号兜底——表里镜号乱序或跳号时就会错位）
  if (shotCode && Number.isFinite(shotCode.n)) row.idx = shotCode.n;
  return row;
}

// 全表补角色：只靠对白反推会漏掉「没台词的镜头」——实测 F1 分镜表 62 条里 31 条无台词，
// 那些镜头没有任何人物参考图，出片时同场景里人脸/服装会跳变（提示词阶段救不回来）。
// 做法：先用全表对白建「已知角色名池」，再拿它回扫画面/机位/子镜头文本补人。
function enrichCharacters(rows) {
  const pool = new Set();
  for (const r of rows) for (const n of (r.characters || [])) if (n) pool.add(n);
  if (!pool.size) return rows;
  // 长名优先：先匹配「男车手」再匹配「车手」，避免宽带窄
  const names = [...pool].sort((a, b) => b.length - a.length);
  for (const r of rows) {
    const text = [r.visual, r.camera, r.sub_shots].filter(Boolean).join(' ');
    const inFrame = text ? names.filter((n) => n.length >= 2 && text.includes(n)) : [];
    // 显式角色列：信任表里给的人（作者知道谁在场），只用画内回扫**补齐**漏写的人，绝不删——
    // 画面描述常用代词、或只写主体动作，靠文本回扫判「不在场」会误删同框的次要角色。
    if (r[EXPLICIT_CHARS]) {
      const extra = inFrame.filter((n) => !(r.characters || []).includes(n));
      if (extra.length) r.characters = [...(r.characters || []), ...extra];
      continue;
    }
    // 画内出现的人优先：对白反推出来的可能只是「画外音说话人」，他并不在画面里。
    // 实测致命案例（F1 表镜9）：画面是怀亚特与布丽隔着台上台下对视，台词却是「斯洛恩（画外）：…」，
    // 旧逻辑「已有角色就跳过回扫」把 characters 定成了斯洛恩 —— 参考图绑成画外人，
    // 出片会在台上画出斯洛恩，而真正的主体（怀亚特、布丽）没有参考图。
    if (inFrame.length) { r.characters = inFrame; continue; }
    // 画内一个具名人物都没有（纯赛车 / 纯空镜 / 只有泛称如「维修人员」）：
    // 若说话人明确标了画外（画外/OS/VO/旁白），他不在画面里，不能绑成画面参考 —— 清空，
    // 让 importStoryboard 判成文字档，避免「空镜里凭空出现一个人」。
    // 没有画外标记时保留说话人（画内人物开口但画面描述用代词、没重复写名字的常见写法）。
    if (/[（(]\s*(画外|OS|VO|旁白)[^）)]*[）)]/i.test(String(r.dialogue || ''))) r.characters = [];
  }
  return rows;
}

function rowsFromCells(columns, body, warnings, header) {
  const rows = [];
  body.forEach((cells, i) => {
    if (!cells.some((c) => String(c || '').trim())) return; // 空行
    const entries = columns.map((field, ci) => ({ field, col: (header && header[ci]) || field, val: cells[ci] }));
    const row = assembleRow(entries);
    // 既没画面也没台词也没旁白 → 大概率是说明行/合计行
    if (!row.visual && !row.dialogue && !row.narration) {
      warnings.push('第 ' + (i + 1) + ' 行没有任何画面/台词内容，已跳过');
      return;
    }
    rows.push(row);
  });
  return rows;
}

// —— 资产解析 ——
function matchAsset(name, category, pool) {
  const n = normalizeName(name);
  if (!n) return null;
  const exact = pool.find((a) => normalizeName(a.name) === n);
  if (exact) return exact;
  const loose = pool.filter((a) => {
    const an = normalizeName(a.name);
    return an && (an.includes(n) || n.includes(an));
  });
  return loose.length === 1 ? loose[0] : null;
}

// —— 场景/道具自动识别 ——
// 分镜表里没人会写「道具」列，场景列也常常没有。但投喂阶段【场景资产】栏必须有东西可引用，
// 分镜的 scene_name 也决定转场判断。所以从画面文本反推，不让人去填。
// 三条经验（都踩过）：
// ① 道具**只用资产名**做关键词。用描述会出事：收纳箱的描述里有「需双手抱持」，于是每个
//    「双手扶护栏」的镜头都被绑上收纳箱（实测 62 镜里误绑 30+ 次）。
// ② 只保留**唯一归属**的词。多个资产都含的词（「赛车」属于赛道也属于维修区）区分度为零，留则必错。
// ③ 特写/空镜常常不含任何场景词（一张脸、一只手），靠邻居继承：前后已绑定的镜头同场景就沿用，
//    否则留空让 agent 的重排阶段补——绝不硬凑一个场景。
const KEYWORD_STOP = new Set(['画面', '场景', '时段', '光影', '色调', '固定', '定物', '中央', '活动', '主入', '次入',
  '安全', '可拍', '禁入', '垂直', '层级', '方位', '依托', '背后', '身后', '其中', '以及', '左右', '普通', '描述']);

// 通用词停用表：这些词在画面描述里到处都是，留着就是把整片镜头绑到同一个场景。
// 全部是实测踩出来的：
//   「现场」来自「F1发布会现场」的尾部切词 → 任何写了「现场」的镜子都被绑发布会；
//   「方向」来自「方向盘（主驾正前）」→「朝门口方向走」被绑到深夜汽车内（玄关戏！）；
//   「赛车」同时出现在「F1 赛车（中央）」和赛道名里 →「赛车服」把客厅镜绑到维修区；
//   「落地」来自「落地窗」→「落在地上」被绑客厅。
const WORD_STOP = new Set(['上方', '下方', '前方', '后方', '左侧', '右侧', '中间', '里面', '外面', '旁边',
  '周围', '尽头', '两侧', '内侧', '外侧', '其中', '以及', '左右', '中央', '活动', '区域', '位置',
  '现场', '方向', '落地', '赛车', '房间', '室内', '室外', '空间', '地面', '墙面', '顶部', '底部',
  '大门', '附近', '周边', '内部', '外部', '正面', '背面', '侧面', '整体', '局部',
  // 「门框」来自发布会固定物「走廊入口门框」：玄关踹门戏每一镜都写「门框清晰 / 入户门」，
  // 于是整段被绑到发布会（实测镜 73）。门框是通用建筑词，不该当场景标识。
  '门框', '入户门', '门口']);

function fixedThingsOf(desc) {
  const d = String(desc || '');
  const m = d.match(/固定物[：:]\s*([^\n。]*(?:。[^\n]*)?)/);
  if (!m) return [];
  return m[1].split(/[、，,／/｜|]+/)
    .map((x) => x.replace(/[（(][^）)]*[）)]/g, '').replace(/[^\u4e00-\u9fa5A-Za-z0-9]/g, '').trim())
    .filter((t) => t.length >= 2)
    .slice(0, 14);
}

// 关键词生成：整段 + 所有 2–4 字连续片段。
// 为什么不做「只取首尾」：中文场景名的核心词常在中间 —— 「F1发布会现场」首尾切出来是
// 「F1发 / 会现场」，真正的场景词「发布会」直接丢了（实测发布会镜只绑上 7 个，其余全漏）。
// 全片段会不会误绑？会，但两道闸拦住了：
//   ① WORD_STOP / KEYWORD_STOP 挡通用词（现场 / 方向 / 上方 / 落地…）；
//   ② 跨资产唯一性：一个词若能指向两个资产就丢弃（「赛车」在赛道与维修区都有）。
// 碎片词（「会现」「发布」）在画面文本里根本不会出现，等于自动失效，无害。
function ngrams(text) {
  const out = new Set();
  const t = String(text || '').replace(/[（(][^）)]*[）)]/g, '').replace(/[^\u4e00-\u9fa5A-Za-z0-9]/g, '').trim();
  if (t.length < 2) return out;
  const push = (w) => { if (w && w.length >= 2 && !KEYWORD_STOP.has(w) && !WORD_STOP.has(w)) out.add(w); };
  for (const seg of t.split(/[与和及、，,／/·]/)) {
    const g = String(seg || '').trim();
    if (g.length < 2) continue;
    push(g);
    for (const L of [2, 3, 4]) {
      for (let i = 0; i + L <= g.length; i++) push(g.slice(i, i + L));
    }
  }
  return out;
}

function buildKeywordIndex(byCat, extraNames) {
  // 名称词与固定物词**分开建表、分开判唯一**。
  // 合成一张表会互相污染：道具里有「话筒」，发布会场景的固定物里也有「话筒架」，
  // 于是「话筒」被判成「两个资产都有」直接丢弃 —— 结果举话筒的记者镜头场景绑不上
  // （实测 4 镜）。分开之后，「话筒」在名称表里唯一指向道具、「话筒架」在固定物表里
  // 唯一指向发布会，两边各取所需。
  const bagName = new Map(); // word → Set(assetId)
  const bagFix = new Map();
  // 角色名必须排除：场景名里常带主人名（「斯洛恩家客厅壁炉」），不排除的话「斯洛恩」
  // 就成了该场景的关键词，每个提到主角的镜头统统被绑到客厅（实测 62 镜里 35 镜误绑）。
  // 注意：导入时角色资产往往还不存在（逐行推断后才创建），所以必须把「表里已出现的
  // 角色名」一起传进来。
  const charNames = [
    ...(byCat.character || []).map((a) => String(a.name || '')),
    ...(extraNames || []),
  ].filter((x) => x.length >= 2);
  const isCharWord = (w) => charNames.some((c) => c.includes(w) || w.includes(c) || (w.length >= 2 && c.startsWith(w)));
  const add = (bag, w, id) => {
    if (!w || w.length < 2 || KEYWORD_STOP.has(w) || WORD_STOP.has(w)) return;
    if (isCharWord(w)) return;
    if (!bag.has(w)) bag.set(w, new Set());
    bag.get(w).add(id);
  };
  for (const a of (byCat.scene || [])) {
    for (const w of ngrams(a.name)) add(bagName, w, a.id);
    for (const f of fixedThingsOf(a.description)) for (const w of ngrams(f)) add(bagFix, w, a.id);
  }
  for (const a of (byCat.prop || [])) {
    // 道具只用名称做关键词：用描述会出事 —— 收纳箱描述里写「需双手抱持」，
    // 于是每个「双手扶护栏」的镜头都被绑上收纳箱（实测误绑 30+ 次）。
    for (const w of ngrams(a.name)) add(bagName, w, a.id);
  }
  const uniq = (bag) => {
    const out = new Map();
    for (const [w, set] of bag) if (set.size === 1) out.set(w, [...set][0]);
    return out;
  };
  return { name: uniq(bagName), fix: uniq(bagFix) };
}

// 统计一段文本里每个资产命中的词数与得分
function hitsOf(text, words) {
  const score = {};
  const count = {};
  for (const [w, id] of words) {
    if (!text.includes(w)) continue;
    let n = 0; let from = 0;
    while (n < 3) { const at = text.indexOf(w, from); if (at < 0) break; n++; from = at + w.length; }
    score[id] = (score[id] || 0) + w.length * Math.min(n, 2);
    count[id] = (count[id] || 0) + 1;
  }
  return { score, count };
}

function inferSceneProps(row, index) {
  const out = { scenes: [], props: [] };
  const kw = index.kw;
  if (!kw || !index.all?.length) return out;
  const text = [row.visual, row.camera, row.sub_shots, row.scene_name].filter(Boolean).join(' ');
  if (!text) return out;
  const id2asset = new Map(index.all.map((a) => [a.id, a]));

  // 场景：命中任一个「名称词」就算认出来（壁炉、发布会、走廊…）；
  // 名称词没命中时才看固定物（护栏、看台、方向盘），要 ≥2 个才认，防单词误判。
  const nm = hitsOf(text, kw.name);
  const fx = hitsOf(text, kw.fix);
  const sceneCand = [];
  for (const id of new Set([...Object.keys(nm.count), ...Object.keys(fx.count)])) {
    const asset = id2asset.get(id);
    if (!asset || asset.category !== 'scene') continue;
    const nameHit = nm.count[id] || 0;
    const fixHit = fx.count[id] || 0;
    // 名称词命中 1 次就够（「发布会」「壁炉」这种词本身就是场景名）；
    // 固定物命中要多个词或高分才认：特写镜里常只有一个线索（「舞台方向」「记者席」），
    // 只要求 1 个词就会把「手扶护栏」绑到发布会；但也别死守 2 个词——同一线索重复出现
    // （「舞台…舞台方向」）本身就是强证据，所以 2 个词 **或** 得分 ≥6 都放行。
    // 名称词（发布会 / 壁炉 / 走廊 / 汽车内）命中就有意义，1 次即绑；
    // 固定物词要 ≥2 个不同词同现才绑：单靠一个固定物（「护栏」「鞋柜」）在特写镜里极易误判，
    // 两个同时出现（「玄关鞋柜 + 入户门」）才算空间证据。
    if (nameHit >= 1 || fixHit >= 1) {
      sceneCand.push({ id, name: asset.name, s: (nm.score[id] || 0) * 2 + (fx.score[id] || 0) });
    }
  }
  out.scenes = sceneCand.sort((a, b) => b.s - a.s).slice(0, 2).map((x) => x.name);
  if (process.env.DBG_KW === '1') {
    try {
      const hitWords = [];
      for (const [w, id] of kw.fix) if (text.includes(w) && sceneCand.some((c) => c.id === id)) hitWords.push(w + '→fix:' + (id2asset.get(id)?.name || ''));
      for (const [w, id] of kw.name) if (text.includes(w) && sceneCand.some((c) => c.id === id)) hitWords.push(w + '→name:' + (id2asset.get(id)?.name || ''));
      // 服务是独立进程，console 看不到，直接落文件
      fs.appendFileSync('data/_verify/kw.log', String(text).slice(0, 34).replace(/\n/g, ' ') + ' ⇒ ' + out.scenes.join(',') + ' ｜ ' + hitWords.join(' ; ') + '\n');
    } catch { /* 调试输出失败不影响主流程 */ }
  }

  // 道具：只认名称词命中，最多 3 件
  const propCand = [];
  for (const id of Object.keys(nm.count)) {
    const asset = id2asset.get(id);
    if (!asset || asset.category !== 'prop') continue;
    propCand.push({ name: asset.name, s: nm.score[id] });
  }
  out.props = propCand.sort((a, b) => b.s - a.s).slice(0, 3).map((x) => x.name);
  return out;
}

// 邻居继承：特写/空镜没有场景词时，沿用同一场次内最近一次已识别的场景。
// 只在「前后邻居同场景」或「只有一个方向有」时继承；两侧不同就留空（说明正处在场景切换点，
// 硬猜会把走廊的镜头绑回发布会，导致跨场景段整段挂错参考图）。
function inheritSceneNames(rows) {
  const keyOf = (r) => String(r.scene_key || '') || String(r.scene_name || '') || String(r.idx || '');
  const group = new Map();
  for (const r of rows) {
    const k = keyOf(r);
    if (!group.has(k)) group.set(k, []);
    group.get(k).push(r);
  }
  for (const list of group.values()) {
    const known = list.map((r) => (r.scenes && r.scenes.length ? r.scenes[0] : ''));
    for (let i = 0; i < list.length; i++) {
      if (list[i].scenes && list[i].scenes.length) continue;
      let prev = '';
      for (let j = i - 1; j >= 0; j--) if (known[j]) { prev = known[j]; break; }
      let next = '';
      for (let j = i + 1; j < list.length; j++) if (known[j]) { next = known[j]; break; }
      // 只有**前后两侧一致**才继承。取单侧（prev || next）在场景切换点上必错：
      // 末尾的「储物间」镜前一脚是维修区、后一脚是赛道，取谁都错，留空更诚实。
      const pick = prev && prev === next ? prev : '';
      if (!pick) continue;
      // 只在间隔不大时继承：隔了太多镜说明已换场景
      const prevGap = (() => { for (let j = i - 1; j >= 0; j--) if (known[j]) return i - j; return 99; })();
      const nextGap = (() => { for (let j = i + 1; j < list.length; j++) if (known[j]) return j - i; return 99; })();
      if (Math.min(prevGap, nextGap) > 3) continue;
      list[i].scenes = [pick];
      if (!list[i].scene_name || /^\d+[-_]\d+$/.test(String(list[i].scene_name))) list[i].scene_name = pick;
    }
  }
  return rows;
}

// 把一间资产库按分类建索引，供多行复用（一次导入只查一次库）
function buildAssetIndex(projectId, extraNames) {
  const all = Assets.list(projectId);
  const byCat = {};
  for (const a of all) {
    (byCat[a.category] = byCat[a.category] || []).push(a);
  }
  return { all, byCat, kw: buildKeywordIndex(byCat, extraNames), extraNames };
}

// 解析一行的资产名字 → id；返回 { ids, missing, created }
function resolveOneRow(row, index, { createMissing, projectId }) {
  const created = [];
  const missing = [];
  const ids = { character_ids: [], scene_ids: [], prop_ids: [], costume_ids: [], age_ids: [], audio_ids: [] };

  // 表里没写场景/道具列（绝大多数分镜表都不会写道具）→ 从画面文本反推，不让人去填。
  // 只在**表里真的没给**时才推断：作者显式写的资产名优先级永远高于推断。
  if (!(row.scenes || []).length && !(row.props || []).length) {
    const guess = inferSceneProps(row, index);
    if (guess.scenes.length) {
      row.scenes = guess.scenes;
      // 表里没有场景列时，scene_name 往往被场次号（1-1 / 2-1）占着——那是「第几集第几场」，
      // 不是场景名。这种形态一律用推断出的资产名覆盖，否则界面上每镜都显示「1-1」，
      // 也判断不出「同场景前后两段」（转场与段缝策略全靠这个）。
      if (!row.scene_name || /^\d+[-_]\d+$/.test(String(row.scene_name))) row.scene_name = guess.scenes[0];
    }
    if (guess.props.length) row.props = guess.props;
  }

  for (const field of ['characters', 'scenes', 'props']) {
    const cat = COLUMN_ASSET_CATEGORY[field];
    const idField = ASSET_ID_FIELD[cat];
    for (const name of row[field] || []) {
      const hit = matchAsset(name, cat, index.byCat[cat] || []);
      if (hit) { ids[idField].push(hit.id); continue; }
      if (createMissing) {
        try {
          const a = Assets.create(projectId, { category: cat, name, description: row.scene_name ? '分镜表导入 · 场次：' + row.scene_name : '分镜表导入' });
          (index.byCat[cat] = index.byCat[cat] || []).push(a);
          // 新资产的「名称词」必须立刻进关键词表。否则流式处理时后面同场景的镜头
          // 推断不出这个名字 → 绑不上 → 拼接阶段会把它当成「换了场景」而错误封段。
          // 重建成本很低（资产几十个），比维护增量索引可靠。
          if (index.extraNames) index.kw = buildKeywordIndex(index.byCat, index.extraNames);
          ids[idField].push(a.id);
          created.push({ category: cat, name });
          continue;
        } catch { /* 落到 missing */ }
      }
      missing.push({ field, name, category: cat });
    }
  }

  // 服装/年龄：必须挂在角色下（parent_id），父角色 = 本行角色里能唯一对上的那个
  for (const field of ['costumes', 'ages']) {
    const cat = COLUMN_ASSET_CATEGORY[field];
    const idField = ASSET_ID_FIELD[cat];
    const owners = ids.character_ids.map((id) => index.all.find((a) => a.id === id)).filter(Boolean);
    for (const name of row[field] || []) {
      // ① 先按资产现名匹配（已有的服装/年龄变体）
      const hit = matchAsset(name, cat, index.byCat[cat] || []);
      if (hit) { ids[idField].push(hit.id); continue; }
      // ② 形如「角色·服装名」：拆出父角色再按变体名匹配
      const m = String(name).match(/^(.+?)\s*[·•・:：-]\s*(.+)$/);
      if (m) {
        const parent = matchAsset(m[1], 'character', index.byCat.character || []);
        const variant = parent && (index.byCat[cat] || []).find((a) => a.parent_id === parent.id && normalizeName(a.name).includes(normalizeName(m[2])));
        if (variant) { ids[idField].push(variant.id); continue; }
      }
      missing.push({ field, name, category: cat, hint: owners.length ? '可先为角色「' + owners.map((o) => o.name).join('/') + '」生成该' + (field === 'costumes' ? '服装' : '年龄') + '变体再导入' : '需要先有角色，服装/年龄是挂在角色下的变体' });
    }
  }

  // 音频：voice / music / sfx 三类统一按名字匹配
  const audioPool = [...(index.byCat.voice || []), ...(index.byCat.music || []), ...(index.byCat.sfx || [])];
  for (const name of row.audios || []) {
    const hit = matchAsset(name, 'voice', audioPool);
    if (hit) ids.audio_ids.push(hit.id);
    else missing.push({ field: 'audios', name, category: 'audio' });
  }

  return { ids, missing, created };
}

// 补齐缺失字段：时长按台词字数倒推（3.3 字/秒 + 缓冲），台词/画面做最小校验
// videoModel：决定时长上限——h3 / seedance20 上限 15s，seedance25 上限 30s。
// 原先写死 Math.min(15, ...) 会把 2.5 分镜表里 25–30s 的段静默压成 15s（实测 28s → 15s）。
function finalizeRow(row, idx, videoModel) {
  const maxDur = shotDurationMax(videoModel);
  const dialogue = String(row.dialogue || '');
  const chars = dialogue.replace(/^[^：:\n]{1,12}[：:]/gm, '').replace(/\s/g, '').length;
  let duration = Number(row.duration) || 0;
  if (!duration) {
    duration = Math.min(maxDur, Math.max(2, Math.ceil(chars / 3.3) + 2));
    if (!chars) duration = 4;
  }
  duration = Math.min(maxDur, Math.max(1, Math.round(duration)));
  return {
    idx: Number(row.idx) || idx,
    duration,
    scene_name: row.scene_name || '',
    camera: row.camera || '',
    visual: row.visual || '',
    dialogue,
    narration: row.narration || '',
    sub_shots: row.sub_shots || '',
  };
}

// ── 流式拼接：把「已经绑定好资产」的碎镜按「同场景 + 段长上限」合并成生成段 ──
// 顺序不能反：单镜属于哪个场景，是绑定这一步（推断 + 匹配资产）才产出的；先有它，
// 才能判断「这两个镜头能不能放进同一个生成段」。所以是边读边建边绑，绑完立刻判能不能并入当前段。
// 台词逐字搬运，不改写、不增删；段内每镜保留原始时长，只累加出段时间码。
function tsFmt(sec) {
  const v = Math.max(0, Math.round(Number(sec) || 0));
  return String(Math.floor(v / 60)).padStart(2, '0') + ':' + String(v % 60).padStart(2, '0');
}

// 导入时 JOIN 过的画面会被写成「主体；表演动作：…；结束画面：…；声音：…」，
// 合并进时间轴前要拆开，否则一行镜头里套着三四个分号标签，模型会读串。
const VIS_TAGS = ['起始画面', '画面主体', '表演动作', '表演', '结束画面', '状态', '光影', '色调', '声音', '音效', '重音', '人声'];
function splitVisual(raw) {
  const out = { body: '', action: '', end: '', sound: '' };
  const text = String(raw || '').trim();
  if (!text) return out;
  const re = new RegExp('[；;]\\s*(' + VIS_TAGS.join('|') + ')\\s*[：:]', 'g');
  const idxs = [];
  let m;
  while ((m = re.exec(text))) idxs.push({ at: m.index, len: m[0].length, tag: m[1] });
  if (!idxs.length) { out.body = text; return out; }
  out.body = text.slice(0, idxs[0].at).trim();
  for (let i = 0; i < idxs.length; i++) {
    const from = idxs[i].at + idxs[i].len;
    const to = i + 1 < idxs.length ? idxs[i + 1].at : text.length;
    const val = text.slice(from, to).trim();
    const tag = idxs[i].tag;
    if (tag === '表演动作' || tag === '表演') out.action = val;
    else if (tag === '结束画面') out.end = val;
    else if (tag === '声音' || tag === '音效') out.sound = val;
    else if (!out.body) out.body = val;
  }
  return out;
}

function buildSegment(subs, videoModel) {
  const seg = {
    idx: 0,
    duration: subs.reduce((acc, x) => acc + (Number(x.duration) || 0), 0),
    // 段级场景取「第一个真实资产名」：段首镜可能没绑上（残留场次号或空），
    // 直接取第一个非空值会让整段的场景变成「2-1」，参考图与场景资产全挂不上。
    scene_name: subs.map((x) => x.scene_name).find((x) => x && !/^\d+[-_]\d+$/.test(x)) || '',
    camera: subs[0].camera || '',
    visual: '',
    dialogue: '',
    narration: '',
    sub_shots: '',
    character_ids: [], scene_ids: [], prop_ids: [], costume_ids: [], age_ids: [], audio_ids: [],
    mode: '',
  };
  let t = 0;
  const lines = [];
  const dlgAll = [];
  for (let i = 0; i < subs.length; i++) {
    const x = subs[i];
    const dur = Number(x.duration) || 0;
    const from = t;
    t += dur;
    const v = splitVisual(x.visual);
    const bodyParts = [v.body, v.action ? '动作与神态：' + v.action : '', v.end ? '结束状态：' + v.end : ''].filter(Boolean);
    const dlg = String(x.dialogue || '').trim();
    if (dlg) dlgAll.push(dlg);
    lines.push(
      tsFmt(from) + '-' + tsFmt(t) + ' [镜头' + (i + 1) + '] ' + (x.camera || '中景 · 50mm · 平视 · 固定')
      + '。画面主体：' + (bodyParts.join('；') || '（延续上一镜）')
      + '；声音：' + (v.sound || '现场环境声')
      + '；台词：' + (dlg ? dlg.replace(/\r?\n/g, ' / ') + (/[。！？.!?]$/.test(dlg.trim()) ? '' : '。') : '无。'),
    );
    for (const k of ['character_ids', 'scene_ids', 'prop_ids', 'costume_ids', 'age_ids', 'audio_ids']) {
      for (const id of (x[k] || [])) if (!seg[k].includes(id)) seg[k].push(id);
    }
  }
  // 原始镜号范围留痕：合并后编号会重排，人工核对时得知道这一段吃了哪几个源镜
  const srcFrom = subs[0].idx;
  const srcTo = subs[subs.length - 1].idx;
  seg.visual = '源镜 ' + srcFrom + '-' + srcTo + (seg.scene_name ? '｜' + seg.scene_name : '')
    + '｜本段 ' + subs.length + ' 个镜头连续叙事（各镜画面见时间轴）：'
    + (splitVisual(subs[0].visual).body || '').slice(0, 60);
  seg.dialogue = dlgAll.join('\n');
  seg.sub_shots = lines.join('\n');
  const anyAsset = seg.character_ids.length || seg.scene_ids.length || seg.prop_ids.length
    || seg.costume_ids.length || seg.age_ids.length || seg.audio_ids.length;
  // 一个参考资产都没有的段（纯空镜/纯赛车）只能走文字档，否则投喂阶段缺参考图会整批失败
  seg.mode = anyAsset ? '' : 'text';
  // 原始子镜留在内存里：尾段过短要和上一段合并时必须重新组一遍文本，靠时间轴行反解不可靠。
  // 不参与落库（pickShotFields 只取白名单字段），返回前会删掉。
  Object.defineProperty(seg, '_subs', { value: subs, enumerable: false });
  // 合并段标记：段级台词是「本段所有镜头的台词总表」，一个 30s 段里 3–4 个人开口是常态，
  // 不能套用「单镜 ≤2 人开口」的校验（那是为了防一镜里人声糊在一起）。
  // 必须用普通字段：后续 seq.push({ ...p, idx }) 用展开复制，defineProperty 的非枚举属性会丢，
  // 标记一丢校验就照旧按单镜算，合并直接失败。
  seg._merged = true;
  return seg;
}

// rows: 已完成资产绑定的单镜数组（每项含 idx/duration/scene_name/camera/visual/dialogue/*_ids/mode）
// 返回：合并后的生成段数组（idx 已重排 1..N）
function mergeIntoSegments(rows, videoModel) {
  const maxDur = shotDurationMax(videoModel);
  // 2.5 的目标段长是 25–30s（上限 30）；H3/2.0 上限本身是 15s，累加到上限即可
  const targetMin = Math.min(25, maxDur);
  const segs = [];
  let cur = null;
  const flush = () => {
    if (!cur || !cur.subs.length) { cur = null; return; }
    segs.push(buildSegment(cur.subs, videoModel));
    cur = null;
  };
  // 切段策略：**以时长为主，场景切换只用来找切点**。
  // 一开始写成「同场景才合并」，结果 62 镜出 24 段、一半是 4–10s 的碎片段 ——
  // 因为原片场景本身就切得碎（发布会↔走廊↔客厅来回跳），每换景就封段，30s 全浪费了。
  // 现在的规则：
  //   ① 装不下（超上限）→ 必切；
  //   ② 换场景时，当前段已 ≥20s → 就在这个切点封段（干净的场景边界）；
  //   ③ 换场景但当前段还短 → 允许跨过去继续装，但一段最多跨 2 个场景（再多模型会把空间搞混）。
  const SOFT_CUT = Math.min(20, maxDur);
  for (const r of rows) {
    const dur = Number(r.duration) || 0;
    const scene = String(r.scene_name || '');
    if (cur) {
      const sameScene = !scene || !cur.scene || scene === cur.scene;
      const fits = cur.dur + dur <= maxDur;
      const scenes = cur.scenes || (cur.scenes = new Set(cur.scene ? [cur.scene] : []));
      const nextSceneCount = (!sameScene && !scenes.has(scene)) ? scenes.size + 1 : scenes.size;
      const shouldCut = !fits || (!sameScene && (cur.dur >= SOFT_CUT || nextSceneCount > 2));
      if (shouldCut) flush();
    }
    if (!cur) cur = { subs: [], dur: 0, scene, scenes: new Set(scene ? [scene] : []) };
    cur.subs.push(r);
    cur.dur += dur;
    if (!cur.scene && scene) cur.scene = scene;
    if (scene) cur.scenes.add(scene);
    // 够长就封段：2.5 的 25–30s 段就是这么攒出来的，别硬塞到 30 再封
    if (cur.dur >= targetMin) flush();
  }
  flush();

  // 尾段过短（<6s）且与上一段同场景、合并后不超上限 → 并进去，避免产出一个没法独立的碎片段
  if (segs.length >= 2) {
    const last = segs[segs.length - 1];
    const prev = segs[segs.length - 2];
    const mergeable = last.duration < 6
      && (last.duration < 4 || !last.scene_name || last.scene_name === prev.scene_name)
      && prev.duration + last.duration <= maxDur;
    if (mergeable) {
      const merged = buildSegment([...(prev._subs || []), ...(last._subs || [])], videoModel);
      segs.splice(segs.length - 2, 2, merged);
    }
  }
  return segs.map((x, i) => ({ ...x, idx: i + 1 }));
}

// 主流程：解析 → 解析资产 →（可选）写入。dryRun=true 只回预览，不落库。
export async function importStoryboard(projectId, chapterTitle, tableText, opts = {}) {
  const project = Projects.get(projectId);
  if (!project) throw new Error('项目不存在');
  // 时长上限按项目视频模型（h3/seedance20=15s，seedance25=30s）。
  // 必须在 finalizeRow 之前定义——它内部按这个上限裁剪时长，放后面会触发 TDZ。
  const videoModel = project.video_model;
  const chapter = Chapters.list(projectId).find((c) => c.title === chapterTitle || c.id === chapterTitle);
  if (!chapter) throw new Error('章节不存在：' + chapterTitle);

  const parsed = parseStoryboardTable(tableText);
  if (!parsed.rows.length) throw new Error('分镜表里没有可用行');

  const createMissing = opts.createMissing !== false;
  // 兜底：项目里一个场景资产都没有、但本章有剧本 → 先按剧本把资产建出来再解析。
  // 顺序上「原文 → 资产 → 分镜表」才对；用户跳过资产阶段直接传表时这里补上，
  // 否则场景/道具一颗都绑不上，投喂阶段没有【场景资产】可引用。
  try {
    const hasScene = Assets.list(projectId).some((a) => a.category === 'scene');
    // script 是 agent 拆过的剧本，novel 是用户直接贴的原文 —— 两者都没有就跳过。
    // 只认 script 会漏掉「用户直接把原文贴进章节」这条最常见的路（那条路 script 还是空的）。
    const source = String(chapter.script || chapter.novel || '').trim();
    if (!hasScene && source) ensureScriptAssets(projectId, source);
  } catch { /* 兜底失败不阻断导入 */ }

  const tableCharNames = [...new Set(parsed.rows.flatMap((r) => r.characters || []))].filter(Boolean);
  const index = buildAssetIndex(projectId, tableCharNames);
  const warnings = [...parsed.warnings];
  const missing = [];
  const created = [];
  const prepared = [];

  parsed.rows.forEach((row, i) => {
    const { ids, missing: miss, created: cre } = resolveOneRow(row, index, { createMissing, projectId });
    missing.push(...miss.map((m) => ({ ...m, row: i + 1 })));
    created.push(...cre.map((c) => ({ ...c, row: i + 1 })));
    // 一个资产都没绑的镜（纯赛车 / 纯空镜 / 纯环境）在参考模式下写不了提示词
    // （refs.js 要求至少一张参考图），到提示词阶段才炸会让整批失败。
    // 导入时直接标成文字档：这类镜头本来就是文生视频，没有可参考的主体。
    const rowFinal = { ...finalizeRow(row, i + 1, videoModel), ...ids };
    const noAsset = !(rowFinal.character_ids?.length || rowFinal.scene_ids?.length || rowFinal.prop_ids?.length
      || rowFinal.costume_ids?.length || rowFinal.audio_ids?.length);
    if (noAsset) rowFinal.mode = 'text';
    // 「2-1 / 1-1」是场次号不是场景名：场景没识别出来时会残留在这里，
    // 一路带到段级 scene_name（合并后整段显示「2-1」），投喂时又会被当成场景去引用。
    if (/^\d+[-_]\d+$/.test(String(rowFinal.scene_name || ''))) rowFinal.scene_name = '';
    prepared.push(rowFinal);
  });

  // 邻居继承跑在**资产解析之后**：inferSceneProps 已经给能认出来的行填了 scenes，
  // 这里只处理仍为空的特写/空镜——用同场次前后邻居的场景名补上，再补一次 id 绑定。
  // 放在 parse 阶段是无效的（那时还没有资产，注入的名字也匹配不到 id）。
  try {
    inheritSceneNames(parsed.rows);
    parsed.rows.forEach((row, i) => {
      const p = prepared[i];
      if (!p || (p.scene_ids || []).length || !(row.scenes || []).length) return;
      for (const nm of row.scenes) {
        const hit = matchAsset(nm, 'scene', index.byCat.scene || []);
        if (hit) {
          p.scene_ids = [...(p.scene_ids || []), hit.id];
          if (!p.scene_name || /^\d+[-_]\d+$/.test(String(p.scene_name))) p.scene_name = hit.name;
          if (p.mode === 'text') p.mode = '';
          break;
        }
      }
    });
  } catch { /* 继承失败不影响主流程 */ }

  // ── 合并成生成段（可选）──
  // 位置很关键：必须放在**资产绑定 + 邻居继承之后**。判「这两个镜头能不能放进同一段」
  // 靠的是「同场景」，而场景正是绑定这一步才产出的。所以顺序天然是：
  // 边读分镜 → 边推断场景道具 → 边建缺的资产 → 边绑 id → 绑完立刻判能不能并入当前段。
  let shotsPrepared = prepared;
  if (opts.mergeSegments) {
    const before = prepared.length;
    shotsPrepared = mergeIntoSegments(prepared, videoModel);
    if (shotsPrepared.length !== before) {
      warnings.push('已按「时长上限 ' + shotDurationMax(videoModel) + 's 为主、场景切换处优先切」把 ' + before
        + ' 个镜头合并成 ' + shotsPrepared.length + ' 个生成段：镜长与台词逐字保留，只累加段时间码。'
        + '段首站位声明（blocking）仍为空——导入搬的是镜行，写不出人物在空间里的方位，需要在分镜阶段补。');
    }
    // 一段里跨了两个场景（闪回、蒙太奇）的要单独点出来：这类段投喂时场景参考图只能给主场景，
    // 最容易出现「闪回镜头被画成主场景」。人工核一遍比事后返工便宜。
    const multiScene = shotsPrepared.filter((x) => {
      const names = new Set(String(x.sub_shots || '').split('\n').map((l) => (l.match(/场景[：:]\s*([^；;\n]+)/) || [])[1]).filter(Boolean));
      return names.size > 1;
    }).map((x) => x.idx);
    if (multiScene.length) {
      warnings.push('以下生成段内部跨越了多个场景（闪回/蒙太奇），投喂时以段首主场景为主、闪回镜头需在时间轴里单独写场景：第 ' + multiScene.join('、') + ' 段');
    }
  }

  // 章内镜号唯一：显式给的号保留，重复/缺失的顺延
  const used = new Set();
  let cursor = 0;
  for (const p of shotsPrepared) {
    cursor = Math.max(cursor, p.idx);
  }
  const existing = Shots.list(projectId).filter((s) => s.chapter === chapter.title);
  const existingMax = existing.reduce((m, s) => Math.max(m, Number(s.idx) || 0), 0);
  const base = opts.replace === false ? existingMax : 0;
  cursor = base;
  const seq = [];
  for (const p of shotsPrepared) {
    let idx = Number(p.idx) || 0;
    if (!idx || idx <= base || used.has(idx)) { cursor += 1; idx = cursor; } else { cursor = Math.max(cursor, idx); }
    used.add(idx);
    seq.push({ ...p, idx });
  }

  // 内容校验（与外部写入 API 同一套规则：时长区间 / 台词语速 / 说话人数）
  // 「台词超速」单独处理：导入的分镜表往往是已定稿的创作产物，时长是作者的设计值。
  // 若按硬校验拦，一张 62 条的英文分镜表会因为 30 多条长台词整批失败、一条都进不来。
  // 所以超速降级为警告（逐条列出），其余问题（时长越界、说话人超限）仍然阻断。
  const errors = [];
  const speedWarnings = [];
  const speakerOver = [];
  seq.forEach((p, i) => {
    const errs = validateShotContent(p, {}, { videoModel });
    for (const e of errs) {
      const item = '第 ' + (i + 1) + ' 条（镜 ' + p.idx + '）：' + e;
      // 合并段的段级 dialogue 是台词总表，多人开口正常：改成逐子镜核对
      // （七段式的【时间轴分镜】本来就是按镜写台词，一镜两人以上才真会糊）
      if (p._merged && /说话人/.test(e)) { speakerOver.push(item); continue; }
      if (/^dialogue 超速/.test(e)) speedWarnings.push(item);
      else errors.push(item);
    }
  });
  if (speakerOver.length) {
    warnings.push('合并段里多人开口 ' + speakerOver.length + ' 处（段级台词总表允许，投喂时按时间轴逐镜分开口型）：'
      + speakerOver.slice(0, 3).join('｜'));
  }
  if (speedWarnings.length) {
    warnings.push('台词语速偏快 ' + speedWarnings.length + ' 条（不阻断导入；提示词阶段需精简台词或延长时长）：' + speedWarnings.join('｜'));
  }
  if (errors.length && !opts.force) {
    throw Object.assign(new Error('分镜表校验未通过：\n- ' + errors.join('\n- ')), { code: 'IMPORT_VALIDATION', details: errors });
  }

  const report = {
    format: parsed.format,
    chapter: chapter.title,
    total: seq.length,
    shots: seq,
    missing,
    created,
    warnings,
    errors,
    speedWarnings,
  };
  if (opts.dryRun) return { ...report, written: 0 };

  // 落库：整批一个事务（写坏可整批回滚）
  const removeIds = opts.replace === false ? [] : existing.map((s) => s.id);
  const written = tx(() => {
    for (const sid of removeIds) legacyShotWrite('storyboard-import.replace', () => Shots.remove(sid));
    const out = [];
    for (const p of seq) {
      // 内部标记不能落库：pickShotFields 对未知字段是严格拒绝（会整批报错「不接受字段 _merged」），
      // 所以入库前显式去掉下划线开头的内部键。
      const clean = { ...p };
      for (const k of Object.keys(clean)) if (k.startsWith('_')) delete clean[k];
      const { patch, errors: pickErrs } = pickShotFields({ ...clean, chapter: chapter.title }, { videoModel });
      if (pickErrs.length) throw new Error('镜 ' + p.idx + '：' + pickErrs.join('；'));
      out.push(legacyShotWrite('storyboard-import.create', () => Shots.create(projectId, { ...patch, chapter: chapter.title })));
    }
    return out;
  });
  // 锁档一致性提示：导入只搬镜行，不重排锁档。本章锁档若覆盖不到新导入的镜号，
  // Agent 之后 upsert 这些镜会被「镜 N 不属于任何节拍」硬拒（门禁只认锁档的 shotRange），
  // 这种不一致在界面上看不出来，所以在这里显式提示一次。
  try {
    const planFile = path.join(projectDir(projectId), 'context', 'storyboard-plan.json');
    const all = JSON.parse(fs.readFileSync(planFile, 'utf8'));
    const plan = all && all[chapter.title];
    if (plan && Array.isArray(plan.beats) && plan.beats.length) {
      const covered = new Set();
      for (const b of plan.beats) {
        const m = String(b && b.shotRange || '').match(/^\s*(\d+)\s*(?:[-–~至到]\s*(\d+))?\s*$/);
        if (!m) continue;
        const from = Number(m[1]);
        const to = m[2] == null ? from : Number(m[2]);
        for (let k = from; k <= to; k++) covered.add(k);
      }
      const maxIdx = written.length ? Math.max(...written.map((x) => Number(x.idx) || 0)) : 0;
      const orphans = [];
      for (let k = 1; k <= maxIdx; k++) if (!covered.has(k)) orphans.push(k);
      if (orphans.length) {
        warnings.push('锁档覆盖不足：本章锁档只覆盖 ' + covered.size + ' 个镜号（' + plan.beats.length + ' 段节拍），'
          + '镜 ' + orphans.slice(0, 12).join('、') + (orphans.length > 12 ? ' 等 ' + orphans.length + ' 个' : '') + ' 不在任何节拍内。'
          + 'Agent 后续改写这些分镜会因「不属于任何节拍」被拒写——重排/续写前先重写锁档（set_storyboard_plan），或让 Agent 按现有分镜重排。');
      }
    }
  } catch { /* 没有锁档文件时不用提示：agent 阶段会自己建 */ }

  return { ...report, written: written.length, removed: removeIds.length, shots: written };
}
