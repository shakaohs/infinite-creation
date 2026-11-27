// 阶段 3 · P5 定向修复：S-07 的 `AXIS_LOCK_INCOMPLETE`（WARN）诊断
//
// 复审指出：`checkAxisVerifiable()` 在 `axis_line` 缺失时只报 `AXIS_UNVERIFIED` /
// `SCREEN_LR_UNVERIFIED`（INFO），而 D02-06 §4.8.1 与 SC-05 还要求
// `AXIS_LOCK_INCOMPLETE`（WARN）—— "允许存在但未定义几何"不等于"没有告警"。
//
// 本文件专测这一处，重点不是"有没有这个码"，而是三件事：
//   ① 轴锁不完整 → WARN，且**不可验证的 INFO 证据不能因此消失**（两者同属一条结果）；
//   ② QL-1 的"一条规则一条结果"不得被破坏（不许出现第二条 S-07）；
//   ③ S-05/S-06 在轴线不可验证时**仍不得**判越轴 FAIL（缺数据 ≠ 通过 ≠ 失败）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-p5-axis-lock-'));
process.env.IC_DATA_DIR = TMP;
delete process.env.IC_DB_SQLITE_PATH;
delete process.env.IC_DB;
delete process.env.DATABASE_URL;

const {
  validateRule, validateShot,
} = await import('../lib/core/validate/index.js');
const F = await import('./helpers/qc-fixture.mjs');

const { ctx, b, scene } = F;

const WARN_CODE = 'AXIS_LOCK_INCOMPLETE';
const INFO_CODES = ['AXIS_UNVERIFIED', 'SCREEN_LR_UNVERIFIED'];

/** 场次去掉轴锁（保留其它几何，确保"只缺轴锁"这一件事） */
function sceneNoLock() {
  const s = scene();
  delete s.axis_lock;
  return s;
}

/** 场次有 `pair/left/right`（§4.8.1 允许落库的那一半），但没有 `axis_line` */
function sceneLockWithoutLine() {
  const s = scene();
  return { ...s, axis_lock: { pair: ['c1', 'c2'], left: 'c1', right: 'c2', camera_side: 'left', cross_allowed: [] } };
}

/** 场次带一个指定写法（含非法写法）的 `axis_line` */
function sceneWithLine(axisLine) {
  const s = scene();
  return { ...s, axis_lock: { ...s.axis_lock, axis_line: axisLine } };
}

/** 命中条目里的全部 code（主 code + 字段级 items），用于"证据有没有丢"的断言 */
function codesOf(entry) {
  const items = Array.isArray(entry?.detail?.items) ? entry.detail.items : [];
  return [entry?.code, ...items.map((x) => x?.code)].filter(Boolean);
}

function itemsOf(entry) {
  return Array.isArray(entry?.detail?.items) ? entry.detail.items : [];
}

/* ── 1. axis_lock 完全缺失 ───────────────────────────────────────────── */

test('S-07 · axis_lock 完全缺失 → AXIS_LOCK_INCOMPLETE（warn，source=axis_lock_missing）', () => {
  const e = validateRule('S-07', ctx({ sceneState: sceneNoLock(), blockings: [b()] }));
  assert.equal(e.rule_id, 'S-07');
  assert.equal(e.level, 'warn');
  assert.equal(e.code, WARN_CODE);
  assert.equal(e.detail.items[0].detail.source, 'axis_lock_missing');
  assert.deepEqual(e.detail.items[0].detail.missing, ['scene_states.axis_lock']);
  // 轴锁整块没了，轴线必然不可验证 —— 两条 INFO 证据必须还在
  for (const code of INFO_CODES) assert.ok(codesOf(e).includes(code), `缺 ${code}：` + codesOf(e).join(','));
});

/* ── 2. axis_lock 存在但 axis_line 缺失 ─────────────────────────────── */

test('S-07 · axis_lock 有 pair/left/right 但缺 axis_line → warn（source=axis_line_absent）', () => {
  const e = validateRule('S-07', ctx({ sceneState: sceneLockWithoutLine(), blockings: [b()] }));
  assert.equal(e.level, 'warn');
  assert.equal(e.code, WARN_CODE);
  const d = e.detail.items[0].detail;
  assert.equal(d.source, 'axis_line_absent');
  assert.equal(d.axis_lock, 'present');
  assert.equal(d.axis_line, 'absent');
  // 不允许"用 left/right 顶上"：缺 axis_line 时不得有任何一条 pass 结论
  assert.notEqual(e.level, 'pass');
});

