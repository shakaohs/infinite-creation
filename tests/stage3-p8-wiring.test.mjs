// 阶段 3 · P8 真实数据流接线（D02-20 R1~R6）
//
// 与 `stage3-p8-boundary` 的区别：那一组用内存夹具证明"组装层判据对不对"；
// 这一组**真的建库、真的写 story_shots 三张从表与 scene_states**，再走生产入口
// `solveSceneContinuity()`（读库 → 组装 → 求解），证明接线通且语义没变。
//
// 三条最容易假通过的地方，各钉一条：
//   ① "接了"不等于"接的是真实数据"—— 断言 rows 真来自 DB（shotCount 与库里行数一致）
//   ② "历史状态没回搬"—— 往 `shot_states` 塞一条带 carried: 的 meta，断言求解结果**逐位不变**
//   ③ "生产调用只此一条路"—— 静态扫描 lib/ 与 app/，除定义与 wrapper 外不得出现 solveContinuity(
//   ④ "解析成功"不等于"形状对"—— 对象列写 `[]`、数组列写 `{}` 都必须当场拒（D02-20-R1）
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// P0 隔离：先钉住数据目录，再导入任何 lib（config.js 在模块加载时固化路径）
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-p8-wiring-'));
process.env.IC_DATA_DIR = TMP;
delete process.env.IC_DB_SQLITE_PATH;
delete process.env.IC_DB;
delete process.env.DATABASE_URL;

const { getDb, Chapters } = await import('../lib/core/db.js');
const { createUserProject } = await import('../lib/core/project-create.js');
const { upsertSceneStates } = await import('../lib/core/scene-state.js');
const { insertStoryShot } = await import('../lib/core/render/global-no.js');
const { solveSceneContinuity, solveLoaded } = await import('../lib/core/continuity/solve-scene.js');
const { loadSceneInput, parseJsonColumn } = await import('../lib/core/continuity/load-scene.js');
const { assembleSolverShots } = await import('../lib/core/continuity/assemble-input.js');
const { solveContinuity } = await import('../lib/core/continuity/solve-continuity.js');

const db = getDb();
const SCENE = 'S01_病房';
const OTHER = 'S02_走廊';

// ── 真实数据夹具（写库，不是内存对象）────────────────────────────────────
let seq = 0;
/**
 * 建一个项目 + 一场戏 + N 个镜头。
 * @param {{shots?:number, globalNos?:number[], sceneKey?:string, withBaseline?:boolean}} o
 */
function seedScene({ shots = 3, globalNos = null, sceneKey = SCENE, withBaseline = true } = {}) {
  seq += 1;
  const p = createUserProject({ name: `P8-接线-${seq}` });
  const ch = Chapters.list(p.id)[0];
  if (withBaseline) {
    upsertSceneStates(p.id, ch, [{
      scene_key: sceneKey,
      coord_system: { active_area: [8, 5, 3] },
      axis_lock: { pair: ['c1', 'c2'], left: 'c1', right: 'c2', axis_line: [[0.5, 0], [0.5, 1]] },
      time_of_day: '夜',
    }]);
  }
  const ids = [];
  for (let i = 1; i <= shots; i += 1) {
    const g = globalNos ? globalNos[i - 1] : i;
    const r = insertStoryShot({
      project_id: p.id, chapter_id: ch.id, scene_key: sceneKey,
      shot_no: i, global_no: g,
      spec_source: i === 1 ? 'manual' : 'ai',
      story_duration: 4,
      speakers: [{ id: 'c1', type: 'on_screen' }],
      time_slices: [{ from: 0, to: 4 }],
    });
    ids.push(r.id);
    // 站位：第一镜给完整坐标（known），后续镜给坐标但小幅移动（不触发跳变）
    db.prepare(
      'INSERT INTO shot_blockings (shot_id, character_id, position_abs, norm_x, norm_y, norm_z, norm_confidence,'
      + ' position_track, anchor_object, facing, gaze_target, posture, in_frame) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
    ).run(r.id, 'c1', '画面左', 0.30 + 0.02 * (i - 1), 0.70, 0, 0.95, '[]', 'fx_table', 'W', 'c2', 'standing', 1);
  }
  return { p, ch, ids, sceneKey };
}

const countOf = (table, where = '', ...args) => db.prepare(`SELECT COUNT(*) AS c FROM ${table}${where}`).get(...args).c;

