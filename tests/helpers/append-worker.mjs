#!/usr/bin/env node
// B-02 的并发探针：一个进程 = 一条连接 = 一个 txProject。
// 只做一件事：插一镜（**不给 global_no**，让号在事务内按 MAX+1 取），把结果打成一行 JSON。
// 为什么要独立进程：SQLite 是同步驱动，同进程里两个事务天然串行，做不出真正的同时进入。
const job = JSON.parse(process.env.IC_APPEND_JOB || '{}');
const core = await import('../../lib/core/index.js');

const out = { ok: true, tag: job.tag || '' };
try {
  const r = core.insertStoryShot({
    project_id: job.projectId,
    chapter_id: job.chapterId,
    scene_key: job.sceneKey || 'S01_并发',
    shot_no: Number(job.shotNo),
    visual_content: 'concurrent ' + (job.tag || ''),
  });
  out.id = r.id;
  out.global_no = r.global_no;
} catch (e) {
  out.ok = false;
  out.error = { code: e.code || 'ERROR', message: String(e.message || e) };
}
process.stdout.write(JSON.stringify(out) + '\n');
process.exit(0);
