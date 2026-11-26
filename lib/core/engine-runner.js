// 外接线上引擎执行器：把「出图 / 出视频」从 ComfyUI 解耦到任意 HTTP API（Seedance / 即梦 / 万相 / 可灵 …）。
//
// 为什么放在 runWorkflow 里分派：runWorkflow 是全部渲染的唯一收口点，在这里按 spec.kind 换执行端，
// 上层的资产图/分镜视频/数字人/音乐等调用方一行都不用改，也不影响本地 ComfyUI 与 RunningHub 两条老通道。
//
// 路由规则（全部来自 config.engines[]，见 lib/core/engine-http.js 的字段说明）：
//   · enabled === true 才生效（默认关闭：配了一半的引擎不会被自动拿去跑生产）
//   · kind = image 接 t2i / i2i；kind = video 接 r2v / i2v / t2v / digital_human
//   · tasks 可选：指定只接哪几种 spec.kind（如 ["r2v"]）；不写 = 该类全接
//   · 同类多引擎按数组顺序取第一个命中的（前面的优先）
//
// 请求体模板可用占位符（除 engine-http.js 已支持的 {prompt}/{model}/{resolution}/{aspect_ratio}/{duration}/{apiKey}）：
//   {negative_prompt} {width} {height} {seconds} {seed} {image} {images_json} {videos_json} {audios_json}
//   {image}        = 第一张参考图的 data URL（Seedance 2.0 单图绑定、图生图都用它）
//   {images_json}  = 参考图数组，元素形如 {"url":"data:image/png;base64,..."}（可直接塞进 JSON 数组位）
//   {videos_json} / {audios_json} 同理，给需要音视频参考的模型用
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';
import { submitHttpTask, submitHttpOnce, pollHttpTask, engineStatusOf, downloadHttpOutput, getByPath, validateEngine } from './engine-http.js';
import { logger } from './logger.js';

// spec.kind → 引擎大类
const FAMILY_OF_KIND = {
  t2i: 'image',
  i2i: 'image',
  r2v: 'video',
  i2v: 'video',
  t2v: 'video',
  digital_human: 'video',
};

export function engineFamilyOf(spec) {
  const kind = String(spec?.kind || '');
  return FAMILY_OF_KIND[kind] || null;
}

// 选出本次该用的外接引擎（没有则返回 null → 继续走 ComfyUI / RunningHub）
export function pickEngine(cfg, spec) {
  const family = engineFamilyOf(spec);
  if (!family) return null;
  const list = Array.isArray(cfg?.engines) ? cfg.engines : [];
  const kind = String(spec?.kind || '');
  for (const e of list) {
    if (!e || e.enabled !== true) continue;
    if (e.kind !== family) continue;
    if (validateEngine(e).length) continue; // 配置不全的引擎跳过，不要让一条坏配置把整条流水线打断
    const tasks = Array.isArray(e.tasks) ? e.tasks.map((t) => String(t).trim()).filter(Boolean) : [];
    if (tasks.length && !tasks.includes(kind)) continue;
    return e;
  }
  return null;
}

// 某一类任务是否已启用外接引擎（供参考素材上传做短路：外接引擎直接读本地文件，
// 不需要先把参考图传到 ComfyUI 的 input 目录；本地没开 ComfyUI 时这个短路尤其重要）。
export function engineEnabledFor(cfg, family) {
  const list = Array.isArray(cfg?.engines) ? cfg.engines : [];
  return !!list.find((e) => e && e.enabled === true && e.kind === family && !validateEngine(e).length);
}

const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.bmp': 'image/bmp', '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.flac': 'audio/flac' };

function dataUrlOf(absPath) {
  try {
    if (!absPath || !fs.existsSync(absPath)) return '';
    const buf = fs.readFileSync(absPath);
    const mime = MIME[path.extname(absPath).toLowerCase()] || 'application/octet-stream';
    return 'data:' + mime + ';base64,' + buf.toString('base64');
  } catch { return ''; }
}

