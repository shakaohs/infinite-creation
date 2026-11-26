// 通用线上渲染引擎适配器（出图/出视频 · 配置驱动）。
// 目的：让「出图/出视频」不绑定 RunningHub，任何一个「提交任务 → 轮询 → 下载」形态的线上 API
// （即梦/Seedance、通义万相、可灵、Liblib、Runway、Pika、Vidu、自定义聚合层…）都能通过 config.engines[]
// 里的一条配置接入，无需改代码。
//
// 每条引擎配置（config.engines[] 元素）的约定字段：
//   id               唯一标识
//   name             显示名
//   kind             'image' | 'video'
//   baseUrl          API 根地址（如 https://api.example.com）
//   apiKey           鉴权 key
//   model            模型名（requestTemplate 里用 {model} 占位）
//   authHeader       鉴权 header 名，默认 Authorization
//   authPrefix       鉴权前缀，默认 'Bearer '（空字符串表示裸 key）
//   submitPath       提交任务路径（POST，相对 baseUrl）
//   pollPath         轮询路径（GET，{taskId} 占位替换）
//   requestTemplate  提交请求体模板（JSON 字符串，含占位符）
//   taskIdPath       提交响应里取 taskId 的点路径（如 data.taskId）
//   statusPath       轮询响应里取状态的点路径（如 data.status）
//   doneValues       完成状态值（逗号分隔，如 succeeded,completed,done,success）
//   failValues       失败状态值（逗号分隔，如 failed,error,fail）
//   outputUrlPath    轮询响应里取产物 URL 的点路径，**支持数组下标**（data.output.url / creations[0].url / output[0]）
//   extraHeaders     额外 header 对象（值支持 {apiKey} 占位）：通义 X-DashScope-Async、Runway X-Runway-Version 等
//   pollMethod       轮询方法，默认 GET；POST 类平台（硅基流动）写 POST
//   pollBody         POST 轮询的请求体模板（默认 {"taskId":"{taskId}"}）
//   tasks            只接管哪几种工作流（如 ["r2v"]），不写 = 该类型全接
//
// requestTemplate 可用占位符：{prompt} {model} {resolution} {aspect_ratio} {duration} {apiKey}
import fs from 'node:fs';
import path from 'node:path';

// 占位符替换：{key} → vars[key]；未提供的键原样保留，便于发现漏传。
export function renderTemplate(tpl, vars) {
  return String(tpl || '').replace(/\{(\w+)\}/g, (m, k) => (vars[k] !== undefined && vars[k] !== null ? String(vars[k]) : m));
}

// 点路径取值，**支持数组下标**：'data.output.url' / 'creations[0].url' / 'output[0]'。
// 必须支持 [0]：主流平台的产物几乎都在数组里（Vidu `creations[0].url`、Runway `output[0]`、
// 硅基流动 `results.videos[0].url`），只支持纯点路径等于这些平台全都取不到产物。
export function getByPath(obj, p) {
  const parts = String(p || '').replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean);
  let cur = obj;
  for (const k of parts) {
    if (cur == null) return undefined;
    cur = cur[k];
  }
  return cur;
}

