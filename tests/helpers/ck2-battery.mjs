// CK-2 电池（P6 · D02-06 §9.2.1 末表）
//
// 一组「故意缺数据 / 故意触发分支」的上下文：同一份电池既供审计脚本（scripts/audit/p6-ck2.mjs）
// 也供测试（tests/stage3-p6-ck.test.mjs）—— 共用一份，避免「脚本绿、测试红」。
//
// 电池不足的后果是  非空（声明了却观测不到读取），所以它同时是「映射没有虚报」的保证。
import * as F from './qc-fixture.mjs';
const CAM_ALL = {
  shot_size: 'medium', cam_direction: 'three_quarter', cam_height: 'eye', cam_roll_deg: 5,
  cam_pos: { x: 2.45, y: 1.75, z: 1.6 }, cam_target: 'c1', cam_distance_m: 2.49,
  lens_mm: 50, fov_deg: 39.6, movement: 'static', movement_amp: 'none',
  cam_path: [{ x: 2.45, y: 1.75, z: 1.6 }], composition_rule: 'center', cam_note: '固定机位',
};

const TRACK = [{ t: 0, x: 0.7, y: 0.5, z: 0 }, { t: 1, x: 0.85, y: 0.5, z: 0 }, { t: 2, x: 0.95, y: 0.9, z: 0 }];

const ACT = {
  locomotion: F.a({ id: 'ac_loco', action_type: 'locomotion', tier: 'T2', t_from: 0, t_to: 1.5,
    path_json: { from: { x: 0.7, y: 0.5, z: 0 }, to: { x: 0.95, y: 0.9, z: 0 } },
    end_state: { pos: { x: 0.95, y: 0.9, z: 0 } },
    result_json: { char_delta: { c1: { posture: 'sitting' } }, prop_delta: [{ prop_id: 'p1', from: { state: 'held', owner: 'c1' }, to: { state: 'dropped' } }], env_delta: { light: 'dim' } },
    speed_json: { profile: 'sudden' }, sync_json: { parallel_with: ['ac_hit'], dialogue_span: [1.5, 3] },
    body_parts: [{ part: 'right_arm', act: '推' }] }),
  combat: F.a({ id: 'ac_hit', action_type: 'combat', tier: 'T3', t_from: 1.6, t_to: 3, power: 9,
    trigger_json: { kind: 'action', ref: 'ac_loco' },
    contact_json: { target_type: 'character', target_id: 'c2', impulse: 'high' },
    force_json: { chain: [1, 2, 3] }, sync_json: { is_key_blow: true },
    body_parts: [{ part: 'head', act: '偏' }] }),
  reaction: F.a({ id: 'ac_react', actor_id: 'c2', action_type: 'reaction', tier: 'T1', t_from: 1.7, t_to: 2.2, is_primary: 0,
    contact_json: {}, body_parts: [{ part: 'left_hand', act: '挡' }] }),
  manipulation: F.a({ id: 'ac_man', action_type: 'manipulation', cog: 'forward', tier: 'T2', t_from: 3, t_to: 4,
    contact_json: { target_type: 'prop', target_id: 'p1', impulse: 'medium' },
    result_json: { prop_delta: [{ prop_id: 'p1', from: { state: 'held' }, to: { state: 'held' } }] } }),
  turn: F.a({ id: 'ac_turn', action_type: 'turn', tier: 'T1', t_from: 4, t_to: 4.3, is_primary: 0, body_parts: [{ part: 'torso', act: '转' }] }),
};

const STATE_BAD = F.st({
  conflicts: [
    { code: 'POSITION_JUMP', character_id: 'c1', field: 'chars.c1.pos', detail: { delta: 0.4 }, message: '跳' },
    { code: 'PROP_APPEAR', prop_id: 'p1', detail: {} },
  ],
  meta: {
    'chars.c1.pos': { rel: 'unknown', src: 'ai' },
    'chars.c1.posture': { rel: 'known', src: 'ai' },
    'props.p1.state': { rel: 'known', src: 'ai' },
    '__solver': { hash: 'sha256:x', solver_version: 'stage3.1' },
    'bad.key': { rel: 'known' },
  },
  state_in: { chars: { c1: { pos: [0.7, 0.5, 0] } }, props: { p1: { state: 'held', owner: 'c1' } } },
  state_out: { chars: { c1: { pos: [0.7, 0.5, 0] } }, props: { p1: { state: 'dropped' } } },
});

