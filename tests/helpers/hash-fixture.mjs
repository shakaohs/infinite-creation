// 阶段 1 hash 测试的固定 fixture（测试与跨 locale 探针共用一个，否则两边比的是不同数据）
import { adaptationHash, compiledHash, sourceSpecHash } from '../../lib/core/hash/index.js';

export const clone = (x) => JSON.parse(JSON.stringify(x));

export function block(over = {}) {
  return {
    character_id: 'roxanne', position_abs: '床边', norm_x: 0.5, norm_y: 0.5, norm_z: 0,
    position_track: [], anchor_object: '床', behind_object: '', facing: '左',
    gaze_target: 'harold', posture: '靠坐', distance_to_camera: 2.4, occlusion: 'none',
    hand_state: '扶床栏', current_task: '', in_frame: 1, power_level: '', instance_anchor: '',
    meta: { rel: 'known' }, ...over,
  };
}

export function action(over = {}) {
  return {
    id: 'ac_1', actor_id: 'roxanne', action_type: 'gesture', is_primary: 1, tier: 'T1',
    init_state: '{}', trigger_json: '{"kind":"action","text":"抬头"}', path_json: '{}',
    force_json: '{}', speed_json: '{}', power: 0, cog: '', body_parts: '[]',
    contact_json: '{}', result_json: '{}', follow_through: '', recovery: '', end_state: '{}',
    sync_json: '{}', t_from: 0, t_to: 1.2, ...over,
  };
}

export function shot(over = {}) {
  return {
    id: 'sh_1', project_id: 'p1', chapter_id: 'c1', scene_key: 'S01_病房', shot_no: 1, global_no: 1,
    purpose: 'advance', dramatic_value: 0.5, info_delta: '得知探视', dialogue_function: 'press',
    is_insert: 0,
    visual_content: '罗克珊靠在床头', composition: '三分法', lighting: '冷白',
    shot_size: 'MCU', cam_direction: '正面', cam_height: 'eye', cam_roll_deg: 0,
    cam_pos: '[0.42,0.5,1.2]', cam_target: 'roxanne', cam_distance_m: 2.4, lens_mm: 50, fov_deg: 36.5,
    movement: 'static', movement_amp: 'none', cam_path: '[]', composition_rule: '', cam_note: '',
    dialogue: '你来了。', speakers: '["roxanne"]', narration: '', sfx: '', music_cue: '',
    voice_ids: '["as_voice_a","as_voice_b"]',
    story_duration: 4.0, time_slices: '[]', speed_ramp: 'none', is_cut_point: 1, time_jump: 0,
    spec_version: 2, spec_source: 'manual', fill_confidence: 0, qc_status: '',
    created_at: 1700000000000, updated_at: 1700000000000,
    blockings: [block()],
    actions: [action()],
    assets: [{ asset_id: 'as_roxanne', role: 'character', order_no: 1, variant_of: '' }],
    state_in: { chars: { roxanne: { posture: '躺' } } },
    state_in_meta: { 'chars.roxanne.posture': { rel: 'known' } },
    state_out: { chars: { roxanne: { posture: '靠坐' } } },
    state_out_meta: { 'chars.roxanne.posture': { rel: 'known' } },
    ...over,
  };
}

export const ASSETS = {
  as_roxanne: { fingerprint: 'fp-rox-1', fpLevel: 'content' },
  as_costume_a: { fingerprint: 'fp-cost-a', fpLevel: 'content' },
  as_costume_b: { fingerprint: 'fp-cost-b', fpLevel: 'content' },
  as_voice_a: { fingerprint: 'fp-voice-a', fpLevel: 'content' },
  as_voice_b: { fingerprint: 'fp-voice-b', fpLevel: 'content' },
};

export const SCENES = [{
  scene_key: 'S01_病房', scene_id: 'sc_1', coord_system: '{"unit":"m"}', fixtures: '["床","监护仪"]',
  entries: '{}', axis_lock: '{"axis":"N"}', power_geometry: '{}', crowd_switch: '',
  time_of_day: '夜', lighting_base: '冷白',
}];

export function fx(over = {}) {
  return { scenes: clone(SCENES), shots: [shot()], assets: clone(ASSETS), ...over };
}

export const AD_SD = {
  adaptation: {
    id: 'ad_sd', adaptation_version: 1, track: 'seedance', profile_ver: 'seedance25.v1',
    profile_max: 30, profile_short_floor: 4, profile_min_slice: 1.5, profile_tail_hold_max: 2.5,
    seam_policy_json: '{"seam":"tail_frame"}',
  },
  units: [{ id: 'u1', unit_no: 1, unit_duration: 29.5 }, { id: 'u2', unit_no: 2, unit_duration: 8.5 }],
  fragments: [
    { unit_id: 'u1', shot_id: 'sh_1', order_no: 1, t_from: 0, t_to: 4, split_reason: '' },
    { unit_id: 'u2', shot_id: 'sh_1', order_no: 1, t_from: 4, t_to: 12, split_reason: '' },
  ],
};

export const AD_H3 = {
  adaptation: {
    id: 'ad_h3', adaptation_version: 1, track: 'h3', profile_ver: 'h3.v1',
    profile_max: 15, profile_short_floor: 3, profile_min_slice: 1, profile_tail_hold_max: 2,
    seam_policy_json: '{"seam":"tail_frame"}',
  },
  units: [{ id: 'u1', unit_no: 1, unit_duration: 14.5 }],
  fragments: [{ unit_id: 'u1', shot_id: 'sh_1', order_no: 1, t_from: 0, t_to: 4, split_reason: '' }],
};

export const COMP = {
  ver: '1.0.0',
  params: { format: 'ref2va', language: 'en', aspectRatio: '9:16', fps: 24, refPackPolicy: 'ordered', seamInjection: true },
};

export function hashes(f, ad = AD_SD, comp = COMP) {
  const source = sourceSpecHash(f);
  const adaptation = adaptationHash(ad);
  return {
    source, adaptation,
    compiled: compiledHash({ sourceHash: source, adaptationHash: adaptation, compilerVer: comp.ver, compilerParams: comp.params }),
  };
}
