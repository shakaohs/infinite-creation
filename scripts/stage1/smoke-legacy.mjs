#!/usr/bin/env node
// 旧链路 Smoke（任务书 §11.7）：在**历史库副本**上验证原有读路径仍然可用。
//
// 这不是"新功能测试"，而是"我改了 db.js / changelog.js / Projects.remove 之后，
// 老页面还打不打得开"。任何一条失败都说明阶段 1 破坏了存量功能。
//
// 用法：IC_DATA_DIR=<副本所在目录> node scripts/stage1/smoke-legacy.mjs
// 副本必须是用 VACUUM INTO 从真实库取的（cp 会漏 -wal）。
import { getDb, Projects, Chapters, Shots, Assets } from '../../lib/core/index.js';

const out = { ok: true, checks: [] };
const check = (name, fn) => {
  try {
    const v = fn();
    out.checks.push({ name, ok: true, value: v });
  } catch (e) {
    out.ok = false;
    out.checks.push({ name, ok: false, error: e.message });
  }
};

const db = getDb();

check('项目列表可读', () => Projects.list().length);
check('章节总可读', () => db.prepare('SELECT COUNT(*) n FROM chapters').get().n);
check('分镜总数可读', () => db.prepare('SELECT COUNT(*) n FROM shots').get().n);
check('资产总数可读', () => db.prepare('SELECT COUNT(*) n FROM assets').get().n);

let firstProject = null;
check('取第一个项目并列出其章节与分镜', () => {
  const ps = Projects.list();
  if (!ps.length) return 'no-projects';
  firstProject = ps[0];
  const chs = Chapters.list(firstProject.id);
  const shots = Shots.list(firstProject.id);
  return { project: firstProject.name, chapters: chs.length, shots: shots.length };
});

check('能打开其中一镜（含 blocking 字段）', () => {
  const ps = Projects.list();
  for (const p of ps) {
    const list = Shots.list(p.id);
    if (list.length) {
      const s = Shots.get(list[0].id);
      return { id: s.id, idx: s.idx, hasBlockingField: Object.prototype.hasOwnProperty.call(s, 'blocking') };
    }
  }
  return 'no-shots';
});

check('新表已建齐但不影响旧读', () => {
  const n = db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE type='table' AND name IN ('story_shots','render_tasks','render_selections','adaptation_locks')").get().n;
  return { newTablesPresent: n };
});

check('integrity_check', () => db.prepare('PRAGMA integrity_check').get().integrity_check);

console.log(JSON.stringify(out, null, 2));
process.exit(out.ok ? 0 : 1);
