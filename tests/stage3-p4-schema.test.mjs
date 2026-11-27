// 阶段 3 · P4：Schema 基础校验（V-01 / V-13 / V-19 / V-20 / V-22；D02-06 §6.1）
//
// 这一组测五件事，每件都对着"最容易假通过"的地方：
//   ① S 级只能由数据算（传 level 不生效）—— 否则"全标 S0"就能逃掉全部校验
//   ② 各级必填集逐级叠加（不是互斥）—— 否则 S4 的镜只被查了 S0 的四项
//   ③ Meta 键必须**能解析且真实存在** —— 拼错的键被"解析失败就忽略"静默放过的代价是可靠性标记失效
//   ④ 时间切片零容差 —— 加 EPS 会把真实空洞放行
//   ⑤ 全部纯函数：不改入参、同输入同输出
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-p4-schema-'));
process.env.IC_DATA_DIR = TMP;
delete process.env.IC_DB_SQLITE_PATH;
delete process.env.IC_DB;
delete process.env.DATABASE_URL;

const schema = await import('../lib/core/validate/schema.js');
const {
  computeLevel, checkRequired, checkShotFields, checkBlockingFields, checkEmptyShot,
  checkMetaKeys, checkTimeSlices, checkSilentChange, checkSchema, countReliabilityEntries,
  S_REQUIRED, LEVELS,
} = schema;

const codes = (hits) => hits.map((h) => h.code);
const fields = (hits) => hits.map((h) => h.field);

/** 只满足 S0 四+1 项的站位 */
const b0 = (over = {}) => ({
  character_id: 'c1', position_abs: '床边', facing: 'N', posture: 'standing', in_frame: 1, ...over,
});
/** S0~S4 全字段齐备的站位（S4 的 crowd_switch 在场次上，不在这一行） */
const bFull = (over = {}) => b0({
  anchor_object: '床', behind_object: '墙', gaze_target: 'c2', hand_state: '扶栏', current_task: '看手机',
  norm_x: 0.5, norm_y: 0.5, norm_z: 0, distance_to_camera: 2.4, occlusion: 'none', power_level: 'mid',
  position_track: [{ t: 0, x: 0.5, y: 0.5, z: 0 }], instance_anchor: '床右侧',
  ...over,
});
const scene = (over = {}) => ({ scene_key: 'S01', axis_lock: { pair: ['c1', 'c2'], axis_line: [[0.1, 0.6], [0.3, 0.7]] }, crowd_switch: 'B', ...over });

// ── P4-T08 S 级由数据推导 ──────────────────────────────────────────────
test('P4-T08a S0~S4 逐级触发', () => {
  assert.equal(computeLevel({ blockings: [b0()] }).level, 'S0');
  assert.equal(computeLevel({ blockings: [b0({ character_id: 'c1' }), b0({ character_id: 'c2' })] }).level, 'S1');
  assert.equal(computeLevel({ blockings: [b0({ character_id: 'c1' }), b0({ character_id: 'c2' }), b0({ character_id: 'c3' })] }).level, 'S2');
  assert.equal(computeLevel({ blockings: [b0()], actions: [{ action_type: 'locomotion', actor_id: 'c1' }] }).level, 'S3');
  assert.equal(computeLevel({ blockings: [bFull({ position_track: [{ t: 0 }, { t: 2 }] })] }).level, 'S3');
  assert.equal(computeLevel({ blockings: [b0()], actions: [{ action_type: 'combat', actor_id: 'c1' }] }).level, 'S4');
  assert.equal(computeLevel({ blockings: [b0()], sceneState: scene({ crowd_switch: 'A' }) }).level, 'S4');
  assert.equal(computeLevel({ blockings: Array.from({ length: 5 }, (_, i) => b0({ character_id: `c${i}`, in_frame: 0 })) }).level, 'S4');
});

