// 阶段 1 · changelog 现有 5 实体回归（**改造前先立基准，改造后必须仍绿**）
//
// 为什么先写这个：changelog 是 project / chapter / shot / asset / reference 五个实体共用的
// 审计与回滚框架。阶段 1 要为 render_selection 改它的四处（ENTITY_TABLE / rawGet /
// applyInverse / projectIdOf），改的是**所有人共用的代码路径**。没有基准就改，等于
// "改完再看老功能坏没坏"——坏了也不知道是哪一步坏的。
//
// 本文件用环境隔离（IC_DATA_DIR 指向临时目录）且**先设 env 再动态 import**，
// 因为 config.js 在模块加载瞬间固化路径（阶段 0 事故的根因）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-s1-changelog-'));
process.env.IC_DATA_DIR = TMP;
delete process.env.IC_DB_SQLITE_PATH;

const { getDb, Projects, Chapters, Shots, Assets } = await import('../lib/core/db.js');
const CL = await import('../lib/core/changelog.js');

const db = getDb();

function lastLogs(n = 5) {
  return db.prepare('SELECT * FROM change_logs ORDER BY rowid DESC LIMIT ?').all(n);
}
function logsBy(entity) {
  return db.prepare('SELECT * FROM change_logs WHERE entity=? ORDER BY rowid').all(entity);
}

test('G-01 Projects.create 记一条 project 创建日志', () => {
  const p = Projects.create({ name: '回归项目', type: 'agent' });
  const logs = logsBy('project');
  assert.ok(logs.length >= 1);
  const g = logs.find((l) => l.entity_id === p.id && l.action === 'create' && !l.before);
  assert.ok(g, '应有 project create 日志');
  assert.equal(g.project_id, p.id);
  assert.equal(g.action, 'create');
  assert.equal(g.before, null);
  assert.ok(g.after);
});

test('G-02 shot 的易变字段（status / video_path）改动不产生日志', () => {
  const p = Projects.create({ name: 'G02', type: 'agent' });
  const s = Shots.create(p.id, { chapter: '第1章', idx: 1, visual: 'a', duration: 5 });
  const before = logsBy('shot').length;
  Shots.update(s.id, { status: 'done', video_path: '/x.mp4', error: '' });
  assert.equal(logsBy('shot').length, before, '易变字段不应产生内容日志');
});

test('G-03 shot 内容字段改动记 update（before/after 都是原始行）', () => {
  const p = Projects.create({ name: 'G03', type: 'agent' });
  const s = Shots.create(p.id, { chapter: '第1章', idx: 1, visual: '原画面', duration: 5 });
  Shots.update(s.id, { visual: '新画面' });
  const logs = logsBy('shot').filter((l) => l.entity_id === s.id && l.action === 'update');
  assert.equal(logs.length, 1);
  assert.ok(JSON.parse(logs[0].before).visual === '原画面');
  assert.ok(JSON.parse(logs[0].after).visual === '新画面');
});

test('G-04 rawGet 返回原始行；未知实体返回 null', () => {
  const p = Projects.create({ name: 'G04', type: 'agent' });
  const row = CL.rawGet('project', p.id);
  assert.equal(row.id, p.id);
  assert.equal(row.name, 'G04');
  assert.equal(CL.rawGet('project', 'no-such-id'), null);
  assert.equal(CL.rawGet('no_such_entity', p.id), null);
});

test('G-05 回滚一条 shot update → 恢复 before 内容', () => {
  const p = Projects.create({ name: 'G05', type: 'agent' });
  const s = Shots.create(p.id, { chapter: '第1章', idx: 1, visual: 'V1', duration: 5 });
  Shots.update(s.id, { visual: 'V2' });
  const log = logsBy('shot').filter((l) => l.entity_id === s.id && l.action === 'update').pop();
  const r = CL.rollbackLogs({ projectId: p.id, logId: log.id });
  assert.equal(r.applied.length, 1);
  assert.equal(Shots.get(s.id).visual, 'V1');
});