// ══ R1：JSON 列形状契约（D02-20-R1）═══════════════════════════════════════
// 编号接在接线用例之后（W14~W21），物理位置放在最前：先钉"读进来的原料长什么样"，
// 再看"这些原料怎么接到求解器"——契约在前、接线在后，读文件时不容易把两者混为一谈。
// 这些用例专测"语法合法、形状错"——`JSON.parse` 成功不等于数据可用：
// `[]` 冒充对象、`{}` 冒充数组，下游只会静默走空分支，算出"看起来正常"的空结论。

let actSeq = 0;
/** 直接写一行 `shot_actions`（只给要测的列，其余吃 DDL 默认值） */
function seedAction(shotId, cols = {}) {
  actSeq += 1;
  const id = `act_r1_${actSeq}`;
  const all = { id, shot_id: shotId, ...cols };
  const keys = Object.keys(all);
  db.prepare(`INSERT INTO shot_actions (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`)
    .run(...keys.map((k) => all[k]));
  return id;
}

test('W14 对象型 JSON 合法时逐列解析（九个对象列 + body_parts 数组）', () => {
  const { p, ids } = seedScene({ shots: 1 });
  const objCols = {
    init_state: { posture: 'standing' },
    trigger_json: { kind: 'grab' },
    path_json: { points: [[0, 0, 0]] },
    force_json: { n: 3 },
    speed_json: { v: 1.2 },
    contact_json: { part: 'wrist' },
    result_json: { ok: true },
    end_state: { posture: 'sitting' },
    sync_json: { with: 'c2' },
  };
  const strings = Object.fromEntries(Object.entries(objCols).map(([k, v]) => [k, JSON.stringify(v)]));
  const actId = seedAction(ids[0], { ...strings, body_parts: '["hand","wrist"]' });

  const row = loadSceneInput({ projectId: p.id, sceneKey: SCENE }).rows[0];
  assert.equal(row.actions.length, 1);
  const a = row.actions[0];
  assert.equal(a.id, actId);
  for (const [k, v] of Object.entries(objCols)) assert.deepEqual(a[k], v, `${k} 没有被解析成对象`);
  assert.deepEqual(a.body_parts, ['hand', 'wrist']);
  // 别名与源列是同一份引用（求解器读 `result` / `contact`）
  assert.equal(a.result, a.result_json);
  assert.equal(a.contact, a.contact_json);
});

test('W15 对象列写成 `[]` → SCENE_INPUT_INVALID_SHAPE（不是"空对象"）', () => {
  const { p, ids } = seedScene({ shots: 1 });
  const actId = seedAction(ids[0], { init_state: '[]' });
  assert.throws(
    () => loadSceneInput({ projectId: p.id, sceneKey: SCENE }),
    (e) => {
      assert.equal(e.code, 'CONTINUITY_SOLVER_FAILED');
      assert.equal(e.reason, 'SCENE_INPUT_INVALID_SHAPE');
      assert.equal(e.table, 'shot_actions');
      assert.equal(e.column, 'init_state');
      assert.equal(e.key, actId);
      assert.equal(e.shot, ids[0]);
      assert.equal(e.actual, 'array');
      return true;
    },
  );
});

test('W16 对象列写成 JSON 字符串 → 拒绝（形状 string）', () => {
  const { p, ids } = seedScene({ shots: 1 });
  seedAction(ids[0], { trigger_json: '"grab"' });
  assert.throws(
    () => loadSceneInput({ projectId: p.id, sceneKey: SCENE }),
    (e) => e.reason === 'SCENE_INPUT_INVALID_SHAPE' && e.column === 'trigger_json' && e.actual === 'string',
  );
});

test('W17 对象列写成数字 / 布尔值 → 拒绝（语法都合法）', () => {
  for (const [raw, shape] of [['42', 'number'], ['true', 'boolean']]) {
    const { p, ids } = seedScene({ shots: 1 });
    seedAction(ids[0], { end_state: raw });
    assert.throws(
      () => loadSceneInput({ projectId: p.id, sceneKey: SCENE }),
      (e) => e.reason === 'SCENE_INPUT_INVALID_SHAPE' && e.column === 'end_state' && e.actual === shape,
      `${raw} 应被拒为 ${shape}`,
    );
  }
});

