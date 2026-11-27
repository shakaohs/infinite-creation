// 阶段 3 · P4：D01 枚举表（V-02 的数据源；D02-06 §6.1）
//
// 这一组测两件事：
//   ① 表里的值**逐字等于 D01**（数量 + 关键禁用值），不是"看起来差不多"；
//   ② `check` 是确定性纯函数：合法通过、非法拒绝、结构化字段不被当字符串枚举、结果顺序稳定。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-p4-enums-'));
process.env.IC_DATA_DIR = TMP;
delete process.env.IC_DB_SQLITE_PATH;
delete process.env.IC_DB;
delete process.env.DATABASE_URL;

const enums = await import('../lib/core/validate/enums.js');
const { ENUMS, STRUCTURED, check, isValid, fieldNames, checkObject } = enums;

// ── P4-T07 表本身与 D01 对齐 ───────────────────────────────────────────
test('P4-T07a 关键枚举的数量与值逐字来自 D01', () => {
  // 数量先钉住：多一个少一个都要当场看见（"顺手补一个值"是最常见的漂移）
  assert.equal(ENUMS.purpose.values.length, 7);
  assert.equal(ENUMS.dialogue_function.values.length, 7);
  assert.equal(ENUMS.shot_size.values.length, 9, 'D01-02 §4.1：9 档');
  assert.equal(ENUMS.cam_direction.values.length, 5, 'D01-02 §4.2：5 值');
  assert.equal(ENUMS.cam_height.values.length, 8, 'D01-02 §4.3：8 值（不是 7）');
  // D01-02 §4.4 标题写 21 值，逐项点数为 22（静止1+平移6+纵深6+变焦4+手持3+特殊2）：
  // 按逐项走，标题笔误不得让一个合法运镜被拒
  assert.equal(ENUMS.movement.values.length, 22, 'D01-02 §4.4 逐项 22 值');
  assert.equal(ENUMS.composition_rule.values.length, 7, 'D01-02 §4.5：7 值');
  assert.equal(ENUMS.movement_amp.values.length, 4);
  assert.equal(ENUMS.action_type.values.length, 6, 'D01-03 §三：6 值');
  assert.equal(ENUMS.tier.values.length, 3);
  assert.equal(ENUMS.cog.values.length, 7);
  assert.equal(ENUMS['speed.profile'].values.length, 5);
  assert.equal(ENUMS['contact.impulse'].values.length, 3);
  assert.equal(ENUMS.posture.values.length, 8, 'D01-04 §四：8 值');
  assert.equal(ENUMS.power_level.values.length, 3);
  assert.equal(ENUMS['cross_allowed.type'].values.length, 5, 'D01-04 §3.3：5 值');
  assert.equal(ENUMS.crowd_switch.values.length, 3);
  assert.equal(ENUMS['prop.state'].values.length, 6, 'absent 是"键不存在"，不是值');
  assert.equal(ENUMS['time_slices.kind'].values.length, 3);
  assert.equal(ENUMS['speakers.type'].values.length, 5);
  assert.equal(ENUMS['state.rel'].values.length, 4);
  assert.equal(ENUMS['asset.role'].values.length, 6);
});

test('P4-T07b cam_height 不含 dutch；荷兰角由 cam_roll_deg 表达', () => {
  assert.ok(!ENUMS.cam_height.values.includes('dutch'), 'dutch 已从高度轴废止（D01-02 §4.3）');
  assert.deepEqual(ENUMS.cam_height.forbidden, ['dutch']);
  assert.equal(check('cam_height', 'dutch').length, 1);
  assert.equal(check('cam_height', 'dutch')[0].code, 'ENUM_INVALID');
  // 8 个合法值逐个通过
  for (const v of ENUMS.cam_height.values) assert.deepEqual(check('cam_height', v), [], v);
});

test('P4-T07c 每个字段的每个合法值都通过，非法值都拒绝', () => {
  for (const [field, spec] of Object.entries(ENUMS)) {
    for (const v of spec.values) {
      assert.deepEqual(check(field, v), [], `${field}=${v} 应通过`);
    }
    const bad = check(field, 'not_a_d01_value');
    assert.equal(bad.length, 1, `${field} 非法值必须被拒`);
    assert.equal(bad[0].level, 'fail');
    assert.equal(bad[0].code, 'ENUM_INVALID', `${field} 应报 ENUM_INVALID`);
    assert.equal(bad[0].field, field);
    assert.ok(bad[0].expected.includes(spec.values[0]), 'expected 必须列出合法值');
  }
});

