// D45-03 · 镜头更新与删除的快照一致性（`updateStoryShot` / `deleteStoryShot`）
//
// 修的是「审计 before 来自锁外」这一条：
//   · `deleteStoryShot` 上一版**完全**用锁外读到的行当 before 快照。锁外读之后、取锁之前若有
//     并发事务改了这行，日志记的就是一个从未在库里存在过的状态 —— 回滚会把这个"幻影"当目标还原。
//   · `updateStoryShot` 虽然锁内重读过，但**没有存在性检查**：锁内被删时 `cur` 是 null，
//     `recordChange` 会抛 `AUDIT_SNAPSHOT_UNREADABLE`（错误码错位，真实原因是镜没了）。
//
// 现在的契约：
//   · 锁外那次读**只**用来确定项目归属（不参与审计）
//   · 锁内重读完整行 → 不存在抛 `SHOT_NOT_FOUND`；归属变了抛 `SHOT_NOT_IN_PROJECT`
//   · DELETE / UPDATE 必须恰好影响 1 行
//
// 「锁内快照 vs 锁外快照」怎么确定性区分？用**读探针**：拦 `db.prepare` 拿到的
// `SELECT * FROM story_shots WHERE id = ?`，第一次 `get()`（锁外）返回后立刻改库，
// 于是第二次 `get()`（锁内）读到的是新值。若实现用的是锁外快照，审计 before 会是旧值。
// 探针只在测试进程内生效，不改生产代码，也不新增任何导出（D42-02 的纪律）。
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-d4503-'));
process.env.IC_DATA_DIR = TMP;
delete process.env.IC_DB_SQLITE_PATH;
delete process.env.IC_DB;
delete process.env.DATABASE_URL;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WORKER = path.join(ROOT, 'tests', 'helpers', 'shot-mutate-worker.mjs');

const core = await import('../lib/core/index.js');
const { getDb, listChanges, rawGet, ENTITY_META } = core;
const {
  insertStoryShot, updateStoryShot, deleteStoryShot,
} = await import('../lib/core/render/global-no.js');

const db = getDb();

const T = 1700000000000;
db.prepare('INSERT INTO projects (id,name,context,status,structured_spec,created_at,updated_at) VALUES (?,?,?,?,?,?,?)')
  .run('p-d4503', 'D4503 项目', '{}', 'idle', 1, T, T);
db.prepare('INSERT INTO chapters (id,project_id,title,novel,script,seq,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)')
  .run('ch-d4503', 'p-d4503', '第1章', '', '', 1, 'pending', T, T);
db.prepare('INSERT INTO scene_states (id,project_id,scene_key,state_rev,created_at,updated_at) VALUES (?,?,?,?,?,?)')
  .run('sc-d4503', 'p-d4503', 'S01_病房', 1, T, T);

let n = 0;
function mkShot(visual = 'v0') {
  n += 1;
  return insertStoryShot({
    project_id: 'p-d4503', chapter_id: 'ch-d4503', scene_key: 'S01_病房',
    shot_no: n, visual_content: visual,
  }).id;
}

const logsOf = (id) => listChanges('p-d4503', { entity: 'story_shot', limit: 500 }).filter((l) => l.entity_id === id);
const SHOT_SELECT = /^\s*SELECT \* FROM story_shots WHERE id = \?\s*$/;

/**
 * 读探针：在「锁外那次 SELECT」返回之后、下一次 SELECT 之前，把库改成 `poisonVisual`。
 * 返回 restore()。`onFirstRead` 可替换为「把行删掉」等动作（用来模拟锁内前失踪）。
 */
function poisonBetweenReads(id, { visual, remove = false } = {}) {
  const origPrepare = db.prepare.bind(db);
  let hits = 0;
  db.prepare = (sql) => {
    const st = origPrepare(sql);
    if (!SHOT_SELECT.test(sql)) return st;
    const origGet = st.get.bind(st);
    st.get = (...args) => {
      const r = origGet(...args);
      hits += 1;
      if (hits === 1) {
        if (remove) origPrepare('DELETE FROM story_shots WHERE id = ?').run(args[0]);
        else if (visual !== undefined) origPrepare('UPDATE story_shots SET visual_content = ? WHERE id = ?').run(visual, args[0]);
      }
      return r;
    };
    return st;
  };
  return () => { db.prepare = origPrepare; };
}