test('W18 对象列的 null 按既定缺省语义处理（SQL NULL / JSON null / 空串都补 {}）', () => {
  const { p, ids } = seedScene({ shots: 1 });
  const cases = {
    [seedAction(ids[0], { init_state: null })]: 'SQL NULL',
    [seedAction(ids[0], { init_state: 'null' })]: 'JSON null',
    [seedAction(ids[0], { init_state: '' })]: '空串',
  };
  const row = loadSceneInput({ projectId: p.id, sceneKey: SCENE }).rows[0];
  assert.equal(row.actions.length, 3);
  const byId = Object.fromEntries(row.actions.map((a) => [a.id, a]));
  for (const [id, label] of Object.entries(cases)) {
    assert.deepEqual(byId[id].init_state, {}, `${label} 应走缺省语义（{}），不应报形状错误`);
  }
});

test('W19 数组列写成对象 → 拒绝（story_shots.time_slices 与 shot_actions.body_parts）', () => {
  const a = seedScene({ shots: 1 });
  db.prepare('UPDATE story_shots SET time_slices = ? WHERE id = ?').run('{}', a.ids[0]);
  assert.throws(
    () => loadSceneInput({ projectId: a.p.id, sceneKey: SCENE }),
    (e) => e.reason === 'SCENE_INPUT_INVALID_SHAPE'
      && e.table === 'story_shots' && e.column === 'time_slices' && e.actual === 'object',
  );

  const b = seedScene({ shots: 1 });
  seedAction(b.ids[0], { body_parts: '{"a":1}' });
  assert.throws(
    () => loadSceneInput({ projectId: b.p.id, sceneKey: SCENE }),
    (e) => e.reason === 'SCENE_INPUT_INVALID_SHAPE'
      && e.table === 'shot_actions' && e.column === 'body_parts' && e.actual === 'object',
  );
});

test('W20 已是对象/数组的输入同样过形状校验（不从字符串来也不放行）', () => {
  const m = (kind) => ({ table: 'shot_actions', column: 'init_state', key: 'act_x', shot: 'sh_x', kind });
  assert.throws(() => parseJsonColumn([], m('object')),
    (e) => e.reason === 'SCENE_INPUT_INVALID_SHAPE' && e.actual === 'array');
  assert.throws(() => parseJsonColumn({}, m('array')),
    (e) => e.reason === 'SCENE_INPUT_INVALID_SHAPE' && e.actual === 'object');
  assert.deepEqual(parseJsonColumn({ a: 1 }, m('object')), { a: 1 });
  assert.deepEqual(parseJsonColumn([1], m('array')), [1]);
  assert.equal(parseJsonColumn(null, m('object')), null);
});

test('W21 错误信息可定位：表名 + 列名 + 记录 id + 所属镜头 + 错误形状', () => {
  const { p, ids } = seedScene({ shots: 1 });
  const actId = seedAction(ids[0], { speed_json: '"fast"' });
  let err;
  try { loadSceneInput({ projectId: p.id, sceneKey: SCENE }); } catch (e) { err = e; }
  assert.ok(err, '形状错误必须抛，不能被吞掉');
  for (const part of ['shot_actions', 'speed_json', actId, ids[0], 'string', '对象']) {
    assert.ok(err.message.includes(part), `错误信息缺少 ${part}：${err.message}`);
  }
  // 语法是合法的：不得误报成"不是合法 JSON"（两类失败必须分得开）
  assert.equal(err.message.includes('不是合法 JSON'), false, err.message);
});

// ══ R1/R2：真实调用链接通 ═════════════════════════════════════════════════

test('W1 真实库 → assembleSolverShots → solveContinuity：三个镜头逐镜出状态', () => {
  const { p, ids } = seedScene({ shots: 3 });
  const out = solveSceneContinuity({ projectId: p.id, sceneKey: SCENE });

  assert.equal(out.shotCount, 3);
  assert.deepEqual(Object.keys(out.states).sort(), [...ids].sort());
  assert.match(out.hash, /^sha256:[0-9a-f]{64}$/);
  // 第一镜从场次基线起步，后续镜沿用前镜（说明状态链真的串起来了，不是各算各的）
  assert.equal(out.states[ids[0]].derived_from, 'scene_baseline');
  assert.equal(out.states[ids[1]].derived_from, `prev_shot:${ids[0]}`);
  assert.equal(out.states[ids[2]].derived_from, `prev_shot:${ids[1]}`);
  // 数据确实来自库：库里就是 3 行
  assert.equal(countOf('story_shots', ' WHERE project_id = ?', p.id), 3);
});