function joinUrl(base, p) {
  const b = String(base || '').replace(/\/+$/, '');
  const q = String(p || '');
  if (/^https?:\/\//i.test(q)) return q;
  return b + (q.startsWith('/') ? '' : '/') + q;
}

function buildHeaders(engine) {
  const h = { 'Content-Type': 'application/json' };
  if (engine.apiKey) {
    const name = String(engine.authHeader || 'Authorization').trim() || 'Authorization';
    const prefix = engine.authPrefix === undefined ? 'Bearer ' : String(engine.authPrefix);
    h[name] = prefix + engine.apiKey;
  }
  // 额外 header：很多平台的鉴权/路由不只在 Authorization 上——
  //   通义万相异步任务必须带 X-DashScope-Async: enable；
  //   Runway 必须带 X-Runway-Version: 2024-11-06；
  //   火山方舟部分模型要 X-Api-Key 而非 Bearer。
  // 值里支持 {apiKey} / {model} 占位，便于把 key 塞进非标准 header。
  const extra = engine.extraHeaders;
  if (extra && typeof extra === 'object' && !Array.isArray(extra)) {
    for (const [k, v] of Object.entries(extra)) {
      if (!k || v === undefined || v === null) continue;
      h[k] = renderTemplate(String(v), { apiKey: engine.apiKey || '', model: engine.model || '' });
    }
  }
  return h;
}

// 提交任务：渲染请求体模板 → POST submitPath → 从响应里取 taskId。
export async function submitHttpTask(engine, payload = {}) {
  const vars = { ...payload, model: engine.model, apiKey: engine.apiKey || '' };
  const body = renderTemplate(engine.requestTemplate, vars);
  const url = joinUrl(engine.baseUrl, engine.submitPath);
  const res = await fetch(url, {
    method: 'POST',
    headers: buildHeaders(engine),
    body,
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error('提交任务失败 ' + res.status + ': ' + (await res.text()).slice(0, 300));
  const j = await res.json().catch(() => ({}));
  const taskId = getByPath(j, engine.taskIdPath);
  if (!taskId) throw new Error('未从响应解析到 taskId（提取路径 ' + engine.taskIdPath + '）：' + JSON.stringify(j).slice(0, 300));
  return String(taskId);
}

// 同步接口（提交即出结果，无 taskId）：返回原始响应 JSON。
// 图片平台大多是这种形态（OpenAI 兼容 /v1/images/generations、硅基流动图片、通义万相图片同步模式），
// 只支持「提交→轮询」等于这些平台全都接不上。
export async function submitHttpOnce(engine, payload = {}) {
  const vars = { ...payload, model: engine.model, apiKey: engine.apiKey || '' };
  const body = renderTemplate(engine.requestTemplate, vars);
  const url = joinUrl(engine.baseUrl, engine.submitPath);
  const res = await fetch(url, {
    method: 'POST',
    headers: buildHeaders(engine),
    body,
    signal: AbortSignal.timeout(300_000),
  });
  if (!res.ok) throw new Error('提交任务失败 ' + res.status + ': ' + (await res.text()).slice(0, 300));
  return res.json().catch(() => ({}));
}

// 轮询任务：pollPath（{taskId} 替换）→ 返回 { status, outputUrl, raw }。
// pollMethod 默认 GET；硅基流动 /v1/video/status 这类「查询也要 POST 带 body」的平台用 POST，
// 请求体由 pollBody 模板渲染（默认 {"taskId":"{taskId}"}）。
export async function pollHttpTask(engine, taskId) {
  const p = renderTemplate(engine.pollPath, { taskId });
  const url = joinUrl(engine.baseUrl, p);
  const method = String(engine.pollMethod || 'GET').toUpperCase();
  const init = { method, headers: buildHeaders(engine), signal: AbortSignal.timeout(60_000) };
  if (method === 'POST') {
    init.body = renderTemplate(
      engine.pollBody || '{"taskId":"{taskId}"}',
      { taskId, apiKey: engine.apiKey || '', model: engine.model || '' },
    );
  }
  const res = await fetch(url, init);
  if (!res.ok) throw new Error('查询任务失败 ' + res.status + ': ' + (await res.text()).slice(0, 300));
  const j = await res.json().catch(() => ({}));
  const status = String(getByPath(j, engine.statusPath) ?? '');
  const outputUrl = engine.outputUrlPath ? String(getByPath(j, engine.outputUrlPath) ?? '') : '';
  return { status, outputUrl, raw: j };
}

// 状态归一化：'done' | 'failed' | 'running'。doneValues/failValues 支持「精确相等」或「包含」匹配。
export function engineStatusOf(engine, status) {
  const split = (s) => String(s || '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
  const done = split(engine.doneValues).length ? split(engine.doneValues) : ['succeeded', 'completed', 'done', 'success'];
  const fail = split(engine.failValues).length ? split(engine.failValues) : ['failed', 'error', 'fail'];
  const s = String(status || '').toLowerCase();
  if (done.some((d) => s === d || s.includes(d))) return 'done';
  if (fail.some((f) => s === f || s.includes(f))) return 'failed';
  return 'running';
}

// 下载产物到本地（引擎鉴权 header 一并带上，兼容需鉴权的产物 URL）。
export async function downloadHttpOutput(url, destPath, engine) {
  const res = await fetch(url, { headers: buildHeaders(engine), signal: AbortSignal.timeout(300_000) });
  if (!res.ok) throw new Error('下载产物失败 ' + res.status + ': ' + (await res.text()).slice(0, 200));
  const buf = Buffer.from(await res.arrayBuffer());
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  fs.writeFileSync(destPath, buf);
  return destPath;
}

// 配置完整性校验：返回错误列表（空数组 = 配置齐全）。
// 骨架阶段「测试连接」只做配置校验，不做真实请求（真实请求会扣费、且依赖真实 key/endpoint）。
export function validateEngine(engine) {
  const e = engine || {};
  const errs = [];
  if (!String(e.name || '').trim()) errs.push('名称必填');
  if (!['image', 'video'].includes(e.kind)) errs.push('类型必须是 image 或 video');
  if (!String(e.baseUrl || '').trim()) errs.push('API 地址必填');
  if (!String(e.submitPath || '').trim()) errs.push('提交路径必填');
  if (!String(e.requestTemplate || '').trim()) errs.push('请求体模板必填');
  // 同步接口（提交即出结果，无 taskId / 无轮询）：taskId、pollPath、statusPath 都不适用，
  // 只要求产物取值路径。原先无差别要求这三个字段，导致所有同步图片平台（Seedream / 通义万相图片 /
  // 硅基图片 / OpenAI 兼容）都过不了校验，pickEngine 直接跳过它们、回落到 ComfyUI。
  const isSync = e.syncMode === true || !String(e.taskIdPath || '').trim();
  if (!String(e.outputUrlPath || '').trim()) errs.push('产物 URL 提取路径必填');
  if (!isSync) {
    if (!String(e.pollPath || '').trim()) errs.push('轮询路径必填');
    if (!String(e.statusPath || '').trim()) errs.push('状态提取路径必填');
  }
  return errs;
}