test('S-07 · 缺 axis_line 时保留原有两条不可验证 INFO（同一条结果内的字段级命中）', () => {
  const e = validateRule('S-07', ctx({ sceneState: sceneLockWithoutLine(), blockings: [b()] }));
  const items = itemsOf(e);
  const need = ['AXIS_UNVERIFIED', 'SCREEN_LR_UNVERIFIED'];
  for (const code of need) {
    const hit = items.find((x) => x.code === code);
    assert.ok(hit, `必须保留 ${code}：` + items.map((x) => x.code).join(','));
    assert.equal(hit.level, 'info');
    assert.ok(Array.isArray(hit.detail.missing) && hit.detail.missing.length > 0, `${code} 必须说明缺什么`);
    assert.ok(hit.detail.missing.includes('scene_states.axis_lock.axis_line'), `${code} 的 missing 必须点到 axis_line`);
  }
  // WARN 是主因：主 code/level 取它，但 fields[] 要把所有命中字段并进来
  assert.equal(e.code, WARN_CODE);
  assert.equal(e.level, 'warn');
  assert.ok(e.fields.includes('scene_states.axis_lock.axis_line'));
  assert.equal(e.field, 'scene_states.axis_lock.axis_line');
});

/* ── 3. axis_line 完整且合法 ────────────────────────────────────────── */

test('S-07 · axis_line 完整且合法 → 不产生 AXIS_LOCK_INCOMPLETE（且不误判为不适用）', () => {
  const e = validateRule('S-07', ctx({ sceneState: scene(), blockings: [b()] }));
  assert.equal(e.applicable, true);
  assert.equal(e.level, 'pass');
  assert.equal(e.code, 'PASS');
  assert.equal(codesOf(e).includes(WARN_CODE), false, '完整基线不得出现 AXIS_LOCK_INCOMPLETE');
  assert.deepEqual(e.fields, []);
});

test('S-07 · axis_line 合法时，即使 cam_pos 缺失也只报 INFO（不升档成 warn）', () => {
  const e = validateRule('S-07', ctx({ sceneState: scene(), blockings: [b()], shot: { cam_pos: null } }));
  assert.equal(e.level, 'info');
  assert.equal(codesOf(e).includes(WARN_CODE), false, '轴锁完整时不得出现 AXIS_LOCK_INCOMPLETE');
  // 同档两条 INFO 的"主 code"由 `worstFinding` 的 field 序决定（cam_pos 排在 axis_lock 之前），
  // 这是 P5 首轮就有的确定性约定，此处只断言"都还报着"，不锁定是谁当主 code
  for (const code of INFO_CODES) assert.ok(codesOf(e).includes(code), `缺 ${code}：` + codesOf(e).join(','));
});

/* ── 4. axis_line 格式非法 ──────────────────────────────────────────── */

const MALFORMED = [
  ['只有 1 个点', [[0.5, 0]]],
  ['3 个点', [[0.5, 0], [0.5, 1], [0, 0]]],
  ['分量非数字', [[0.5, 0], [0.5, 'a']]],
  ['两点重合（退化）', [[0.5, 0.5], [0.5, 0.5]]],
  ['不是数组', 'garbage'],
];

for (const [label, line] of MALFORMED) {
  test(`S-07 · axis_line 非法（${label}）→ warn（source=axis_line_malformed）`, () => {
    const e = validateRule('S-07', ctx({ sceneState: sceneWithLine(line), blockings: [b()] }));
    assert.equal(e.level, 'warn', `非法 axis_line 必须升到 warn：${label}`);
    assert.equal(e.code, WARN_CODE);
    const d = e.detail.items[0].detail;
    assert.equal(d.source, 'axis_line_malformed');
    assert.equal(d.axis_line, 'malformed');
    // 非法 = 没有合法轴线 → 两条不可验证 INFO 同样要在
    for (const code of INFO_CODES) assert.ok(codesOf(e).includes(code), `缺 ${code}：` + codesOf(e).join(','));
  });
}

/* ── 5. 轴线不可验证时 S-05 / S-06 不得判 FAIL ─────────────────────── */

/** 这组站位在完整基线下会判越轴（S-05 的负向夹具） */
function crossingCtx(sceneState) {
  return ctx({
    sceneState,
    blockings: [b({ character_id: 'c1', norm_x: 0.8, norm_y: 0.6 }), b({ character_id: 'c2', norm_x: 0.3, norm_y: 0.25 })],
  });
}

test('S-05/S-06 · 完整基线下这组站位确实越轴（先证明夹具会红）', () => {
  const s5 = validateRule('S-05', crossingCtx(scene()));
  assert.equal(s5.level, 'fail');
  assert.equal(s5.code, 'LEFT_RIGHT_FLIP');
});

