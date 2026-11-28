// SwotAtmk/infinite-creation · 开源地址 https://github.com/SwotAtmk/infinite-creation
import { NextResponse } from 'next/server';
import { legacyShotWrite, Shots, Chapters, pickShotFields, idxTakenBy, validateShotContent, withWriteContext,
  isStructuredSpec, classifyStructuredPatch, ShotParams } from '@/lib/core/index.js';
import { activeJobOfChapter } from '@/lib/agent/index.js';

export const dynamic = 'force-dynamic';

// 更新分镜。原实现只允许 6 个 *_ids 字段（素材绑定），外部无法写入分镜正文；
// 现改为走 shot-write 白名单：内容字段可写，生成产物字段（status/error/video_path…）仍被拒绝。
export async function PATCH(req, { params }) {
  const { id, sid } = await params;
  const body = await req.json().catch(() => ({}));
  const shot = Shots.get(sid);
  if (!shot || shot.project_id !== id) return NextResponse.json({ error: '分镜不存在' }, { status: 404 });

  // 时长上限按项目视频模型（h3/2.0=15s，seedance25=30s）
  const videoModel = Projects.get(id)?.video_model;
  const { patch, errors } = pickShotFields(body, { videoModel });
  if (errors.length) return NextResponse.json({ error: errors.join('；') }, { status: 400 });
  if (!Object.keys(patch).length) return NextResponse.json({ error: '无可更新字段' }, { status: 400 });
  // 跨字段校验（台词速度/说话人数）只在本次改了台词或时长时才做——见 shot-write.js
  // validateShotContent 的说明：拿库里旧值重算会让历史脏行整行不可编辑（绑素材也被 400 挡住）
  const contentErrors = validateShotContent(patch, shot, { videoModel });
  if (contentErrors.length) return NextResponse.json({ error: contentErrors.join('；') }, { status: 400 });
  if (patch.chapter) {
    const titles = new Set(Chapters.list(id).map((c) => c.title));
    if (!titles.has(patch.chapter)) return NextResponse.json({ error: '章节不存在：' + patch.chapter }, { status: 400 });
  }
  // 改 idx（可能连着改所属章）时按「目标章节」判章内唯一：idx 是成片排序键，撞号顺序不确定
  if (patch.idx !== undefined) {
    const dup = idxTakenBy(Shots.list(id), patch.chapter || shot.chapter, patch.idx, sid);
    if (dup) return NextResponse.json({ error: 'idx ' + patch.idx + ' 已被该章分镜占用——同一章内镜号必须唯一' }, { status: 400 });
  }

  // ── C-06 PATCH 三分流（D02-40 §4.5 H-02）──────────────────────────────────
  // 结构化项目上，这个 HTTP 入口只保留 B 组（段级生成参数）：
  //   B → ShotParams.update；A → 400（走 Stage 3 镜头写入）；C/E → 400（产物/快照不给这个口）。
  // 三分流是**互斥**的：同一请求里混着 A 和 B 也拒绝，让调用方自己拆成两次，
  // 否则"改了一半"没有任何回滚边界（HTTP 层没有跨资源的项目事务）。
  if (isStructuredSpec(id)) {
    const cls = classifyStructuredPatch(patch);
    if (cls.kind === 'stage3') {
      return NextResponse.json({
        error: '这些是创作字段（' + cls.fields.join(', ') + '），结构化项目必须走 Stage 3 镜头写入入口（update_shot 带 story_shot_id）',
        code: 'HTTP_STAGE3_FIELD_REQUIRED',
      }, { status: 400 });
    }
    if (cls.kind === 'denied') {
      return NextResponse.json({
        error: '这些字段不允许通过此入口修改：' + cls.fields.join(', ') + '（产物归生成侧、快照归项目参数）',
        code: 'HTTP_SHOT_FIELD_DENIED',
      }, { status: 400 });
    }
    if (cls.kind === 'empty') return NextResponse.json({ error: '无可更新字段' }, { status: 400 });
    return withWriteContext('PATCH /api/projects/:id/shots/:sid (params)', async () => {
      try {
        const r = ShotParams.update(sid, patch, { origin: 'PATCH /shots/:sid' });
        return NextResponse.json({ ...r, shot: Shots.get(sid) });
      } catch (e) {
        return NextResponse.json({ error: e.message, code: e.code || 'HTTP_SHOT_PARAM_FAILED' }, { status: 400 });
      }
    });
  }

  return withWriteContext('PATCH /api/projects/:id/shots/:sid', async () => NextResponse.json(legacyShotWrite('PATCH /shots/:sid', () => Shots.update(sid, patch))));
}

export async function DELETE(_req, { params }) {
  const { id, sid } = await params;
  const shot = Shots.get(sid);
  if (!shot || shot.project_id !== id) return NextResponse.json({ error: '分镜不存在' }, { status: 404 });
  // 运行中的任务持有这一行：删掉后它的回写（Shots.update）只会静默落空，
  // 于是「成片用的是旧分镜、分镜表里已经没有这条」。只挡同一章的任务。
  if (activeJobOfChapter(id, shot.chapter)) {
    return NextResponse.json({ error: '本章正在运行任务，运行中不可删除分镜；请等任务结束或先停止任务' }, { status: 409 });
  }
  return withWriteContext('DELETE /api/projects/:id/shots/:sid', async () => {
    legacyShotWrite('DELETE /shots/:sid', () => Shots.remove(sid));
    return NextResponse.json({ ok: true });
  });
}
