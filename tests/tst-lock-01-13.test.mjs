// TST-LOCK-01~13（SQLite 侧）+ 锁协议的错误码 / 冻结 / 断言单测。
//
// 边界（必须写清楚，否则这份"全绿"会被读成 P2 通过）：
//   · 本文件只覆盖 **SQLite**。P2 要求 11~13 必须在 **PostgreSQL 真库**执行，
//     而测试进程按 P0 隔离规则一律禁止连 PG（db.js 的 TEST_REQUIRES_SQLITE）。
//   · PG 侧由 `scripts/verify/tst-lock-pg.mjs` 在**非测试进程**里跑，证据另附。
//   · SQLite 的互斥来源是库级 BEGIN IMMEDIATE，因此"不同项目并行不互相阻塞"这一条
//     在 SQLite 上必然不成立 —— 这里如实标注，不当作通过。
//
// 并发用**独立子进程**（tests/helpers/lock-worker.mjs）：同进程里两个事务在同步驱动下
// 天然串行，做不出交错，等于什么都没验。
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-tst-lock-'));
process.env.IC_DATA_DIR = TMP;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WORKER = path.join(ROOT, 'tests', 'helpers', 'lock-worker.mjs');

const core = await import('../lib/core/index.js');
const { getDb, tx, txProject, txProjects, lockedProjects, assertProjectLocked } = core;

// 先把库建好再放子进程进来：否则几个子进程同时跑 initSchema，测的就不是锁协议了
getDb();

test.after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* 占用中 */ } });

function childEnv(job, extra = {}) {
  // IC_LOCK_TEST=1：取锁顺序观察者的显式开关（内部模块，不是公共 API；D42-02）。
  // 少了它子进程会 exit 2，用例直接失败 —— 不允许"order 为空"被当成"没有取锁"。
  const env = { ...process.env, IC_DATA_DIR: TMP, IC_LOCK_JOB: JSON.stringify(job), IC_LOCK_TEST: '1' };
  delete env.NODE_TEST_CONTEXT;   // 子进程不是 node:test 进程，它只跑一个事务
  for (const k of ['DATABASE_URL', 'IC_DB', 'PGHOST', 'PGPORT', 'PGUSER', 'PGDATABASE', 'PGPASSWORD']) delete env[k];
  return { ...env, ...extra };
}

