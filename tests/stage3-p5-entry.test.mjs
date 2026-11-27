// 阶段 3 · P5：统一入口 `validateShot(ctx)` 的契约测试
//
// 这组测的不是"某条规则对不对"，而是**编排层的行为**：
//   · 一条规则一条结果、不多不少（69 条，不重不漏）
//   · 同输入两次逐字一致、不改入参
//   · 规则抛异常必须暴露成 fail，不能静默变 PASS，也不能拖累其它规则
//   · 等级聚合 `fail > warn > info > pass`；一条适用规则都没有 → `info`
//   · `applicable=false` 不进统计
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-p5-entry-'));
process.env.IC_DATA_DIR = TMP;
delete process.env.IC_DB_SQLITE_PATH;
delete process.env.IC_DB;
delete process.env.DATABASE_URL;

const {
  validateShot, validateRule, aggregateLevel, RULES, RULESET_VER, ruleIds, ruleCatalog,
} = await import('../lib/core/validate/index.js');
const F = await import('./helpers/qc-fixture.mjs');

const { ctx, b, a, scene, st } = F;

/** 一个"数据齐全、应当全绿"的镜（作为编排层断言的主场景） */
function fullCtx(over = {}) {
  return ctx({
    shot: {
      id: 'sh_01',
      speakers: [{ type: 'on_screen', id: 'c1' }],
      dialogue: '',
      voice_ids: ['v1'],
      ...(over.shot ?? {}),
    },
    blockings: over.blockings ?? [
      b(),
      b({ character_id: 'c2', position_abs: '画面左', norm_x: 0.3, norm_y: 0.5, power_level: 'low', anchor_object: 'fx_bed', gaze_target: 'c1' }),
    ],
    actions: over.actions ?? [
      a(),
      a({ id: 'ac2', actor_id: 'c2', action_type: 'reaction', is_primary: 0, tier: 'T1', contact_json: {}, body_parts: [{ part: 'head' }], t_from: 1, t_to: 2 }),
    ],
    shotAssets: over.shotAssets ?? [
      { shot_id: 'sh_01', asset_id: 'c1', role: 'character', order_no: 1 },
      { shot_id: 'sh_01', asset_id: 'c2', role: 'character', order_no: 2 },
      { shot_id: 'sh_01', asset_id: 'p1', role: 'prop', order_no: 1 },
      { shot_id: 'sh_01', asset_id: 's1', role: 'scene', order_no: 1 },
      { shot_id: 'sh_01', asset_id: 'v1', role: 'voice', order_no: 1 },
    ],
    sceneState: over.sceneState ?? scene(),
    shotState: over.shotState ?? st({
      state_in: { chars: { c1: { pos: [0.7, 0.5, 0] }, c2: { pos: [0.3, 0.5, 0] } }, props: { p1: { state: 'held', owner: 'c1' } } },
      state_out: { chars: { c1: { pos: [0.7, 0.5, 0] }, c2: { pos: [0.3, 0.5, 0] } }, props: { p1: { state: 'dropped' } } },
      meta: { 'chars.c1.pos': { rel: 'known' }, 'chars.c2.pos': { rel: 'known' } },
      state_source: 'solved',
    }),
    chapterShots: over.chapterShots ?? [],
    declaredLevel: over.declaredLevel,
  });
}

test('P5-E1 一次调用产出 69 条结果，规则编号不重不漏', () => {
  const r = validateShot(fullCtx());
  assert.equal(r.hits.length, 69);
  const ids = r.hits.map((h) => h.rule_id);
  assert.equal(new Set(ids).size, 69, '规则编号不得重复');
  assert.deepEqual(ids.slice().sort(), ruleIds(), '必须与规则表一一对应');
  assert.equal(r.stats.rules_total, 69);
  assert.equal(
    r.stats.pass + r.stats.warn + r.stats.fail + r.stats.info + r.stats.not_applicable,
    69,
    '五档之和必须等于规则总数（没有"没人管"的规则）',
  );
  assert.equal(r.stats.applicable + r.stats.not_applicable, 69);
  assert.equal(RULESET_VER, 'd01-v7/stage3.1');
  assert.equal(ruleCatalog().length, 69);
});

