// P5 测试夹具：一镜"形状正确"的上下文 + 逐字段改写工具
//
// 为什么要有夹具：69 条规则每条都要"一正一负"，若各写一份 40 行 ctx，最后没人能确认
// "负向用例到底只改了那一处"。这里只给一个中性基座，规则用**最少的 override** 造负向，
// 这样每个负向测试的差异一眼可见。
//
// 单位约定（与 D01 一致，混淆过一次就会算错几何）：
//   · `shot.cam_pos` / `cam_distance_m` / `distance_to_camera` / `story_duration` 是**米/秒**；
//   · `blockings.norm_*` / `axis_lock.axis_line` 是**归一化**；
//   · `coord_system.active_area = [width_m, height_m, depth_m]` 是两者之间的唯一桥梁。
export const ACTIVE_AREA = Object.freeze([6, 5, 3]);

/** 场景资产 id / 资产表（V-03、A-07、S-02 都要查它） */
export const ASSETS = Object.freeze({
  c1: { id: 'c1', category: 'character', name: '哈罗德' },
  c2: { id: 'c2', category: 'character', name: '罗克珊' },
  c3: { id: 'c3', category: 'character', name: '凯森' },
  p1: { id: 'p1', category: 'prop', name: '文件' },
  s1: { id: 's1', category: 'scene', name: '病房' },
  ct1: { id: 'ct1', category: 'costume', name: '病号服' },
  ct2: { id: 'ct2', category: 'costume', name: '常服' },
  v1: { id: 'v1', category: 'voice', name: '哈罗德音色' },
  v2: { id: 'v2', category: 'voice', name: '罗克珊音色' },
  v3: { id: 'v3', category: 'voice', name: '凯森音色' },
  v4: { id: 'v4', category: 'voice', name: '旁白音色' },
});

/** 摄影机 14 字段齐备的镜（V-14 的正向基线） */
export const baseShot = Object.freeze({
  id: 'sh_01', project_id: 'p1', chapter_id: 'ch1', scene_key: 'S01_病房', scene_id: 's1',
  shot_no: 2, global_no: 2, beat_key: '', prev_shot_id: '',
  purpose: 'advance', dramatic_value: 3, info_delta: '', dialogue_function: 'inform', is_insert: 0,
  visual_content: '哈罗德把文件摔在床头柜上，罗克珊抬眼看他',
  composition: '中景双人', lighting: '床头灯侧光',
  shot_size: 'medium', cam_direction: 'three_quarter', cam_height: 'eye', cam_roll_deg: 0,
  // 米制机位：换算成归一化是 (2.45/6, 1.75/5) = (0.408, 0.35)
  cam_pos: { x: 2.45, y: 1.75, z: 1.6 },
  cam_target: 'c1',
  // 与 c1 的归一化坐标 (0.7,0.5,0) → 米 (4.2,2.5,0) 换算一致：hypot(1.75,0.75,1.6)=2.487
  cam_distance_m: 2.49,
  lens_mm: 50, fov_deg: 39.6,
  movement: 'static', movement_amp: 'none',
  cam_path: [{ x: 2.45, y: 1.75, z: 1.6 }],
  composition_rule: 'center', cam_note: '固定机位，不推不摇',
  dialogue: '', speakers: [], narration: '', sfx: '', music_cue: '',
  voice_ids: [],
  story_duration: 4.5,
  time_slices: [{ from: 0, to: 2, kind: 'action' }, { from: 2, to: 4.5, kind: 'dialogue' }],
  speed_ramp: 'none', is_cut_point: 1, time_jump: 0,
  spec_version: 2, spec_source: 'manual', fill_confidence: 1, qc_status: '',
});

/** 站位行：c1 在画面右、靠床头柜、坐标齐备 */
export function b(over = {}) {
  return {
    shot_id: 'sh_01', character_id: 'c1',
    position_abs: '画面右', norm_x: 0.7, norm_y: 0.5, norm_z: 0, norm_confidence: 0.95,
    position_track: [], anchor_object: 'fx_table', behind_object: 'fx_window',
    facing: 'W', gaze_target: 'c2', posture: 'standing',
    distance_to_camera: 2.49, occlusion: 'none', hand_state: '右手按在柜面',
    current_task: '施压', in_frame: 1, power_level: 'high', instance_anchor: '床头柜旁',
    ...over,
  };
}

