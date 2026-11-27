// P6 连续性夹具（D01-04 §5.7 四镜算例 + C-1~C-7 共用）
//
// 与 `qc-fixture.mjs` 的分工：那个面向"单镜 QC 上下文"，这个面向"一个场次的镜序列"，
// 因为求解器读的是 `shot.blockings` / `shot.actions`（按镜嵌套），不是扁平的 ctx 键。
//
// 单位：`norm_*` 归一化（0~1）；`active_area = [6,5,3]` 米；
// D01-04 §5.7 里的 (1.80, 3.50) 米 → 归一化 (0.30, 0.70)，夹具按归一化写。
export const ACTIVE_AREA = Object.freeze([6, 5, 3]);

/** 场次基线：竖直轴线 x=0.5，左右两侧 c1/c2 */
export function scene(over = {}) {
  return {
    scene_key: 'S1_病房',
    coord_system: { basis: { north: '正对主窗' }, active_area: [...ACTIVE_AREA] },
    entries: { main: '正门' },
    fixtures: [{ id: 'fx_table', name: '床头柜', zone: [0.3, 0.35, 0.5, 0.55], movable: false }],
    axis_lock: { pair: ['c1', 'c2'], left: 'c1', right: 'c2', camera_side: 'left', axis_line: [[0.5, 0], [0.5, 1]], cross_allowed: [] },
    power_geometry: { start: { holder: 'c1' }, end: { holder: 'c2' } },
    crowd_switch: 'B',
    time_of_day: '夜',
    ...over,
  };
}

/** 站位行 */
export function blk(over = {}) {
  return {
    character_id: 'c1', in_frame: 1,
    norm_x: 0.3, norm_y: 0.7, norm_z: 0, norm_confidence: 0.95,
    position_abs: '画面左', position_track: [], anchor_object: 'fx_table', behind_object: '',
    facing: 'W', gaze_target: 'c2', posture: 'standing', hand_state: '自然下垂',
    ...over,
  };
}

/** 动作行 */
export function act(over = {}) {
  return {
    id: 'ac_1', actor_id: 'c1', action_type: 'manipulation', tier: 'T2', is_primary: 1, cog: 'forward',
    t_from: 0, t_to: 1, body_parts: [{ part: 'right_arm', act: '推' }],
    trigger_json: { kind: 'self', ref: '' },
    contact_json: { target_type: 'prop', target_id: 'p1', impulse: 'medium' },
    result_json: {}, end_state: {}, path_json: {}, sync_json: {}, init_state: {},
    ...over,
  };
}

/** 一镜（求解器入参形状：站位/动作挂在镜上） */
export function shot(over = {}) {
  return {
    id: 'sh_01', project_id: 'p1', chapter_id: 'ch1', scene_key: 'S1_病房',
    shot_no: 1, global_no: 1, spec_source: 'manual', spec_version: 2,
    time_jump: 0, fill_confidence: 1, is_cut_point: 1,
    blockings: [blk()], actions: [], meta: {},
    ...over,
  };
}

/**
 * D01-04 §5.7 四镜算例（只跟踪 c1 的 pos / posture）。
 *
 * | 镜 | pos | posture | spec_source |
 * | sh_40 | (1.80,3.50) | standing | manual |
 * | sh_41 | 键缺失 | standing | ai |
 * | sh_42 | (1.80,3.50) | null | manual |
 * | sh_43 | (1.80,3.50) 但显式 rel=unknown | sitting | ai |
 */
export function fourShots() {
  return [
    shot({ id: 'sh_40', global_no: 1, shot_no: 1, spec_source: 'manual', blockings: [blk()] }),
    shot({ id: 'sh_41', global_no: 2, shot_no: 2, spec_source: 'ai', blockings: [{ character_id: 'c1', in_frame: 1, posture: 'standing' }] }),
    shot({ id: 'sh_42', global_no: 3, shot_no: 3, spec_source: 'manual', blockings: [blk({ posture: null })] }),
    shot({
      id: 'sh_43', global_no: 4, shot_no: 4, spec_source: 'ai',
      blockings: [blk({ posture: 'sitting' })],
      meta: { 'chars.c1.pos': { rel: 'unknown' } },
    }),
  ];
}