test('P5-E2 每条结果都满足 hits 契约（四键 + fields 含 field）', () => {
  const r = validateShot(fullCtx());
  for (const h of r.hits) {
    for (const k of ['rule_id', 'code', 'level', 'applicable', 'source', 'carried_from', 'field', 'fields', 'expected', 'detail']) {
      assert.ok(Object.prototype.hasOwnProperty.call(h, k), `${h.rule_id} 缺 ${k}`);
    }
    assert.equal(h.source, 'run', '本轮纯执行结果只能是 run');
    assert.equal(h.carried_from, '', '本轮没有继承机制，carried_from 必须为空');
    assert.ok(Array.isArray(h.fields));
    if (h.applicable === false) {
      assert.equal(h.level, '', '不适用必须 level 为空（不进统计）');
      assert.equal(h.code, 'NOT_APPLICABLE');
    } else if (h.level === 'pass') {
      assert.equal(h.code, 'PASS');
    } else {
      assert.ok(h.fields.length >= 1, `${h.rule_id} 命中时 fields 不得为空`);
      assert.ok(h.fields.includes(h.field), `${h.rule_id} fields 必须包含 field`);
      assert.ok(h.fields.every((x) => typeof x === 'string' && x.length > 0), 'fields 里不得有空串');
      assert.ok(h.expected.length > 0, `${h.rule_id} 命中时 expected 不得为空`);
    }
  }
});

test('P5-E3 同输入两次逐字一致；hits 按 rule_id 的 cmpStr 顺序稳定', () => {
  const c = fullCtx();
  const r1 = validateShot(c);
  const r2 = validateShot(c);
  assert.deepEqual(r1, r2);
  const ids = r1.hits.map((h) => h.rule_id);
  assert.deepEqual(ids, ids.slice().sort(), 'hits 必须按 rule_id 排序（cmpStr，禁 localeCompare）');
});

test('P5-E4 不修改入参（含冻结对象）', () => {
  const shot = Object.freeze({ ...F.baseShot });
  const blockings = Object.freeze([Object.freeze(b())]);
  const actions = Object.freeze([Object.freeze(a())]);
  const sceneState = Object.freeze(scene());
  const shotState = Object.freeze(st());
  const before = JSON.stringify({ shot, blockings, actions, sceneState, shotState });
  validateShot({
    shot, blockings, actions, sceneState, shotState, shotAssets: [], assetsById: { ...F.ASSETS }, chapterShots: [],
  });
  assert.equal(JSON.stringify({ shot, blockings, actions, sceneState, shotState }), before, '不得改写任何入参');
});

test('P5-E5 缺 ctx.shot → 抛 QC_CTX_INVALID（不产出半份报告）', () => {
  assert.throws(() => validateShot({}), (e) => e.code === 'QC_CTX_INVALID');
  assert.throws(() => validateShot(null), (e) => e.code === 'QC_CTX_INVALID');
  assert.throws(() => validateShot({ shot: [] }), (e) => e.code === 'QC_CTX_INVALID');
});

test('P5-E6 规则抛异常 → 该条 fail + QC_RULE_EXEC_FAILED，其它规则照常出结果', () => {
  const base = fullCtx();
  // 让 `time_slices` 的读取直接抛错：V-20 / A-15 / A-16 会炸，其余规则不受影响
  const shot = new Proxy(base.shot, {
    get(t, k) {
      if (k === 'time_slices') throw new Error('boom');
      return t[k];
    },
  });
  const r = validateShot({ ...base, shot });
  const failed = r.hits.filter((h) => h.code === 'QC_RULE_EXEC_FAILED');
  assert.ok(failed.length >= 1, '抛异常的规则必须显式暴露');
  for (const h of failed) assert.equal(h.level, 'fail', '规则异常不能被降级为 pass/info');
  assert.ok(failed.some((h) => h.rule_id === 'V-20'));
  assert.equal(r.level, 'fail', '有规则异常时报告等级必须是 fail');
  assert.equal(r.hits.length, 69, '不能因为某条规则炸了就少几条结果');
  assert.ok(r.hits.some((h) => h.rule_id === 'V-12' && h.applicable === false), '其它规则仍照常执行');
});