test('P4-T08b 逐级提升而不是互斥 else-if：高等级条件不会被低等级挡住', () => {
  // 3 人在画（S2）+ combat（S4）→ 必须 S4；用 else-if 会停在 S2
  const three = [b0({ character_id: 'c1' }), b0({ character_id: 'c2' }), b0({ character_id: 'c3' })];
  assert.equal(computeLevel({ blockings: three, actions: [{ action_type: 'combat', actor_id: 'c1' }] }).level, 'S4');
  // 2 人在画（S1）+ 轨迹 2 点（S3）→ S3
  const two = [bFull({ character_id: 'c1', position_track: [{ t: 0 }, { t: 1 }] }), b0({ character_id: 'c2' })];
  assert.equal(computeLevel({ blockings: two }).level, 'S3');
  // 本章其他镜的人数不得参与：只给本镜 1 人 → S0
  assert.equal(computeLevel({ blockings: [b0()] }).level, 'S0', '只按本镜数据判级');
});

test('P4-T08c prop 被 ≥2 人接触 → S2；同一人摸两次不算', () => {
  const touch = (actor, id = 'p1') => ({ action_type: 'manipulation', actor_id: actor, contact: { target_type: 'prop', target_id: id } });
  assert.equal(computeLevel({ blockings: [b0()], actions: [touch('c1'), touch('c2')] }).level, 'S2');
  // 都是同一个 actor（两条动作同一个人）→ 不算多人接触
  assert.equal(computeLevel({ blockings: [b0()], actions: [touch('c1'), touch('c1')] }).level, 'S0');
  // env 不是人
  assert.equal(computeLevel({ blockings: [b0()], actions: [touch('env'), touch('c1')] }).level, 'S0');
});

test('P4-T08d 判级依据逐项可查（basis），且识别 chars_in_frame 只数 in_frame=1', () => {
  const r = computeLevel({
    blockings: [b0({ character_id: 'c1' }), b0({ character_id: 'c2', in_frame: 0 }), b0({ character_id: 'c3', in_frame: 0 })],
    actions: [{ action_type: 'locomotion', actor_id: 'c1' }],
    sceneState: scene(),
  });
  assert.equal(r.level, 'S3');
  assert.equal(r.basis.chars_in_frame, 1);
  assert.equal(r.basis.chars_total, 3);
  assert.equal(r.basis.has_locomotion, true);
  assert.equal(r.basis.crowd_switch, 'B');
});

// ── P4-T10 调用方伪造 S 级无效 ─────────────────────────────────────────
test('P4-T10 传入 level 不参与计算，只留痕', () => {
  const two = [b0({ character_id: 'c1' }), b0({ character_id: 'c2' })];
  const r = computeLevel({ blockings: two, level: 'S0' });
  assert.equal(r.level, 'S1', '声明 S0 不得覆盖程序推导');
  assert.equal(r.declared_ignored, true);

  const out = checkSchema({
    shot: { shot_no: 1, global_no: 1, story_duration: 3 },
    blockings: two, declaredLevel: 'S0',
  });
  assert.equal(out.level, 'S1');
  assert.ok(out.hits.some((h) => h.code === 'LEVEL_DECLARED_IGNORED' && h.level === 'info'));
});

// ── P4-T09 各级必填集 ──────────────────────────────────────────────────
test('P4-T09a S0 缺字段 → BLOCKING_FIELD_MISSING（章级四要素里的 field 要能定位）', () => {
  const hits = checkRequired({ level: 'S0', blockings: [{ character_id: 'c1', in_frame: 1 }] });
  assert.deepEqual(codes(hits).sort(), ['BLOCKING_FIELD_MISSING', 'BLOCKING_FIELD_MISSING', 'BLOCKING_FIELD_MISSING']);
  assert.deepEqual(fields(hits).sort(), ['shot_blockings[0].facing', 'shot_blockings[0].position_abs', 'shot_blockings[0].posture']);
  assert.ok(hits.every((h) => h.level === 'fail'));
});

