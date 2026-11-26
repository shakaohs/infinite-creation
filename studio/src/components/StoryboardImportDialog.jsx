import { useMemo, useRef, useState } from 'react';
import { FileText, Upload, Wand2, AlertTriangle, CheckCircle2 } from 'lucide-react';
import { api } from '../lib/api.js';
import { Badge, Button, Checkbox, Field, Input, Select, Spinner, Textarea } from './ui.jsx';
import { Modal } from './overlays.jsx';
import { useToast } from './toast.jsx';

// 分镜表批量导入：粘贴 / 上传一份分镜表（xlsx · csv · tsv · md · json），
// 先「解析预览」看资产匹配结果，再确认导入。
// xlsx 不在前端解析：读成 base64 交给后端（服务端用解压库解工作表），
// 这样前端不用引 sheetjs，也不会因为表头在第二行、单元格内换行而解错。
const SAMPLE = `| 镜号 | 时长 | 场次 | 景别/机位 | 画面 | 台词 | 角色 | 场景 | 道具 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 5 | 第1场 夜 客厅 | 中近景｜平视｜固定机位 | 林昭站在窗边，手里捏着一封信，窗外雨打玻璃 | 林昭：这封信，你什么时候收到的？ | 林昭、周牧 | 客厅 | 信封 |
| 2 | 6 | 第1场 夜 客厅 | 近景｜平视｜微推 | 周牧坐在沙发上，没有抬头，指节敲着扶手 | 周牧：比你想象得早。 | 周牧 | 客厅 |  |`;