/** 起一个事务子进程；返回 { child, done } */
function startWorker(job, extraEnv = {}) {
  const child = spawn(process.execPath, [WORKER], { cwd: ROOT, env: childEnv(job, extraEnv), stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  let err = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { err += d; });
  const done = new Promise((resolve) => {
    child.on('close', (code) => {
      const line = out.split('\n').filter((l) => l.trim().startsWith('{')).pop();
      if (!line) { resolve({ ok: false, error: { code: 'NO_OUTPUT', message: err.slice(0, 800) }, code }); return; }
      try { resolve(JSON.parse(line)); } catch (e) { resolve({ ok: false, error: { code: 'BAD_JSON', message: String(e) }, raw: line }); }
    });
  });
  return { child, done };
}

/** 跑一个事务子进程并等它结束 */
async function runWorker(job, extraEnv = {}) {
  return startWorker(job, extraEnv).done;
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** 轮询等一个文件出现（不用 sleep 命令，超时即失败） */
async function waitForFile(file, ms = 15000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (fs.existsSync(file)) return true;
    await wait(25);
  }
  return false;
}

const probeRows = (project) => getDb()
  .prepare('SELECT n, tag FROM lock_probe WHERE project_id=? ORDER BY n').all(project);

// ── 01~05：五个必须真实跑的交错（D02-32 §3.6 / D02-40 §8.3.2）─────────────────

test('TST-LOCK-01 同项目两个事务并发取号：串行完成，n 不撞号', async () => {
  const p = 'p-lock01';
  const t0 = Date.now();
  const [a, b] = await Promise.all([
    runWorker({ op: 'race', project: p, holdMs: 300, tag: 'A' }),
    runWorker({ op: 'race', project: p, holdMs: 300, tag: 'B' }),
  ]);
  const wall = Date.now() - t0;
  assert.equal(a.ok, true, JSON.stringify(a.error));
  assert.equal(b.ok, true, JSON.stringify(b.error));
  const rows = probeRows(p);
  assert.equal(rows.length, 2);
  // 串行的直接证据：两个事务各持 300ms，串行 ⇒ 墙钟 ≥ 600ms；并行 ⇒ 只有 ~300ms。
  // （只看单个子进程的 elapsedMs 证明不了：等待期与它自己的持锁期重叠。
  //   若并行，两者都会读到 max=0 从而都写 n=1，下面的 [1,2] 也会红。）
  assert.ok(wall >= 550, `未观察到等待：墙钟 ${wall}ms`);
  assert.deepEqual(rows.map((r) => r.n), [1, 2], '两个事务必须拿到 1 与 2，而不是同一个号');
});

test('TST-LOCK-02 一事务写入、另一事务读取：读到的是已提交快照（不半新半旧）', async () => {
  const p = 'p-lock02';
  const ready = path.join(TMP, 'lock02.ready');
  const holder = startWorker({ op: 'hold', project: p, holdMs: 600, tag: 'H' }, { IC_LOCK_READY_FILE: ready });
  assert.equal(await waitForFile(ready), true, '持有者没能在 15s 内拿到锁');
  const reader = await runWorker({ op: 'read', project: p });
  await holder.done;
  assert.equal(reader.ok, true, JSON.stringify(reader.error));
  // 读到 [1]：说明看到的是提交后的整行，而不是"事务进行中什么都没有"
  assert.deepEqual(reader.result.rows, [1]);
});

test('TST-LOCK-03 不同项目并发：SQLite 为库级锁，只验正确性，不验隔离性（如实标注）', async () => {
  const [a, b] = await Promise.all([
    runWorker({ op: 'race', project: 'p-lock03-a', holdMs: 200, tag: 'A' }),
    runWorker({ op: 'race', project: 'p-lock03-b', holdMs: 200, tag: 'B' }),
  ]);
  assert.equal(a.ok, true, JSON.stringify(a.error));
  assert.equal(b.ok, true, JSON.stringify(b.error));
  assert.equal(probeRows('p-lock03-a').length, 1);
  assert.equal(probeRows('p-lock03-b').length, 1);
  // 说明：SQLite 的互斥是库级（BEGIN IMMEDIATE），两个不同项目也会互相等待。
  // 「不同项目不互相阻塞」只在 PG 成立，由 scripts/verify/tst-lock-pg.mjs 验证。
});

test('TST-LOCK-04 事务抛错后锁释放：后续事务能在超时窗口内取到锁', async () => {
  const p = 'p-lock04';
  const f = await runWorker({ op: 'fail', project: p });
  assert.equal(f.ok, false);
  assert.equal(f.error.code, 'PROBE_FAIL');
  assert.equal(f.lockedAfter, null, '异常路径必须清空锁上下文');
  const t0 = Date.now();
  const r = await runWorker({ op: 'race', project: p, holdMs: 0 });
  const cost = Date.now() - t0;
  assert.equal(r.ok, true, JSON.stringify(r.error));
  assert.ok(cost < 5000, `锁未及时释放：${cost}ms`);
  assert.deepEqual(probeRows(p).map((x) => x.n), [1], '失败事务写的那行必须已回滚');
});

test('TST-LOCK-05 事务中断（进程被杀）后：无残留锁、无半写行', async () => {
  const p = 'p-lock05';
  const ready = path.join(TMP, 'lock05.ready');
  const { child, done } = startWorker({ op: 'hold', project: p, holdMs: 30000, tag: 'K' }, { IC_LOCK_READY_FILE: ready });
  assert.equal(await waitForFile(ready), true, '没能进入事务');
  child.kill('SIGKILL');
  await done;
  const t0 = Date.now();
  const r = await runWorker({ op: 'race', project: p, holdMs: 0 });
  const cost = Date.now() - t0;
  assert.equal(r.ok, true, JSON.stringify(r.error));
  assert.ok(cost < 5000, `进程被杀后锁未释放：${cost}ms`);
  assert.deepEqual(probeRows(p).map((x) => x.n), [1], '被杀事务的未提交行必须不存在');
});

// ── 06~10：顺序、嵌套拒绝、断言 ─────────────────────────────────────────────

test('TST-LOCK-06 单项目最外层：fn 内 lockedProjects=[P]，提交后为 null，返回值透传', async () => {
  const p = 'p-lock06';
  const r = await runWorker({ op: 'read', project: p });
  assert.equal(r.ok, true);
  assert.deepEqual(r.result.locked, [p]);
  assert.equal(r.lockedAfter, null);
  assert.ok(Array.isArray(r.result.rows), 'fn 的返回值必须原样返回');
});

test('TST-LOCK-06b 无锁调用断言：事务外用 assertProjectLocked 必抛 TX_PROJECT_NOT_LOCKED', async () => {
  const r = await runWorker({ op: 'assertOutside', project: 'p-lock06b' });
  assert.equal(r.ok, true);
  assert.equal(r.result.code, 'TX_PROJECT_NOT_LOCKED');
});

test('TST-LOCK-07 多项目乱序输入 [Q,P]：实际取锁顺序为 [P,Q]', async () => {
  const r = await runWorker({ op: 'multi', projects: ['q-lock07', 'p-lock07'], holdMs: 0 });
  assert.equal(r.ok, true, JSON.stringify(r.error));
  assert.deepEqual(r.order, ['p-lock07', 'q-lock07'], '取锁必须按 cmpStr 升序，不得按入参顺序');
  assert.deepEqual(r.result.locked, ['p-lock07', 'q-lock07']);
});

test('TST-LOCK-08 同项目嵌套复用：取锁次数为 1，内外层看到同一个冻结快照', async () => {
  const r = await runWorker({ op: 'nestedSame', project: 'p-lock08' });
  assert.equal(r.ok, true, JSON.stringify(r.error));
  assert.deepEqual(r.order, ['p-lock08'], '同项目嵌套不得重复取锁');
  assert.deepEqual(r.result.outer, ['p-lock08']);
  assert.deepEqual(r.result.inner.locked, ['p-lock08']);
  assert.equal(probeRows('p-lock08').length, 1);
});

test('TST-LOCK-09 已持 P 后 txProject(Q)：抛 TX_CROSS_PROJECT_NESTED，业务写入未发生', async () => {
  const r = await runWorker({ op: 'cross', project: 'p-lock09', other: 'q-lock09' });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'TX_CROSS_PROJECT_NESTED');
  assert.equal(r.lockedAfter, null, '外层事务必须整体回滚并清空锁上下文');
  assert.equal(probeRows('q-lock09').length, 0, '跨项目写入不得发生');
});