test('P4-T09b S1 额外五项 + 场次 axis_lock', () => {
  const hits = checkRequired({ level: 'S1', blockings: [b0({ character_id: 'c1' }), b0({ character_id: 'c2' })], sceneState: {} });
  const need = ['anchor_object', 'behind_object', 'gaze_target', 'hand_state', 'current_task'];
  for (const f of need) assert.ok(fields(hits).some((x) => x.endsWith(`.${f}`)), `缺 ${f} 必须报`);
  assert.ok(fields(hits).includes('scene_states.axis_lock'));
  assert.ok(hits.every((h) => h.code === 'SCHEMA_INVALID'));

  // 补齐后无命中
  const ok = checkRequired({ level: 'S1', blockings: [bFull({ character_id: 'c1' }), bFull({ character_id: 'c2' })], sceneState: scene() });
  assert.deepEqual(ok, []);
});

test('P4-T09c S2 额外三项坐标 + 距离 + 遮挡 + 权力', () => {
  const bare = [b0({ character_id: 'c1' }), b0({ character_id: 'c2' }), b0({ character_id: 'c3' })];
  const hits = checkRequired({ level: 'S2', blockings: bare, sceneState: scene() });
  for (const f of ['norm_x', 'norm_y', 'norm_z', 'distance_to_camera', 'occlusion', 'power_level']) {
    assert.ok(fields(hits).some((x) => x.endsWith(`.${f}`)), `S2 缺 ${f} 必须报`);
  }
  assert.deepEqual(checkRequired({ level: 'S2', blockings: bare.map((b) => bFull({ ...b })), sceneState: scene() }), []);
});

test('P4-T09d S3 额外 position_track + state_in/out（状态不得由 Schema 代造）', () => {
  const hits = checkRequired({ level: 'S3', blockings: [bFull({ position_track: [] })], sceneState: scene(), shotState: {} });
  assert.ok(fields(hits).includes('shot_blockings[0].position_track'));
  assert.ok(fields(hits).includes('shot_states.state_in'));
  assert.ok(fields(hits).includes('shot_states.state_out'));
  // 只报缺，不生成默认状态：入参对象不得被改写
  const st = {};
  checkRequired({ level: 'S3', blockings: [bFull()], sceneState: scene(), shotState: st });
  assert.deepEqual(st, {}, 'Schema 不得为通过校验而补造状态');
  assert.deepEqual(
    checkRequired({ level: 'S3', blockings: [bFull()], sceneState: scene(), shotState: { state_in: { chars: {} }, state_out: { chars: {} } } }),
    [],
  );
});

test('P4-T09e S4 额外 crowd_switch（场次）+ 逐动作 contact + instance_anchor', () => {
  const hits = checkRequired({
    level: 'S4',
    blockings: [bFull({ instance_anchor: '' })],
    sceneState: scene({ crowd_switch: '' }),
    actions: [{ action_type: 'combat', actor_id: 'c1' }],
  });
  assert.ok(fields(hits).includes('shot_blockings[0].instance_anchor'));
  assert.ok(fields(hits).includes('scene_states.crowd_switch'));
  assert.ok(fields(hits).includes('shot_actions[0].contact'));

  assert.deepEqual(checkRequired({
    level: 'S4',
    blockings: [bFull()],
    sceneState: scene({ crowd_switch: 'A' }),
    actions: [{ action_type: 'combat', actor_id: 'c1', contact: { target_type: 'char', target_id: 'c2' } }],
    shotState: { state_in: { chars: {} }, state_out: { chars: {} } },
  }), []);
  assert.deepEqual(S_REQUIRED.S4, ['instance_anchor'], 'crowd_switch 在场次上，不在 blocking 行');
});

// ── P4-T11 V-13 空镜台词 ───────────────────────────────────────────────
test('P4-T11a 空镜（is_insert=1）里画内人物开口 → FAIL', () => {
  const bl = [b0({ character_id: 'c1', in_frame: 1 })];
  const hits = checkEmptyShot({ is_insert: 1, dialogue: '我说一句', speakers: [{ type: 'on_screen', id: 'c1' }], blockings: bl });
  assert.deepEqual(codes(hits), ['EMPTY_SHOT_ONSCREEN_SPEAKER']);
  assert.equal(hits[0].level, 'fail');
  assert.equal(hits[0].field, 'speakers[0].id');
});

