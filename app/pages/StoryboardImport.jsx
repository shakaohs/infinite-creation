'use client';
// 分镜表批量导入：选文件（xlsx / csv / tsv / md / json）或直接粘贴表格文本。
// 流程固定两段：先 dryRun 预览（条数 / 总时长 / 资产新建 / 校验问题），确认后才真写库。
// 为什么必须有预览：导入是「整章替换」，直接吃掉本章已渲染的分镜不可撤销；
// 而分镜表千奇百怪（表头在第二行、列名不同、单元格带换行），不预览就等于赌。
import { useState, useRef, useEffect } from 'react';
import { Button, Modal, ModalContent, ModalHeader, ModalBody, ModalFooter, Textarea, Switch, Chip, Spinner, Select, SelectItem } from '@heroui/react';
import { api } from '../api-client.js';
import { useToast } from '../toast';

const ACCEPT = '.xlsx,.csv,.tsv,.txt,.md,.json';

function fmtDur(list) {
  const t = (list || []).reduce((s, x) => s + (Number(x.duration) || 0), 0);
  return t ? (t >= 60 ? Math.round(t / 60) + ' 分 ' + (t % 60) + ' 秒' : t + ' 秒') : '—';
}

export default function StoryboardImport({ projectId, chapter, open, onClose, onDone }) {
  const toast = useToast();
  const fileRef = useRef(null);
  const [fileName, setFileName] = useState('');
  const [payload, setPayload] = useState(null); // { file?: base64, table?: text }
  const [pasted, setPasted] = useState('');
  const [preview, setPreview] = useState(null);
  // 一份 xlsx 里常分多张表（EP1 一张、EP2 一张）：必须能选，否则只会取到行数最多的那张
  const [sheet, setSheet] = useState('');
  const [busy, setBusy] = useState('');
  const [replace, setReplace] = useState(true);
  const [createMissing, setCreateMissing] = useState(true);
  // 默认合并：分镜表是「碎镜」（2–8 秒一镜），直接投喂会让段数翻几倍、段缝风险成倍上升。
  // 合并=按「同场景 + 段长上限」把相邻镜并成一个生成段，镜长与台词一个字都不改。
  const [mergeSegments, setMergeSegments] = useState(true);
  // 导入到哪一章：EP1/EP2 这种必须分开导，否则两集会在同一章里混成一条时间线。
  // 上游传进来的 chapter 是当前查看的章，可能为空（全章视图），所以这里自己拉列表兜底。
  const [chapters, setChapters] = useState([]);
  // 路由参数要的是章节 **id**（/chapters/<cid>/...），而上游传进来的 chapter 是标题。
  // 两者混用会得到「章节不存在」，所以这里统一存 id，标题只用于显示。
  const [target, setTarget] = useState('');

  useEffect(() => {
    if (!open) return;
    api.get('/api/projects/' + projectId + '/chapters')
      .then((list) => {
        const arr = Array.isArray(list) ? list : (list?.chapters || []);
        setChapters(arr);
        if (arr.length) {
          // 优先选中当前查看的那一章（按标题对），否则第一章
          const hit = arr.find((c) => c.title === chapter) || arr[0];
          setTarget(hit.id || '');
        }
      })
      .catch(() => {});
  }, [open, projectId]);

  const reset = () => {
    setFileName(''); setPayload(null); setPasted(''); setPreview(null); setBusy(''); setSheet('');
    if (fileRef.current) fileRef.current.value = '';
  };

  const close = () => { if (busy) return; reset(); onClose(); };

  async function pickFile(e) {
    const f = e.target.files && e.target.files[0];
    if (!f) return;
    if (f.size > 20 * 1024 * 1024) { toast.error('文件超过 20MB'); return; }
    setFileName(f.name);
    setPreview(null);
    setPasted('');
    setSheet('');
    // 二进制文件读成 base64 交给后端解析（xlsx 在服务端解成表格文本，前端不引解析库）
    const isBin = /\.(xlsx|xls)$/i.test(f.name);
    if (isBin) {
      const b64 = await new Promise((res, rej) => {
        const r = new FileReader();
        r.onload = () => res(String(r.result || ''));
        r.onerror = () => rej(new Error('读取文件失败'));
        r.readAsDataURL(f);
      }).catch(() => '');
      if (!b64) { toast.error('读取文件失败'); return; }
      setPayload({ file: b64, fileName: f.name });
    } else {
      // Excel「另存为 CSV」默认是 GBK，按 UTF-8 硬读会得到一整片 U+FFFD（乱码），
      // 表头认不出来 → 0 行可导入。这里先 UTF-8 试，坏字符多了再按 GBK 重解。
      const buf = await f.arrayBuffer();
      let text = new TextDecoder('utf-8').decode(buf);
      const badChars = (text.match(/\uFFFD/g) || []).length;
      if (badChars > 3) {
        try { text = new TextDecoder('gbk').decode(buf); } catch { /* 浏览器不支持 gbk 时保持原样 */ }
      }
      text = text.replace(/^\uFEFF/, '');
      setPayload({ table: text, fileName: f.name });
      setPasted(text);
    }
  }

  async function doPreview(sheetOverride) {
    const useSheet = sheetOverride !== undefined ? sheetOverride : sheet;
    const body = payload || (pasted.trim() ? { table: pasted } : null);
    if (!body) { toast.error('先选择文件或粘贴表格'); return; }
    if (!target) { toast.error('先选择要导入的章节'); return; }
    setBusy('解析中…');
    try {
      const r = await api.post('/api/projects/' + projectId + '/chapters/' + encodeURIComponent(target) + '/storyboard/import',
        { ...body, sheet: useSheet || undefined, dryRun: true, replace, createMissing, mergeSegments });
      setPreview(r);
      if (!r.total) toast.error('没有解析出任何分镜行');
    } catch (e) {
      setPreview(null);
      toast.error(e.message || '解析失败');
    } finally { setBusy(''); }
  }

  async function doImport() {
    const body = payload || (pasted.trim() ? { table: pasted } : null);
    if (!body) return;
    setBusy('写入中…');
    try {
      const r = await api.post('/api/projects/' + projectId + '/chapters/' + encodeURIComponent(target) + '/storyboard/import',
        { ...body, sheet: sheet || undefined, replace, createMissing, mergeSegments });
      toast.success('已导入 ' + r.written + ' 条分镜' + (r.created?.length ? '，新建资产 ' + r.created.length + ' 个' : ''));
      reset();
      onClose();
      if (onDone) onDone(r);
    } catch (e) {
      toast.error(e.message || '导入失败');
    } finally { setBusy(''); }
  }

  const warnList = (preview?.warnings || []).filter(Boolean);
  const sample = (preview?.shots || []).slice(0, 3);

  return (
    <Modal isOpen={open} onClose={close} size="3xl" scrollBehavior="inside">
      <ModalContent>
        <ModalHeader className="flex flex-col gap-1">
          导入分镜表 · {(chapters.find((c) => c.id === target) || {}).title || '本章'}
          <span className="muted" style={{ fontSize: 12, fontWeight: 400 }}>
            支持 xlsx / csv / tsv / md / json，也可以直接粘贴表格。先预览，确认后再写库。
          </span>
        </ModalHeader>
        <ModalBody className="gap-3">
          {chapters.length > 0 && (
            <Select
              size="sm"
              label="导入到章节"
              selectedKeys={target ? [target] : []}
              onSelectionChange={(keys) => { const v = [...keys][0]; setTarget(String(v || '')); setPreview(null); }}
              isDisabled={!!busy}
              description="每集单独一章导入，别把两集放进同一章（段缝和时间线会乱）。"
            >
              {chapters.map((c) => <SelectItem key={c.id}>{c.title}</SelectItem>)}
            </Select>
          )}
          <div className="row" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <input ref={fileRef} type="file" accept={ACCEPT} onChange={pickFile} style={{ display: 'none' }} />
            <Button size="sm" variant="flat" onPress={() => fileRef.current && fileRef.current.click()} isDisabled={!!busy}>
              📄 选择文件
            </Button>
            {fileName && <Chip size="sm" variant="flat">{fileName}</Chip>}
            <Button size="sm" color="primary" variant="flat" onPress={() => doPreview()} isLoading={busy === '解析中…'} isDisabled={!!busy || (!payload && !pasted.trim())}>
              解析预览
            </Button>
            {preview && <Button size="sm" variant="light" onPress={reset} isDisabled={!!busy}>清除</Button>}
          </div>

          <Textarea
            label="或粘贴表格文本"
            placeholder={'| 镜号 | 时长 | 景别 | 画面 | 台词 |\n|---|---|---|---|---|\n| 1 | 6 | 远景 | … | … |'}
            minRows={4}
            maxRows={8}
            value={pasted}
            onValueChange={(v) => { setPasted(v); setPayload(null); setPreview(null); if (v) setFileName(''); }}
            description="xlsx 不必粘贴，直接选文件即可（服务端会把工作表解成表格）。"
          />

          <div className="row" style={{ gap: 20, flexWrap: 'wrap' }}>
            <Switch size="sm" isSelected={replace} onValueChange={setReplace}>整章替换（关闭=追加到末尾）</Switch>
            <Switch size="sm" isSelected={createMissing} onValueChange={setCreateMissing}>缺的资产自动创建</Switch>
            <Switch size="sm" isSelected={mergeSegments} onValueChange={(v) => { setMergeSegments(v); setPreview(null); }}>
              合并成生成段
            </Switch>
          </div>

          {busy && (
            <div className="row" style={{ gap: 8, alignItems: 'center' }}><Spinner size="sm" /><span className="muted">{busy}</span></div>
          )}

          {preview && (
            <div style={{ border: '1px solid var(--line, #2a2f3a)', borderRadius: 8, padding: 12 }}>
              <div className="row" style={{ gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
                <Chip size="sm" color="primary" variant="flat">解析到 {preview.total} 条{mergeSegments ? '生成段' : '分镜'}</Chip>
                <Chip size="sm" variant="flat">总时长 {fmtDur(preview.shots)}</Chip>
                <Chip size="sm" variant="flat">格式 {preview.format}</Chip>
                {preview.used && <Chip size="sm" variant="flat">工作表 {preview.used}</Chip>}
                {!!preview.created?.length && <Chip size="sm" color="success" variant="flat">将新建资产 {preview.created.length}</Chip>}
                {!!warnList.length && <Chip size="sm" color="warning" variant="flat">{warnList.length} 条提示</Chip>}
              </div>
              <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>
                前 {sample.length} 条预览（镜号 / 时长 / 镜头 / 台词开头）
              </div>
              <div style={{ fontSize: 12, display: 'flex', flexDirection: 'column', gap: 4 }}>
                {sample.map((s) => (
                  <div key={s.idx} style={{ borderBottom: '1px dashed var(--line, #2a2f3a)', paddingBottom: 4 }}>
                    <b>{s.idx}</b> · {s.duration}s · {String(s.camera || '').slice(0, 40)}
                    <div className="muted" style={{ whiteSpace: 'pre-wrap' }}>{String(s.visual || '').slice(0, 90)}</div>
                    {s.dialogue ? <div style={{ opacity: 0.85 }}>台词：{String(s.dialogue).slice(0, 60)}</div> : null}
                  </div>
                ))}
              </div>
              {preview.sheets && preview.sheets.length > 1 && (
                <div style={{ marginTop: 8 }}>
                  <Select
                    size="sm"
                    label={'这份文件有 ' + preview.sheets.length + ' 张工作表 · 当前用「' + preview.used + '」'}
                    selectedKeys={sheet ? [sheet] : [preview.used]}
                    onSelectionChange={(keys) => {
                      const v = String([...keys][0] || '');
                      setSheet(v);
                      // 换表要立刻按新表重解析（表格内容完全换了一份）；
                      // 直接把 v 传进去，不要依赖 state 更新后的下一次渲染
                      doPreview(v);
                    }}
                  >
                    {preview.sheets.map((x) => <SelectItem key={x.name}>{x.name + '（' + x.rows + ' 行）'}</SelectItem>)}
                  </Select>
                </div>
              )}
              {!!warnList.length && (
                <div style={{ marginTop: 8, fontSize: 12 }}>
                  <div className="muted">提示（不阻断导入）：</div>
                  {warnList.slice(0, 5).map((w, i) => <div key={i} style={{ opacity: 0.85 }}>· {String(w).slice(0, 200)}</div>)}
                  {warnList.length > 5 && <div className="muted">…共 {warnList.length} 条</div>}
                </div>
              )}
              {replace && <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>⚠ 整章替换会删掉本章现有分镜，再写入这 {preview.total} 条。</div>}
            </div>
          )}
        </ModalBody>
        <ModalFooter>
          <Button variant="light" onPress={close} isDisabled={!!busy}>取消</Button>
          <Button color="primary" onPress={doImport} isDisabled={!preview || !!busy}>
            确认导入 {preview ? preview.total + ' 条' : ''}
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}
