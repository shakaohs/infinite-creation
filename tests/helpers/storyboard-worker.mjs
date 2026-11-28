#!/usr/bin/env node
// D45-01 的并发探针：一个进程 = 一条连接 = 一个 set_storyboard 事务。
//
// 为什么必须独立进程：SQLite 是同步驱动，同进程里两个 `BEGIN IMMEDIATE` 天然串行，
// 做不出"两个请求同时读到同一个 MAX(shot_no)"的那个瞬间。
//
// job = { projectId, chapter, shots:[{idx?|省略, visual, camera}], tag }
// 输出一行：{ ok, tag, added, updated, shotNos:[...], text | error }
const job = JSON.parse(process.env.IC_SB_JOB || '{}');
const { createToolRuntime, runTool } = await import('../../lib/agent/tools.js');

// `set_storyboard` 有一道"必读 reference 已加载"的硬门禁（早于本轮就存在）。
// 这里把它标成已加载：本探针测的是**镜号分配的并发安全**，不是技能加载门禁。
const H3_REFS = ['00-framework-adapter.md', 'pipeline.md', 'camera-four-axis-h3.md', 'h3-shot-grammar.md',
  'spatial-anchor-and-hold.md', 'dialogue-density.md', 'checklist.md', 'h3-constraints-qc.md'];

const out = { ok: true, tag: job.tag || '' };
try {
  const ctx = createToolRuntime({ projectId: job.projectId });
  for (const r of H3_REFS) ctx.loadedRefs.add('forest-laoli-h3/' + r);
  const text = await runTool(ctx, 'set_storyboard', {
    chapter: job.chapter || '第1章',
    clear: !!job.clear,
    shots: job.shots || [],
  });
  out.text = String(text);
  const m = /新增 (\d+)，更新 (\d+)/.exec(out.text);
  out.added = m ? Number(m[1]) : null;
  out.updated = m ? Number(m[2]) : null;
} catch (e) {
  out.ok = false;
  out.error = { code: e.code || 'ERROR', message: String(e.message || e).slice(0, 400) };
}
process.stdout.write(JSON.stringify(out) + '\n');
process.exit(0);