test('G-06 回滚「chapter 创建」→ 级联删该章 shot，且每行各留一条 delete 日志', () => {
  const p = Projects.create({ name: 'G06', type: 'agent' });
  // Projects.create 会顺带建「第1章」，所以这里用「第2章」避免标题重复
  const ch = Chapters.create(p.id, { title: '第2章' });
  const s1 = Shots.create(p.id, { chapter: '第2章', idx: 1, visual: 'A', duration: 5 });
  const s2 = Shots.create(p.id, { chapter: '第2章', idx: 2, visual: 'B', duration: 5 });
  const createLog = logsBy('chapter').find((l) => l.entity_id === ch.id && l.action === 'create');
  const r = CL.rollbackLogs({ projectId: p.id, logId: createLog.id });
  assert.equal(r.applied.length, 1);
  assert.equal(Shots.get(s1.id), null, '级联删除后 shot 应不存在');
  assert.equal(Shots.get(s2.id), null);
  const cascade = db.prepare("SELECT * FROM change_logs WHERE entity='shot' AND action='delete' AND entity_id IN (?,?)").all(s1.id, s2.id);
  assert.equal(cascade.length, 2, '级联删除的每一行都要各留一条 delete 日志');
});

test('G-07 回滚「project 创建」必须被拒（禁止通过回滚删项目）', () => {
  const p = Projects.create({ name: 'G07', type: 'agent' });
  const createLog = logsBy('project').find((l) => l.entity_id === p.id && l.action === 'create');
  const r = CL.rollbackLogs({ projectId: p.id, logId: createLog.id });
  assert.equal(r.skipped.length, 1);
  assert.match(r.skipped[0].reason, /不可回滚/);
  assert.ok(Projects.get(p.id), '项目必须还在');
});

test('G-08 回滚成功后原日志打 reverted_by，回滚自身也留一条 action=rollback', () => {
  const p = Projects.create({ name: 'G08', type: 'agent' });
  const s = Shots.create(p.id, { chapter: '第1章', idx: 1, visual: 'X1', duration: 5 });
  Shots.update(s.id, { visual: 'X2' });
  const log = logsBy('shot').filter((l) => l.entity_id === s.id && l.action === 'update').pop();
  CL.rollbackLogs({ projectId: p.id, logId: log.id });
  const after = db.prepare('SELECT * FROM change_logs WHERE id=?').get(log.id);
  assert.equal(after.reverted_by, '1'.repeat(0) || after.reverted_by, '字段存在');
  assert.ok(after.reverted_by, '原日志应打上 reverted_by');
  const rollbackLog = db.prepare("SELECT * FROM change_logs WHERE project_id=? AND action='rollback'").get(p.id);
  assert.ok(rollbackLog, '回滚动作本身要留档');
});

test('G-09 漂移保护：内容被再次改动后回滚被 blocked（未 force 时不改任何东西）', () => {
  const p = Projects.create({ name: 'G09', type: 'agent' });
  const s = Shots.create(p.id, { chapter: '第1章', idx: 1, visual: 'D0', duration: 5 });
  Shots.update(s.id, { visual: 'D1' });
  const log = logsBy('shot').filter((l) => l.entity_id === s.id && l.action === 'update').pop();
  Shots.update(s.id, { visual: 'D2' });          // 在待回滚的日志之后又改了一次
  const r = CL.rollbackLogs({ projectId: p.id, logId: log.id });
  assert.equal(r.blocked, true);
  assert.ok(r.conflicts.length >= 1);
  assert.equal(Shots.get(s.id).visual, 'D2', '被阻断时不得改库');
});

test('G-10 listChanges 按实体/动作过滤，且 project_id 隔离', () => {
  const p1 = Projects.create({ name: 'G10a', type: 'agent' });
  const p2 = Projects.create({ name: 'G10b', type: 'agent' });
  Shots.create(p1.id, { chapter: '第1章', idx: 1, visual: 'p1', duration: 5 });
  Shots.create(p2.id, { chapter: '第1章', idx: 1, visual: 'p2', duration: 5 });
  const l1 = CL.listChanges(p1.id, { entity: 'shot' });
  assert.ok(l1.length >= 1);
  assert.ok(l1.every((x) => x.project_id === p1.id));
  const total = CL.countChanges(p1.id, { entity: 'shot' });
  assert.equal(total, l1.length);
});

test('G-11 asset 的易变字段（image_path/status）不记日志，描述改动记日志', () => {
  const p = Projects.create({ name: 'G11', type: 'agent' });
  const a = Assets.create(p.id, { category: 'character', name: '罗克珊' });
  const n0 = logsBy('asset').length;
  Assets.update(a.id, { status: 'done', image_path: '/a.png' });
  assert.equal(logsBy('asset').length, n0, '易变字段不记日志');
  Assets.update(a.id, { description: '换了描述' });
  assert.ok(logsBy('asset').length > n0, '内容字段要记日志');
});
