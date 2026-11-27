// P5 独立复审 · 证据脚本（只读，不改任何业务代码/数据）
//
// 用途：把 69 条规则**实际读取的字段路径**跑出来（不是看注释、不是看映射表）。
// 做法：对 ctx 做深层 Proxy，规则每读一个属性就记一条路径；每条规则在多组
//       "故意缺数据"的上下文下各跑一遍，取并集（覆盖不同的 exit 分支）。
//
// 输出的两条用途：
//   ① CK-2 的"代码 → 映射"一侧：这是唯一不靠人写的读取集合；
//   ② 找隐式依赖：规则读到的 ctx 顶层键里，哪些不在 `validateShot` 的 JSDoc 契约里。
//
// 运行：node scripts/audit/p5-deps.mjs [--json]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-p5-audit-'));
process.env.IC_DATA_DIR = TMP;
delete process.env.IC_DB_SQLITE_PATH;
delete process.env.IC_DB;
delete process.env.DATABASE_URL;

const V = await import('../../lib/core/validate/index.js');
const F = await import('../../tests/helpers/qc-fixture.mjs');

/** 访问器/容器方法名：不是字段，只是读法 */
const METHOD = new Set([
  'length', 'filter', 'map', 'some', 'every', 'find', 'findIndex', 'includes', 'forEach',
  'slice', 'sort', 'join', 'reduce', 'keys', 'values', 'entries', 'push', 'split', 'trim',
  'startsWith', 'endsWith', 'concat', 'indexOf', 'toLowerCase', 'hasOwnProperty',
  'toString', 'valueOf', 'replace', 'match',
]);

const isIndex = (s) => /^\d+$/.test(s);

/** 把 Proxy 记到的原始路径归一成"字段路径" */
function normalize(raw) {
  const segs = raw.split('.').filter((s) => s && !isIndex(s) && !METHOD.has(s));
  if (!segs.length) return '';
  return segs.join('.');
}

/** 深层 Proxy：任何属性读取都上报；返回的仍是可继续读取的 Proxy */
function track(onPath) {
  const wrap = (val, p) => {
    if (val === null || typeof val !== 'object') return val;
    return new Proxy(val, {
      get(target, key, recv) {
        if (typeof key === 'symbol') return Reflect.get(target, key, recv);
        const next = p ? `${p}.${key}` : String(key);
        onPath(next);
        return wrap(Reflect.get(target, key, recv), next);
      },
    });
  };
  return wrap;
}

// ── 上下文变体：一组"故意缺数据"的输入，逼出各条 exit 分支 ──────────────

const fullShot = {
  ...F.baseShot,
  speakers: [{ id: 'c1', type: 'on_screen' }, { id: 'c2', type: 'off_screen' }],
  time_slices: [{ from: 0, to: 2, kind: 'action' }, { from: 2, to: 4.5, kind: 'hold' }],
};

const fullActions = [
  F.a({
    id: 'ac1',
    action_type: 'locomotion',
    tier: 'T2',
    path_json: { from: { x: 0.1, y: 0.5, z: 0 }, to: { x: 0.2, y: 0.5, z: 0 } },
    end_state: { pos: { x: 0.2, y: 0.5, z: 0 } },
    result_json: { prop_delta: [{ prop_id: 'p1', from: { state: 'held' }, to: { state: 'dropped' } }] },
    speed_json: { profile: 'sudden' },
    sync_json: { parallel_with: ['ac2'], dialogue_span: [2, 4] },
    force_json: { chain: [1, 2, 3] },
    body_parts: [{ part: 'right_arm', act: '下压' }],
  }),
  F.a({
    id: 'ac2',
    action_type: 'combat',
    tier: 'T3',
    trigger_json: { kind: 'action', ref: 'ac1' },
    contact_json: { target_type: 'character', target_id: 'c2', impulse: 'medium' },
    body_parts: [{ part: 'head', act: '偏转' }],
    power: 9,
  }),
];

const fullBlockings = [
  F.b({ position_track: [{ t: 0, x: 0.7, y: 0.5, z: 0 }, { t: 2, x: 0.8, y: 0.5, z: 0 }] }),
  F.b({ character_id: 'c2', norm_x: 0.2, norm_y: 0.5, norm_z: 0, in_frame: 1 }),
];