test('TST-LOCK-10 已持锁后再调 txProjects：集合相同/超集/不相交都必须抛', async () => {
  const p = 'p-lock10';
  for (const set of [[p], [p, 'q-lock10'], ['r-lock10']]) {
    const r = await runWorker({ op: 'nestedMulti', project: p, projects: set });
    assert.equal(r.ok, false, `集合 ${JSON.stringify(set)} 未被拒绝`);
    assert.equal(r.error.code, 'TX_NESTED_MULTI_PROJECT', `集合 ${JSON.stringify(set)} 的错误码不对`);
  }
  assert.equal(probeRows('r-lock10').length, 0);
});

// ── 11~13：跨事务顺序 / 释放 / 整组重跑（PG 侧另测，SQLite 侧只证明不撞号不死锁）──

test('TST-LOCK-11 两个事务以相反输入顺序启动：都按 [P,Q] 取锁，都成功（SQLite 侧不变量）', async () => {
  const [a, b] = await Promise.all([
    runWorker({ op: 'multi', projects: ['p-lock11', 'q-lock11'], holdMs: 200 }),
    runWorker({ op: 'multi', projects: ['q-lock11', 'p-lock11'], holdMs: 200 }),
  ]);
  assert.equal(a.ok, true, JSON.stringify(a.error));
  assert.equal(b.ok, true, JSON.stringify(b.error));
  assert.deepEqual(a.order, ['p-lock11', 'q-lock11']);
  assert.deepEqual(b.order, ['p-lock11', 'q-lock11']);
  assert.equal(probeRows('p-lock11').length, 2);
  assert.equal(probeRows('q-lock11').length, 2);
});

test('TST-LOCK-12 异常退出后另一连接可取锁；锁上下文为 null', async () => {
  const p = 'p-lock12';
  const f = await runWorker({ op: 'fail', project: p });
  assert.equal(f.lockedAfter, null);
  const r = await runWorker({ op: 'read', project: p });
  assert.equal(r.ok, true, JSON.stringify(r.error));
  assert.equal(r.lockedAfter, null);
});

