// P10-A 阶段 B · B-02：镜头写入（`story_shots`）
//
// 锁四件事：
//   ① `segment_id` / `scene_uid` 能落库（新增白名单列），且**段 id 与镜 id 不混用**；
//   ② `global_no` 在项目锁内取 ⇒ 两个**独立进程**并发插入不会撞号；
//   ③ A2 `story_shot` 的 create/update/delete 都有行级审计；
//   ④ 归属解析失败 / 审计失败一律 fail-closed，且与业务写入同事务回滚。
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-b02-'));
process.env.IC_DATA_DIR = TMP;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WORKER = path.join(ROOT, 'tests', 'helpers', 'append-worker.mjs');

const core = await import('../lib/core/index.js');
const {
  getDb, insertStoryShot, updateStoryShot, deleteStoryShot, recordChange, rawGet,
  listChanges, ENTITY_META,
} = core;

const db = getDb();
const T = 1700000000000;
db.prepare('INSERT INTO projects (id,name,context,status,structured_spec,created_at,updated_at) VALUES (?,?,?,?,?,?,?)')
  .run('p-b02', 'B02 项目', '{}', 'idle', 1, T, T);
db.prepare('INSERT INTO chapters (id,project_id,title,novel,script,seq,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)')
  .run('ch-b02', 'p-b02', '第1章', '', '', 1, 'pending', T, T);
db.prepare('INSERT INTO scene_states (id,project_id,scene_key,state_rev,created_at,updated_at) VALUES (?,?,?,?,?,?)')
  .run('sc-b02', 'p-b02', 'S01_病房', 1, T, T);

const logsOf = (id) => listChanges('p-b02', { entity: 'story_shot', limit: 500 }).filter((l) => l.entity_id === id);

test('B02-01 segment_id / scene_uid 落库，A2 create 留审计（快照是原始行）', () => {
  const r = insertStoryShot({
    project_id: 'p-b02', chapter_id: 'ch-b02', scene_key: 'S01_病房', shot_no: 1,
    segment_id: 'seg-1', scene_uid: 'sc-b02', visual_content: '病房全景',
  });
  const row = rawGet('story_shot', r.id);
  assert.equal(row.segment_id, 'seg-1');
  assert.equal(row.scene_uid, 'sc-b02');
  assert.equal(row.global_no, 1, '不给 global_no 时必须在锁内按 MAX+1 取');
  const logs = logsOf(r.id);
  assert.equal(logs.length, 1);
  assert.equal(logs[0].action, 'create');
  assert.equal(logs[0].project_id, 'p-b02', '归属必须来自真实行');
});