const fullAssets = [
  { shot_id: 'sh_01', asset_id: 'c1', role: 'character', order_no: 1 },
  { shot_id: 'sh_01', asset_id: 'p1', role: 'prop', order_no: 1 },
  // costume 行必须给：否则 S-13 在 `cur.length===0` 处就 notApplicable，
  // `prevShotAssets` / `costumeChangeAllowed` 的读取分支永远跑不到（会误判成"契约里有但没人读"）
  { shot_id: 'sh_01', asset_id: 'ct1', role: 'costume', order_no: 1 },
  { shot_id: 'sh_01', asset_id: 'v1', role: 'voice', order_no: 1 },
  { shot_id: 'sh_01', asset_id: 'v2', role: 'voice', order_no: 2 },
  { shot_id: 'sh_01', asset_id: 'v3', role: 'voice', order_no: 3 },
  { shot_id: 'sh_01', asset_id: 'v4', role: 'voice', order_no: 4 },
];

const fullState = F.st({
  conflicts: [{ code: 'POSITION_JUMP', character_id: 'c1' }],
  meta: {
    'chars.c1.pos': { rel: 'unknown', src: 'ai' },
    'props.p1.state': { rel: 'known', src: 'ai' },
    __solver: { hash: 'x' },
  },
  state_in: { chars: { c1: { pos: [0.7, 0.5, 0] } }, props: { p1: { state: 'held', owner: 'c1' } } },
  state_out: { chars: { c1: { pos: [0.7, 0.5, 0] } }, props: { p1: { state: 'dropped' } } },
});

const VARIANTS = [
  ['full', {
    shot: fullShot,
    blockings: fullBlockings,
    actions: fullActions,
    shotAssets: fullAssets,
    assetsById: { ...F.ASSETS },
    sceneState: F.scene({ crowd_switch: 'A', power_geometry: { start: { h: 'c1' }, end: { h: 'c2' } } }),
    shotState: fullState,
    prevShot: { ...F.baseShot, id: 'sh_00' },
    prevShotState: fullState,
    prevShotAssets: [{ shot_id: 'sh_00', asset_id: 'ct2', role: 'costume', order_no: 1 }],
    prevActions: [F.a({ id: 'ac0', t_from: 0, t_to: 1 })],
    nextShot: { ...F.baseShot, id: 'sh_02' },
    nextShotState: fullState,
    chapterShots: F.chapter(6),
    targetProfile: { roll_sign_verified: false },
    declaredLevel: 'S2',
    costumeChangeAllowed: false,
  }],
  ['no-scene', {
    shot: fullShot, blockings: fullBlockings, actions: fullActions, shotAssets: fullAssets,
    assetsById: { ...F.ASSETS }, shotState: fullState, chapterShots: F.chapter(6),
  }],
  ['scene-no-lock', {
    shot: fullShot, blockings: fullBlockings, actions: fullActions, shotAssets: fullAssets,
    assetsById: { ...F.ASSETS }, shotState: fullState, chapterShots: F.chapter(6),
    sceneState: { ...F.scene(), axis_lock: undefined },
  }],
  ['scene-no-area', {
    shot: fullShot, blockings: fullBlockings, actions: fullActions, shotAssets: fullAssets,
    assetsById: { ...F.ASSETS }, shotState: fullState, chapterShots: F.chapter(6),
    sceneState: { ...F.scene(), coord_system: {} },
  }],
  ['no-blockings', {
    shot: fullShot, actions: fullActions, shotAssets: fullAssets, assetsById: { ...F.ASSETS },
    sceneState: F.scene(), shotState: fullState, chapterShots: F.chapter(6),
  }],
  ['no-actions', {
    shot: fullShot, blockings: fullBlockings, shotAssets: fullAssets, assetsById: { ...F.ASSETS },
    sceneState: F.scene(), shotState: fullState, chapterShots: F.chapter(6),
  }],
  ['no-asserts', {
    shot: fullShot, blockings: fullBlockings, actions: fullActions, assetsById: { ...F.ASSETS },
    sceneState: F.scene(), shotState: fullState, chapterShots: F.chapter(6),
  }],
  ['no-state', {
    shot: fullShot, blockings: fullBlockings, actions: fullActions, shotAssets: fullAssets,
    assetsById: { ...F.ASSETS }, sceneState: F.scene(), chapterShots: F.chapter(6),
  }],
  ['empty-chapter', {
    shot: fullShot, blockings: fullBlockings, actions: fullActions, shotAssets: fullAssets,
    assetsById: { ...F.ASSETS }, sceneState: F.scene(), shotState: fullState, chapterShots: [],
  }],
  ['bare-shot', { shot: { id: 'sh_01' } }],
  ['odd-values', {
    shot: { ...fullShot, lens_mm: 0, fov_deg: 0, cam_roll_deg: 7, is_insert: 1, purpose: 'turn', spec_source: 'ai' },
    blockings: fullBlockings, actions: fullActions, shotAssets: fullAssets,
    assetsById: {}, sceneState: F.scene(), shotState: fullState, chapterShots: F.chapter(6),
    targetProfile: {},
  }],
];

