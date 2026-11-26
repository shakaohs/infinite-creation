// SwotAtmk/infinite-creation · 开源地址 https://github.com/SwotAtmk/infinite-creation
// 分镜表 xlsx 读取：把 Excel 工作簿解成「二维字符串数组」，交给现有表格解析链路。
//
// 为什么自己解、不装 sheetjs：项目里已经有 adm-zip（xlsx 本质就是 zip + 若干 xml），
// 而分镜表只需要「单元格文本」，不需要样式、公式、合并单元格的完整语义。
// 装一个新依赖会引入体积与许可问题，这里只要 200 行足够。
//
// 支持的单元格类型：
//   t="inlineStr" → <is><t>…</t></is>（多数在线表格导出走这条，本项目的测试表就是）
//   t="s"         → sharedStrings 索引（Excel 另存为走这条）
//   t="str"       → 公式结果字符串
//   其它（无 t / t="n"）→ 数字，原样保留
// 富文本（<r><t>…</t></r>）会把多段 t 拼起来；<t xml:space="preserve"> 的空白保留。
import AdmZip from 'adm-zip';

function decodeXml(s) {
  return String(s || '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, '&');
}

// 从一段 xml 里取所有 <t> 文本并拼接（富文本会拆成多段 <r>）
function textOf(xml) {
  const parts = [];
  const re = /<t[^>]*>([\s\S]*?)<\/t>/g;
  let m;
  while ((m = re.exec(xml))) parts.push(decodeXml(m[1]));
  return parts.join('');
}

// A1 → 列号（A=1, Z=26, AA=27）
function colOf(ref) {
  const m = String(ref || '').match(/^([A-Z]+)/);
  if (!m) return 0;
  let n = 0;
  for (const ch of m[1]) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n;
}

function parseSharedStrings(xml) {
  if (!xml) return [];
  const out = [];
  const re = /<si>([\s\S]*?)<\/si>/g;
  let m;
  while ((m = re.exec(xml))) out.push(textOf(m[1]));
  return out;
}

function parseSheet(xml, shared) {
  const rows = [];
  const rowRe = /<row[^>]*>([\s\S]*?)<\/row>/g;
  const cellRe = /<c([^>]*)>([\s\S]*?)<\/c>|<c([^>]*)\/>/g;
  let rm;
  while ((rm = rowRe.exec(xml))) {
    const body = rm[1];
    const cells = [];
    let cm;
    cellRe.lastIndex = 0;
    while ((cm = cellRe.exec(body))) {
      const attrs = cm[1] || cm[3] || '';
      const inner = cm[2] || '';
      const refM = attrs.match(/\br="([A-Z]+\d+)"/);
      const tM = attrs.match(/\bt="([^"]+)"/);
      const type = tM ? tM[1] : '';
      let val = '';
      if (type === 'inlineStr') {
        val = textOf(inner);
      } else if (type === 's') {
        const vM = inner.match(/<v>([\s\S]*?)<\/v>/);
        const idx = vM ? Number(decodeXml(vM[1])) : -1;
        val = Number.isFinite(idx) && idx >= 0 ? (shared[idx] ?? '') : '';
      } else if (type === 'str') {
        val = textOf(inner);
      } else {
        const vM = inner.match(/<v>([\s\S]*?)<\/v>/);
        val = vM ? decodeXml(vM[1]) : '';
        // 日期是 Excel 的序列号：分镜表里不会用到，保持原样交给上层（不可解析时上层会丢弃）
      }
      const col = refM ? colOf(refM[1]) : cells.length + 1;
      if (col > 0) cells[col - 1] = val;
    }
    // 补空洞（合并单元格/缺列）
    for (let i = 0; i < cells.length; i++) if (cells[i] == null) cells[i] = '';
    if (cells.some((c) => String(c).trim())) rows.push(cells);
  }
  return rows;
}

// 表头词：用来在「剧名/说明行」之下找到真正的那一行列名。
// 分镜表第一行经常是《剧名》或「第 1 集 分镜脚本」这种跨列标题，直接当表头会让整表 0 行可解析
// （实测：F1 那张表首行是剧名，解析结果 0 条 + 63 条警告）。
const HEADER_HINTS = [
  '镜号', '分镜号', '镜头号', '序号', '编号', '段号',
  '景别', '焦段', '机位', '运镜', '镜头', '画面', '时长', '时间',
  '台词', '对白', '对话', '角色', '人物', '场景', '道具', '动作', '声音', '音效', '旁白',
  'shot', 'no', 'duration', 'camera', 'visual', 'dialogue', 'character', 'scene',
];

function headerScore(row) {
  const cells = row.map((c) => String(c || '').trim()).filter(Boolean);
  if (cells.length < 3) return 0;
  let hit = 0;
  for (const c of cells) {
    const low = c.toLowerCase();
    if (HEADER_HINTS.some((h) => low === h.toLowerCase() || (c.length <= 8 && low.includes(h.toLowerCase())))) hit++;
  }
  // 命中多、且命中率高的那行最可能是表头
  return hit >= 2 ? hit * 10 + Math.round((hit / cells.length) * 5) : 0;
}