test('P4-T11b 声明 off_screen 但 in_frame=1 → FAIL；in_frame=0 → 通过', () => {
  const bad = checkEmptyShot({
    is_insert: 1, dialogue: '画外音', speakers: [{ type: 'off_screen', id: 'c1' }],
    blockings: [b0({ character_id: 'c1', in_frame: 1 })],
  });
  assert.deepEqual(codes(bad), ['EMPTY_SHOT_INFRAME_SPEAKER']);

  const ok = checkEmptyShot({
    is_insert: 1, dialogue: '画外音', speakers: [{ type: 'off_screen', id: 'c1' }],
    blockings: [b0({ character_id: 'c1', in_frame: 0 })],
  });
  assert.deepEqual(ok, []);
});

test('P4-T11c 纯空镜（无台词无 speakers）合法；is_insert=0 不限制；未登记角色不判错', () => {
  assert.deepEqual(checkEmptyShot({ is_insert: 1, dialogue: '', speakers: [], blockings: [] }), []);
  assert.deepEqual(checkEmptyShot({ is_insert: 1, dialogue: '旁白', speakers: [], blockings: [] }), [], '带台词但无 speakers 归 V-04 判');
  assert.deepEqual(
    checkEmptyShot({ is_insert: 0, dialogue: '说话', speakers: [{ type: 'on_screen', id: 'c1' }], blockings: [b0({ character_id: 'c1', in_frame: 1 })] }),
    [],
    'is_insert=0 时 V-13 不管',
  );
  // 未登记的说话人 → in_frame 未知 → 不判（S-20）
  assert.deepEqual(
    checkEmptyShot({ is_insert: 1, dialogue: 'x', speakers: [{ type: 'on_screen', id: 'ghost' }], blockings: [b0({ character_id: 'c1' })] }),
    [],
  );
});

// ── P4-T12 V-19 Meta 键 ────────────────────────────────────────────────
const state = () => ({
  chars: { c1: { pos: [0.5, 0.5, 0], posture: 'standing', facing: 'N', hand: {}, gaze: 'c2' } },
  props: { p1: { state: 'held', owner: 'c1', hand: 'right', surface: '', condition: '' } },
  costumes: { c1: 'cos_1' },
  env: { light: 'day', time: 'morning', door: 'closed' },
});

test('P4-T12a 合法路径全部通过', () => {
  const meta = {
    'chars.c1.pos': { rel: 'known' },
    'chars.c1.posture': { rel: 'inferred' },
    'props.p1.state': { rel: 'known' },
    'props.p1.condition': { rel: 'unknown' },
    'costumes.c1': { rel: 'known' },
    'env.light': { rel: 'not_applicable' },
  };
  assert.deepEqual(checkMetaKeys(meta, state()), []);
});

test('P4-T12b 拼错/不存在的路径必须拒（不得"解析失败就忽略"）', () => {
  assert.deepEqual(codes(checkMetaKeys({ 'charss.c1.pos': { rel: 'known' } }, state())), ['META_KEY_UNRESOLVED']);
  assert.deepEqual(codes(checkMetaKeys({ 'chars.c1.invalid_field': { rel: 'known' } }, state())), ['META_FIELD_UNKNOWN']);
  assert.deepEqual(codes(checkMetaKeys({ 'chars.ghost.pos': { rel: 'known' } }, state())), ['META_ENTITY_NOT_FOUND']);
  assert.deepEqual(codes(checkMetaKeys({ 'chars.c1': { rel: 'known' } }, state())), ['META_KEY_UNRESOLVED']);
  assert.deepEqual(codes(checkMetaKeys({ 'chars.c1.pos.extra': { rel: 'known' } }, state())), ['META_KEY_UNRESOLVED']);
  assert.deepEqual(codes(checkMetaKeys({ 'props.p1.nope': { rel: 'known' } }, state())), ['META_FIELD_UNKNOWN']);
  assert.deepEqual(codes(checkMetaKeys({ 'costumes.c1.x': { rel: 'known' } }, state())), ['META_KEY_UNRESOLVED']);
  assert.deepEqual(codes(checkMetaKeys({ 'env.nope': { rel: 'known' } }, state())), ['META_FIELD_UNKNOWN']);
});