test('W2 顺序以 global_no 为准（不是 shot_no、不是入库顺序）', () => {
  // shot_no 1/2/3，但 global_no 故意写成 30/10/20
  const { p, ids } = seedScene({ shots: 3, globalNos: [30, 10, 20] });
  const out = solveSceneContinuity({ projectId: p.id, sceneKey: SCENE });

  // 对象键序＝求解顺序：按 global_no 升序 → 第 2 个建的（gn=10）排在最前
  assert.deepEqual(Object.keys(out.states), [ids[1], ids[2], ids[0]]);
  assert.equal(out.states[ids[1]].derived_from, 'scene_baseline');
  assert.equal(out.states[ids[2]].derived_from, `prev_shot:${ids[1]}`);
  assert.equal(out.states[ids[0]].derived_from, `prev_shot:${ids[2]}`);
});

test('W3 annotations 精确对应镜头 id，且不影响未标注的镜', () => {
  const { p, ids } = seedScene({ shots: 3 });
  const base = solveSceneContinuity({ projectId: p.id, sceneKey: SCENE });
  const out = solveSceneContinuity({
    projectId: p.id, sceneKey: SCENE,
    annotations: { [ids[1]]: { source: 'manual', entries: { 'chars.c1.pos': { rel: 'unknown' } } } },
  });

  assert.deepEqual(out.annotatedShotIds, [ids[1]]);
  // 标注只作用在目标镜上：该镜 pos 的可靠性被显式 unknown 否决，未标注的镜仍按站位判 known
  assert.equal(out.states[ids[1]].meta['chars.c1.pos'].rel, 'unknown');
  assert.equal(base.states[ids[1]].meta['chars.c1.pos'].rel, 'known');
  assert.equal(out.states[ids[0]].meta['chars.c1.pos'].rel, 'known');
  // 说明：标注的 `manual:` 前缀不会留在 state_out.meta（U-P8-4：采信→blocking:、不采信→carried:），
  // 这里只断言"来源确实被认过"——值没被采信，于是沿用上镜。
  assert.match(out.states[ids[1]].meta['chars.c1.pos'].src, /^carried:/);
  // 标注是真输入 → hash 必须变；而导出的 shot id 集合不变
  assert.notEqual(out.hash, base.hash);
  assert.deepEqual(Object.keys(out.states).sort(), Object.keys(base.states).sort());
});

test('W4 历史 shot_states 不回搬：塞一条带 carried: 的 meta，求解结果逐位不变', () => {
  const { p, ids } = seedScene({ shots: 2 });
  const before = solveSceneContinuity({ projectId: p.id, sceneKey: SCENE });

  // 模拟"上一轮已持久化的结果"：meta 里带 carried: 与 conf（结果侧字段）
  db.prepare(
    'INSERT INTO shot_states (shot_id, state_in, state_out, meta, derived_from, state_source, conflicts, updated_at)'
    + ' VALUES (?,?,?,?,?,?,?,?)',
  ).run(ids[1], '{}', '{}',
    JSON.stringify({ 'chars.c1.pos': { rel: 'unknown', src: 'carried:' + ids[0], conf: 0.855, ver: 3 } }),
    ids[0], 'solved', '[]', Date.now());

  const after = solveSceneContinuity({ projectId: p.id, sceneKey: SCENE });
  assert.equal(after.hash, before.hash, 'hash 变了说明读到了 shot_states');
  assert.deepEqual(after.states, before.states, '状态变了说明历史结果被回搬成输入');
  // 读取层根本没把 shot_states 变成 meta
  const loaded = loadSceneInput({ projectId: p.id, sceneKey: SCENE });
  for (const row of loaded.rows) assert.equal(Object.prototype.hasOwnProperty.call(row, 'meta'), false);
});

test('W5 没有人工标注的镜不会凭空生成 meta（组装层不补、读取层不给）', () => {
  const { p } = seedScene({ shots: 3 });
  const loaded = loadSceneInput({ projectId: p.id, sceneKey: SCENE });
  const { shots, annotatedShotIds } = assembleSolverShots({
    projectId: p.id, sceneKey: SCENE, rows: loaded.rows,
  });
  assert.deepEqual(annotatedShotIds, []);
  for (const s of shots) assert.equal(s.meta, undefined);

  // 求解输出里也不该出现 manual: 来源
  const out = solveSceneContinuity({ projectId: p.id, sceneKey: SCENE });
  for (const st of Object.values(out.states)) {
    for (const v of Object.values(st.meta ?? {})) assert.doesNotMatch(String(v.src ?? ''), /^manual:/);
  }
});

