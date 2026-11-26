import { useEffect, useState } from 'react';
import { Plus, Trash2, ChevronDown, ChevronRight, Globe, Zap, ExternalLink } from 'lucide-react';
import { Badge, Button, Checkbox, Field, Input, Select, Switch, Textarea } from './ui.jsx';

const KIND_ITEMS = [
  { value: 'video', label: '视频' },
  { value: 'image', label: '出图' },
];

// 可接入的任务类型：与 lib/core/engine-runner.js 的 FAMILY_OF_KIND 对齐
const TASK_ITEMS = {
  image: [
    { value: 't2i', label: '文生图（资产图）' },
    { value: 'i2i', label: '图生图（换装/年龄/参考派生）' },
  ],
  video: [
    { value: 'r2v', label: '参考生视频（分镜主力）' },
    { value: 'i2v', label: '图生视频（首帧）' },
    { value: 't2v', label: '文生视频' },
    { value: 'digital_human', label: '数字人' },
  ],
};

// 新建引擎的默认模板：一套「提交 → 轮询 → 下载」通用配置，字段见 lib/core/engine-http.js。
const NEW_ENGINE = {
  id: '',
  name: '',
  kind: 'video',
  enabled: false,
  tasks: ['r2v'],
  baseUrl: '',
  apiKey: '',
  model: '',
  authHeader: 'Authorization',
  authPrefix: 'Bearer ',
  submitPath: '/v1/tasks',
  pollPath: '/v1/tasks/{taskId}',
  requestTemplate: '{"model":"{model}","input":{"prompt":"{prompt}","aspect_ratio":"{aspect_ratio}","resolution":"{resolution}","duration":"{duration}"}}',
  taskIdPath: 'data.taskId',
  statusPath: 'data.status',
  doneValues: 'succeeded,completed,done,success',
  failValues: 'failed,error,fail',
  outputUrlPath: 'data.output.url',
};