// ── P4-T13 __solver 单独放行 ───────────────────────────────────────────
test('P4-T13a __solver 放行且不计入可靠性条目；其他 __ 键拒', () => {
  const meta = { __solver: { hash: 'x', state: 'ok' }, 'chars.c1.pos': { rel: 'known' } };
  assert.deepEqual(checkMetaKeys(meta, state()), []);
  assert.equal(countReliabilityEntries(meta), 1, '__solver 不是字段可靠性条目');

  assert.deepEqual(codes(checkMetaKeys({ __bad: {} }, state())), ['META_KEY_RESERVED']);
  assert.deepEqual(codes(checkMetaKeys({ __solver: {}, __solver2: {} }, state())), ['META_KEY_RESERVED']);
  assert.deepEqual(codes(checkMetaKeys({ __solver_x: {} }, state())), ['META_KEY_RESERVED']);
});

test('P4-T13b meta 非对象 → META_INVALID；meta 缺失 → 不报', () => {
  assert.deepEqual(codes(checkMetaKeys([], state())), ['META_INVALID']);
  assert.deepEqual(codes(checkMetaKeys('{}', state())), ['META_INVALID']);
  assert.deepEqual(checkMetaKeys(undefined, state()), []);
  assert.deepEqual(checkMetaKeys(null, state()), []);
});

// ── P4-T14 V-20 时间切片 ───────────────────────────────────────────────
test('P4-T14a 合法切片通过；乱序输入先排序再判', () => {
  assert.deepEqual(checkTimeSlices([{ from: 0, to: 2, kind: 'action' }, { from: 2, to: 4, kind: 'hold' }], 4), []);
  assert.deepEqual(checkTimeSlices([{ from: 2, to: 4 }, { from: 0, to: 2 }], 4), [], '输入顺序不影响结论');
});

test('P4-T14b 首片不从 0 / 末片不到 duration / 中间空洞 / 重叠 都拒，且零容差', () => {
  assert.deepEqual(codes(checkTimeSlices([{ from: 0.5, to: 4 }], 4)), ['TIME_SLICE_GAP']);
  assert.deepEqual(codes(checkTimeSlices([{ from: 0, to: 3.999 }], 4)), ['TIME_SLICE_GAP']);
  assert.deepEqual(codes(checkTimeSlices([{ from: 0, to: 2 }, { from: 3, to: 4 }], 4)), ['TIME_SLICE_GAP']);
  assert.deepEqual(codes(checkTimeSlices([{ from: 0, to: 2 }, { from: 1.5, to: 4 }], 4)), ['TIME_SLICE_OVERLAP']);
  // 1 微秒的空洞也不放过（不得用 EPS 掩盖）
  assert.deepEqual(codes(checkTimeSlices([{ from: 0, to: 2 }, { from: 2.000001, to: 4 }], 4)), ['TIME_SLICE_GAP']);
});

test('P4-T14c 空数组 → INFO（数据不足），不伪造 PASS 也不判 FAIL', () => {
  for (const v of [[], null, undefined]) {
    const hits = checkTimeSlices(v, 4);
    assert.equal(hits.length, 1);
    assert.equal(hits[0].level, 'info');
    assert.equal(hits[0].code, 'TIME_SLICES_EMPTY');
  }
});

test('P4-T14d 结构非法（非数 / from>=to / 越界）分别报', () => {
  assert.deepEqual(codes(checkTimeSlices([{ from: 'a', to: 4 }], 4)), ['TIME_SLICE_INVALID']);
  assert.deepEqual(codes(checkTimeSlices([{ from: 2, to: 2 }], 4)), ['TIME_SLICE_INVALID']);
  assert.deepEqual(codes(checkTimeSlices([{ from: -1, to: 4 }], 4)), ['TIME_SLICE_INVALID']);
  assert.deepEqual(codes(checkTimeSlices([{ from: 0, to: 5 }], 4)), ['TIME_SLICE_OUT_OF_RANGE']);
  assert.deepEqual(codes(checkTimeSlices([{ from: 0, to: 4 }], 0)), ['SCHEMA_INVALID'], 'duration 不合法时无法判覆盖');
});