function jsonList(urls) {
  return urls.map((u) => '{"url":' + JSON.stringify(u) + '}').join(',');
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function extOfUrl(url, family) {
  try {
    const p = new URL(url).pathname;
    const ext = path.extname(p).toLowerCase();
    if (ext && ext.length <= 5) return ext;
  } catch { /* 非法 URL 走默认后缀 */ }
  return family === 'video' ? '.mp4' : '.png';
}

// 组装模板变量：把框架内部参数（spec roles 的语义角色 + references）翻成线上 API 常见字段
export function buildEngineVars(engine, params = {}, kind = '') {
  const refs = Array.isArray(params.references) ? params.references : [];
  const pick = (type) => refs.filter((r) => r.type === type && r.localPath).map((r) => dataUrlOf(r.localPath)).filter(Boolean);
  const images = pick('image');
  const videos = pick('video');
  const audios = pick('audio');
  // {prompt} 被直接拼进 JSON 模板，台词里的双引号/换行必须转义，否则请求体立刻变成非法 JSON
  // （短剧台词本身就满是引号，实测会 100% 提交失败）。另给 {prompt_json} = 带引号的 JSON 字符串，
  // 模板里写 `"text": {prompt_json}` 可完全避开手工转义。
  const esc = (v) => String(v == null ? '' : v).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r?\n/g, '\\n');
  return {
    prompt: esc(params.positive_prompt),
    prompt_json: JSON.stringify(String(params.positive_prompt || '')),
    negative_prompt: esc(params.negative_prompt),
    model: engine.model || '',
    apiKey: engine.apiKey || '',
    aspect_ratio: params.aspect_ratio || '',
    resolution: params.resolution || '',
    duration: params.seconds != null ? String(params.seconds) : '',
    seconds: params.seconds != null ? String(params.seconds) : '',
    width: params.width != null ? String(params.width) : '',
    height: params.height != null ? String(params.height) : '',
    seed: params.seed != null ? String(params.seed) : '',
    kind,
    image: images[0] || '',
    images_json: jsonList(images),
    videos_json: jsonList(videos),
    audios_json: jsonList(audios),
    image_count: String(images.length),
  };
}

// 跑一次外接引擎任务：提交 → 轮询 → 下载到本地，返回与 ComfyUI 同构的 { prompt_id, outputs }
export async function runEngineTask(cfg, spec, params, engine, opts = {}) {
  const family = engineFamilyOf(spec);
  if (!family) throw new Error('该工作流类型不支持外接引擎：' + (spec?.kind || ''));
  const vars = buildEngineVars(engine, params, String(spec?.kind || ''));
  const timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : 30 * 60 * 1000;
  const pollMs = Math.max(1500, Number(opts.pollMs) || 5000);
  if (opts.onStatus) opts.onStatus({ kind: 'engine_submit', engine: engine.name || engine.id });

  // ── 同步模式：提交即出结果（OpenAI 兼容图片接口、硅基流动图片、通义万相图片同步档）
  //    没有 taskId、没有轮询，直接从响应里取产物 URL。
  if (engine.syncMode || !String(engine.taskIdPath || '').trim()) {
    const raw = await submitHttpOnce(engine, vars);
    const outputUrl = String(getByPath(raw, engine.outputUrlPath || '') ?? '');
    if (!outputUrl) {
      throw new Error('同步引擎未返回产物 URL（检查 outputUrlPath：' + (engine.outputUrlPath || '未配置') + '）：' + JSON.stringify(raw).slice(0, 300));
    }
    const dir = path.join(DATA_DIR, 'tmp', 'engines');
    fs.mkdirSync(dir, { recursive: true });
    const tag = 'sync_' + Date.now();
    const file = path.join(dir, (engine.id || 'eng') + '_' + tag + extOfUrl(outputUrl, family));
    await downloadHttpOutput(outputUrl, file, engine);
    const kind = family === 'video' ? 'videos' : 'images';
    return {
      prompt_id: tag,
      outputs: [{ kind, filename: path.basename(file), localFile: file, url: outputUrl }],
    };
  }

  const taskId = await submitHttpTask(engine, vars);
  if (opts.onSubmitted) opts.onSubmitted(taskId);
  logger.info('外接引擎任务已提交', { engine: engine.name || engine.id, taskId, kind: spec?.kind });
  const deadline = Date.now() + timeoutMs;
  let lastStatus = '';
  while (Date.now() < deadline) {
    if (opts.isAborted && opts.isAborted()) throw new Error('任务已取消');
    await sleep(pollMs);
    const { status, outputUrl } = await pollHttpTask(engine, taskId);
    if (status && status !== lastStatus) {
      lastStatus = status;
      if (opts.onStatus) opts.onStatus({ kind: 'engine_status', status });
    }
    const norm = engineStatusOf(engine, status);
    if (norm === 'done') {
      if (!outputUrl) throw new Error('外接引擎已完成但未返回产物 URL（检查 outputUrlPath：' + (engine.outputUrlPath || '未配置') + '）');
      const dir = path.join(DATA_DIR, 'tmp', 'engines');
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, (engine.id || 'eng') + '_' + taskId + extOfUrl(outputUrl, family));
      await downloadHttpOutput(outputUrl, file, engine);
      const kind = family === 'video' ? 'videos' : 'images';
      return {
        prompt_id: taskId,
        outputs: [{ kind, filename: path.basename(file), localFile: file, url: outputUrl }],
      };
    }
    if (norm === 'failed') {
      throw new Error('外接引擎任务失败（状态：' + status + '，taskId=' + taskId + '）');
    }
  }
  throw new Error('外接引擎任务超时（' + Math.round(timeoutMs / 1000) + 's，taskId=' + taskId + '，最后状态：' + (lastStatus || '未知') + '）');
}