function uid() {
  return 'eng-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

// 单个引擎的编辑表单（展开时显示）
function EngineForm({ engine, onChange, onRemove }) {
  const set = (k, v) => onChange({ ...engine, [k]: v });
  const tasks = Array.isArray(engine.tasks) ? engine.tasks : [];
  const taskItems = TASK_ITEMS[engine.kind] || TASK_ITEMS.video;
  const toggleTask = (value, checked) => {
    const next = checked ? [...new Set([...tasks, value])] : tasks.filter((t) => t !== value);
    set('tasks', next);
  };
  return (
    <div className="flex flex-col gap-3 rounded-xl border border-[var(--line)] bg-white/[0.02] p-3">
      <div className="rounded-lg border border-[var(--line)] bg-black/20 px-3 py-2">
        <Switch
          checked={!!engine.enabled}
          onChange={(v) => set('enabled', v)}
          label="启用该引擎（接管对应任务的渲染）"
          hint="启用后，命中「类型 + 接入任务」的生成不再走 ComfyUI/RunningHub，直接调这条 API；关掉即回到原通道。"
        />
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="名称">
          <Input value={engine.name || ''} onChange={(e) => set('name', e.target.value)} placeholder="如：即梦 Seedance 2.5" />
        </Field>
        <Field label="类型">
          <Select
            value={engine.kind || 'video'}
            onChange={(v) => {
              // 换类型时把接入任务收敛到新类型的默认项，避免留下 image/video 混装的脏配置
              onChange({ ...engine, kind: v, tasks: (TASK_ITEMS[v] || TASK_ITEMS.video).slice(0, 1).map((t) => t.value) });
            }}
            items={KIND_ITEMS}
          />
        </Field>
        <Field label="API 地址">
          <Input value={engine.baseUrl || ''} onChange={(e) => set('baseUrl', e.target.value)} placeholder="https://api.example.com" />
        </Field>
        <Field label="Api-key">
          <Input type="password" value={engine.apiKey || ''} onChange={(e) => set('apiKey', e.target.value)} placeholder="sk-..." />
        </Field>
        <Field label="模型（{model} 占位）">
          <Input value={engine.model || ''} onChange={(e) => set('model', e.target.value)} placeholder="如 seedance-2.5-pro / wan2.7-t2i" />
        </Field>
        <Field label="鉴权（Header · 前缀）">
          <div className="grid grid-cols-[1fr_auto] gap-2">
            <Input value={engine.authHeader || 'Authorization'} onChange={(e) => set('authHeader', e.target.value)} placeholder="Authorization" />
            <Input value={engine.authPrefix ?? 'Bearer '} onChange={(e) => set('authPrefix', e.target.value)} placeholder="Bearer " className="w-[110px]" />
          </div>
        </Field>
      </div>
      <Field label="接管哪些生成任务" hint="不勾 = 该类型的全部任务都接管；只勾部分则其余任务仍走 ComfyUI">
        <div className="flex flex-wrap gap-3 pt-1">
          {taskItems.map((t) => (
            <Checkbox key={t.value} checked={tasks.includes(t.value)} onChange={(v) => toggleTask(t.value, v)} label={t.label} />
          ))}
        </div>
      </Field>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="提交路径（POST）">
          <Input value={engine.submitPath || ''} onChange={(e) => set('submitPath', e.target.value)} placeholder="/v1/tasks" />
        </Field>
        <Field label="轮询路径（GET，{taskId} 占位）">
          <Input value={engine.pollPath || ''} onChange={(e) => set('pollPath', e.target.value)} placeholder="/v1/tasks/{taskId}" />
        </Field>
      </div>
      <Field
        label="请求体模板（JSON · 占位符见下）"
        hint="{prompt} {negative_prompt} {model} {aspect_ratio} {resolution} {duration} {width} {height} {seed} {image} {images_json} {videos_json} {audios_json} {apiKey}"
      >
        <Textarea rows={4} value={engine.requestTemplate || ''} onChange={(e) => set('requestTemplate', e.target.value)} className="font-mono text-[12px]" />
      </Field>
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="taskId 提取路径">
          <Input value={engine.taskIdPath || ''} onChange={(e) => set('taskIdPath', e.target.value)} placeholder="data.taskId" />
        </Field>
        <Field label="状态提取路径">
          <Input value={engine.statusPath || ''} onChange={(e) => set('statusPath', e.target.value)} placeholder="data.status" />
        </Field>
        <Field label="产物 URL 提取路径">
          <Input value={engine.outputUrlPath || ''} onChange={(e) => set('outputUrlPath', e.target.value)} placeholder="data.output.url" />
        </Field>
        <Field label="完成状态值（逗号分隔）">
          <Input value={engine.doneValues || ''} onChange={(e) => set('doneValues', e.target.value)} placeholder="succeeded,completed,done,success" />
        </Field>
        <Field label="失败状态值（逗号分隔）">
          <Input value={engine.failValues || ''} onChange={(e) => set('failValues', e.target.value)} placeholder="failed,error,fail" />
        </Field>
      </div>
      <div className="flex items-center justify-between gap-3 pt-1">
        <p className="m-0 text-[11px] leading-relaxed text-[var(--fg-4)]">
          已实装：命中即接管渲染（提交 → 轮询 → 下载落盘），参考图以 data URL 随请求体发出；产物直接进项目素材库/分镜候选。
          视频引擎建议只勾「参考生视频」，让分镜视频走外接 API、资产图仍走本地 ComfyUI。
        </p>
        <Button variant="ghost" size="sm" onClick={onRemove} className="text-[var(--danger)]">
          <Trash2 size={14} className="mr-1" /> 删除
        </Button>
      </div>
    </div>
  );
}

export default function EnginesPanel({ cfg, setCfg }) {
  const engines = Array.isArray(cfg?.engines) ? cfg.engines : [];
  const [openId, setOpenId] = useState(null); // 展开编辑的引擎 id；'new' 表示新建
  const update = (fn) => setCfg({ ...cfg, engines: fn(engines) });

  // ── 主流平台模板：一次拉列表，选中后再拉完整配置填入表单
  const [presets, setPresets] = useState(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [presetMsg, setPresetMsg] = useState('');
  useEffect(() => {
    let alive = true;
    fetch('/api/engines/presets')
      .then((r) => r.json())
      .then((j) => { if (alive) setPresets(Array.isArray(j.items) ? j.items : []); })
      .catch(() => { if (alive) setPresets([]); });
    return () => { alive = false; };
  }, []);

  async function addFromPreset(key) {
    setPickerOpen(false);
    try {
      const r = await fetch('/api/engines/presets?key=' + encodeURIComponent(key));
      const j = await r.json();
      if (!j.engine) throw new Error(j.error || '模板不存在');
      const eng = { ...NEW_ENGINE, ...j.engine, id: uid() };
      update((list) => [...list, eng]);
      setOpenId(eng.id);
      // ready=false 的平台要明确告知「填了也跑不通」，否则用户会以为是自己配错
      setPresetMsg(j.preset && j.preset.ready === false
        ? '⚠️ ' + j.preset.name + '：' + (j.preset.why || '需要自建网关')
        : '已载入「' + (j.preset?.name || eng.name) + '」模板，补上 API Key 与模型名后点「启用」。');
    } catch (e) {
      setPresetMsg('载入模板失败：' + e.message);
    }
  }

  function add() {
    const id = uid();
    update((list) => [...list, { ...NEW_ENGINE, id }]);
    setOpenId(id);
  }
  function patch(id, next) {
    update((list) => list.map((e) => (e.id === id ? next : e)));
  }
  function remove(id) {
    update((list) => list.filter((e) => e.id !== id));
    if (openId === id) setOpenId(null);
  }
  function toggle(id) {
    update((list) => list.map((e) => (e.id === id ? { ...e, enabled: !e.enabled } : e)));
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-start justify-between gap-3">
        <p className="m-0 text-[12px] leading-relaxed text-[var(--fg-3)]">
          外接线上生成 API：任何「提交任务 → 轮询 → 下载」形态的出图/出视频服务（即梦 Seedance、通义万相、可灵、Liblib、Runway、Pika、Vidu…）都能在这里接入。
          启用后按「类型 + 接管任务」自动接管对应渲染，与本地 ComfyUI / RunningHub 并存、互不干扰。
        </p>
        <div className="flex shrink-0 items-center gap-2">
          <div className="relative">
            <Button variant="secondary" size="sm" onClick={() => setPickerOpen((v) => !v)}>
              <Globe size={14} className="mr-1" /> 主流平台
            </Button>
            {pickerOpen ? (
              <div className="absolute right-0 z-30 mt-1 w-[400px] max-h-[440px] overflow-auto rounded-xl border border-[var(--line)] bg-[var(--panel)] p-1 shadow-xl">
                {['video', 'image'].map((kind) => (
                  <div key={kind}>
                    <div className="px-2 pb-1 pt-2 text-[11px] font-medium text-[var(--fg-4)]">
                      {kind === 'video' ? '视频 · 分镜出片' : '图片 · 资产图 / 定妆照'}
                    </div>
                    {(presets || []).filter((p) => p.kind === kind).map((p) => (
                      <button
                        key={p.key}
                        type="button"
                        onClick={() => addFromPreset(p.key)}
                        className="flex w-full flex-col items-start gap-0.5 rounded-lg px-2 py-1.5 text-left hover:bg-white/[0.05]"
                      >
                        <span className="flex w-full items-center gap-1.5">
                          <span className="min-w-0 flex-1 truncate text-[12px] text-[var(--fg)]">{p.name}</span>
                          {p.ready ? <Badge tone="success">可直接用</Badge> : <Badge tone="danger">需网关</Badge>}
                        </span>
                        <span className="line-clamp-2 text-[10px] leading-snug text-[var(--fg-4)]">
                          {p.vendor} · {p.authNote}
                        </span>
                      </button>
                    ))}
                  </div>
                ))}
                {presets && !presets.length ? (
                  <p className="m-0 px-2 py-3 text-[11px] text-[var(--fg-4)]">模板列表加载失败，可直接用「添加引擎」手工填。</p>
                ) : null}
              </div>
            ) : null}
          </div>
          <Button variant="primary" size="sm" onClick={add}>
            <Plus size={14} className="mr-1" /> 添加引擎
          </Button>
        </div>
      </div>

      {presetMsg ? (
        <div className="rounded-xl border border-[var(--line)] bg-[var(--panel-2)] px-3 py-2 text-[11px] leading-relaxed text-[var(--fg-3)]">
          {presetMsg}
        </div>
      ) : null}

      {!engines.length ? (
        <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-[var(--line)] px-4 py-10 text-center">
          <Globe size={22} className="text-[var(--fg-4)]" />
          <p className="m-0 text-[13px] text-[var(--fg-3)]">还没有配置线上引擎</p>
          <p className="m-0 text-[11px] text-[var(--fg-4)]">点「主流平台」选一个平台（火山方舟 / 通义万相 / 硅基流动 / Vidu / Runway…），模板会自动填好路径与请求体，只需补 API Key。</p>
        </div>
      ) : (
        engines.map((e) => {
          const open = openId === e.id;
          const tasks = Array.isArray(e.tasks) && e.tasks.length ? e.tasks.join(' / ') : '全部任务';
          return (
            <div key={e.id} className="rounded-xl border border-[var(--line)] bg-[var(--panel-2)]">
              <button
                type="button"
                onClick={() => setOpenId(open ? null : e.id)}
                className="flex w-full items-center gap-2 px-3 py-2.5 text-left hover:bg-white/[0.03]"
              >
                {open ? <ChevronDown size={15} className="shrink-0 text-[var(--fg-3)]" /> : <ChevronRight size={15} className="shrink-0 text-[var(--fg-3)]" />}
                <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-[var(--fg)]">{e.name || '未命名引擎'}</span>
                {e.enabled ? <Badge tone="success" dot>启用中</Badge> : <Badge tone="neutral">未启用</Badge>}
                <Badge tone={e.kind === 'image' ? 'info' : 'accent'}>{e.kind === 'image' ? '出图' : '视频'}</Badge>
                <span className="hidden max-w-[180px] truncate text-[11px] text-[var(--fg-4)] sm:inline">{tasks}</span>
              </button>
              <div className="flex items-center justify-between gap-2 border-t border-[var(--line)] px-3 py-1.5">
                <span className="truncate text-[11px] text-[var(--fg-4)]">{e.baseUrl || '未填 API 地址'}</span>
                <Button variant="ghost" size="sm" onClick={() => toggle(e.id)}>
                  <Zap size={13} className="mr-1" /> {e.enabled ? '停用' : '启用'}
                </Button>
              </div>
              {open ? <div className="px-3 pb-3"><EngineForm engine={e} onChange={(next) => patch(e.id, next)} onRemove={() => remove(e.id)} /></div> : null}
            </div>
          );
        })
      )}
    </div>
  );
}
