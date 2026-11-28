#!/usr/bin/env node
// D45-03 的并发探针：一个进程 = 一条连接 = 一个 txProject。
// job = { projectId, op: 'update' | 'delete', shotId, visual, tag }
const job = JSON.parse(process.env.IC_MUT_JOB || '{}');
const core = await import('../../lib/core/index.js');

const out = { ok: true, tag: job.tag || '', op: job.op };
try {
  if (job.op === 'delete') {
    const r = core.deleteStoryShot(job.shotId);
    out.deleted = r.deleted;
  } else {
    core.updateStoryShot(job.shotId, { visual_content: job.visual });
    out.updated = true;
  }
} catch (e) {
  out.ok = false;
  out.error = { code: e.code || 'ERROR', message: String(e.message || e).slice(0, 300) };
}
process.stdout.write(JSON.stringify(out) + '\n');
process.exit(0);