// ══ R4：真实数据映射的拒绝路径 ═════════════════════════════════════════════

test('W6 跨场混合 / 重复 global_no / 重复 id 均被拒（真实行数据上验证）', () => {
  const a = seedScene({ shots: 2 });
  // 另一个场次用不相交的 global_no（否则先撞"号重复"，测不到跨场）
  const b = seedScene({ shots: 1, sceneKey: OTHER, globalNos: [99] });

  const rowsA = loadSceneInput({ projectId: a.p.id, sceneKey: SCENE }).rows;
  const rowsB = loadSceneInput({ projectId: b.p.id, sceneKey: OTHER }).rows;

  // ① 跨场：求解器不按 scene_key 过滤，必须在组装层挡住
  assert.throws(
    () => solveLoaded({ projectId: a.p.id, sceneKey: SCENE, rows: [...rowsA, ...rowsB], sceneState: null }),
    (e) => e.reason === 'SHOT_SCENE_MISMATCH',
  );

  // ② 重复 global_no
  const dupNo = rowsA.map((r) => ({ ...r }));
  dupNo[1].global_no = dupNo[0].global_no;
  assert.throws(
    () => solveLoaded({ projectId: a.p.id, sceneKey: SCENE, rows: dupNo, sceneState: null }),
    (e) => e.reason === 'SHOT_GLOBAL_NO_DUPLICATED',
  );

  // ③ 重复 id
  const dupId = rowsA.map((r) => ({ ...r }));
  dupId[1].id = dupId[0].id;
  assert.throws(
    () => solveLoaded({ projectId: a.p.id, sceneKey: SCENE, rows: dupId, sceneState: null }),
    (e) => e.reason === 'SHOT_ID_DUPLICATED',
  );

  // ④ 真实库层面重复 global_no 进不来（uq_ss_gn），所以上面 ② 只可能是"临时拼出来的行"
  assert.throws(
    () => db.prepare('UPDATE story_shots SET global_no = ? WHERE id = ?').run(rowsA[0].global_no, rowsA[1].id),
    (e) => /UNIQUE|constraint/i.test(String(e.message)),
  );
});

test('W7 接线不改语义：生产入口结果 = 直接对同一批行求解的结果（逐位相同）', () => {
  const { p } = seedScene({ shots: 3 });
  const loaded = loadSceneInput({ projectId: p.id, sceneKey: SCENE });
  const { shots } = assembleSolverShots({ projectId: p.id, sceneKey: SCENE, rows: loaded.rows });
  const direct = solveContinuity({ projectId: p.id, sceneKey: SCENE, shots, sceneState: loaded.sceneState });
  const wired = solveSceneContinuity({ projectId: p.id, sceneKey: SCENE });

  assert.equal(wired.hash, direct.hash);
  assert.deepEqual(wired.states, direct.states);
  assert.deepEqual(wired.sceneConflicts, direct.sceneConflicts);
});

test('W8 缺场次基线：允许求解但如实标记 baselineMissing，且不编造左右/尺寸', () => {
  const { p, ids } = seedScene({ shots: 2, withBaseline: false });
  const out = solveSceneContinuity({ projectId: p.id, sceneKey: SCENE });
  assert.equal(out.baselineMissing, true);
  assert.equal(out.states[ids[0]].derived_from, 'scene_baseline');
  // 没有 axis_lock → 左右/侧别不得凭空得出
  assert.equal(out.states[ids[1]].meta['chars.c1.pos'].pos_rel ?? '', '');
  assert.ok(Array.isArray(out.states[ids[1]].diagnostics));
});

test('W9 坏 JSON 列当场失败（不把"数据坏了"降级成"没有数据"）', () => {
  const { p, ids } = seedScene({ shots: 1 });
  db.prepare('UPDATE story_shots SET time_slices = ? WHERE id = ?').run('[{"from":0,', ids[0]);
  assert.throws(
    () => solveSceneContinuity({ projectId: p.id, sceneKey: SCENE }),
    (e) => e.reason === 'SCENE_INPUT_INVALID_JSON' && e.column === 'time_slices',
  );
});

