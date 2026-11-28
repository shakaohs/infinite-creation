#!/usr/bin/env node
// TST-LOCK 的**独立事务进程**：一个进程 = 一条数据库连接 = 一个事务。
//
// 为什么必须是独立进程（不是同一进程里两个 txProject）：
//   仓库的 SQLite 是同步 API、PG 驱动是单连接 + `Atomics.wait`，同一进程里的两个事务天然串行，
//   做不出交错。D02-40 §8.3.3 第 5 项写明：双连接必须是真的两条连接。
//   本文件因此只做一件事 —— 收一份作业描述，在自己的连接上跑一个事务，把结果打成一行 JSON。
//
// 作业描述（环境变量 IC_LOCK_JOB，JSON）：
//   { op, project?, projects?, holdMs?, tag?, table? }
// op 见 switch；所有 op 都只在 lock_probe 探针表上写（不碰任何业务表）。
//
// 输出（stdout，单行）：{ ok, op, osPid, backendPid, locked, order, result, error, elapsedMs }
import fs from 'node:fs';

const job = JSON.parse(process.env.IC_LOCK_JOB || '{}');
const {
  tx, txProject, txProjects, lockedProjects, assertProjectLocked, getDb, uid,
} = await import('../../lib/core/index.js');
// 取锁顺序观察者从**内部模块**引用，不经 lib/core/index.js（D42-02）：
// 它不是公共 API，公共面里既没有它、也不该有它。父进程负责传 IC_LOCK_TEST=1。
const { setLockOrderSink, lockOrderObserving } = await import('../../lib/core/internal/lock-order.js');

const db = getDb();
const backendPid = db.dialect === 'postgres'
  ? db.prepare('SELECT pg_backend_pid() AS p').get().p
  : process.pid;

db.exec(`CREATE TABLE IF NOT EXISTS lock_probe (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  n INTEGER NOT NULL,
  tag TEXT DEFAULT ''
)`);

const sleepSync = (ms) => {
  if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};
const maxOf = (pid) => db.prepare('SELECT COALESCE(MAX(n),0) AS m FROM lock_probe WHERE project_id=?').get(pid).m;
const insertProbe = (pid, n, tag) => db.prepare('INSERT INTO lock_probe (id,project_id,n,tag) VALUES (?,?,?,?)')
  .run(uid(), pid, n, tag || '');

const order = [];
setLockOrderSink((pid) => order.push(pid));
if (!lockOrderObserving()) {
  // 不静默：观察者没挂上时 order 恒为 []，会被误读成"没取锁"而不是"没观测"
  process.stderr.write('lock-worker: 取锁观察者未生效（IC_LOCK_TEST 未设为 1？）\n');
  process.exit(2);
}

const readyFile = process.env.IC_LOCK_READY_FILE || '';