// ── P4-T15 V-22 静默修改 ───────────────────────────────────────────────
test('P4-T15a 无 meta → N/A（INFO），不判 warn', () => {
  for (const v of [undefined, null, {}]) {
    const hits = checkSilentChange({ state: state(), meta: v });
    assert.equal(hits.length, 1);
    assert.equal(hits[0].level, 'info');
    assert.equal(hits[0].code, 'SILENT_CHANGE_NA');
  }
});

test('P4-T15b rel=unknown 却有确定值 → WARN；无值/not_applicable 不判', () => {
  const warn = checkSilentChange({ state: state(), meta: { 'chars.c1.pos': { rel: 'unknown' } } });
  assert.deepEqual(codes(warn), ['SILENT_CHANGE']);
  assert.equal(warn[0].level, 'warn');

  // 值也缺失 → 不是"被写入确定值"
  const s2 = state();
  delete s2.chars.c1.posture;
  assert.deepEqual(checkSilentChange({ state: s2, meta: { 'chars.c1.posture': { rel: 'unknown' } } }), []);
  // 不适用字段不算静默修改
  assert.deepEqual(checkSilentChange({ state: state(), meta: { 'env.light': { rel: 'not_applicable' } } }), []);
  // known/inferred 都不是
  assert.deepEqual(checkSilentChange({ state: state(), meta: { 'chars.c1.pos': { rel: 'known' } } }), []);
  assert.deepEqual(checkSilentChange({ state: state(), meta: { 'chars.c1.pos': { rel: 'inferred' } } }), []);
});

test('P4-T15c 检测过程不改写 meta，也不改状态', () => {
  const meta = { 'chars.c1.pos': { rel: 'unknown' } };
  const frozen = JSON.parse(JSON.stringify(meta));
  const st = state();
  const stCopy = JSON.parse(JSON.stringify(st));
  checkSilentChange({ state: st, meta });
  assert.deepEqual(meta, frozen, 'meta 不得被自动补成 known');
  assert.deepEqual(st, stCopy);
});

// ── 类型与范围 ────────────────────────────────────────────────────────
test('P4-EXT1 只查 D01 明写的范围；合法的 0 / null / 空数组不误判', () => {
  assert.deepEqual(checkShotFields({ dramatic_value: 10, cam_roll_deg: -20, cam_distance_m: 0.3, lens_mm: 0, fov_deg: 5, story_duration: 0.5 }), []);
  assert.deepEqual(checkShotFields({}), [], '缺字段是 S 级/写入侧的事，不在范围检查里编造');
  assert.deepEqual(codes(checkShotFields({ dramatic_value: 11 })), ['SCHEMA_INVALID']);
  assert.deepEqual(codes(checkShotFields({ cam_roll_deg: 20.5 })), ['SCHEMA_INVALID']);
  assert.deepEqual(codes(checkShotFields({ cam_distance_m: 0.29 })), ['SCHEMA_INVALID']);
  assert.deepEqual(codes(checkShotFields({ lens_mm: 5 })), ['SCHEMA_INVALID']);
  assert.deepEqual(codes(checkShotFields({ fov_deg: 121 })), ['SCHEMA_INVALID']);
  assert.deepEqual(codes(checkShotFields({ story_duration: 0 })), ['SCHEMA_INVALID']);
  assert.deepEqual(codes(checkShotFields({ info_delta: '字'.repeat(81) })), ['SCHEMA_INVALID']);
  assert.deepEqual(checkShotFields({ info_delta: '字'.repeat(80) }), []);
  assert.deepEqual(codes(checkShotFields({ is_insert: 2 })), ['SCHEMA_INVALID']);
  assert.deepEqual(codes(checkShotFields({ shot_no: 0 })), ['SCHEMA_INVALID']);
});

