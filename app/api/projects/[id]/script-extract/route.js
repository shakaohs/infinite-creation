// 剧本抽取阶段入口（阶段 3 · P2 / D02-06 §4.8.4 PS-C）
//
// 为什么单独一个路由而不是塞进 /run：这两个入口的**工具池不同**。
// /run 是分镜创作（看不到 set_scene_state）；这里是剧本抽取（只有 set_scene_state 那一套）。
// 混在一条路由里靠 body 参数切换，就等于让客户端决定工具池 —— 权限会退化成约定。
import { NextResponse } from 'next/server';
import { Projects, Chapters, Jobs } from '@/lib/core/index.js';
import { startScriptExtractJob } from '@/lib/agent/index.js';
import { broadcast } from '@/lib/ws.js';

export const dynamic = 'force-dynamic';

export async function POST(req, { params }) {
  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  const p = Projects.get(id);
  if (!p) return NextResponse.json({ error: '项目不存在' }, { status: 404 });

  const chapter = String(body?.chapter || '').trim();
  if (!chapter) return NextResponse.json({ error: '缺少 chapter：剧本抽取按章进行' }, { status: 400 });
  const hit = Chapters.list(id).find((c) => c.title === chapter || c.id === chapter);
  if (!hit) return NextResponse.json({ error: '章节不存在：' + chapter }, { status: 404 });

  // 同一章已有抽取任务在跑就复用，避免重复点两次烧两份 LLM（与 /run 的口径一致）
  const active = Jobs.list(id).find(
    (j) => (j.status === 'running' || j.status === 'queued')
      && j.checkpoint && j.checkpoint.toolSet === 'script'
      && (j.checkpoint.chapter === hit.title || j.checkpoint.chapter === hit.id),
  );
  if (active) return NextResponse.json({ ...active, deduped: true });

  try {
    return NextResponse.json(startScriptExtractJob({ projectId: id, chapter: hit.title, onProgress: (patch) => broadcast(patch) }));
  } catch (e) {
    return NextResponse.json({ error: e.message }, { status: 400 });
  }
}