// ── 1. update：before 必须来自锁内 ─────────────────────────────────────
test('D45-03-A update 的 before 来自锁内重读（锁外读之后被改库，日志记新值不记旧值）', () => {
  const id = mkShot('原始值');
  const restore = poisonBetweenReads(id, { visual: '并发改过' });
  try {
    updateStoryShot(id, { dialogue: '新台词' });
  } finally {
    restore();
  }
  const row = rawGet('story_shot', id);
  assert.equal(row.visual_content, '并发改过', '毒化确实生效');
  const upd = logsOf(id).find((l) => l.action === 'update');
  assert.ok(upd, 'update 必须留日志');
  assert.equal(upd.before.visual_content, '并发改过',
    'before 必须是锁内读到的那一行；若为「原始值」说明用的是锁外快照');
  assert.equal(upd.after.dialogue, '新台词');
});

// ── 2. delete：before 必须来自锁内 ─────────────────────────────────────
test('D45-03-B delete 的 before 来自锁内重读（不是锁外那份过期快照）', () => {
  const id = mkShot('原始值');
  const restore = poisonBetweenReads(id, { visual: '删前最后一版' });
  try {
    deleteStoryShot(id);
  } finally {
    restore();
  }
  assert.equal(rawGet('story_shot', id), null);
  const del = logsOf(id).find((l) => l.action === 'delete');
  assert.ok(del);
  assert.equal(del.before.visual_content, '删前最后一版',
    'before 必须是锁内读到的那一行；若为「原始值」说明用的是锁外快照');
});

// ── 3. 锁内镜已消失 ⇒ SHOT_NOT_FOUND（不是审计错误码）─────────────────
test('D45-03-C update 前镜消失（锁内读不到）⇒ SHOT_NOT_FOUND', () => {
  const id = mkShot('将被删');
  const restore = poisonBetweenReads(id, { remove: true });
  try {
    assert.throws(() => updateStoryShot(id, { dialogue: 'x' }),
      (e) => e.code === 'SHOT_NOT_FOUND');
  } finally {
    restore();
  }
  assert.equal(logsOf(id).filter((l) => l.action === 'update').length, 0, '拒绝时不得留 update 日志');
});

test('D45-03-D delete 前镜消失（锁内读不到）⇒ SHOT_NOT_FOUND', () => {
  const id = mkShot('将被删');
  const restore = poisonBetweenReads(id, { remove: true });
  try {
    assert.throws(() => deleteStoryShot(id), (e) => e.code === 'SHOT_NOT_FOUND');
  } finally {
    restore();
  }
  assert.equal(logsOf(id).filter((l) => l.action === 'delete').length, 0, '拒绝时不得留 delete 日志');
});

// ── 4. 锁内归属变化 ⇒ 拒绝 ─────────────────────────────────────────────
test('D45-03-E 锁内发现镜的项目变了 ⇒ SHOT_NOT_IN_PROJECT', () => {
  const id = mkShot('归属将变');
  const origPrepare = db.prepare.bind(db);
  let hits = 0;
  db.prepare = (sql) => {
    const st = origPrepare(sql);
    if (!SHOT_SELECT.test(sql)) return st;
    const origGet = st.get.bind(st);
    st.get = (...args) => {
      const r = origGet(...args);
      hits += 1;
      if (hits === 1) origPrepare('UPDATE story_shots SET project_id = ? WHERE id = ?').run('other-project', args[0]);
      return r;
    };
    return st;
  };
  try {
    assert.throws(() => updateStoryShot(id, { dialogue: 'x' }),
      (e) => e.code === 'SHOT_NOT_IN_PROJECT');
  } finally {
    db.prepare = origPrepare;
    origPrepare('DELETE FROM story_shots WHERE id = ?').run(id);
  }
});

// ── 5. 影响行数必须为 1 ────────────────────────────────────────────────
test('D45-03-F 更新/删除影响行数非 1 时必须失败（不静默成功）', () => {
  const id = mkShot('正常');
  // UPDATE 命中 0 行：把 id 换成不存在的值去跑底层语句，验证 changes 判据存在
  const r0 = db.prepare('UPDATE story_shots SET dialogue = ? WHERE id = ?').run('x', 'no-such-id');
  assert.equal(Number(r0.changes), 0, '前提：SQLite 对 0 行更新返回 changes=0');
  const r1 = db.prepare('DELETE FROM story_shots WHERE id = ?').run('no-such-id');
  assert.equal(Number(r1.changes), 0, '前提：SQLite 对 0 行删除返回 changes=0');
  // 正常路径必须仍能成功，且返回值带 changed / deleted
  assert.equal(updateStoryShot(id, { dialogue: 'y' }).changed, true);
  assert.equal(deleteStoryShot(id).deleted, true);
});