test('P4-EXT2 站位坐标三缺一 → COORD_PARTIAL（S-24 写入侧口径）', () => {
  assert.deepEqual(codes(checkBlockingFields({ norm_x: 0.5, norm_y: 0.5, norm_z: null })), ['COORD_PARTIAL']);
  assert.deepEqual(codes(checkBlockingFields({ norm_x: null, norm_y: null, norm_z: null })), [], '三者同空合法');
  assert.deepEqual(codes(checkBlockingFields({ norm_x: 0.5, norm_y: 0.5, norm_z: 0 })), [], '三者同有合法');
  assert.deepEqual(codes(checkBlockingFields({ norm_confidence: 1.2 })), ['SCHEMA_INVALID']);
  assert.deepEqual(codes(checkBlockingFields({ position_track: {} })), ['SCHEMA_INVALID']);
});

// ── 复审补齐：norm_xyz ∈ [0,1]³（D01-04 §四）────────────────────────────
// 为什么必须单独测：`norm_x` 是"归一化"坐标，出界意味着写入侧换了坐标系或写错列。
// 只判"有限数"会把 `1.5` / `-0.2` 全放行，而下游全部拿它当 0..1 用（S-15 取景半径、越轴判定）。
test('P4-EXT3 三维归一化坐标：0 与 1 是合法边界，负数和 >1 一律 SCHEMA_INVALID', () => {
  // 三坐标必须齐备再判（只给一个分量本来就会命中 COORD_PARTIAL，那是另一条规则）
  const withCoord = (f, v) => ({ norm_x: 0.5, norm_y: 0.5, norm_z: 0.5, [f]: v });
  for (const f of ['norm_x', 'norm_y', 'norm_z']) {
    for (const edge of [0, 1]) {
      assert.deepEqual(codes(checkBlockingFields(withCoord(f, edge))), [], `${f}=${edge} 是合法边界`);
    }
    for (const bad of [-0.1, -1, 1.0001, 1.5, 2]) {
      const r = checkBlockingFields(withCoord(f, bad));
      assert.deepEqual(codes(r), ['SCHEMA_INVALID'], `${f}=${bad} 必须被拒`);
      assert.equal(r[0].field, `shot_blockings[0].${f}`, 'field 要能定位到具体分量');
      assert.match(r[0].expected, /0 ~ 1/);
      assert.equal(r[0].got, bad, 'got 要原样回显，别把出界值悄悄改成边界值');
    }
  }
  // 三个分量同时出界 → 三条，各自定位（不是只报第一条就收工）
  const multi = checkBlockingFields({ norm_x: -0.5, norm_y: 2, norm_z: 3 });
  assert.deepEqual(codes(multi), ['SCHEMA_INVALID', 'SCHEMA_INVALID', 'SCHEMA_INVALID']);
  assert.deepEqual(fields(multi), ['shot_blockings[0].norm_x', 'shot_blockings[0].norm_y', 'shot_blockings[0].norm_z']);
});

test('P4-EXT4 范围检查不得替 NULL 补 0：同空合法、部分空只报 COORD_PARTIAL、非有限数仍拒', () => {
  // 三者同空：合法（三维坐标整体性规则，不是"补个默认值就过范围检查"）
  assert.deepEqual(codes(checkBlockingFields({ norm_x: null, norm_y: null, norm_z: null })), []);
  assert.deepEqual(codes(checkBlockingFields({})), [], '未给坐标也不算错误（S 级必填另外管）');
  // 部分为空：只有 COORD_PARTIAL，**不得**再叠一条范围错（NULL 没被当成 0 或越界值）
  for (const partial of [
    { norm_x: 0.5, norm_y: 0.5, norm_z: null },
    { norm_x: null, norm_y: 0.5, norm_z: 0.5 },
    { norm_x: 0.5, norm_y: '', norm_z: 0.5 },
  ]) {
    assert.deepEqual(codes(checkBlockingFields(partial)), ['COORD_PARTIAL'], JSON.stringify(partial));
  }
  // 部分为空 + 有值分量越界 → 两条都要报（整体性错误与范围错误是两回事，不能互相掩盖）
  assert.deepEqual(
    codes(checkBlockingFields({ norm_x: 1.4, norm_y: 0.5, norm_z: null })),
    ['SCHEMA_INVALID', 'COORD_PARTIAL'],
  );
  // 非有限数仍按"有限数或 NULL"拒，而不是走范围判断
  for (const bad of [NaN, Infinity, -Infinity, '0.5']) {
    assert.deepEqual(codes(checkBlockingFields({ norm_x: bad, norm_y: 0.5, norm_z: 0.5 })), ['SCHEMA_INVALID'], String(bad));
  }
  // 纯函数：入参不被改写（尤其不得把 null 变成 0）
  const input = Object.freeze({ norm_x: 0.5, norm_y: null, norm_z: null });
  checkBlockingFields(input);
  assert.deepEqual(input, { norm_x: 0.5, norm_y: null, norm_z: null });
});