const started = Date.now();
let out;
try {
  switch (job.op) {
    // 同项目 MAX+1 取号：无锁时两个事务会读到同一个 max，唯一索引只会让后者失败
    case 'race': {
      const r = txProject(job.project, () => {
        const m = maxOf(job.project);
        sleepSync(job.holdMs || 0);
        const n = m + 1;
        insertProbe(job.project, n, job.tag);
        return { n, locked: lockedProjects() };
      });
      out = { ok: true, result: r };
      break;
    }
    // 持锁一段时间（供另一个进程观测"等待"与"崩溃后释放"）
    case 'hold': {
      const r = txProject(job.project, () => {
        insertProbe(job.project, maxOf(job.project) + 1, job.tag || 'hold');
        // 就绪文件里带后端 pid：父进程要在事务**还开着**的时候去 pg_locks 里核对真实锁
        if (readyFile) fs.writeFileSync(readyFile, JSON.stringify({ backendPid, osPid: process.pid }));
        sleepSync(job.holdMs || 1000);
        return { locked: lockedProjects() };
      });
      out = { ok: true, result: r };
      break;
    }
    // 事务内读：用于验证"读到一致快照"，以及"另一事务等待后能看到已提交的行"
    case 'read': {
      const r = txProject(job.project, () => {
        const rows = db.prepare('SELECT n FROM lock_probe WHERE project_id=? ORDER BY n').all(job.project).map((x) => x.n);
        sleepSync(job.holdMs || 0);
        return { rows, locked: lockedProjects() };
      });
      out = { ok: true, result: r };
      break;
    }
    // 事务失败：写入必须回滚、锁必须释放
    case 'fail': {
      txProject(job.project, () => {
        insertProbe(job.project, maxOf(job.project) + 1, job.tag || 'fail');
        throw Object.assign(new Error('故意失败'), { code: 'PROBE_FAIL' });
      });
      out = { ok: false, result: null };
      break;
    }
    // 多项目：集合乱序传入，取锁顺序必须被规范化
    case 'multi': {
      const r = txProjects(job.projects, () => {
        for (const p of job.projects) insertProbe(p, maxOf(p) + 1, job.tag || 'multi');
        sleepSync(job.holdMs || 0);
        return { locked: lockedProjects() };
      });
      out = { ok: true, result: r };
      break;
    }
    // 嵌套：项目事务内再调 txProjects（集合相同也拒）
    case 'nestedMulti': {
      txProject(job.project, () => txProjects(job.projects || [job.project], () => {
        insertProbe(job.project, 1, 'should-not-happen');
      }));
      out = { ok: true, result: null };
      break;
    }
    // 嵌套：同项目复用（取锁次数必须是 1，不是 2）
    case 'nestedSame': {
      const r = txProject(job.project, () => {
        const outer = lockedProjects();
        const inner = txProject(job.project, () => {
          insertProbe(job.project, maxOf(job.project) + 1, 'nested');
          return { locked: lockedProjects() };
        });
        return { outer, inner, sameRef: outer === inner };
      });
      out = { ok: true, result: r };
      break;
    }
    // 嵌套：跨项目
    case 'cross': {
      txProject(job.project, () => txProject(job.other, () => {
        insertProbe(job.other, 1, 'should-not-happen');
      }));
      out = { ok: true, result: null };
      break;
    }
    // 嵌套：普通 tx() 内调 txProject
    case 'plainTx': {
      tx(() => txProject(job.project, () => {
        insertProbe(job.project, 1, 'should-not-happen');
      }));
      out = { ok: true, result: null };
      break;
    }
    // 断言：持锁时断言本项目的通过，断言别的项目抛 TX_PROJECT_NOT_LOCKED
    case 'assert': {
      const r = txProject(job.project, () => {
        assertProjectLocked(job.project);
        let badCode = '';
        try { assertProjectLocked(job.other); } catch (e) { badCode = e.code; }
        return { good: true, badCode, locked: lockedProjects() };
      });
      out = { ok: true, result: r };
      break;
    }
    // 断言：事务外调用必须抛（不得"预检通过就当持有"）
    case 'assertOutside': {
      let code = '';
      try { assertProjectLocked(job.project); } catch (e) { code = e.code; }
      out = { ok: true, result: { code } };
      break;
    }
    // 锁集合冻结：push 必须 TypeError，且返回的不是内部引用
    case 'frozen': {
      const r = txProject(job.project, () => {
        const snap = lockedProjects();
        let pushError = '';
        try { snap.push('hacked'); } catch (e) { pushError = e.constructor.name; }
        return {
          frozen: Object.isFrozen(snap), pushError, len: snap.length, locked: snap,
          afterOutside: null,
        };
      });
      out = { ok: true, result: r };
      break;
    }
    // 空集合 / 超上限 / 空 projectId
    case 'badArgs': {
      const codes = {};
      const take = (k, fn) => { try { fn(); codes[k] = 'NO_THROW'; } catch (e) { codes[k] = e.code; } };
      take('emptySet', () => txProjects([], () => {}));
      take('blankIds', () => txProjects(['', '  '], () => {}));
      take('tooMany', () => txProjects(['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7', 'p8', 'p9'], () => {}));
      take('blankProject', () => txProject('', () => {}));
      take('asyncFn', () => txProject(job.project, async () => {}));
      out = { ok: true, result: { codes } };
      break;
    }
    default:
      out = { ok: false, error: { code: 'UNKNOWN_OP', message: String(job.op) } };
  }
} catch (e) {
  out = {
    ok: false,
    error: { code: e.code || 'ERROR', message: String(e.message || e) },
  };
}

out.op = job.op;
out.osPid = process.pid;
out.backendPid = backendPid;
out.dialect = db.dialect;
out.order = order;
out.lockedAfter = lockedProjects();
out.elapsedMs = Date.now() - started;
process.stdout.write(JSON.stringify(out) + '\n');
try { if (db.raw) db.raw.close(); } catch { /* SQLite 已关 */ }
process.exit(0);