const ASSETS = [
  { id: 'c1', category: 'character', name: '哈罗德', parent_id: '' },
  { id: 'c2', category: 'character', name: '罗克珊', parent_id: '' },
  { id: 'p1', category: 'prop', name: '文件', parent_id: '' },
  { id: 'ct1', category: 'costume', name: '病号服', parent_id: '' },
];

const SHOT_ASSETS = [
  { asset_id: 'c1', role: 'character', order_no: 1 },
  { asset_id: 'c2', role: 'character', order_no: 2 },
  { asset_id: 'p1', role: 'prop', order_no: 1 },
  { asset_id: 'ct1', role: 'costume', order_no: 1 },
  { asset_id: 'v1', role: 'voice', order_no: 1 },
  { asset_id: 'v2', role: 'voice', order_no: 2 },
  { asset_id: 'v3', role: 'voice', order_no: 3 },
  { asset_id: 'v4', role: 'voice', order_no: 4 },
];

const full = (over = {}) => {
  const c = F.ctx({
    shot: { ...F.baseShot, ...CAM_ALL, purpose: 'turn', spec_source: 'ai', speakers: [{ id: 'c1', type: 'on_screen' }, { id: 'c2', type: 'off_screen' }], is_insert: 1, dialogue: '你来了。我们走吧。', voice_ids: ['v1', 'v2'], ...(over.shot ?? {}) },
    blockings: over.blockings ?? [
      F.b({ position_track: TRACK, position_abs: '画面右', anchor_object: 'fx_table' }),
      F.b({ character_id: 'c2', norm_x: 0.2, norm_y: 0.5, norm_z: 0, in_frame: 1, anchor_object: 'fx_bed' }),
    ],
    actions: over.actions ?? [ACT.locomotion, ACT.combat, ACT.reaction, ACT.manipulation, ACT.turn],
    shotAssets: over.shotAssets ?? SHOT_ASSETS,
    assetsById: over.assetsById ?? Object.fromEntries(ASSETS.map((a) => [a.id, a])),
    sceneState: over.sceneState ?? F.scene({ crowd_switch: 'A', power_geometry: { start: { holder: 'c1' }, end: { holder: 'c1' } } }),
    shotState: over.shotState ?? STATE_BAD,
    prevShot: over.prevShot ?? { id: 'sh_00' },
    prevShotAssets: over.prevShotAssets ?? [{ asset_id: 'ct2', role: 'costume', order_no: 1 }],
    nextShot: over.nextShot ?? { id: 'sh_02' },
    nextShotState: over.nextShotState ?? F.st({ state_in: { chars: { c1: { pos: [0.1, 0.1, 0] } } } }),
    // 本镜必须在章内（否则 V-07 直接 N/A，`shot_size` 永远读不到）
    chapterShots: over.chapterShots ?? F.chapter(6).map((s) => ({ ...s, id: s.id === 'sh_03' ? 'sh_01' : s.id, shot_size: 'medium' })),
    targetProfile: over.targetProfile ?? { roll_sign_verified: false },
    costumeChangeAllowed: over.costumeChangeAllowed,
  });
  // `F.ctx()` 只认夹具白名单里的键：契约外的输入（prevActions）与派生的 level 只能后挂
  c.prevActions = over.prevActions ?? [F.a({ id: 'ac_prev', t_from: 0, t_to: 1 })];
  c.level = over.level;
  return c;
};

// 同人重叠、共享独占部位组 → A-12 命中；同时两个都是 primary → A-02 命中
const OVERLAP = [
  F.a({ id: 'ac_x', actor_id: 'c1', is_primary: 1, t_from: 0, t_to: 2, body_parts: [{ part: 'right_arm', act: '推' }] }),
  F.a({ id: 'ac_y', actor_id: 'c1', is_primary: 1, t_from: 1, t_to: 3, body_parts: [{ part: 'right_hand', act: '抓' }] }),
];
// contact 指向角色但没有 reaction 动作 → A-08 命中
const NO_REACTION = [
  F.a({ id: 'ac_hit', action_type: 'combat', tier: 'T3', power: 9, t_from: 0, t_to: 1,
    contact_json: { target_type: 'character', target_id: 'c2', impulse: 'high' },
    body_parts: [{ part: 'head', act: '撞' }], force_json: { chain: [1, 2] } }),
];
// prop_delta 的 from 与 state_in 不一致 → A-10 命中
const BAD_DELTA = [
  F.a({ id: 'ac_pd', action_type: 'manipulation', t_from: 0, t_to: 1,
    contact_json: { target_type: 'prop', target_id: 'p1', impulse: 'medium' },
    result_json: { prop_delta: [{ prop_id: 'p1', from: { state: 'broken', owner: 'c2' }, to: { state: 'held' } }] } }),
];
// 轨迹穿过承重墙 / 人站在墙里 → S-04、V-17 命中
const WALL_TRACK = [
  F.b({ character_id: 'c1', norm_x: 0.95, norm_y: 0.8, norm_z: 0, in_frame: 1, anchor_object: 'fx_table',
    position_track: [{ t: 0, x: 0.2, y: 0.2, z: 0 }, { t: 2, x: 0.95, y: 0.9, z: 0 }] }),
];
// 轨迹终点与状态位置不一致 → S-18 命中
const BAD_TRACK_STATE = F.st({
  state_in: { chars: { c1: { pos: [0.1, 0.1, 0] } } },
  state_out: { chars: { c1: { pos: [0.1, 0.1, 0] } } },
  conflicts: [], meta: {},
});

