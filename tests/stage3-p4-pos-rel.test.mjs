// 阶段 3 · P4：posRel 搬迁回归（D01-04 §5.2.2；D02-06 §7.1）
//
// 搬迁的唯一证明方式是"同一份数据、两条路径、逐行相同"：
//   · 老路径 `lib/core/hash/source-spec-hash.js`（经 `hash/index.js` 导入）
//   · 新路径 `lib/core/continuity/pos-rel.js`
// 两份矩阵数据都取自 `tests/fixtures/pos-rel-matrix.mjs` —— 只有一份数据，就不存在"两边悄悄不同"。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// P0 隔离：纯函数模块本身不开库，但仍按约定钉住数据目录（防将来有人在这里 import 业务模块）
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-p4-posrel-'));
process.env.IC_DATA_DIR = TMP;
delete process.env.IC_DB_SQLITE_PATH;
delete process.env.IC_DB;
delete process.env.DATABASE_URL;

const rel = await import('../lib/core/continuity/pos-rel.js');
const hash = await import('../lib/core/hash/index.js');
const core = await import('../lib/core/index.js');
const { POS_REL_MATRIX, POS_REL_WARNING_CASES } = await import('./fixtures/pos-rel-matrix.mjs');
const { fx } = await import('./helpers/hash-fixture.mjs');

const { posRel, posRelDetail } = rel;

// ── P4-T02 新路径跑同一份 13 行矩阵 ────────────────────────────────────
test('P4-T02 新路径（continuity/pos-rel.js）13 行矩阵逐行相同', () => {
  assert.equal(POS_REL_MATRIX.length, 13, '矩阵必须恰好 13 行');
  for (const row of POS_REL_MATRIX) {
    assert.equal(posRel(row.args), row.expected, `第 ${row.n} 行：${row.why}`);
  }
});

// ── P4-T01 老路径仍在（R-44 由 stage1-hash 负责，这里只钉"同一个函数对象"）──
test('P4-T01/P4-T05 老路径与新路径是同一份实现（同一个函数引用）', () => {
  assert.equal(typeof hash.posRel, 'function');
  assert.equal(hash.posRel, posRel, 'hash 侧必须再导出同一个函数，不能是副本');
  assert.equal(hash.posRelDetail, posRelDetail);
  assert.equal(core.posRel, posRel, 'lib/core/index.js 的公开导出也必须是同一个函数');
  assert.equal(core.posRelDetail, posRelDetail);
});

test('P4-T05 全仓只有一处 `function posRel` 定义', () => {
  const root = path.resolve('lib');
  const hits = [];
  const walk = (dir) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) { walk(full); continue; }
      if (!/\.(js|mjs)$/.test(ent.name)) continue;
      const text = fs.readFileSync(full, 'utf8');
      if (/function\s+posRel\s*\(/.test(text)) hits.push(path.relative(process.cwd(), full).replace(/\\/g, '/'));
    }
  };
  walk(root);
  assert.deepEqual(hits, ['lib/core/continuity/pos-rel.js'], '不得出现第二份实现');
});

// ── P4-T03 两种矛盾告警 ────────────────────────────────────────────────
test('P4-T03 posRelDetail 两种矛盾告警', () => {
  for (const c of POS_REL_WARNING_CASES) {
    assert.deepEqual(posRelDetail(c.args).warnings, c.expectedWarnings, c.why);
  }
  // 无矛盾时不得凭空产生告警
  assert.deepEqual(posRelDetail({ x: 1.2, y: 3.4, z: 0, metaEntry: { rel: 'known' } }).warnings, []);
  assert.deepEqual(posRelDetail({ x: 1.2, y: 3.4, z: 0 }).warnings, []);
});

// ── P4-T04 BL-05：降级站位（norm_xyz 全 NULL）必须 unknown ─────────────
test('P4-T04 BL-05 三维坐标缺失时，即使 spec_source=manual / meta 标 known 也必须 unknown', () => {
  // 这是评审点名的那条：历史 66 条分镜的 norm_xyz 全为 NULL，若按来源推导成 inferred，
  // 求解器就会拿"没位置"当"位置是推断的"，产出假 PASS。
  assert.equal(posRel({ x: null, y: null, z: null, specSource: 'manual' }), 'unknown');
  assert.equal(posRel({ x: null, y: null, z: null, specSource: 'manual', metaEntry: { rel: 'known' } }), 'unknown');
  assert.equal(posRel({ x: null, y: null, z: null, specSource: 'scene_baseline' }), 'unknown');
  // 部分缺失同样不成立（S-24 的判定基础）
  assert.equal(posRel({ x: 0.5, y: null, z: 0, specSource: 'manual' }), 'unknown');
  assert.equal(posRel({ x: 0.5, y: 0.5, z: null, specSource: 'manual' }), 'unknown');
});