test('P4-T07d 可选字段的空值放行，必填字段的空值拒绝', () => {
  for (const [field, spec] of Object.entries(ENUMS)) {
    for (const empty of ['', null, undefined]) {
      const r = check(field, empty);
      if (spec.allowEmpty) assert.deepEqual(r, [], `${field} 允许空值`);
      else {
        assert.equal(r.length, 1, `${field} 必填`);
        assert.equal(r[0].code, 'ENUM_REQUIRED_MISSING');
      }
    }
  }
  // `dialogue_function` 的 D01 默认值就是 ''（不是 'none'）
  assert.deepEqual(check('dialogue_function', ''), []);
  assert.deepEqual(check('composition_rule', ''), []);
});

test('P4-T07e 字符串枚举收到对象/数组时判类型错，不判"值非法"', () => {
  const r = check('purpose', ['advance']);
  assert.equal(r.length, 1);
  assert.equal(r[0].code, 'ENUM_TYPE_INVALID', '数组塞进字符串枚举是类型问题，不该让调用方去改数据');
  assert.equal(check('movement', { v: 'static' })[0].code, 'ENUM_TYPE_INVALID');
});

test('P4-T07f 数值型/结构型字段不会被当成字符串枚举（表里根本没有它们）', () => {
  // 这些是数值或结构字段，走 schema.js 的类型/范围检查，不进枚举表
  for (const f of ['norm_confidence', 'cam_roll_deg', 'story_duration', 'time_slices', 'position_track', 'contact']) {
    const r = check(f, 0.5);
    assert.equal(r.length, 1);
    assert.equal(r[0].code, 'ENUM_FIELD_UNKNOWN', `${f} 不是枚举字段`);
  }
});

// ── 结构化字段 ─────────────────────────────────────────────────────────
test('P4-T07g facing 是"四方位 + 角度"，不能只认四个字符串', () => {
  for (const v of ['N', 'S', 'E', 'W', 'N+30', 'S-45', 'E+180', { dir: 'N' }, { dir: 'W', deg: -12.5 }]) {
    assert.deepEqual(check('facing', v), [], JSON.stringify(v) + ' 应通过');
  }
  for (const v of ['X', 'NN', 'N+200', 'N+abc', 30, ['N'], { deg: 30 }, null]) {
    const r = check('facing', v);
    assert.equal(r.length, 1, JSON.stringify(v) + ' 应被拒');
    assert.equal(r[0].code, 'ENUM_INVALID');
  }
  assert.deepEqual(STRUCTURED.facing.directions, ['N', 'S', 'E', 'W']);
});

test('P4-T07h occlusion 是 none/half/full + partial(部位)，裸 partial 不合法', () => {
  for (const v of ['none', 'half', 'full', 'partial:arm', 'partial(左肩)', { type: 'partial', part: 'arm' }]) {
    assert.deepEqual(check('occlusion', v), [], JSON.stringify(v) + ' 应通过');
  }
  for (const v of ['partial', { type: 'partial' }, 'partial:', 'blocked', 1]) {
    const r = check('occlusion', v);
    assert.equal(r.length, 1, JSON.stringify(v) + ' 应被拒');
    assert.equal(r[0].code, 'ENUM_INVALID');
  }
});

// ── 确定性 ────────────────────────────────────────────────────────────
test('P4-T07i 同一输入多次校验结果逐字一致；批量顺序按 cmpStr 稳定', () => {
  const obj = {
    cam_height: 'dutch',
    purpose: 'nope',
    'speed.profile': 'zoom',
    posture: 'levitating',
    facing: 'Q',
  };
  const a = checkObject(obj);
  const b = checkObject(obj);
  assert.deepEqual(a, b);
  assert.ok(a.length >= 5);
  const fields = a.map((x) => x.field);
  assert.deepEqual(fields, [...fields].sort(), 'field 必须按 cmpStr 升序');
  // 打乱键顺序不影响结果
  const shuffled = { facing: 'Q', posture: 'levitating', 'speed.profile': 'zoom', purpose: 'nope', cam_height: 'dutch' };
  assert.deepEqual(checkObject(shuffled), a);
});