export const BATTERY = [
  { name: 'full', ctx: full() },
  { name: 'full-S0', ctx: full({ level: 'S0' }) },
  { name: 'full-S1', ctx: full({ level: 'S1' }) },
  { name: 'full-S2', ctx: full({ level: 'S2' }) },
  { name: 'full-S3', ctx: full({ level: 'S3' }) },
  { name: 'full-S4', ctx: full({ level: 'S4' }) },
  { name: 'costume-allowed', ctx: full({ costumeChangeAllowed: true }) },
  { name: 'no-track', ctx: full({ blockings: [F.b({ anchor_object: 'fx_table' })] }) },
  { name: 'partial-coord', ctx: full({ blockings: [F.b({ norm_z: null, position_track: [] })] }) },
  { name: 'no-actions', ctx: full({ actions: [] }) },
  { name: 'only-loco', ctx: full({ actions: [ACT.locomotion] }) },
  { name: 'overlap-actions', ctx: full({ actions: OVERLAP }) },
  { name: 'no-reaction', ctx: full({ actions: NO_REACTION }) },
  { name: 'bad-prop-delta', ctx: full({ actions: BAD_DELTA }) },
  { name: 'wall-track', ctx: full({ blockings: WALL_TRACK, shotState: BAD_TRACK_STATE }) },
  { name: 'plain-state', ctx: full({ shotState: F.st({ state_in: { chars: { c1: { pos: [0.7, 0.5, 0] } } }, props: { p1: { state: 'held' } } }) }) },
  { name: 'state-no-out', ctx: full({ shotState: { state_in: { chars: { c1: { pos: [0.7, 0.5, 0] } } }, meta: { 'chars.c1.pos': { rel: 'known' } }, conflicts: [] } }) },
  { name: 'no-state', ctx: full({ shotState: null }) },
  { name: 'no-scene', ctx: full({ sceneState: null }) },
  { name: 'scene-no-lock', ctx: full({ sceneState: { ...F.scene(), axis_lock: undefined } }) },
  { name: 'no-next', ctx: full({ nextShot: null, nextShotState: null }) },
  { name: 'no-prev', ctx: full({ prevShot: null, prevShotAssets: [], prevActions: [] }) },
  { name: 'chapter-1', ctx: full({ chapterShots: [{ ...F.baseShot, id: 'sh_01', shot_no: 1 }] }) },
  { name: 'missing-asset', ctx: full({ assetsById: { c1: ASSETS[0] }, shotAssets: [{ asset_id: 'c1', role: 'character', order_no: 1 }, { asset_id: 'zzz', role: 'prop', order_no: 1 }] }) },
  { name: 'prev-trigger', ctx: full({ actions: [F.a({ id: 'ac_cur', t_from: 1.5, t_to: 2.5, trigger_json: { kind: 'action', ref: 'ac_prev' } })] }) },
  { name: 'lipsync', ctx: full({ actions: [F.a({ id: 'ac_mouth', actor_id: 'c1', power: 9, t_from: 1.5, t_to: 2.5, body_parts: [{ part: 'head', act: '摇' }], sync_json: { dialogue_span: [1.5, 3] } })] }) },
  { name: 'bad-anchor', ctx: full({ level: 'S2', blockings: [F.b({ anchor_object: '不存在的依托物' })] }) },
  { name: 'bare', ctx: F.ctx({ shot: { id: 'sh_01' } }) },
];