test('P4-T04b z=0 是合法确定值；NaN / Infinity / 非数值一律 unknown', () => {
  assert.equal(posRel({ x: 0.5, y: 0.5, z: 0, specSource: 'manual' }), 'known');
  assert.equal(posRel({ x: 0, y: 0, z: 0, specSource: 'manual' }), 'known', '全 0 不是"缺失"');
  assert.equal(posRel({ x: 0.5, y: 0.5, z: NaN, specSource: 'manual' }), 'unknown');
  assert.equal(posRel({ x: 0.5, y: 0.5, z: Infinity, specSource: 'manual' }), 'unknown');
  assert.equal(posRel({ x: 0.5, y: 0.5, z: -Infinity, specSource: 'manual' }), 'unknown');
  assert.equal(posRel({ x: 0.5, y: 0.5, z: '0', specSource: 'manual' }), 'unknown', '字符串不是有限数');
  assert.equal(posRel(), 'unknown', '无参数 = 三分量缺失');
});

test('P4-T04c meta 里只有 __solver 时，不得把它当成字段可靠性条目', () => {
  // `__solver` 是求解器元数据（B-05），不是 `{rel,src,conf}` 条目
  const meta = { __solver: { rel: 'unknown', hash: 'abc', state: 'ok' } };
  assert.equal(posRel({ x: 1.2, y: 3.4, z: 0, metaEntry: meta, specSource: 'manual' }), 'known',
    '读不到 metaEntry.rel 时应按来源推导，不能被 __solver.rel 干扰');
  assert.deepEqual(posRelDetail({ x: 1.2, y: 3.4, z: 0, metaEntry: meta }).warnings, []);
});

test('P4-T04d 同输入多次调用结果稳定（纯函数）', () => {
  const args = { x: 1.2, y: 3.4, z: 0, metaEntry: { rel: 'inferred' }, specSource: 'manual' };
  const first = posRel(args);
  for (let i = 0; i < 5; i += 1) assert.equal(posRel(args), first);
  assert.deepEqual(posRelDetail(args), posRelDetail(args));
});

// ── P4-T06 Hash 侧行为不变 ─────────────────────────────────────────────
test('P4-T06 buildSourcePayload 仍由 posRel 求 rel；sourceSpecHash 结果可复算', () => {
  const payload = hash.buildSourcePayload(fx());
  const shot0 = payload.shots[0];
  assert.ok(Array.isArray(shot0.blockings) && shot0.blockings.length > 0, '样例必须带站位');
  for (const b of shot0.blockings) {
    // fixture 的 block() 给了 meta.rel='known'，坐标完整 → known
    assert.equal(b.rel, 'known');
  }
  // 同输入两次 → 同一个 hash（搬迁没有引入不确定性）
  const a = hash.sourceSpecHash(fx());
  const b = hash.sourceSpecHash(fx());
  assert.equal(a, b);
  assert.match(a, /^sha256:[0-9a-f]{64}$/);
});

test('P4-T06b 坐标缺失时 payload 的 rel 必须是 unknown（不是 inferred）', () => {
  const input = fx();
  input.shots[0].blockings[0].norm_y = null;
  input.shots[0].blockings[0].meta = { rel: 'known' };
  const payload = hash.buildSourcePayload(input);
  assert.equal(payload.shots[0].blockings[0].rel, 'unknown');
});

test('P4-T06c 搬迁没有改变 hash 输入：payload 结构与既有字段逐字一致', () => {
  const payload = hash.buildSourcePayload(fx());
  const keys = Object.keys(payload.shots[0].blockings[0]).sort();
  assert.deepEqual(keys, [
    'anchor', 'anchorObj', 'behind', 'char', 'dist', 'facing', 'gaze', 'hand', 'inFrame',
    'occ', 'pos', 'posTrack', 'posture', 'power', 'rel', 'task', 'xy',
  ].sort(), '站位白名单字段不得因搬迁增减');
});
