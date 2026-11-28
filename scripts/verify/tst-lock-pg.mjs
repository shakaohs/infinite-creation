#!/usr/bin/env node
// TST-LOCK-01~13 · PostgreSQL 真库取证（Gate P2 的执行载体）
//
// 为什么是独立脚本而不是 node:test 用例：
//   1. `lib/core/db.js` 在测试进程里**一律拒绝** PG（`TEST_REQUIRES_SQLITE`）—— 因为 IC_DATA_DIR
//      对 PG 没有隔离意义。这里不是测试进程，走的是应用真实连接路径。
//   2. P2 要求 11~13 **必须**双连接。双连接靠的是**两个独立 node 进程**（各自一条连接），
//      不是同一连接上的两个事务（`pg-worker` 单连接 + `Atomics.wait` 做不出交错）。
//
// 六项自检（D02-40 §8.3.3，缺一即 P2 不通过）：
//   ① 服务端在跑 ② 测试库可连 ③ 版本 16.x ④ advisory lock 可执行 ⑤ 两条独立连接 ⑥ 连的是测试库
//   第 ⑥ 项不满足是**安全事件**：立即退出，不计入通过与否。
//
// 用法（密码只经环境变量，不进命令行文本、不进日志）：
//   PGPASSWORD=$(cat /d/pg16/pw.txt) PGHOST=127.0.0.1 PGPORT=55432 PGUSER=postgres \
//   PGDATABASE=infinite_creation_test node scripts/verify/tst-lock-pg.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const WORKER = path.join(ROOT, 'tests', 'helpers', 'lock-worker.mjs');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-pg-lock-'));

const PG = {
  host: process.env.PGHOST || '127.0.0.1',
  port: Number(process.env.PGPORT || 55432),
  user: process.env.PGUSER || 'postgres',
  password: process.env.PGPASSWORD || '',
  database: process.env.PGDATABASE || 'infinite_creation_test',
};
const EXPECT_DB = 'infinite_creation_test';

const results = [];
const log = (...a) => console.log(...a);

function record(id, name, ok, detail) {
  results.push({ id, name, ok, detail });
  log(`${ok ? 'PASS' : 'FAIL'}  ${id}  ${name}${detail ? '  ' + detail : ''}`);
}

async function client() {
  const c = new pg.Client({ ...PG, connectionTimeoutMillis: 8000 });
  c.on('error', () => {});   // 被 terminate 时不要让整个进程崩（D02-39 踩过）
  await c.connect();
  return c;
}

// ── 零：六项自检 ───────────────────────────────────────────────────────────
async function preflight() {
  const c1 = await client();
  const info = await c1.query("SELECT current_setting('server_version') AS v, current_database() AS d, pg_backend_pid() AS p");
  const { v, d, p } = info.rows[0];
  log(`[自检] 服务端版本=${v} 库名=${d} 后端pid=${p}`);

  if (d !== EXPECT_DB) {
    log(`[安全事件] 连到的库是 ${d}，不是 ${EXPECT_DB}。立即停止，不执行任何写操作。`);
    process.exit(2);
  }
  record('SELF-1', '服务端在跑（可建立连接）', true, `${PG.host}:${PG.port}`);
  record('SELF-2', '测试库可连（返回 backend pid）', !!p, `pid=${p}`);
  record('SELF-3', '版本 16.x', String(v).startsWith('16.'), v);

  // ④ advisory lock 可执行且 pg_locks 可见（事务内取锁 → 查锁 → 回滚）
  await c1.query('BEGIN');
  const key = await c1.query("SELECT hashtextextended('project:selftest', 0) AS k");
  await c1.query('SELECT pg_advisory_xact_lock($1)', [key.rows[0].k]);
  const seen = await c1.query("SELECT count(*)::int AS c FROM pg_locks WHERE locktype='advisory' AND pid=pg_backend_pid()");
  await c1.query('ROLLBACK');
  record('SELF-4', 'advisory lock 可执行且 pg_locks 可见', seen.rows[0].c > 0,
    `hashtextextended=${key.rows[0].k} 锁数=${seen.rows[0].c}`);

  // ⑤ 两条独立连接 = 两个不同 backend pid
  const c2 = await client();
  const p2 = (await c2.query('SELECT pg_backend_pid() AS p')).rows[0].p;
  await c2.end();
  record('SELF-5', '两个独立连接（两个不同 backend pid）', p !== p2 && !!p && !!p2, `pid1=${p} pid2=${p2}`);
  record('SELF-6', '连的是测试库', d === EXPECT_DB, d);

  await c1.end();
  return { version: v, database: d, controlPid: p };
}