test('S-05/S-06 · 缺 axis_line 时不产生越轴 FAIL（不适用，不是通过）', () => {
  const c = crossingCtx(sceneLockWithoutLine());
  for (const id of ['S-05', 'S-06']) {
    const e = validateRule(id, c);
    assert.notEqual(e.level, 'fail', `${id} 不得在轴线不可验证时判 FAIL`);
    assert.notEqual(e.level, 'pass', `${id} 也不得伪装成通过`);
    assert.equal(e.applicable, false, `${id} 应为不适用：` + e.detail.reason);
  }
});

test('S-05/S-06 · axis_line 非法时同样不得判越轴 FAIL', () => {
  const c = crossingCtx(sceneWithLine([[0.5, 0.5], [0.5, 0.5]]));
  for (const id of ['S-05', 'S-06']) {
    const e = validateRule(id, c);
    assert.notEqual(e.level, 'fail', `${id} 不得拿退化 axis_line 判 FAIL`);
    assert.equal(e.applicable, false);
  }
});

/* ── 6. 一条规则一条结果（QL-1）────────────────────────────────────── */

test('QL-1 · 轴锁不完整时 S-07 仍只产生一条结果（不得追加第二条 S-07）', () => {
  const r = validateShot({
    ...ctx({ sceneState: sceneLockWithoutLine(), blockings: [b()] }),
    chapterShots: [],
  });
  const s07 = r.hits.filter((h) => h.rule_id === 'S-07');
  assert.equal(s07.length, 1, 'S-07 只能有一条：' + r.hits.map((h) => h.rule_id).join(','));
  assert.equal(s07[0].level, 'warn');
  assert.equal(s07[0].code, WARN_CODE);
  // 三条字段级命中合并在同一条里，而不是拆成三条记录
  assert.equal(s07[0].detail.items.length, 3);
  // 唯一键 (target, rule_id) 不重复：整份 hits 的 rule_id 必须互不相同
  const ids = r.hits.map((h) => h.rule_id);
  assert.equal(new Set(ids).size, ids.length, 'hits 里 rule_id 出现重复：' + ids.join(','));
  // 统计口径：这一条只计入 warn 一档，不得同时算进 info
  assert.equal(r.stats.warn >= 1, true);
  assert.equal(r.hits.filter((h) => h.rule_id === 'S-07' && h.level === 'info').length, 0);
});

test('QL-4 · 轴锁不完整会抬高报告级 level 到 warn（此前是 info）', () => {
  const base = { ...ctx({ sceneState: scene(), blockings: [b()] }), chapterShots: [] };
  const withLock = validateShot(base);
  const without = validateShot({ ...base, sceneState: sceneLockWithoutLine() });
  assert.equal(withLock.hits.find((h) => h.rule_id === 'S-07').level, 'pass');
  assert.equal(without.hits.find((h) => h.rule_id === 'S-07').level, 'warn');
  // 报告级 level 取最高档：warn > info，所以整体至少是 warn
  assert.ok(['warn', 'fail'].includes(without.level), '报告级 level 应被抬高：' + without.level);
});

/* ── 7. 确定性 / 不改入参 / 不补默认值 ──────────────────────────────── */

test('S-07 · 不改写入参、两次调用逐字一致', () => {
  const sceneState = Object.freeze(sceneLockWithoutLine());
  const shot = Object.freeze({ ...F.baseShot });
  const blockings = Object.freeze([b()]);
  const before = JSON.stringify({ sceneState, shot, blockings });
  const a1 = validateRule('S-07', { shot, blockings, sceneState });
  const a2 = validateRule('S-07', { shot, blockings, sceneState });
  assert.equal(JSON.stringify(a1), JSON.stringify(a2), '两次调用必须逐字一致');
  assert.equal(JSON.stringify({ sceneState, shot, blockings }), before, '不得改写任何入参');
  // 缺 axis_line 不得被"补"出来：命中的 expected 是要求补，不是已补
  assert.equal(sceneState.axis_lock.axis_line, undefined);
});

test('S-07 · scene_states 行完全没传 → 同样报 AXIS_LOCK_INCOMPLETE（source=scene_state_missing）', () => {
  const e = validateRule('S-07', ctx({ sceneState: null, blockings: [b()] }));
  assert.equal(e.level, 'warn');
  assert.equal(e.code, WARN_CODE);
  assert.equal(e.detail.items[0].detail.source, 'scene_state_missing');
  // 没有场次行时 active_area 也一定缺 → 不可验证 INFO 依然保留
  const un = e.detail.items.find((x) => x.code === 'AXIS_UNVERIFIED');
  assert.ok(un.detail.missing.includes('scene_states.coord_system.active_area'));
});