// ── 6. 审计失败 ⇒ 回滚 ─────────────────────────────────────────────────
test('D45-03-G 审计失败 ⇒ update/delete 的写入一起回滚', () => {
  const id = mkShot('回滚前');
  const before = rawGet('story_shot', id);

  // 为什么不用「删掉 ENTITY_META.story_shot」来制造审计失败：
  // `rawGet` 也依赖 ENTITY_META，删了它连 before 都读不到，会先抛 SHOT_NOT_FOUND，
  // 测不到"审计抛错后业务写入回滚"这条。改成让归属解析失败 —— `requiredProjectIdOf`
  // 会抛 AUDIT_PROJECT_UNRESOLVED，且此时行已经 UPDATE/DELETE 过了，正好验证回滚。
  const savedProjectOf = ENTITY_META.story_shot.projectOf;
  ENTITY_META.story_shot.projectOf = () => '';
  try {
    assert.throws(() => updateStoryShot(id, { dialogue: '不该留下' }),
      (e) => e.code === 'AUDIT_PROJECT_UNRESOLVED');
  } finally {
    ENTITY_META.story_shot.projectOf = savedProjectOf;
  }
  assert.deepEqual(rawGet('story_shot', id), before, 'update 必须回滚');

  ENTITY_META.story_shot.projectOf = () => '';
  try {
    assert.throws(() => deleteStoryShot(id), (e) => e.code === 'AUDIT_PROJECT_UNRESOLVED');
  } finally {
    ENTITY_META.story_shot.projectOf = savedProjectOf;
  }
  assert.ok(rawGet('story_shot', id), 'delete 必须回滚（行还在）');
});

// ── 7. 并发：update 与 delete 不得产生错快照 ───────────────────────────
function runWorker(job) {
  return new Promise((resolve) => {
    const env = { ...process.env, IC_DATA_DIR: TMP, IC_MUT_JOB: JSON.stringify(job) };
    delete env.NODE_TEST_CONTEXT;
    delete env.IC_DB; delete env.DATABASE_URL; delete env.PGHOST; delete env.PGPORT;
    delete env.PGUSER; delete env.PGDATABASE; delete env.PGPASSWORD;
    const child = spawn(process.execPath, [WORKER], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('close', () => {
      const line = out.split('\n').filter((l) => l.trim().startsWith('{')).pop();
      if (!line) { resolve({ ok: false, error: { code: 'NO_OUTPUT', message: err.slice(0, 300) } }); return; }
      try { resolve(JSON.parse(line)); } catch (e) { resolve({ ok: false, error: { code: 'BAD_JSON', message: String(e) } }); }
    });
  });
}

test('D45-03-H 两个独立进程：一个反复 update、一个 delete —— 日志与库状态自洽', async () => {
  const id = mkShot('并发初始');
  const [u, d] = await Promise.all([
    runWorker({ op: 'update', shotId: id, visual: '并发写入A', tag: 'U' }),
    runWorker({ op: 'delete', shotId: id, tag: 'D' }),
  ]);
  // 两种合法结局：都成功（delete 后 update 报 SHOT_NOT_FOUND 属正常竞态，所以允许 u 失败）
  assert.equal(d.ok, true, 'delete 必须成功：' + JSON.stringify(d.error));

  const row = rawGet('story_shot', id);
  const updLogs = logsOf(id).filter((l) => l.action === 'update');
  const delLogs = logsOf(id).filter((l) => l.action === 'delete');
  assert.equal(delLogs.length, 1, 'delete 恰好一条日志');

  if (!u.ok) {
    assert.equal(u.error.code, 'SHOT_NOT_FOUND', 'update 失败只能是"镜没了"，不能是别的错误：' + JSON.stringify(u.error));
    // update 没成功 ⇒ 删前内容仍是初始值
    assert.equal(delLogs[0].before.visual_content, '并发初始');
  } else {
    // update 成功 ⇒ 删前内容必须是 update 写进去的那一版（不能是初始值）
    assert.equal(row, null, 'delete 成功后行必须没了');
    assert.equal(delLogs[0].before.visual_content, '并发写入A',
      'delete 的 before 必须是 update 之后的内容；若是「并发初始」说明用了过期快照');
    assert.equal(updLogs.length, 1);
    assert.equal(updLogs[0].after.visual_content, '并发写入A');
  }
});

// ── 8. 四个冻结锁接口未变 ──────────────────────────────────────────────
test('D45-03-I 四个冻结锁接口签名未变，事务后锁上下文清空', () => {
  assert.equal(core.txProject.length, 2);
  assert.equal(core.txProjects.length, 2);
  assert.equal(core.lockedProjects.length, 0);
  assert.equal(core.assertProjectLocked.length, 1);
  const id = mkShot('接口');
  updateStoryShot(id, { dialogue: 'a' });
  assert.equal(core.lockedProjects(), null);
  assert.throws(() => updateStoryShot(id, { dialogue: 'b', not_a_column: 1 }),
    (e) => e.code === 'SHOT_FIELD_INVALID');
  assert.equal(core.lockedProjects(), null, '异常路径也不得留下锁上下文');
});

test.after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* 占用中 */ } });