// ── 事务子进程（每条 = 一条独立连接）────────────────────────────────────────
function childEnv(job, extra = {}) {
  // IC_LOCK_TEST=1：取锁顺序观察者（内部模块）的显式开关。不设它 ⇒ 观察者拒绝注入，
  // 子进程会以 exit 2 退出 —— 让"没观测到"显形，而不是给出一份 order=[] 的假证据。
  const env = { ...process.env, IC_LOCK_JOB: JSON.stringify(job), IC_DB: 'postgres', IC_DATA_DIR: TMP, IC_LOCK_TEST: '1' };
  delete env.NODE_TEST_CONTEXT;
  return { ...env, ...extra };
}

function startWorker(job, extraEnv = {}) {
  const child = spawn(process.execPath, [WORKER], { cwd: ROOT, env: childEnv(job, extraEnv), stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  let err = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { err += d; });
  const done = new Promise((resolve) => {
    child.on('close', () => {
      const line = out.split('\n').filter((l) => l.trim().startsWith('{')).pop();
      if (!line) { resolve({ ok: false, error: { code: 'NO_OUTPUT', message: err.slice(0, 600) } }); return; }
      try { resolve(JSON.parse(line)); } catch { resolve({ ok: false, error: { code: 'BAD_JSON' }, raw: line }); }
    });
  });
  return { child, done };
}
const runWorker = (job, extra) => startWorker(job, extra).done;

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitForJson(file, ms = 20000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (fs.existsSync(file)) {
      try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* 正在写 */ }
    }
    await wait(25);
  }
  return null;
}

async function probeRows(c, project) {
  const r = await c.query('SELECT n, tag FROM lock_probe WHERE project_id=$1 ORDER BY n', [project]);
  return r.rows;
}

// ── 一条用例的最小断言工具 ─────────────────────────────────────────────────
function assertThat(id, name, cond, detail) {
  record(id, name, !!cond, detail);
  return !!cond;
}

