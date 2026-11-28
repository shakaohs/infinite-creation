// P10-A · D42-02：取锁顺序观察者不进入公共 API
//
// 背景：TST-LOCK-07 要求「用注入的 spy 记录真实取锁顺序」（D02-34 §4.1）。上一版把
// `setLockOrderSink` 直接 export 在 db.js 里 —— 而 lib/core/index.js 有 `export * from './db.js'`，
// 于是这个纯测试用的注入点**自动变成了对外 API**，业务代码可以随手把锁顺序改成任意值。
//
// 本轮把它移到 lib/core/internal/lock-order.js：不被 index.js 转出、需要显式路径引用，
// 且非 IC_LOCK_TEST=1 的进程调用直接抛。四条冻结接口的签名一个参数都没动。
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-d42-02-'));
process.env.IC_DATA_DIR = TMP;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const core = await import('../lib/core/index.js');
const dbNs = await import('../lib/core/db.js');
const internal = await import('../lib/core/internal/lock-order.js');

const { getDb, txProject, txProjects, lockedProjects, assertProjectLocked } = core;
getDb();

test.after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* 占用中 */ } });

test('D42-02-A 公共面里没有 setLockOrderSink（index.js 与 db.js 都不导出）', () => {
  assert.equal(typeof core.setLockOrderSink, 'undefined', 'lib/core/index.js 不得导出取锁观察者');
  assert.equal(typeof dbNs.setLockOrderSink, 'undefined', 'lib/core/db.js 不得再导出取锁观察者');
  assert.equal('setLockOrderSink' in core, false);
});

test('D42-02-B 四条冻结接口签名不变（参数个数逐个核）', () => {
  assert.equal(typeof txProject, 'function');
  assert.equal(typeof txProjects, 'function');
  assert.equal(typeof lockedProjects, 'function');
  assert.equal(typeof assertProjectLocked, 'function');
  assert.equal(txProject.length, 2, 'txProject(projectId, fn)');
  assert.equal(txProjects.length, 2, 'txProjects(projectIds, fn)');
  assert.equal(lockedProjects.length, 0, 'lockedProjects() 无参数');
  assert.equal(assertProjectLocked.length, 1, 'assertProjectLocked(projectId) 单参、无 options');
});

test('D42-02-C 无 IC_LOCK_TEST=1 时注入直接拒绝：LOCK_SINK_TEST_ONLY', () => {
  const saved = process.env.IC_LOCK_TEST;
  delete process.env.IC_LOCK_TEST;
  try {
    assert.throws(() => internal.setLockOrderSink(() => {}), (e) => e.code === 'LOCK_SINK_TEST_ONLY');
    assert.throws(() => internal.setLockOrderSink(null), (e) => e.code === 'LOCK_SINK_TEST_ONLY',
      '注销同样受闸门保护：外部不得把测试观察者关掉后当"没取锁"');
    assert.equal(internal.lockOrderObserving(), false);
  } finally {
    if (saved === undefined) delete process.env.IC_LOCK_TEST; else process.env.IC_LOCK_TEST = saved;
  }
});

test('D42-02-D 观察者缺席时 emit 是空操作（生产路径不受影响）', () => {
  assert.equal(internal.lockOrderObserving(), false);
  assert.equal(internal.emitLockOrder('p-x'), undefined);
});

test('D42-02-E 显式开启后观察者记录**真实**取锁顺序（TST-LOCK-07 能力未降级）', () => {
  process.env.IC_LOCK_TEST = '1';
  const seen = [];
  try {
    internal.setLockOrderSink((pid) => seen.push(pid));
    assert.equal(internal.lockOrderObserving(), true, '注入必须真的生效，否则 order=[] 会被误读成"没取锁"');
    const r = txProjects(['q-lock07x', 'p-lock07x'], () => lockedProjects());
    assert.deepEqual(r, ['p-lock07x', 'q-lock07x'], '锁集合按 cmpStr 升序');
    assert.deepEqual(seen, ['p-lock07x', 'q-lock07x'], '观察到的顺序必须与入参顺序无关');
    // 嵌套复用不得重复回调（同项目只取一次锁）
    seen.length = 0;
    txProject('p-lock07x', () => { txProject('p-lock07x', () => {}); });
    assert.deepEqual(seen, ['p-lock07x']);
  } finally {
    internal.setLockOrderSink(null);
    delete process.env.IC_LOCK_TEST;
  }
  assert.equal(internal.lockOrderObserving(), false, '测试结束必须能可靠注销');
});

test('D42-02-F 静态扫描：只有 db.js 引用内部模块，且只有 tests/ 能引用注入入口', () => {
  const SKIP_DIRS = new Set(['node_modules', '.git', '.next', 'dist', 'build', 'coverage']);
  const walk = (dir, out = []) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (SKIP_DIRS.has(e.name)) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p, out);
      else if (/\.(mjs|cjs|js|ts)$/.test(e.name)) out.push(p);
    }
    return out;
  };

  const productionDirs = ['lib', 'app', 'scripts'].map((d) => path.join(ROOT, d)).filter((d) => fs.existsSync(d));
  // 只认**真正的 import 语句**，不认注释/文档里的字符串 —— 否则一段说明就能把扫描糊过去
  const importsInternal = (src) => /from\s+['"][^'"]*internal\/lock-order/.test(src)
    || /import\(\s*['"][^'"]*internal\/lock-order/.test(src);
  const importers = [];
  const sinkUsers = [];
  for (const dir of productionDirs) {
    for (const file of walk(dir)) {
      const src = fs.readFileSync(file, 'utf8');
      const rel = path.relative(ROOT, file).split(path.sep).join('/');
      if (importsInternal(src)) importers.push(rel);
      if (src.includes('setLockOrderSink')) sinkUsers.push(rel);
    }
  }

  // db.js 只 import emitLockOrder；它不该出现注入入口的名字
  assert.deepEqual(importers, ['lib/core/db.js'], `生产代码里只允许 db.js 引用内部模块，实际：${importers.join(', ')}`);
  // setLockOrderSink 只允许**定义**在内部模块里：出现第二个文件 = 有人又把它搬回公共面或复制了一份
  assert.deepEqual(sinkUsers, ['lib/core/internal/lock-order.js'],
    `setLockOrderSink 只允许存在于内部模块定义处，实际：${sinkUsers.join(', ')}`);

  // index.js 是公共面的唯一出口：源码里不该出现这个内部模块的任何痕迹
  const indexPath = path.join(ROOT, 'lib', 'core', 'index.js');
  const indexSrc = fs.readFileSync(indexPath, 'utf8');
  assert.equal(indexSrc.includes('lock-order'), false, 'index.js 不得转出内部模块');
  assert.equal(indexSrc.includes('setLockOrderSink'), false);
});