/** 动作行：c1 摔文件（T2，非位移） */
export function a(over = {}) {
  return {
    id: 'ac1', shot_id: 'sh_01', actor_id: 'c1', action_type: 'manipulation', is_primary: 1, tier: 'T2',
    init_state: {}, trigger_json: { kind: 'self', ref: '', text: '自主' },
    path_json: {}, force_json: {}, speed_json: { profile: 'constant' },
    power: 5, cog: 'forward',
    body_parts: [{ part: 'right_arm', act: '下压' }],
    contact_json: { target_type: 'prop', target_id: 'p1', impulse: 'medium' },
    result_json: {},
    follow_through: '手停在柜面', recovery: '收回手',
    end_state: {}, sync_json: {}, t_from: 0, t_to: 2,
    ...over,
  };
}

/** 场次：6×5×3 米、三件 fixtures、竖直轴线（x=0.5）、权力几何会变 */
export function scene(over = {}) {
  return {
    id: 'sc1', project_id: 'p1', scene_key: 'S01_病房', scene_id: 's1',
    coord_system: { basis: { north: '正对主窗' }, active_area: [...ACTIVE_AREA] },
    fixtures: [
      { id: 'fx_bed', name: '病床', zone: [0.05, 0.3, 0.55, 0.95], movable: false, can_lean: true, height_m: 0.6 },
      { id: 'fx_table', name: '床头柜', zone: [0.3, 0.35, 0.5, 0.55], movable: false, can_place: true },
      { id: 'fx_window', name: '百叶窗', zone: [0.7, 0, 1, 0.4], movable: false, light_source: true },
      // 硬障碍：没有任何可交互能力 → 人不能站进去（V-17 的负向就靠它）
      { id: 'fx_wall', name: '承重墙', zone: [0.9, 0.6, 1, 1], movable: false },
    ],
    entries: { main: '正门' },
    axis_lock: {
      pair: ['c1', 'c2'], left: 'c1', right: 'c2', camera_side: 'left',
      axis_line: [[0.5, 0], [0.5, 1]],
      cross_allowed: [],
    },
    power_geometry: { start: { holder: 'c1' }, end: { holder: 'c2' } },
    crowd_switch: 'B', time_of_day: '夜', state_rev: 1,
    ...over,
  };
}

/** `shot_states` 行：首尾同位置，无冲突 */
export function st(over = {}) {
  return {
    shot_id: 'sh_01',
    state_in: { chars: { c1: { pos: [0.7, 0.5, 0] } } },
    state_out: { chars: { c1: { pos: [0.7, 0.5, 0] } } },
    meta: {},
    derived_from: 'prev_shot:sh_00',
    state_source: 'solved',
    conflicts: [],
    ...over,
  };
}

/** 基座：只给"最小可跑"，每条规则的用例自己补齐它读的字段 */
export function ctx(patch = {}) {
  return {
    shot: { ...baseShot, ...(patch.shot ?? {}) },
    blockings: patch.blockings ?? [],
    actions: patch.actions ?? [],
    shotAssets: patch.shotAssets ?? [],
    assetsById: patch.assetsById ?? { ...ASSETS },
    sceneState: patch.sceneState ?? null,
    shotState: patch.shotState ?? null,
    prevShot: patch.prevShot ?? null,
    prevShotState: patch.prevShotState ?? null,
    prevShotAssets: patch.prevShotAssets ?? [],
    nextShot: patch.nextShot ?? null,
    nextShotState: patch.nextShotState ?? null,
    chapterShots: patch.chapterShots ?? [],
    targetProfile: patch.targetProfile ?? null,
    declaredLevel: patch.declaredLevel,
    costumeChangeAllowed: patch.costumeChangeAllowed,
    __audit: patch.__audit,
  };
}

/** 章内 N 镜（`shot_no` 1..N，`shot_size` 轮换），供 V-06~V-08 */
export function chapter(n = 5, sizes = ['extreme_wide', 'full', 'medium', 'medium_close', 'close']) {
  return Array.from({ length: n }, (_, i) => ({
    ...baseShot,
    id: `sh_${String(i + 2).padStart(2, '0')}`,
    shot_no: i + 1,
    global_no: i + 1,
    shot_size: sizes[i % sizes.length],
    cam_height: 'eye',
    cam_direction: 'three_quarter',
    cam_roll_deg: 0,
  }));
}