test('B02-02 两个独立进程并发插入：global_no 不撞号（必须在锁内取号）', async () => {
  const run = (tag, shotNo) => new Promise((resolve) => {
    const env = { ...process.env, IC_DATA_DIR: TMP, IC_APPEND_JOB: JSON.stringify({ projectId: 'p-b02', chapterId: 'ch-b02', shotNo, tag }) };
    delete env.NODE_TEST_CONTEXT;
    delete env.IC_DB; delete env.DATABASE_URL; delete env.PGHOST; delete env.PGPORT; delete env.PGUSER; delete env.PGDATABASE; delete env.PGPASSWORD;
    const child = spawn(process.execPath, [WORKER], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('close', () => {
      const line = out.split('\n').filter((l) => l.trim().startsWith('{')).pop();
      if (!line) { resolve({ ok: false, error: { code: 'NO_OUTPUT', message: err.slice(0, 400) } }); return; }
      try { resolve(JSON.parse(line)); } catch (e) { resolve({ ok: false, error: { code: 'BAD_JSON', message: String(e) } }); }
    });
  });

  const [a, b] = await Promise.all([run('A', 2), run('B', 3)]);
  assert.equal(a.ok, true, JSON.stringify(a.error));
  assert.equal(b.ok, true, JSON.stringify(b.error));
  assert.notEqual(a.global_no, b.global_no, '两个事务不得拿到同一个号');
  assert.deepEqual([a.global_no, b.global_no].sort((x, y) => x - y), [2, 3]);
  const rows = db.prepare('SELECT global_no FROM story_shots WHERE project_id=? ORDER BY global_no').all('p-b02').map((x) => Number(x.global_no));
  assert.deepEqual(rows, [1, 2, 3], '项目内 global_no 必须连续且唯一');
});

test('B02-03 A2 update：改内容记一条；只改易变列不记', () => {
  const r = insertStoryShot({ project_id: 'p-b02', chapter_id: 'ch-b02', scene_key: 'S01_病房', shot_no: 4, visual_content: 'v1' });
  updateStoryShot(r.id, { visual_content: 'v2' });
  assert.equal(logsOf(r.id).length, 2, 'create + update');

  const before = rawGet('story_shot', r.id);
  // 只改 updated_at：属 VOLATILE，不得产生内容日志
  updateStoryShot(r.id, { updated_at: before.updated_at + 1 });
  assert.equal(logsOf(r.id).length, 2, 'opts.updated_at 被忽略 ⇒ 不写也记不出变化');
});

test('B02-04 A2 delete：删前快照必须进日志', () => {
  const r = insertStoryShot({ project_id: 'p-b02', chapter_id: 'ch-b02', scene_key: 'S01_病房', shot_no: 5, visual_content: '待删' });
  deleteStoryShot(r.id);
  assert.equal(rawGet('story_shot', r.id), null);
  const del = logsOf(r.id).find((l) => l.action === 'delete');
  assert.ok(del, 'delete 必须留日志');
  assert.equal(del.before.visual_content, '待删', 'delete 日志必须带 before 快照');
});

test('B02-05 归属无法解析 ⇒ A2 fail-closed（不认调用方的 projectId）', () => {
  const ghost = {
    id: 'ss-ghost', project_id: '', chapter_id: 'ch-b02', scene_key: 'S01_病房',
    shot_no: 99, global_no: 99, visual_content: 'x',
  };
  assert.throws(
    () => recordChange({ entity: 'story_shot', action: 'create', after: ghost, projectId: 'p-b02' }),
    (e) => e.code === 'AUDIT_PROJECT_UNRESOLVED',
  );
});

test('B02-06 审计失败 ⇒ 业务写入同事务回滚', () => {
  const before = db.prepare('SELECT COUNT(*) AS c FROM story_shots').get().c;
  const saved = ENTITY_META.story_shot;
  delete ENTITY_META.story_shot;
  try {
    assert.throws(
      () => insertStoryShot({ project_id: 'p-b02', chapter_id: 'ch-b02', scene_key: 'S01_病房', shot_no: 6, visual_content: '应回滚' }),
      (e) => e.code === 'AUDIT_ENTITY_META_MISSING',
    );
  } finally {
    ENTITY_META.story_shot = saved;
  }
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM story_shots').get().c, before, '镜行必须随审计失败回滚');
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM story_shots WHERE shot_no=6").get().c, 0);
});

test('B02-07 段 id 与镜 id 混用必须拒绝', () => {
  assert.throws(
    () => insertStoryShot({
      id: 'same-id', project_id: 'p-b02', chapter_id: 'ch-b02', scene_key: 'S01_病房',
      shot_no: 7, segment_id: 'same-id',
    }),
    (e) => e.code === 'SEGMENT_ID_CONFLICT',
  );
  assert.equal(rawGet('story_shot', 'same-id'), null);
});

test('B02-08 voice_ids 不接受外部写（派生列）', () => {
  const r = insertStoryShot({ project_id: 'p-b02', chapter_id: 'ch-b02', scene_key: 'S01_病房', shot_no: 8 });
  assert.throws(
    () => updateStoryShot(r.id, { voice_ids: '["x"]' }),
    (e) => e.code === 'DERIVED_FIELD_REJECTED',
  );
});

test.after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* 占用中 */ } });