test('P4-T07j check 不改入参，也不依赖外部状态', () => {
  const value = Object.freeze({ dir: 'N', deg: 30 });
  const obj = Object.freeze({ facing: value, design: 'x' });
  assert.deepEqual(check('facing', value), []);
  assert.deepEqual(checkObject(obj), []);
  assert.deepEqual(value, { dir: 'N', deg: 30 });
});

test('P4-T07k fieldNames 覆盖全部表项且有序', () => {
  const names = fieldNames();
  assert.equal(names.length, Object.keys(ENUMS).length + Object.keys(STRUCTURED).length);
  assert.deepEqual(names, [...names].sort());
  assert.ok(names.includes('facing') && names.includes('occlusion'));
});

// ── 复审补齐：两个工程枚举（首轮漏项）────────────────────────────────────
// `spec_source` 决定 posRel 第⑤级怎么推（manual→known / legacy→unknown / 其余→inferred），
// `state_source` 决定状态行是求解产出还是人工填的。两者都是**封闭取值**，
// 放行任意字符串会让"来源"这一层可靠性语义彻底失真。
/** 只取 code 的便捷函数（与 schema 测试同一口径） */
function codes(hits) {
  return hits.map((h) => h.code);
}

test('P4-T07l spec_source / state_source 的值逐字来自 D01，且缺失按默认值放行', () => {
  // 值域与来源（数量先钉住）
  assert.deepEqual(ENUMS.spec_source.values, ['ai', 'import', 'manual', 'legacy'], 'D01-02 §十一');
  assert.equal(ENUMS.spec_source.source, 'D01-02 §十一');
  assert.deepEqual(ENUMS.state_source.values, ['solved', 'none', 'manual'], 'D01-04 §5.1');
  assert.equal(ENUMS.state_source.source, 'D01-04 §5.1');

  // 全部合法值逐一通过
  for (const v of ['ai', 'import', 'manual', 'legacy']) assert.deepEqual(check('spec_source', v), [], v);
  for (const v of ['solved', 'none', 'manual']) assert.deepEqual(check('state_source', v), [], v);
  // 带空白的写法按 trim 后判（与其余字段同一口径）
  assert.deepEqual(check('spec_source', ' manual '), []);

  // 非法值：ENUM_INVALID，且 expected 要列出全部合法值（调用方据此自查）
  for (const [field, bad, values] of [
    ['spec_source', 'ai_gen', ['ai', 'import', 'manual', 'legacy']],
    ['spec_source', 'solved', ['ai', 'import', 'manual', 'legacy']], // 另一个字段的值不能被串用
    ['state_source', 'derived', ['solved', 'none', 'manual']],
    ['state_source', 'legacy', ['solved', 'none', 'manual']],
  ]) {
    const r = check(field, bad);
    assert.equal(r.length, 1, `${field}=${bad} 必须被拒`);
    assert.equal(r[0].code, 'ENUM_INVALID');
    assert.equal(r[0].field, field);
    for (const v of values) assert.ok(r[0].expected.includes(v), 'expected 必须列全');
  }

  // 空值：两者在 D01-05 都有 DDL 默认值（`DEFAULT 'ai'` / `DEFAULT 'none'`），
  // 因此缺失/空串不是错误——报"必填缺失"会把默认值场景判成数据缺陷。
  for (const empty of ['', null, undefined]) {
    assert.deepEqual(check('spec_source', empty), [], 'spec_source 空值按默认 ai');
    assert.deepEqual(check('state_source', empty), [], 'state_source 空值按默认 none');
  }

  // 已纳入 fieldNames / checkObject 体系
  const names = fieldNames();
  assert.ok(names.includes('spec_source') && names.includes('state_source'));
  assert.deepEqual(checkObject({ spec_source: 'manual', state_source: 'solved' }), []);
  assert.deepEqual(
    codes(checkObject({ spec_source: 'nope', state_source: 'nope' })),
    ['ENUM_INVALID', 'ENUM_INVALID'],
  );
  // 类型错误与值错误分开（对象塞进字符串枚举）
  assert.equal(check('spec_source', { v: 'ai' })[0].code, 'ENUM_TYPE_INVALID');
});