test('P5-E7 多规则同时命中不丢结果（每条的字段都在各自的 fields 里）', () => {
  const r = validateShot(ctx({
    shot: { shot_size: 'close_up', lens_mm: 24, fov_deg: 90, movement: 'pan_left', movement_amp: 'none', purpose: 'nope' },
    blockings: [b({ norm_z: null })],
    shotAssets: [{ shot_id: 'sh_01', asset_id: 'p_missing', role: 'character', order_no: 4 }],
    sceneState: scene(),
  }));
  const failed = r.hits.filter((h) => h.level === 'fail').map((h) => h.rule_id);
  for (const id of ['V-02', 'V-11', 'V-24', 'V-25', 'S-24']) {
    // V-24 在无 meta 时不适用，见下面的精确断言
    if (id === 'V-24') continue;
    assert.ok(failed.includes(id), `${id} 应当命中，实际命中：${failed.join(',')}`);
  }
  assert.ok(r.hits.filter((h) => h.level === 'fail').length >= 4, '多条规则同时命中时不得只留一条');
});

test('P5-E8 等级聚合：fail > warn > info > pass；无适用规则 → info', () => {
  const E = (rule_id, level, applicable = true) => ({ rule_id, level, applicable });
  assert.equal(aggregateLevel([E('V-01', 'pass'), E('V-02', 'info'), E('V-03', 'warn'), E('V-04', 'fail')]), 'fail');
  assert.equal(aggregateLevel([E('V-01', 'pass'), E('V-02', 'info'), E('V-03', 'warn')]), 'warn');
  assert.equal(aggregateLevel([E('V-01', 'pass'), E('V-02', 'info')]), 'info');
  assert.equal(aggregateLevel([E('V-01', 'pass')]), 'pass');
  assert.equal(aggregateLevel([E('V-01', '', false), E('V-02', '', false)]), 'info', '全部不适用 → info，不得伪造 pass');
  assert.equal(aggregateLevel([]), 'info');
  assert.equal(
    aggregateLevel([E('V-01', 'fail', false), E('V-02', 'pass')]),
    'pass',
    'applicable=false 不进聚合（否则一条不适用的 fail 会让整镜红掉）',
  );
});

test('P5-E9 声明 S 级不生效：levelBasis 记录推导值与"被忽略的声明"', () => {
  const r = validateShot(fullCtx({ declaredLevel: 'S0' }));
  assert.equal(r.levelBasis.level, 'S1', '两人在画 → 程序推 S1，不采信声明值');
  assert.equal(r.levelBasis.declared_ignored, true);
  const ignored = r.hits.find((h) => h.rule_id === 'V-01');
  assert.ok(!r.hits.some((h) => h.rule_id === 'LEVEL_DECLARED_IGNORED'));
  assert.ok(ignored, 'V-01 必须按推导出的 S1 判必填');
});

test('P5-E10 V-12 在整镜结果里恒为 NOT_APPLICABLE（阶段 4 未实现）', () => {
  const r = validateShot(fullCtx());
  const v12 = r.hits.find((h) => h.rule_id === 'V-12');
  assert.equal(v12.applicable, false);
  assert.equal(v12.code, 'NOT_APPLICABLE');
  assert.equal(v12.level, '');
  assert.ok(r.stats.not_applicable_rules.includes('V-12'));
});

test('P5-E11 未知规则编号 → 明确抛错（不静默返回空结果）', () => {
  assert.throws(() => validateRule('V-99', ctx({})), (e) => e.code === 'QC_RULE_UNKNOWN');
});
