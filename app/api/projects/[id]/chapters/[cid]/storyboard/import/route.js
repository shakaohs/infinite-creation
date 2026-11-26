// SwotAtmk/infinite-creation · 开源地址 https://github.com/SwotAtmk/infinite-creation
import { NextResponse } from 'next/server';
import { Projects, Chapters, importStoryboard, xlsxToTable, withWriteContext } from '@/lib/core/index.js';
import { activeJobOfChapter } from '@/lib/agent/index.js';

export const dynamic = 'force-dynamic';

// 分镜表批量导入：把用户手上的分镜表一次性变成本章分镜。
// 支持三种送法（都在这里归一成「表格文本」再进 importStoryboard）：
//   ① JSON { table }            —— 前端粘贴 / 已有的文本
//   ② JSON { file, fileName }   —— file 是 base64（可带 data: 前缀），xlsx/xls 走 xlsxToTable
//   ③ multipart/form-data       —— 直接上传文件（浏览器 <input type=file> 走这条最省事）
// 文本类（md / csv / tsv / json）原样进；二进制 xlsx 先解成 Markdown 表格再进。
//
// body（JSON 或 form 字段）:
//   table         string  分镜表原文（与 file 二选一）
//   file          string  文件 base64（与 table 二选一）
//   fileName      string  文件名，用来判断类型（.xlsx 走解析，.csv/.md 当文本）
//   sheet         string  xlsx 里的工作表名（不给则取行数最多的那张）
//   replace       bool    默认 true = 整章替换；false = 追加到本章末尾
//   createMissing bool    默认 true = 表里出现但库里没有的资产自动建
//   dryRun        bool    默认 false = 只解析返回预览（不落库）
//   force         bool    默认 false = 校验不过就整批拒绝
export async function POST(req, { params }) {
  const { id, cid } = await params;
  if (!Projects.get(id)) return NextResponse.json({ error: '项目不存在' }, { status: 404 });
  // cid 一般是章节 id（路由约定），但聊天里/手写脚本时常直接给章节标题（「第1章」）。
  // 两种都认：先按 id 取，取不到再按标题在本项目里找——否则用户看到的是「章节不存在」，
  // 完全看不出是自己把标题当 id 传了。
  const chapter = Chapters.get(cid)
    || Chapters.list(id).find((c) => c.title === cid || c.title === decodeURIComponent(String(cid || '')));
  if (!chapter || chapter.project_id !== id) return NextResponse.json({ error: '章节不存在' }, { status: 404 });

  const ct = String(req.headers.get('content-type') || '');
  let body = {};
  let fileBuf = null;
  let fileName = '';

  if (ct.includes('multipart/form-data')) {
    const form = await req.formData().catch(() => null);
    if (!form) return NextResponse.json({ error: '表单解析失败' }, { status: 400 });
    for (const [k, v] of form.entries()) {
      if (typeof v === 'string') body[k] = v;
      else if (v && typeof v.arrayBuffer === 'function') {
        fileName = v.name || '';
        fileBuf = Buffer.from(await v.arrayBuffer());
      }
    }
    // form 里的布尔是字符串
    body.dryRun = body.dryRun === 'true' || body.dryRun === true;
    body.replace = body.replace === 'false' ? false : true;
    body.createMissing = body.createMissing !== 'false';
    body.mergeSegments = body.mergeSegments === 'true';
    body.force = body.force === 'true';
  } else {
    body = await req.json().catch(() => ({}));
    fileName = String(body?.fileName || '');
    if (body?.file) {
      const b64 = String(body.file).replace(/^data:[^,]*,/, '');
      fileBuf = Buffer.from(b64, 'base64');
    }
  }

  // xlsx / xls 走解析；文本类直接当 table
  let table = String(body?.table || '');
  let sheetInfo = null;
  const looksXlsx = fileBuf && (
    /\.xlsx$/i.test(fileName) || (fileBuf[0] === 0x50 && fileBuf[1] === 0x4b)
  );
  const looksXlsOld = fileBuf && /\.xls$/i.test(fileName) && !looksXlsx;
  if (looksXlsOld) {
    return NextResponse.json({
      error: '老版 .xls 二进制格式不支持，请在 Excel/WPS 里「另存为 .xlsx」后重试（或导出 CSV）',
    }, { status: 400 });
  }
  if (looksXlsx) {
    try {
      const r = xlsxToTable(fileBuf, { sheet: body?.sheet });
      table = r.table;
      sheetInfo = { sheets: r.sheets, used: r.used, ...(r.sheetMissing ? { sheetMissing: r.sheetMissing } : {}) };
    } catch (e) {
      return NextResponse.json({ error: 'xlsx 解析失败：' + (e?.message || e) }, { status: 400 });
    }
  } else if (fileBuf && !table) {
    // 文本文件（csv / tsv / md / json）：按 UTF-8 读，去掉 BOM
    table = fileBuf.toString('utf8').replace(/^\uFEFF/, '');
  }

  if (!table.trim()) return NextResponse.json({ error: '缺少分镜表内容（table 或 file）' }, { status: 400 });
  if (table.length > 800_000) return NextResponse.json({ error: '分镜表过大（单次最多 800KB 文本）' }, { status: 400 });
  const dryRun = body?.dryRun === true;
  const replace = body?.replace !== false;

  // 整章替换会删掉本章已渲染的分镜：有任务在跑时先挡住（与整章写入接口同口径）
  if (replace && !dryRun && activeJobOfChapter(id, chapter.title)) {
    return NextResponse.json({ error: '本章正在运行任务，运行中不可整章替换分镜；请等任务结束或改选「追加导入」' }, { status: 409 });
  }

  try {
    const run = () => importStoryboard(id, chapter.title, table, {
      replace,
      createMissing: body?.createMissing !== false,
      mergeSegments: body?.mergeSegments === true,
      dryRun,
      force: body?.force === true,
    });
    const result = dryRun
      ? await run()
      : await withWriteContext('POST /api/projects/:id/chapters/:cid/storyboard/import', run);
    return NextResponse.json({ ok: true, ...result, ...(sheetInfo ? { fromFile: fileName || 'xlsx', ...sheetInfo } : {}) });
  } catch (e) {
    // 校验类错误带上逐条明细，前端可直接展示「哪一镜哪一条不合格」
    const detail = Array.isArray(e?.details) ? e.details : null;
    return NextResponse.json({ error: e?.message || '导入失败', details: detail }, { status: 400 });
  }
}