// ── P4-T16 纯函数：稳定、不改入参 ─────────────────────────────────────
test('P4-T16 全部检查同输入同输出，且不修改入参（冻结对象不抛）', () => {
  const shot = Object.freeze({
    shot_no: 1, global_no: 1, story_duration: 4, dramatic_value: 3,
    time_slices: Object.freeze([{ from: 0, to: 2 }, { from: 2, to: 4 }]),
    speakers: Object.freeze([{ type: 'on_screen', id: 'c1' }]),
    is_insert: 0,
  });
  const blockings = Object.freeze([Object.freeze(bFull({ character_id: 'c1' })), Object.freeze(bFull({ character_id: 'c2' }))]);
  const actions = Object.freeze([Object.freeze({ action_type: 'manipulation', actor_id: 'c1', contact: Object.freeze({ target_type: 'prop', target_id: 'p1' }) })]);
  const shotState = Object.freeze({
    state_in: Object.freeze({ chars: Object.freeze({ c1: Object.freeze({ pos: Object.freeze([0.5, 0.5, 0]) }) }) }),
    state_out: Object.freeze({ chars: Object.freeze({ c1: Object.freeze({ pos: Object.freeze([0.5, 0.5, 0]) }) }) }),
    meta: Object.freeze({ 'chars.c1.pos': Object.freeze({ rel: 'known' }) }),
  });
  const sceneState = Object.freeze(scene());

  const ctx = { shot, blockings, actions, shotState, sceneState, timeSlices: shot.time_slices, storyDuration: 4 };
  const a = checkSchema(ctx);
  const b = checkSchema(ctx);
  assert.deepEqual(a, b, '同输入必须逐字同输出');
  assert.equal(a.level, 'S1', '2 人在画 → S1');
  // 排序稳定：再次调用，字段序列一致
  assert.deepEqual(a.hits.map((h) => h.field), b.hits.map((h) => h.field));
});

test('P4-T16b checkSchema 只聚合本文件的五类检查（不越界到 P5）', () => {
  const out = checkSchema({
    shot: { shot_no: 1, global_no: 1, story_duration: 2 },
    blockings: [b0()],
    actions: [],
    shotState: {},
    sceneState: {},
    timeSlices: [{ from: 0, to: 2 }],
  });
  const allowed = new Set([
    'BLOCKING_FIELD_MISSING', 'SCHEMA_INVALID', 'COORD_PARTIAL',
    'EMPTY_SHOT_ONSCREEN_SPEAKER', 'EMPTY_SHOT_INFRAME_SPEAKER',
    'META_INVALID', 'META_KEY_RESERVED', 'META_KEY_UNRESOLVED', 'META_ENTITY_NOT_FOUND', 'META_FIELD_UNKNOWN',
    'TIME_SLICES_EMPTY', 'TIME_SLICE_INVALID', 'TIME_SLICE_OUT_OF_RANGE', 'TIME_SLICE_GAP', 'TIME_SLICE_OVERLAP',
    'SILENT_CHANGE_NA', 'SILENT_CHANGE', 'LEVEL_DECLARED_IGNORED',
  ]);
  for (const h of out.hits) assert.ok(allowed.has(h.code), `不应出现 P5 的规则码：${h.code}`);
  assert.deepEqual(LEVELS, ['S0', 'S1', 'S2', 'S3', 'S4']);
});