// 把行数组转成 Markdown 表格：复用 importStoryboard 已有的 md 解析（列名→字段的别名匹配都在那儿）
function toMarkdownTable(rows) {
  if (!rows.length) return '';
  // 跳过前置标题行：在前 8 行里找表头分最高的一行，之前的内容（剧名、说明）丢弃
  let hi = 0;
  let bestScore = 0;
  for (let i = 0; i < Math.min(rows.length, 8); i++) {
    const sc = headerScore(rows[i]);
    if (sc > bestScore) { bestScore = sc; hi = i; }
  }
  const dataRows = bestScore > 0 ? rows.slice(hi) : rows;
  const width = Math.max(...dataRows.map((r) => r.length));
  const norm = dataRows.map((r) => {
    const a = r.slice();
    while (a.length < width) a.push('');
    return a.map((c) => String(c ?? '').replace(/\r\n?/g, '\n').replace(/\|/g, '｜').trim());
  });
  const head = norm[0];
  const body = norm.slice(1);
  const line = (cells) => '| ' + cells.join(' | ') + ' |';
  return [line(head), '|' + new Array(width).fill('---').join('|') + '|', ...body.map(line)].join('\n');
}

/**
 * 读 xlsx → Markdown 表格文本
 * @param {Buffer|string} input 文件二进制，或 base64（可带 data: 前缀）
 * @returns {{ table: string, sheets: {name:string, rows:number}[], used: string }}
 */
export function xlsxToTable(input, opts = {}) {
  let buf = input;
  if (typeof input === 'string') {
    const b64 = input.replace(/^data:[^,]*,/, '');
    buf = Buffer.from(b64, 'base64');
  }
  if (!Buffer.isBuffer(buf) || !buf.length) throw new Error('xlsx 内容为空');
  // zip 头校验：PK\x03\x04。不是 xlsx 时给出明确提示，别让 AdmZip 抛模糊错误
  if (!(buf[0] === 0x50 && buf[1] === 0x4b)) {
    throw new Error('不是有效的 xlsx 文件（可能是改名后的 csv/xls）。csv 请直接按文本导入，xls 请另存为 xlsx');
  }
  const zip = new AdmZip(buf);
  const shared = parseSharedStrings(zip.readAsText('xl/sharedStrings.xml', 'utf8') || '');

  // 工作表顺序按 workbook.xml 来；文件名靠 rels 映射（sheet1.xml 不一定对应第 1 张表）
  const wb = zip.readAsText('xl/workbook.xml', 'utf8') || '';
  const rels = zip.readAsText('xl/_rels/workbook.xml.rels', 'utf8') || '';
  const relMap = new Map();
  const relRe = /<Relationship[^>]*Id="([^"]+)"[^>]*Target="([^"]+)"[^>]*\/>|<Relationship[^>]*Target="([^"]+)"[^>]*Id="([^"]+)"[^>]*\/>/g;
  let rm;
  while ((rm = relRe.exec(rels))) {
    const id = rm[1] || rm[4];
    const target = rm[2] || rm[3];
    if (id && target) relMap.set(id, target.replace(/^\/?xl\//, '').replace(/^\//, ''));
  }
  const sheets = [];
  const sheetRe = /<sheet[^>]*name="([^"]*)"[^>]*r:id="([^"]+)"[^>]*\/>/g;
  let sm;
  while ((sm = sheetRe.exec(wb))) {
    const path = relMap.get(sm[2]);
    if (path) sheets.push({ name: decodeXml(sm[1]), path });
  }
  if (!sheets.length) {
    // workbook 里没写（极少见）：退回扫描 zip 里的 worksheets
    for (const e of zip.getEntries()) {
      const m = e.entryName.match(/^xl\/worksheets\/sheet\d+\.xml$/);
      if (m) sheets.push({ name: e.entryName.replace(/^xl\/worksheets\/|\.xml$/g, ''), path: e.entryName.replace(/^xl\//, '') });
    }
  }

  const parsed = [];
  for (const s of sheets) {
    const xml = zip.readAsText('xl/' + s.path, 'utf8') || '';
    const rows = parseSheet(xml, shared);
    if (rows.length) parsed.push({ name: s.name, rows });
  }
  if (!parsed.length) throw new Error('xlsx 里没有可读的表格数据');

  // 指定了工作表就用它（EP1/EP2 常分两个 sheet，必须能选）；没指定或名字对不上，
  // 取行数最多的那张（有人把说明页放在第一张，按第一张取会得到一张说明表）。
  const wantSheet = String(opts.sheet || '').trim();
  const picked = (wantSheet && parsed.find((p) => p.name === wantSheet))
    || parsed.slice().sort((a, b) => b.rows.length - a.rows.length)[0];
  return {
    table: toMarkdownTable(picked.rows),
    sheets: parsed.map((p) => ({ name: p.name, rows: p.rows.length })),
    used: picked.name,
    sheetMissing: !!(wantSheet && !parsed.find((p) => p.name === wantSheet)) ? wantSheet : '',
  };
}

export default xlsxToTable;