export default function StoryboardImportDialog({ open, onOpenChange, projectId, chapters = [], defaultChapterId = '', onImported }) {
  const toast = useToast();
  const fileRef = useRef(null);
  const [chapterId, setChapterId] = useState(defaultChapterId || chapters[0]?.id || '');
  const [table, setTable] = useState('');
  // 二进制文件（xlsx）走 base64 直传；文本文件读成 table。两者二选一。
  const [filePayload, setFilePayload] = useState(null);
  const [fileName, setFileName] = useState('');
  const [sheet, setSheet] = useState('');
  const [replace, setReplace] = useState(true);
  const [createMissing, setCreateMissing] = useState(true);
  // 碎镜合并成生成段：分镜表多是 2–8 秒一镜，直接当生成段投喂会让段数翻几倍、段缝风险成倍上升。
  // 合并只累加时间码、台词逐字搬运，镜长不改。
  const [mergeSegments, setMergeSegments] = useState(true);
  const [preview, setPreview] = useState(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');

  const chapterTitle = useMemo(() => chapters.find((c) => c.id === chapterId)?.title || '', [chapters, chapterId]);

  const reset = () => { setPreview(null); setError(''); };

  const canSubmit = !!filePayload || !!table.trim();
  const post = (dryRun) => {
    if (!canSubmit) { setError('请先粘贴分镜表内容，或上传一个文件'); return Promise.reject(new Error('empty')); }
    if (!chapterId) { setError('请选择要导入的章节'); return Promise.reject(new Error('no-chapter')); }
    const body = filePayload ? { ...filePayload } : { table };
    return api.post('/api/projects/' + projectId + '/chapters/' + chapterId + '/storyboard/import', {
      ...body, sheet: sheet || undefined, dryRun, replace, createMissing, mergeSegments,
    });
  };

  async function doPreview() {
    setBusy('preview'); setError(''); setPreview(null);
    try {
      const r = await post(true);
      setPreview({ ...r, dryRun: true });
      if (!r.total) setError('没有解析出任何分镜行');
    } catch (e) {
      if (e && e.message !== 'empty' && e.message !== 'no-chapter') setError(e.message);
    } finally { setBusy(''); }
  }

  async function doImport() {
    setBusy('import'); setError('');
    try {
      const r = await post(false);
      setPreview({ ...r, dryRun: false });
      if (r.written) {
        toast.success('已导入 ' + r.written + ' 条分镜到「' + r.chapter + '」');
        if (onImported) await onImported();
      }
    } catch (e) {
      if (e && e.message !== 'empty' && e.message !== 'no-chapter') setError(e.message);
    } finally { setBusy(''); }
  }

  async function onPickFile(e) {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (!f) return;
    if (f.size > 20 * 1024 * 1024) { setError('文件超过 20MB，先拆分再导入'); return; }
    if (/\.xls$/i.test(f.name)) {
      setError('老版 .xls 不支持，请在 Excel / WPS 里「另存为 .xlsx」后重试（或导出 CSV）');
      return;
    }
    try {
      if (/\.xlsx$/i.test(f.name)) {
        // base64 交给后端解：前端解 xlsx 要引 sheetjs，且解不对「表头在第二行 / 单元格内换行」
        const buf = await f.arrayBuffer();
        let bin = '';
        const bytes = new Uint8Array(buf);
        for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
        setFilePayload({ file: btoa(bin), fileName: f.name });
        setTable('');
        setFileName(f.name);
        setSheet('');
        reset();
        toast.success('已读取 ' + f.name + '，点「解析预览」看解析结果');
        return;
      }
      // Excel 导出的 CSV 默认 GBK，按 UTF-8 硬读是整片乱码（表头认不出 → 0 行可导入）
      const buf = await f.arrayBuffer();
      let text = new TextDecoder('utf-8').decode(buf);
      if ((text.match(/\uFFFD/g) || []).length > 3) {
        try { text = new TextDecoder('gbk').decode(buf); } catch { /* 浏览器不支持 gbk 时保持原样 */ }
      }
      text = text.replace(/^\uFEFF/, '');
      setTable(text);
      setFilePayload(null);
      setFileName(f.name);
      setSheet('');
      reset();
      toast.success('已读取 ' + f.name);
    } catch (err) { toast.error('读取文件失败：' + err.message); }
  }

  const missingByRow = useMemo(() => {
    const m = new Map();
    for (const x of preview?.missing || []) {
      const k = x.field;
      m.set(k, (m.get(k) || 0) + 1);
    }
    return [...m.entries()];
  }, [preview]);

  return (
    <Modal
      open={open}
      onOpenChange={(v) => { if (!v) reset(); onOpenChange(v); }}
      title="批量导入分镜表"
      description="支持 xlsx / CSV / TSV / Markdown / JSON；表里的角色、场景、道具会按名字绑定到项目资产，缺的自动建。开「合并成生成段」时按同场景+段长上限把碎镜并成 25–30 秒的生成段（台词逐字保留）。"
      size="lg"
      footer={
        <div className="flex w-full items-center justify-between gap-3">
          <span className="text-[11px] text-[var(--fg-4)]">
            {preview ? (preview.dryRun ? '预览结果未落库' : '已写入 ' + (preview.written || 0) + ' 条') : '先解析预览，确认资产匹配再导入'}
          </span>
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="md" onClick={() => onOpenChange(false)}>关闭</Button>
            <Button variant="secondary" size="md" loading={busy === 'preview'} disabled={!!busy || !canSubmit} onClick={doPreview}>
              <Wand2 size={13} /> 解析预览
            </Button>
            <Button variant="primary" size="md" loading={busy === 'import'} disabled={!!busy || !preview} onClick={doImport}>
              <Upload size={13} /> {replace ? '替换本章并导入' : '追加导入'}
            </Button>
          </div>
        </div>
      }
    >
      <div className="flex flex-col gap-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="导入到章节">
            <Select
              value={chapterId}
              onChange={(v) => { setChapterId(v); reset(); }}
              items={chapters.map((c) => ({ value: c.id, label: c.title }))}
              placeholder="选择章节"
            />
          </Field>
          <Field label="分镜表文件" hint="支持 .xlsx / .csv / .tsv / .md / .json，也可以直接粘贴到下面">
            <div className="flex items-center gap-2">
              <Button variant="secondary" size="md" onClick={() => fileRef.current?.click()}>
                <FileText size={13} /> 选择文件
              </Button>
              <input ref={fileRef} type="file" accept=".xlsx,.xls,.md,.markdown,.csv,.tsv,.txt,.json" className="hidden" onChange={onPickFile} />
              <Button variant="ghost" size="md" onClick={() => { setTable(SAMPLE); reset(); }}>填入示例</Button>
            </div>
          </Field>
        </div>

        <Field label="分镜表内容" hint="表头会自动识别：镜号 / 时长 / 场次 / 景别·机位·运镜 / 画面 / 台词 / 旁白 / 时间轴 / 角色 / 场景 / 道具 / 服装 / 年龄 / 音频">
          <Textarea
            rows={9}
            value={table}
            onChange={(e) => { setTable(e.target.value); reset(); }}
            placeholder={SAMPLE}
            className="font-mono text-[12px] leading-relaxed"
          />
        </Field>

        <div className="flex flex-wrap items-center gap-4 rounded-xl border border-[var(--line)] bg-white/[0.02] px-3 py-2.5">
          <Checkbox checked={replace} onChange={(v) => { setReplace(v); reset(); }} label="整章替换（清空本章现有分镜）" />
          <Checkbox checked={createMissing} onChange={(v) => { setCreateMissing(v); reset(); }} label="自动创建缺失的角色/场景/道具资产" />
          <Checkbox checked={mergeSegments} onChange={(v) => { setMergeSegments(v); reset(); }} label="合并成生成段（碎镜 → 25–30 秒段）" />
          {fileName ? <span className="text-[11px] text-[var(--fg-4)]">文件：{fileName}</span> : null}
          <span className="text-[11px] text-[var(--fg-4)]">目标：{chapterTitle || '未选择'}</span>
        </div>

        {error ? (
          <div className="rounded-xl border border-[color-mix(in_srgb,var(--danger)_30%,transparent)] bg-[color-mix(in_srgb,var(--danger)_8%,transparent)] px-3 py-2 text-[12px] leading-relaxed text-[var(--danger)] whitespace-pre-wrap">
            {error}
          </div>
        ) : null}

        {busy === 'preview' && !preview ? (
          <div className="flex items-center gap-2 text-[12px] text-[var(--fg-3)]"><Spinner size={14} /> 正在解析…</div>
        ) : null}

        {preview ? (
          <div className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone="accent">{preview.format || 'table'}</Badge>
              <Badge tone="neutral">共 {preview.total} {mergeSegments ? '段' : '镜'}</Badge>
              {preview.used ? <Badge tone="neutral">工作表 {preview.used}</Badge> : null}
              {preview.total ? (
                <Badge tone="neutral">
                  总时长 {preview.shots.reduce((a, b) => a + (Number(b.duration) || 0), 0)}s
                </Badge>
              ) : null}
              {preview.created?.length ? <Badge tone="info">新建资产 {preview.created.length}</Badge> : null}
              {preview.missing?.length ? <Badge tone="danger">未匹配 {preview.missing.length}</Badge> : <Badge tone="success">资产全部命中</Badge>}
              {preview.removed ? <Badge tone="neutral">清空旧分镜 {preview.removed}</Badge> : null}
            </div>

            {preview.created?.length ? (
              <div className="rounded-xl border border-[var(--line)] bg-white/[0.02] px-3 py-2">
                <p className="m-0 mb-1 flex items-center gap-1.5 text-[12px] font-medium text-[var(--fg-2)]">
                  <CheckCircle2 size={13} className="text-[var(--info)]" /> 将新建这些资产（占位，稍后可在素材库补描述并出图）
                </p>
                <p className="m-0 text-[11.5px] leading-relaxed text-[var(--fg-3)]">
                  {preview.created.map((c) => c.name + '（' + c.category + '）').join('、')}
                </p>
              </div>
            ) : null}

            {preview.missing?.length ? (
              <div className="rounded-xl border border-[#d97706]/35 bg-[#d97706]/10 px-3 py-2">
                <p className="m-0 mb-1 flex items-center gap-1.5 text-[12px] font-medium text-[var(--fg-2)]">
                  <AlertTriangle size={13} className="text-[#d97706]" /> 这些引用没匹配到资产（会被跳过绑定）
                </p>
                <ul className="m-0 list-disc pl-5 text-[11.5px] leading-relaxed text-[var(--fg-3)]">
                  {preview.missing.slice(0, 12).map((m, i) => (
                    <li key={i}>第 {m.row} 行 · {m.name}（{m.category}）{m.hint ? '：' + m.hint : ''}</li>
                  ))}
                  {preview.missing.length > 12 ? <li>…另有 {preview.missing.length - 12} 条</li> : null}
                </ul>
              </div>
            ) : null}

            {preview.warnings?.length ? (
              <p className="m-0 text-[11.5px] leading-relaxed text-[var(--fg-4)]">提示：{preview.warnings.slice(0, 6).join('；')}</p>
            ) : null}

            <div className="overflow-hidden rounded-xl border border-[var(--line)]">
              <table className="w-full border-collapse text-[11.5px]">
                <thead>
                  <tr className="bg-white/[0.03] text-left text-[var(--fg-3)]">
                    <th className="px-2 py-1.5 font-medium">镜号</th>
                    <th className="px-2 py-1.5 font-medium">时长</th>
                    <th className="px-2 py-1.5 font-medium">场次</th>
                    <th className="px-2 py-1.5 font-medium">画面</th>
                    <th className="px-2 py-1.5 font-medium">台词</th>
                    <th className="px-2 py-1.5 font-medium">子镜</th>
                    <th className="px-2 py-1.5 font-medium">角色/场景</th>
                  </tr>
                </thead>
                <tbody>
                  {(preview.shots || []).slice(0, 12).map((s, i) => (
                    <tr key={i} className="border-t border-[var(--line)] align-top text-[var(--fg-2)]">
                      <td className="px-2 py-1.5">{s.idx}</td>
                      <td className="px-2 py-1.5">{s.duration}s</td>
                      <td className="max-w-[120px] truncate px-2 py-1.5">{s.scene_name || '—'}</td>
                      <td className="max-w-[220px] truncate px-2 py-1.5" title={s.visual}>{s.visual || '—'}</td>
                      <td className="max-w-[200px] truncate px-2 py-1.5" title={s.dialogue}>{s.dialogue || '—'}</td>
                      <td className="px-2 py-1.5">{String(s.sub_shots || '').split('\n').filter(Boolean).length || 1}</td>
                      <td className="px-2 py-1.5">{(s.character_ids?.length || 0) + '/' + (s.scene_ids?.length || 0)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {preview.shots?.length > 12 ? (
                <p className="m-0 px-2 py-1.5 text-[11px] text-[var(--fg-4)]">…另有 {preview.shots.length - 12} 条，导入后可在下方列表查看</p>
              ) : null}
            </div>
            <p className="m-0 text-[11px] leading-relaxed text-[var(--fg-4)]">
              导入后：分镜进入「分镜审查」列表，可逐镜补素材/改提示词，再点「生成候选」出片。镜号重复会自动顺延，不会撞号。
            </p>
          </div>
        ) : null}
      </div>
    </Modal>
  );
}