async function main() {
  log('=== P2 · PostgreSQL 真库 · TST-LOCK-01~13 ===');
  const meta = await preflight();
  if (results.some((r) => !r.ok)) {
    log('自检未全通过 ⇒ P2 不通过（不得进入阶段 B）');
    return finish(meta);
  }

  const ctl = await client();
  // 预热：先让一个子进程把 schema 建好，避免多个子进程并发跑 initSchema 互相干扰
  const warm = await runWorker({ op: 'read', project: 'p-warmup' });
  if (!warm.ok) { record('WARMUP', 'schema 预热失败', false, JSON.stringify(warm.error)); await ctl.end(); return finish(meta); }
  log(`[预热] 应用 schema 就绪（连接 pid=${warm.backendPid}）`);
  // 探针表可重复执行：每次运行前清掉上一轮的探针行（只动本脚本自己建的 lock_probe）
  await ctl.query("DELETE FROM lock_probe WHERE project_id LIKE 'pg-%' OR project_id LIKE 'p-lock%'");

  // 01 · 同项目并发取号
  {
    const p = 'pg-lock01';
    const t0 = Date.now();
    const [a, b] = await Promise.all([
      runWorker({ op: 'race', project: p, holdMs: 400, tag: 'A' }),
      runWorker({ op: 'race', project: p, holdMs: 400, tag: 'B' }),
    ]);
    const wall = Date.now() - t0;
    const rows = await probeRows(ctl, p);
    // 注意：驱动把 DDL 里的 INTEGER 放大成 BIGINT，pg 会把 BIGINT 以**字符串**返回。
    // 直接 `rows[0].n === 1` 会因为 '1' !== 1 而假红 —— 这里统一转数值再比。
    const nums = rows.map((r) => Number(r.n));
    assertThat('LOCK-01', '同项目两事务串行取号，n=[1,2]',
      a.ok && b.ok && rows.length === 2 && nums[0] === 1 && nums[1] === 2 && wall >= 750,
      `wall=${wall}ms n=[${rows.map((r) => r.n)}] rows=${rows.length} pid=${a.backendPid}/${b.backendPid}`
      + ` errA=${a.ok ? '-' : JSON.stringify(a.error)} errB=${b.ok ? '-' : JSON.stringify(b.error)}`);
  }

  // 02 · 一写一读：读事务必须等待，且只看到提交后快照
  {
    const p = 'pg-lock02';
    const ready = path.join(TMP, 'pg-lock02.ready');
    const holder = startWorker({ op: 'hold', project: p, holdMs: 700, tag: 'H' }, { IC_LOCK_READY_FILE: ready });
    const info = await waitForJson(ready);
    const reader = await runWorker({ op: 'read', project: p });
    await holder.done;
    assertThat('LOCK-02', '求解/读事务等待写入方提交，读到一致快照（不半新半旧）',
      !!info && reader.ok && Array.isArray(reader.result.rows) && reader.result.rows.length === 1 && reader.result.rows[0] === 1,
      `holderPid=${info && info.backendPid} readerPid=${reader.backendPid} rows=[${reader.ok ? reader.result.rows : 'err'}] readerElapsed=${reader.elapsedMs}ms`);
  }

  // 03 · 不同项目并行：PG 项目级锁 ⇒ 不互相阻塞（SQLite 做不到，这是两库的实质差异）
  {
    const t0 = Date.now();
    const [a, b] = await Promise.all([
      runWorker({ op: 'race', project: 'pg-lock03-a', holdMs: 900, tag: 'A' }),
      runWorker({ op: 'race', project: 'pg-lock03-b', holdMs: 900, tag: 'B' }),
    ]);
    const wall = Date.now() - t0;
    // 判据不靠拍一个绝对阈值：并行 ⇒ 墙钟约等于「一个事务 + 进程启动」，
    // 必然小于两个事务耗时之和；串行 ⇒ 墙钟约等于两者之和再叠加启动开销。
    // 这个比较对启动开销是保守的（偏严），不会因为机器慢而假绿。
    assertThat('LOCK-03', '不同项目并行写入：不互相阻塞（墙钟 < 两个事务耗时之和）',
      a.ok && b.ok && a.elapsedMs >= 850 && b.elapsedMs >= 850 && wall < a.elapsedMs + b.elapsedMs,
      `wall=${wall}ms vs 串行下界=${a.elapsedMs + b.elapsedMs}ms（单事务 ${a.elapsedMs}/${b.elapsedMs}）pid=${a.backendPid}/${b.backendPid}`);
  }

  // 04 · 失败后释放
  {
    const p = 'pg-lock04';
    const f = await runWorker({ op: 'fail', project: p });
    const t0 = Date.now();
    const r = await runWorker({ op: 'race', project: p, holdMs: 0 });
    const cost = Date.now() - t0;
    const rows = await probeRows(ctl, p);
    assertThat('LOCK-04', '事务失败后锁释放，后续事务 5s 内取到锁且失败写入已回滚',
      f.error && f.error.code === 'PROBE_FAIL' && f.lockedAfter === null && r.ok && cost < 5000 && rows.length === 1,
      `f.code=${f.error && f.error.code} 取锁耗时=${cost}ms rows=${rows.length}`);
  }

  // 05 · 连接被杀：锁自动释放、无残余
  {
    const p = 'pg-lock05';
    const ready = path.join(TMP, 'pg-lock05.ready');
    const { child, done } = startWorker({ op: 'hold', project: p, holdMs: 30000, tag: 'K' }, { IC_LOCK_READY_FILE: ready });
    const info = await waitForJson(ready);
    const before = await ctl.query(
      "SELECT count(*)::int AS c FROM pg_locks WHERE locktype='advisory' AND pid=$1", [info ? info.backendPid : -1]);
    await ctl.query('SELECT pg_terminate_backend($1)', [info ? info.backendPid : -1]);
    await done;
    child.kill();
    const t0 = Date.now();
    const r = await runWorker({ op: 'race', project: p, holdMs: 0 });
    const cost = Date.now() - t0;
    const after = await ctl.query(
      "SELECT count(*)::int AS c FROM pg_locks WHERE locktype='advisory' AND pid=$1", [info ? info.backendPid : -1]);
    const rows = await probeRows(ctl, p);
    assertThat('LOCK-05', '连接被杀后 advisory 锁随事务释放、无残留、无半写行',
      before.rows[0].c > 0 && after.rows[0].c === 0 && r.ok && cost < 5000 && rows.length === 1,
      `被杀前锁数=${before.rows[0].c} 被杀后=${after.rows[0].c} 重新取锁=${cost}ms rows=${rows.length}`);
  }

  // 06 · 最外层单项目：记账 + 返回值
  {
    const p = 'pg-lock06';
    const r = await runWorker({ op: 'read', project: p });
    assertThat('LOCK-06', '单项目最外层：fn 内 locked=[P]，提交后 null，返回值透传',
      r.ok && JSON.stringify(r.result.locked) === JSON.stringify([p]) && r.lockedAfter === null,
      `locked=${JSON.stringify(r.ok ? r.result.locked : null)} after=${r.lockedAfter}`);
  }

  // 07 · 乱序输入 → 规范化取锁顺序
  {
    const r = await runWorker({ op: 'multi', projects: ['pg-q07', 'pg-p07'], holdMs: 0 });
    assertThat('LOCK-07', '多项目乱序输入 [Q,P]：实际取锁序列 [P,Q]',
      r.ok && JSON.stringify(r.order) === JSON.stringify(['pg-p07', 'pg-q07']),
      `order=${JSON.stringify(r.order)}`);
  }

  // 08 · 同项目嵌套复用：取锁一次
  {
    const r = await runWorker({ op: 'nestedSame', project: 'pg-lock08' });
    assertThat('LOCK-08', '同项目嵌套复用：取锁次数 1',
      r.ok && r.order.length === 1 && JSON.stringify(r.result.outer) === JSON.stringify(['pg-lock08']),
      `order=${JSON.stringify(r.order)}`);
  }

  // 09 · 跨项目嵌套拒绝
  {
    const r = await runWorker({ op: 'cross', project: 'pg-lock09', other: 'pg-other09' });
    const rows = await probeRows(ctl, 'pg-other09');
    assertThat('LOCK-09', '已持 P 后 txProject(Q)：TX_CROSS_PROJECT_NESTED，写入未发生',
      !r.ok && r.error.code === 'TX_CROSS_PROJECT_NESTED' && r.lockedAfter === null && rows.length === 0,
      `code=${r.error && r.error.code} otherRows=${rows.length}`);
  }

  // 10 · 嵌套 txProjects 一律拒绝（相同 / 超集 / 不相交）
  {
    const p = 'pg-lock10';
    let all = true;
    const codes = [];
    for (const set of [[p], [p, 'pg-q10'], ['pg-r10']]) {
      const r = await runWorker({ op: 'nestedMulti', project: p, projects: set });
      codes.push(r.error && r.error.code);
      all = all && !r.ok && r.error.code === 'TX_NESTED_MULTI_PROJECT';
    }
    assertThat('LOCK-10', '已持锁后 txProjects（相同/超集/不相交）全部 TX_NESTED_MULTI_PROJECT', all, codes.join(','));
  }

  // 11 · 相反顺序启动：都按 [P,Q] 取锁，无 40P01
  {
    const t0 = Date.now();
    const [a, b] = await Promise.all([
      runWorker({ op: 'multi', projects: ['pg-p11', 'pg-q11'], holdMs: 700 }),
      runWorker({ op: 'multi', projects: ['pg-q11', 'pg-p11'], holdMs: 700 }),
    ]);
    const wall = Date.now() - t0;
    const okBoth = a.ok && b.ok;
    assertThat('LOCK-11', '两事务相反输入顺序启动：都按 [P,Q] 取锁，无死锁（40P01），两者都成功',
      okBoth
        && JSON.stringify(a.order) === JSON.stringify(['pg-p11', 'pg-q11'])
        && JSON.stringify(b.order) === JSON.stringify(['pg-p11', 'pg-q11']),
      `wall=${wall}ms orderA=${JSON.stringify(a.order)} orderB=${JSON.stringify(b.order)} err=${a.error ? a.error.code : ''}${b.error ? b.error.code : ''}`);
  }

  // 12 · 异常退出后另一连接可取同一项目锁
  {
    const p = 'pg-lock12';
    const c1 = await client();
    await c1.query('BEGIN');
    const key = (await c1.query("SELECT hashtextextended('project:' || $1, 0) AS k", [p])).rows[0].k;
    await c1.query('SELECT pg_advisory_xact_lock($1)', [key]);
    const held = await c1.query("SELECT count(*)::int AS c FROM pg_locks WHERE locktype='advisory' AND pid=pg_backend_pid()");
    await c1.query('ROLLBACK');
    await c1.end();
    const t0 = Date.now();
    const r = await runWorker({ op: 'race', project: p, holdMs: 0 });
    const cost = Date.now() - t0;
    assertThat('LOCK-12', '外部事务持有→回滚后，另一连接能在 lock_timeout 内取到同一项目锁',
      held.rows[0].c > 0 && r.ok && cost < 5000,
      `持锁时 pg_locks=${held.rows[0].c} 取锁耗时=${cost}ms`);
  }

  // 13 · 整组重跑（06~12 的关键不变量）+ 真实 pg_advisory_xact_lock 证据
  {
    const p = 'pg-lock13';
    const ready = path.join(TMP, 'pg-lock13.ready');
    const holder = startWorker({ op: 'hold', project: p, holdMs: 800, tag: 'R13' }, { IC_LOCK_READY_FILE: ready });
    const info = await waitForJson(ready);
    const locks = await ctl.query(
      "SELECT locktype, classid::text AS classid, objid::text AS objid, mode FROM pg_locks WHERE locktype='advisory' AND pid=$1",
      [info ? info.backendPid : -1]);
    await holder.done;
    const seq = [];
    seq.push((await runWorker({ op: 'multi', projects: ['pg-q13', 'pg-p13'], holdMs: 0 })).order);
    seq.push((await runWorker({ op: 'nestedSame', project: 'pg-lock13s' })).order);
    const cross = await runWorker({ op: 'cross', project: 'pg-lock13c', other: 'pg-lock13d' });
    const nested = await runWorker({ op: 'nestedMulti', project: 'pg-lock13e', projects: ['pg-lock13e'] });
    const plain = await runWorker({ op: 'plainTx', project: 'pg-lock13f' });
    const realLock = locks.rows.length > 0;
    assertThat('LOCK-13', 'PG 真库整组重跑：真实 pg_advisory_xact_lock 在 pg_locks 可见，06~12 不变量保持',
      realLock
        && JSON.stringify(seq[0]) === JSON.stringify(['pg-p13', 'pg-q13'])
        && seq[1].length === 1
        && cross.error && cross.error.code === 'TX_CROSS_PROJECT_NESTED'
        && nested.error && nested.error.code === 'TX_NESTED_MULTI_PROJECT'
        && plain.error && plain.error.code === 'TX_MUST_BE_IMMEDIATE',
      `pg_locks.advisory=${locks.rows.length} 行 mode=${locks.rows.map((r) => r.mode).join('/')}`);
  }

  await ctl.end();
  finish(meta);
}

function finish(meta) {
  const pass = results.filter((r) => r.ok).length;
  const fail = results.length - pass;
  log('');
  log(`P2-RESULT ${JSON.stringify({
    server_version: meta.version, database: meta.database, control_pid: meta.controlPid,
    total: results.length, pass, fail, ok: fail === 0 && results.length >= 19,
    cases: results.map((r) => ({ id: r.id, ok: r.ok, detail: r.detail })),
  })}`);
  process.exit(fail === 0 && results.length >= 19 ? 0 : 1);
}

main().catch((e) => {
  log('脚本异常：' + (e && e.message ? e.message : String(e)));
  log(`P2-RESULT ${JSON.stringify({ ok: false, error: String(e && e.message || e), cases: results })}`);
  process.exit(1);
});