const readByRule = new Map();

for (const rule of V.RULES) {
  const set = new Set();
  for (const [, c] of VARIANTS) {
    const raw = [];
    // `level` 由入口 `computeLevel` 注入（`F.ctx()` 不认这个键），
    // 不注入的话 V-01/S-02 会在第一行就以 S0 分支退出，读集被严重低估
    const levelVariants = c.level ? [c.level] : [undefined, 'S0', 'S2', 'S4'];
    for (const lv of levelVariants) {
      const base = F.ctx(c);
      if (lv) base.level = lv;
      const ctx = track((p) => raw.push(p))(base);
      try {
        rule.run(ctx);
      } catch (e) {
        // 抛错本身也是证据（记录后继续），不影响读取集合的采集
        set.add(`!!THROW:${String(e && e.message).slice(0, 60)}`);
      }
    }
    for (const p of raw) {
      const n = normalize(p);
      if (n) set.add(n);
    }
  }
  readByRule.set(rule.id, set);
}

// ── 报告 ────────────────────────────────────────────────────────────────

const CTX_KEYS = [
  'shot', 'blockings', 'actions', 'shotAssets', 'assetsById', 'sceneState', 'shotState',
  'prevShot', 'prevShotState', 'prevShotAssets', 'prevActions', 'nextShot', 'nextShotState',
  'chapterShots', 'targetProfile', 'declaredLevel', 'costumeChangeAllowed', 'level', '__audit',
];

/** `validateShot` 的 JSDoc 契约里写明的 ctx 键（index.js 的 @param 清单） */
const DOCUMENTED = new Set([
  'shot', 'blockings', 'actions', 'shotAssets', 'assetsById', 'sceneState', 'shotState',
  'prevShot', 'prevShotState', 'prevShotAssets', 'nextShot', 'nextShotState', 'chapterShots',
  'targetProfile', 'declaredLevel', 'costumeChangeAllowed',
]);

const rows = [];
for (const rule of V.RULES) {
  const set = readByRule.get(rule.id);
  const roots = [...new Set([...set].map((p) => p.split('.')[0]).filter((x) => CTX_KEYS.includes(x)))].sort();
  rows.push({
    rule_id: rule.id,
    declared_level: rule.level,
    roots,
    undocumented: roots.filter((r) => !DOCUMENTED.has(r)),
    paths: [...set].sort(),
  });
}

if (process.argv.includes('--json')) {
  process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
} else {
  console.log('| 规则 | 读取的 ctx 顶层键 | 未在 validateShot 契约里声明 | 字段数 |');
  console.log('|---|---|---|---:|');
  for (const r of rows) {
    console.log(`| ${r.rule_id} | ${r.roots.join(', ') || '—'} | ${r.undocumented.join(', ') || '—'} | ${r.paths.length} |`);
  }
  const bad = rows.filter((r) => r.undocumented.length);
  console.log('');
  console.log(`规则数 ${rows.length}；存在未声明 ctx 依赖的规则 ${bad.length} 条：${bad.map((r) => r.rule_id).join(', ') || '无'}`);
  const unread = CTX_KEYS.filter((k) => !DOCUMENTED.has(k) && rows.every((r) => !r.roots.includes(k)));
  console.log(`契约外但确实被读取的键：${[...new Set(bad.flatMap((r) => r.undocumented))].join(', ') || '无'}`);
  console.log(`全部规则都没读的契约键：${CTX_KEYS.filter((k) => rows.every((r) => !r.roots.includes(k))).join(', ') || '无'}`);
  void unread;
}