test('TST-LOCK-13 SQLite 整组重跑：01~12 的关键不变量一次性复验', async () => {
  // 这一条不是新逻辑，是"不得用某一次偶然结果充当结论"的可执行载体：
  // 用全新项目名把顺序、嵌套、释放、并发取号再跑一遍，任何一条回归即红。
  const p = 'p-lock13';
  const [a, b] = await Promise.all([
    runWorker({ op: 'race', project: p, holdMs: 150, tag: 'A' }),
    runWorker({ op: 'race', project: p, holdMs: 150, tag: 'B' }),
  ]);
  assert.equal(a.ok && b.ok, true);
  assert.deepEqual(probeRows(p).map((x) => x.n), [1, 2]);
  const order = await runWorker({ op: 'multi', projects: ['zz-lock13', 'aa-lock13'], holdMs: 0 });
  assert.deepEqual(order.order, ['aa-lock13', 'zz-lock13']);
  const cross = await runWorker({ op: 'cross', project: 'p-lock13', other: 'x-lock13' });
  assert.equal(cross.error.code, 'TX_CROSS_PROJECT_NESTED');
  const nested = await runWorker({ op: 'nestedMulti', project: 'p-lock13', projects: ['p-lock13'] });
  assert.equal(nested.error.code, 'TX_NESTED_MULTI_PROJECT');
  const plain = await runWorker({ op: 'plainTx', project: 'p-lock13' });
  assert.equal(plain.error.code, 'TX_MUST_BE_IMMEDIATE');
});

// ── 错误码封闭集 / 冻结语义 / 断言（同进程即可，不涉并发）────────────────────
// 编号说明：A05-EXT-nn 是**附加用例**，不属于冻结的 TST-LOCK-01~13，也不改变 P2 的判据；
// 它们锁的是"错误码封闭集"与"冻结语义"，防止实现被后来的人改松。

test('A05-EXT-01 参数与错误码封闭集：空集合 / 超上限 / 空 projectId / 异步函数（附加用例，不属冻结的 13 条）', () => {
  const take = (fn) => { try { fn(); return 'NO_THROW'; } catch (e) { return e.code; } };
  assert.equal(take(() => txProjects([], () => {})), 'TX_EMPTY_PROJECT_SET');
  assert.equal(take(() => txProjects(['', '  '], () => {})), 'TX_EMPTY_PROJECT_SET');
  assert.equal(take(() => txProjects(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'], () => {})), 'TX_TOO_MANY_PROJECTS');
  assert.equal(take(() => txProject('', () => {})), 'TX_EMPTY_PROJECT_SET');
  assert.equal(take(() => txProject('p-x', async () => {})), 'ASYNC_TX');
  // 失败后不得留下锁上下文
  assert.equal(lockedProjects(), null);
});

test('A05-EXT-02 普通 tx() 内调 txProject：抛 TX_MUST_BE_IMMEDIATE，不得"先做再看"（附加）', () => {
  let code = '';
  try {
    tx(() => txProject('p-y', () => {}));
  } catch (e) { code = e.code; }
  assert.equal(code, 'TX_MUST_BE_IMMEDIATE');
  assert.equal(lockedProjects(), null);
});

test('A05-EXT-03 锁集合冻结：返回值为冻结数组，push 抛 TypeError（附加）', () => {
  let frozen = false;
  let pushErr = '';
  let after = 'x';
  txProject('p-z', () => {
    const snap = lockedProjects();
    frozen = Object.isFrozen(snap);
    try { snap.push('hacked'); } catch (e) { pushErr = e.constructor.name; }
    assert.deepEqual(snap, ['p-z']);
  });
  after = lockedProjects();
  assert.equal(frozen, true);
  assert.equal(pushErr, 'TypeError');
  assert.equal(after, null);
});

test('A05-EXT-04 断言只在同一事务内有效：txProject 内通过，跨项目拒绝（附加）', () => {
  txProject('p-a', () => {
    assertProjectLocked('p-a');
    let code = '';
    try { assertProjectLocked('p-b'); } catch (e) { code = e.code; }
    assert.equal(code, 'TX_PROJECT_NOT_LOCKED');
  });
  // 事务结束后再断言 = 没持锁
  let code = '';
  try { assertProjectLocked('p-a'); } catch (e) { code = e.code; }
  assert.equal(code, 'TX_PROJECT_NOT_LOCKED');
});