// ══ R6：读写边界（本轮只读）════════════════════════════════════════════════

test('W10 求解不写库：shot_states 仍为 0 行，story_shots / scene_states 行数不变', () => {
  const { p, ids } = seedScene({ shots: 3 });
  const before = {
    shots: countOf('story_shots', ' WHERE project_id = ?', p.id),
    blocks: countOf('shot_blockings', ' WHERE shot_id IN (SELECT id FROM story_shots WHERE project_id = ?)', p.id),
    states: countOf('shot_states', ' WHERE shot_id IN (SELECT id FROM story_shots WHERE project_id = ?)', p.id),
    scenes: countOf('scene_states', ' WHERE project_id = ?', p.id),
  };
  // 带标注解两次（标注不落库，所以第二次结果一致）
  const r1 = solveSceneContinuity({
    projectId: p.id, sceneKey: SCENE,
    annotations: { [ids[1]]: { source: 'manual', entries: { 'chars.c1.pos': { rel: 'unknown' } } } },
  });
  const r2 = solveSceneContinuity({ projectId: p.id, sceneKey: SCENE });
  assert.notEqual(r1.hash, r2.hash, '标注应只影响本次计算');

  const after = {
    shots: countOf('story_shots', ' WHERE project_id = ?', p.id),
    blocks: countOf('shot_blockings', ' WHERE shot_id IN (SELECT id FROM story_shots WHERE project_id = ?)', p.id),
    states: countOf('shot_states', ' WHERE shot_id IN (SELECT id FROM story_shots WHERE project_id = ?)', p.id),
    scenes: countOf('scene_states', ' WHERE project_id = ?', p.id),
  };
  assert.deepEqual(after, before, '求解路径出现了写入');
  assert.equal(after.states, 0, '本轮不写 shot_states（P9 才持久化）');
});

// ══ R3：生产调用旁路封闭（静态扫描）════════════════════════════════════════

test('W11 lib/ 与 app/ 里除"定义 + 组装入口"外，不得出现 solveContinuity( 调用', () => {
  const ROOT = path.resolve(import.meta.dirname, '..');
  const ALLOW = new Set([
    path.join('lib', 'core', 'continuity', 'solve-continuity.js'), // 定义处
    path.join('lib', 'core', 'continuity', 'solve-scene.js'),      // 唯一生产入口
  ]);
  const stripComments = (src) => src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');

  const hits = [];
  const walk = (dir) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) { walk(full); continue; }
      if (!ent.name.endsWith('.js')) continue;
      const rel = path.relative(ROOT, full);
      if (ALLOW.has(rel)) continue;
      const code = stripComments(fs.readFileSync(full, 'utf8'));
      if (/\bsolveContinuity\s*\(/.test(code)) hits.push(rel);
    }
  };
  walk(path.join(ROOT, 'lib'));
  walk(path.join(ROOT, 'app'));
  assert.deepEqual(hits, [], '存在绕过组装层的生产调用：' + hits.join(', '));
});

test('W12 路由走的是生产入口，且没有任何写入调用', () => {
  const ROOT = path.resolve(import.meta.dirname, '..');
  const route = fs.readFileSync(path.join(ROOT, 'app/api/projects/[id]/continuity/solve/route.js'), 'utf8');
  assert.match(route, /solveSceneContinuity/);
  assert.doesNotMatch(route.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1'), /\bsolveContinuity\s*\(/);
  // 只读：路由里不得有写库动作
  for (const w of ['withWriteContext', 'INSERT INTO', 'UPDATE ', 'DELETE FROM', 'db.exec']) {
    assert.equal(route.includes(w), false, `路由出现了写操作标记：${w}`);
  }
});

test('W13 路由 import 的入口就是本组测的那个函数（同一引用，不是同名副本）', async () => {
  const core = await import('../lib/core/index.js');
  assert.equal(typeof core.solveSceneContinuity, 'function');
  assert.equal(core.solveSceneContinuity, solveSceneContinuity, 'core 导出的求解入口必须是同一实现');
  assert.equal(core.loadSceneInput, loadSceneInput);
  // 反向：core 不得把底层 solveContinuity 暴露成"顺手可用"的顶层 API
  assert.equal(Object.prototype.hasOwnProperty.call(core, 'solveContinuity'), false);
});
