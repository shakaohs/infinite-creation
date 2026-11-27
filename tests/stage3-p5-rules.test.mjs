// 阶段 3 · P5：69 条 QC 规则逐条测试（一正一负）
//
// 结构：每条规则一个 `test()`，内部两次调用 `validateRule(id, ...)`：
//   · 正向：`applicable=true` 且 `level='pass'`（INFO/WARN 类规则的正向同样是 pass —— 只有"命中"才不是 pass）
//   · 负向：`level` 等于该规则声明的档位（fail/warn/info），且 `fields[]` 非空、包含 `field`
// 这样"某条规则没实现"或"实现了但永不命中"都会当场变红；用模块级测试糊过去是不行的。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-p5-rules-'));
process.env.IC_DATA_DIR = TMP;
delete process.env.IC_DB_SQLITE_PATH;
delete process.env.IC_DB;
delete process.env.DATABASE_URL;

const {
  validateRule, validateShot, RULES, ruleIds,
} = await import('../lib/core/validate/index.js');
const F = await import('./helpers/qc-fixture.mjs');

const { ctx, b, a, scene, st, chapter, baseShot } = F;

/** 契约断言：每条命中都必须能被 LLM 直接用于修改 */
function assertContract(entry, id) {
  for (const k of ['rule_id', 'code', 'level', 'applicable', 'source', 'field', 'fields', 'expected', 'detail']) {
    assert.ok(Object.prototype.hasOwnProperty.call(entry, k), `${id} 缺字段 ${k}`);
  }
  assert.equal(entry.rule_id, id);
  assert.equal(entry.source, 'run');
  assert.ok(Array.isArray(entry.fields), `${id} fields 必须是数组`);
}

/* ── 规则用例表 ────────────────────────────────────────────────────────
 * `pass` / `fail` 都是"对夹具的最小改写"；`expect` 是负向命中的档位。
 * 表里没有的字段一律走夹具默认值 —— 负向用例只改一处，评审能一眼看出"到底在测什么"。
 */
const CASES = [
  // ── V 系列 ──────────────────────────────────────────────────────────
  {
    id: 'V-01',
    pass: { blockings: [b()] },
    fail: { blockings: [b({ posture: '' })] },
  },
  {
    id: 'V-02',
    pass: { blockings: [b()] },
    fail: { shot: { purpose: 'not_a_purpose' } },
  },
  {
    id: 'V-03',
    pass: { shotAssets: [{ shot_id: 'sh_01', asset_id: 'c1', role: 'character', order_no: 1 }] },
    fail: { shotAssets: [{ shot_id: 'sh_01', asset_id: 'c_missing', role: 'character', order_no: 1 }] },
  },
  {
    id: 'V-04',
    pass: { shot: { speakers: [{ type: 'on_screen', id: 'c1' }] }, blockings: [b()] },
    fail: { shot: { speakers: [{ type: 'on_screen', id: 'c1' }] }, blockings: [b({ in_frame: 0 })] },
  },
  {
    id: 'V-05',
    pass: { shot: { shot_size: 'medium' } },
    fail: { shot: { shot_size: 'close_up', visual_content: '脚踩在地面上，鞋尖抵住床脚' } },
  },
  {
    id: 'V-06',
    pass: { chapterShots: chapter(5), shot: { id: 'sh_03' } },
    fail: {
      chapterShots: chapter(5).map((s, i) => (i < 2 ? { ...s, cam_roll_deg: 5 } : s)),
      shot: { id: 'sh_03' },
    },
    expect: 'warn',
  },
  {
    id: 'V-07',
    pass: { shot: { id: 'sh_02', shot_size: 'extreme_wide' }, chapterShots: chapter(5) },
    fail: {
      shot: { id: 'sh_02', shot_size: 'medium' },
      chapterShots: chapter(5, ['medium', 'medium', 'medium', 'close', 'close']),
    },
    expect: 'warn',
  },
  {
    id: 'V-08',
    pass: { chapterShots: chapter(5, ['extreme_wide', 'full', 'medium', 'medium_close', 'close']), shot: { id: 'sh_03' } },
    fail: { chapterShots: chapter(5, ['extreme_wide', 'wide', 'full', 'medium', 'medium_full']), shot: { id: 'sh_03' } },
    expect: 'warn',
  },
  {
    id: 'V-09',
    pass: {
      shot: { dialogue: '你把文件放下。' },
      actions: [a({ sync_json: { dialogue_span: [2, 4.4] } })],
    },
    fail: {
      shot: { dialogue: '你把文件放下，我说了让你把文件放下，你听见没有。' },
      actions: [a({ sync_json: { dialogue_span: [2, 4.4] } })],
    },
  },
  {
    id: 'V-11',
    pass: {},
    fail: { shot: { movement: 'pan_left', movement_amp: 'none' } },
  },
  {
    id: 'V-13',
    pass: { shot: { is_insert: 1, dialogue: '他走了。', speakers: [] } },
    fail: { shot: { is_insert: 1, speakers: [{ type: 'on_screen', id: 'c1' }] }, blockings: [b()] },
  },
  {
    id: 'V-14',
    pass: {},
    fail: { shot: { fov_deg: null, cam_note: '' } },
    expect: 'info',
  },
  {
    id: 'V-15',
    pass: { shot: { shot_size: 'medium_close', lens_mm: 50 } },
    fail: { shot: { shot_size: 'close_up', lens_mm: 24 } },
    expect: 'warn',
  },
  {
    id: 'V-16',
    pass: {},
    fail: { shot: { fov_deg: 62 } },
    expect: 'warn',
  },
  {
    id: 'V-17',
    pass: { blockings: [b({ norm_x: 0.2, norm_y: 0.5 })], sceneState: scene(), shotState: st() },
    fail: { blockings: [b({ norm_x: 0.95, norm_y: 0.8 })], sceneState: scene(), shotState: st() },
  },
  {
    id: 'V-18',
    pass: { shotState: st() },
    fail: { shotState: st({ conflicts: [{ code: 'POSTURE_JUMP', character_id: 'c1' }] }) },
  },
  {
    id: 'V-19',
    pass: { shotState: st({ meta: { 'chars.c1.pos': { rel: 'known' } } }) },
    fail: { shotState: st({ meta: { 'chars.c1.nope': { rel: 'known' } } }) },
  },
  {
    id: 'V-20',
    pass: {},
    fail: { shot: { time_slices: [{ from: 0, to: 2, kind: 'action' }, { from: 2.5, to: 4.5, kind: 'dialogue' }] } },
  },
  {
    id: 'V-21',
    pass: { blockings: [b()], sceneState: scene() },
    fail: { blockings: [b()], sceneState: scene(), shot: { cam_distance_m: 1.0 } },
    expect: 'warn',
  },
  {
    id: 'V-22',
    pass: { shotState: st({ meta: { 'chars.c1.pos': { rel: 'known' } } }) },
    fail: { shotState: st({ meta: { 'chars.c1.pos': { rel: 'unknown' } } }) },
    expect: 'warn',
  },
  {
    id: 'V-23',
    pass: {
      shot: { voice_ids: ['v1'] },
      shotAssets: [{ shot_id: 'sh_01', asset_id: 'v1', role: 'voice', order_no: 1 }],
    },
    fail: {
      shot: { voice_ids: ['v2'] },
      shotAssets: [{ shot_id: 'sh_01', asset_id: 'v1', role: 'voice', order_no: 1 }],
    },
  },
  {
    id: 'V-24',
    pass: { shot: { spec_source: 'ai' }, shotState: st({ state_out: { chars: {} }, meta: { 'chars.c1.pos': { rel: 'known' } } }) },
    fail: { shot: { spec_source: 'ai' }, shotState: st({ meta: { 'chars.c1.pos': { rel: 'known' } } }) },
    expect: 'warn',
  },
  {
    id: 'V-25',
    pass: {
      shotAssets: [
        { shot_id: 'sh_01', asset_id: 'c1', role: 'character', order_no: 1 },
        { shot_id: 'sh_01', asset_id: 'c2', role: 'character', order_no: 2 },
      ],
    },
    fail: {
      shotAssets: [
        { shot_id: 'sh_01', asset_id: 'c1', role: 'character', order_no: 1 },
        { shot_id: 'sh_01', asset_id: 'c2', role: 'character', order_no: 3 },
      ],
    },
  },
  {
    id: 'V-26',
    pass: {
      shotAssets: [
        { shot_id: 'sh_01', asset_id: 'v1', role: 'voice', order_no: 1 },
        { shot_id: 'sh_01', asset_id: 'v2', role: 'voice', order_no: 2 },
        { shot_id: 'sh_01', asset_id: 'v3', role: 'voice', order_no: 3 },
      ],
    },
    fail: {
      shotAssets: [
        { shot_id: 'sh_01', asset_id: 'v1', role: 'voice', order_no: 1 },
        { shot_id: 'sh_01', asset_id: 'v2', role: 'voice', order_no: 2 },
        { shot_id: 'sh_01', asset_id: 'v3', role: 'voice', order_no: 3 },
        { shot_id: 'sh_01', asset_id: 'v4', role: 'voice', order_no: 4 },
      ],
    },
  },
  // ── A 系列 ──────────────────────────────────────────────────────────
  {
    id: 'A-01',
    pass: { actions: [a()] },
    fail: { actions: [a({ is_primary: 0 })] },
  },
  {
    id: 'A-02',
    pass: { actions: [a(), a({ id: 'ac2', t_from: 3, t_to: 4 })] },
    fail: { actions: [a(), a({ id: 'ac2', t_from: 1, t_to: 3 })] },
  },
  {
    id: 'A-03',
    pass: { actions: [a({ action_type: 'locomotion', path_json: { from: { x: 0.7, y: 0.5, z: 0 }, to: { x: 0.4, y: 0.5, z: 0 } } })] },
    fail: { actions: [a({ action_type: 'locomotion', path_json: {} })] },
  },
  {
    id: 'A-04',
    pass: {
      actions: [a({
        action_type: 'locomotion',
        path_json: { from: { x: 0.7, y: 0.5, z: 0 }, to: { x: 0.4, y: 0.5, z: 0 } },
        end_state: { pos: { x: 0.4, y: 0.5, z: 0 } },
      })],
    },
    fail: {
      actions: [a({
        action_type: 'locomotion',
        path_json: { from: { x: 0.7, y: 0.5, z: 0 }, to: { x: 0.4, y: 0.5, z: 0 } },
        end_state: { pos: { x: 0.55, y: 0.5, z: 0 } },
      })],
    },
  },
  {
    id: 'A-05',
    pass: {
      sceneState: scene(),
      actions: [a({ action_type: 'locomotion', path_json: { from: { x: 0.7, y: 0.45, z: 0 }, to: { x: 0.75, y: 0.45, z: 0 } } })],
    },
    fail: {
      sceneState: scene(),
      actions: [a({ action_type: 'locomotion', path_json: { from: { x: 0.95, y: 0.65, z: 0 }, to: { x: 0.95, y: 0.95, z: 0 } } })],
    },
  },
  {
    id: 'A-06',
    pass: {
      actions: [a({ action_type: 'locomotion', path_json: { from: { x: 0.7, y: 0.5, z: 0 }, to: { x: 0.4, y: 0.5, z: 0 } } })],
      nextShotState: { state_in: { chars: { c1: { pos: [0.42, 0.5, 0] } } } },
    },
    fail: {
      actions: [a({ action_type: 'locomotion', path_json: { from: { x: 0.7, y: 0.5, z: 0 }, to: { x: 0.4, y: 0.5, z: 0 } } })],
      nextShotState: { state_in: { chars: { c1: { pos: [0.95, 0.5, 0] } } } },
    },
  },
  {
    id: 'A-07',
    pass: { actions: [a()] },
    fail: { actions: [a({ contact_json: { target_type: 'prop', target_id: 'p_missing', impulse: 'medium' } })] },
  },
  {
    id: 'A-08',
    pass: {
      actions: [
        a({ contact_json: { target_type: 'character', target_id: 'c2', impulse: 'medium' } }),
        a({ id: 'ac2', actor_id: 'c2', action_type: 'reaction', t_from: 1, t_to: 2 }),
      ],
    },
    fail: { actions: [a({ contact_json: { target_type: 'character', target_id: 'c2', impulse: 'medium' } })] },
    expect: 'warn',
  },
  {
    id: 'A-09',
    pass: {
      actions: [
        a({ id: 'ac1', t_from: 0, t_to: 1 }),
        a({ id: 'ac2', t_from: 1.2, t_to: 2, trigger_json: { kind: 'action', ref: 'ac1' } }),
      ],
    },
    fail: { actions: [a({ trigger_json: { kind: 'action', ref: 'ac_missing' } })] },
  },
  {
    id: 'A-10',
    pass: {
      shotState: st({ state_in: { props: { p1: { state: 'held', owner: 'c1' } }, chars: { c1: { pos: [0.7, 0.5, 0] } } } }),
      actions: [a({ result_json: { prop_delta: [{ prop_id: 'p1', from: { state: 'held', owner: 'c1' }, to: { state: 'dropped' } }] } })],
    },
    fail: {
      shotState: st({ state_in: { props: { p1: { state: 'held', owner: 'c1' } }, chars: { c1: { pos: [0.7, 0.5, 0] } } } }),
      actions: [a({ result_json: { prop_delta: [{ prop_id: 'p1', from: { state: 'placed', owner: 'c1' }, to: { state: 'dropped' } }] } })],
    },
  },
  {
    id: 'A-11',
    pass: { actions: [a()] },
    fail: { actions: [a({ t_from: 3, t_to: 6 })] },
  },
  {
    id: 'A-12',
    pass: {
      actions: [
        a({ body_parts: [{ part: 'right_arm' }], t_from: 0, t_to: 2 }),
        a({ id: 'ac2', body_parts: [{ part: 'left_hand' }], t_from: 1, t_to: 2.5 }),
      ],
    },
    fail: {
      actions: [
        a({ body_parts: [{ part: 'right_arm' }], t_from: 0, t_to: 2 }),
        a({ id: 'ac2', body_parts: [{ part: 'right_hand' }], t_from: 1, t_to: 2.5 }),
      ],
    },
  },
  {
    id: 'A-13',
    pass: { actions: [a({ t_from: 0, t_to: 2 })] },
    fail: { actions: [a({ t_from: 0, t_to: 4.45 })] },
    expect: 'warn',
  },
  {
    id: 'A-14',
    pass: {
      shot: { speakers: [{ type: 'on_screen', id: 'c1' }] },
      actions: [a({ power: 3, sync_json: { dialogue_span: [0, 2] } })],
    },
    fail: {
      shot: { speakers: [{ type: 'on_screen', id: 'c1' }] },
      actions: [a({ power: 9, body_parts: [{ part: 'head' }], sync_json: { dialogue_span: [0, 2] } })],
    },
    expect: 'warn',
  },
  {
    id: 'A-15',
    pass: {},
    fail: { shot: { time_slices: [{ from: 0, to: 2, kind: 'action' }, { from: 2, to: 4, kind: 'dialogue' }] } },
  },
  {
    id: 'A-16',
    pass: {
      shot: { time_slices: [{ from: 0, to: 1, kind: 'hold' }, { from: 1, to: 4.5, kind: 'action' }] },
      actions: [a({ speed_json: { profile: 'sudden' }, t_from: 1, t_to: 3 })],
    },
    fail: {
      shot: { time_slices: [{ from: 0, to: 1, kind: 'action' }, { from: 1, to: 4.5, kind: 'action' }] },
      actions: [a({ speed_json: { profile: 'sudden' }, t_from: 1, t_to: 3 })],
    },
    expect: 'warn',
  },
  {
    id: 'A-17',
    pass: { actions: [a({ tier: 'T2' })] },
    fail: { actions: [a({ tier: 'T1' })] },
    expect: 'warn',
  },
  {
    id: 'A-18',
    pass: { actions: [a()] },
    fail: {
      actions: [
        a({ sync_json: { parallel_with: ['ac2'] } }),
        a({ id: 'ac2', t_from: 2, t_to: 4 }),
      ],
    },
    expect: 'info',
  },
  {
    id: 'A-19',
    pass: {
      actions: [a({ tier: 'T3', action_type: 'combat', sync_json: { is_key_blow: true }, force_json: { chain: [1, 2, 3, 4, 5, 6, 7, 8] } })],
    },
    fail: {
      actions: [a({ tier: 'T3', action_type: 'combat', sync_json: { is_key_blow: true }, force_json: { chain: [1, 2, 3] } })],
    },
  },
  // ── S 系列 ──────────────────────────────────────────────────────────
  {
    id: 'S-01',
    pass: { sceneState: scene() },
    fail: { sceneState: null },
  },
  {
    id: 'S-02',
    pass: { blockings: [b(), b({ character_id: 'c2', norm_x: 0.2 })], sceneState: scene() },
    fail: { blockings: [b({ anchor_object: '不存在的椅子' }), b({ character_id: 'c2', norm_x: 0.2 })], sceneState: scene() },
  },
  {
    id: 'S-03',
    pass: { blockings: [b({ position_abs: '画面右', norm_x: 0.7 })] },
    fail: { blockings: [b({ position_abs: '画面右', norm_x: 0.2 })] },
  },
  {
    id: 'S-04',
    pass: {
      sceneState: scene(),
      blockings: [b({ position_track: [{ t: 0, x: 0.7, y: 0.5, z: 0 }, { t: 2, x: 0.72, y: 0.5, z: 0 }] })],
    },
    fail: {
      sceneState: scene(),
      blockings: [b({ position_track: [{ t: 0, x: 0.95, y: 0.65, z: 0 }, { t: 2, x: 0.95, y: 0.95, z: 0 }] })],
    },
  },
  {
    id: 'S-05',
    pass: { blockings: [b({ character_id: 'c1', norm_x: 0.2, norm_y: 0.5 }), b({ character_id: 'c2', norm_x: 0.3, norm_y: 0.5 })], sceneState: scene() },
    fail: { blockings: [b({ character_id: 'c1', norm_x: 0.8, norm_y: 0.6 }), b({ character_id: 'c2', norm_x: 0.3, norm_y: 0.25 })], sceneState: scene() },
  },
  {
    id: 'S-06',
    pass: { blockings: [b({ character_id: 'c1', norm_x: 0.2, norm_y: 0.5 }), b({ character_id: 'c2', norm_x: 0.3, norm_y: 0.5 })], sceneState: scene() },
    fail: { blockings: [b({ character_id: 'c1', norm_x: 0.8, norm_y: 0.6 }), b({ character_id: 'c2', norm_x: 0.2, norm_y: 0.5 })], sceneState: scene() },
    expect: 'info',
  },
  {
    id: 'S-07',
    pass: { blockings: [b()], sceneState: scene() },
    fail: { blockings: [b()], sceneState: scene(), shot: { cam_pos: null } },
    expect: 'info',
  },
  {
    id: 'S-08',
    pass: { shotState: st() },
    fail: { shotState: st({ conflicts: [{ code: 'POSITION_JUMP', character_id: 'c1' }] }) },
  },
  {
    id: 'S-09',
    pass: { shotState: st() },
    fail: { shotState: st({ conflicts: [{ code: 'POSTURE_JUMP', character_id: 'c1' }] }) },
  },
  {
    id: 'S-10',
    pass: { shotState: st() },
    fail: { shotState: st({ conflicts: [{ code: 'HAND_JUMP', character_id: 'c1' }] }) },
  },
  {
    id: 'S-11',
    pass: { shotState: st() },
    fail: { shotState: st({ conflicts: [{ code: 'PROP_APPEAR', prop_id: 'p1' }] }) },
  },
  {
    id: 'S-12',
    pass: { shotState: st() },
    fail: { shotState: st({ conflicts: [{ code: 'PROP_REVIVE', prop_id: 'p1' }] }) },
  },
  {
    id: 'S-13',
    pass: {
      shotAssets: [{ shot_id: 'sh_01', asset_id: 'ct1', role: 'costume', order_no: 1 }],
      prevShotAssets: [{ shot_id: 'sh_00', asset_id: 'ct1', role: 'costume', order_no: 1 }],
    },
    fail: {
      shotAssets: [{ shot_id: 'sh_01', asset_id: 'ct1', role: 'costume', order_no: 1 }],
      prevShotAssets: [{ shot_id: 'sh_00', asset_id: 'ct2', role: 'costume', order_no: 1 }],
    },
  },
  {
    id: 'S-14',
    pass: { shotState: st() },
    fail: { shotState: st({ conflicts: [{ code: 'CHAR_POP', character_id: 'c2' }] }) },
  },
  {
    id: 'S-15',
    pass: { blockings: [b()], sceneState: scene() },
    fail: {
      sceneState: scene(),
      blockings: [
        b({ character_id: 'c1', norm_x: 0.1, norm_y: 0.5 }),
        b({ character_id: 'c2', norm_x: 0.9, norm_y: 0.5, position_abs: '画面左', anchor_object: 'fx_bed' }),
      ],
    },
    expect: 'warn',
  },
  {
    id: 'S-16',
    pass: { sceneState: scene({ crowd_switch: 'B' }) },
    fail: { sceneState: scene({ crowd_switch: 'A' }), shot: { shot_size: 'close_up' } },
    expect: 'warn',
  },
  {
    id: 'S-17',
    pass: { sceneState: scene() },
    fail: { sceneState: scene({ power_geometry: { start: { holder: 'c1' }, end: { holder: 'c1' } } }), shot: { purpose: 'turn' } },
    expect: 'warn',
  },
  {
    id: 'S-18',
    pass: {
      shotState: st(),
      blockings: [b({ position_track: [{ t: 0, x: 0.7, y: 0.5, z: 0 }, { t: 2, x: 0.7, y: 0.5, z: 0 }] })],
    },
    fail: {
      shotState: st(),
      blockings: [b({ position_track: [{ t: 0, x: 0.2, y: 0.2, z: 0 }, { t: 2, x: 0.2, y: 0.2, z: 0 }] })],
    },
  },
  {
    id: 'S-19',
    pass: { blockings: [b({ position_track: [{ t: 0, x: 0.7, y: 0.5, z: 0 }, { t: 2, x: 0.72, y: 0.5, z: 0 }] })] },
    fail: { blockings: [b({ position_track: [{ t: 0, x: 0.2, y: 0.2, z: 0 }, { t: 2, x: 0.9, y: 0.9, z: 0 }] })] },
  },
  {
    id: 'S-20',
    pass: { __audit: [{ rule_id: 'A-04', code: 'STATE_UNKNOWN', level: 'info', field: 'end_state.pos@ac1', detail: { rel: 'unknown' } }] },
    fail: { __audit: [{ rule_id: 'S-03', code: 'BLOCKING_ABS_COORD_MISMATCH', level: 'fail', field: 'shot_blockings(c1).norm_x', detail: { rel: 'unknown' } }] },
  },
  {
    id: 'S-21',
    pass: { __audit: [{ rule_id: 'A-04', code: 'STATE_UNKNOWN', level: 'info', field: 'end_state.pos@ac1', detail: { rel: 'inferred' } }] },
    fail: { __audit: [{ rule_id: 'A-06', code: 'ACTION_CROSS_SHOT_MISMATCH', level: 'fail', field: 'pos@ac1', detail: { rel: 'inferred' } }] },
  },
  {
    id: 'S-22',
    pass: {},
    fail: { shot: { cam_roll_deg: 5 }, targetProfile: { roll_sign_verified: false } },
    expect: 'warn',
  },
  {
    id: 'S-23',
    pass: { blockings: [b()], sceneState: scene() },
    fail: { blockings: [b()], sceneState: scene(), shot: { cam_pos: { x: 2.45, y: 1.75, z: 1.6 }, cam_target: { x: 2.45, y: 1.75, z: 3 } } },
    expect: 'info',
  },
  {
    id: 'S-24',
    pass: { blockings: [b()] },
    fail: { blockings: [b({ norm_z: null })] },
  },
  {
    id: 'S-25',
    pass: { __audit: [] },
    fail: { __audit: [{ rule_id: 'S-18', code: 'TRACK_ENDS_MISMATCH', level: 'fail', field: 'shot_blockings(c1).position_track', detail: { rel: 'unknown' } }] },
  },
];

/* ── 逐条执行 ──────────────────────────────────────────────────────── */
assert.equal(CASES.length, 68, '用例表覆盖 68 条（V-12 是 NOT_APPLICABLE，单独测）');

for (const spec of CASES) {
  test(`P5-${spec.id} 正向通过 / 负向命中`, () => {
    const pos = validateRule(spec.id, ctx(spec.pass));
    assertContract(pos, spec.id);
    assert.equal(pos.applicable, true, `${spec.id} 正向应适用：${pos.detail?.reason ?? ''}`);
    assert.equal(pos.level, 'pass', `${spec.id} 正向应为 pass，实际 ${pos.level} ${pos.code}`);

    const neg = validateRule(spec.id, ctx(spec.fail));
    assertContract(neg, spec.id);
    assert.equal(neg.applicable, true, `${spec.id} 负向应适用`);
    assert.equal(neg.level, spec.expect ?? 'fail', `${spec.id} 负向档位不对（实际 ${neg.level} ${neg.code}）`);
    assert.notEqual(neg.code, 'PASS');
    assert.ok(neg.fields.length >= 1, `${spec.id} fields 不得为空`);
    assert.ok(neg.fields.includes(neg.field), `${spec.id} fields 必须包含 field`);
    assert.ok(neg.expected.length > 0, `${spec.id} expected 不得为空`);

    // 确定性：同输入两次逐字一致
    assert.deepEqual(validateRule(spec.id, ctx(spec.fail)), neg);
  });
}

/* ── 特殊规则 ──────────────────────────────────────────────────────── */
test('P5-V-12 剪辑点 vs 单元边界：阶段 4 项，必须 NOT_APPLICABLE 而不是伪造 PASS', () => {
  const r = validateRule('V-12', ctx({}));
  assert.equal(r.applicable, false);
  assert.equal(r.level, '');
  assert.equal(r.code, 'NOT_APPLICABLE');
  assert.match(String(r.detail.reason), /阶段 4/);
});

test('P5-V-10 已废止：规则表里没有 V-10，源码里也没有它的实现', () => {
  assert.ok(!ruleIds().includes('V-10'), '规则表不得包含 V-10');
  assert.ok(!RULES.some((r) => r.id === 'V-10'));
  const dir = path.resolve('lib/core/validate');
  const offenders = [];
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.js')) continue;
    const text = fs.readFileSync(path.join(dir, f), 'utf8');
    // 允许注释里出现「V-10 已废止」，但不得出现判定逻辑（"台词 + 动作 ≤ 时长"）
    if (/rule_id:\s*'V-10'/.test(text) || /function\s+\w*V10/.test(text)) offenders.push(f);
  }
  assert.deepEqual(offenders, [], '不得存在 V-10 的实现');
});

test('P5-S-20/S-21/S-25 是"规则的规则"：正常输入下三条全部 PASS', () => {
  const c = ctx({
    blockings: [b({ norm_x: 0.7, norm_y: 0.5, norm_z: null })], // 故意制造 unknown 坐标
    actions: [a()],
    sceneState: scene(),
    shotState: st({ state_in: { chars: { c1: { pos: [null, null, null] } } }, conflicts: [] }),
  });
  for (const id of ['S-20', 'S-21', 'S-25']) {
    const r = validateRule(id, c);
    assert.equal(r.level, 'pass', `${id} 在 unknown 数据下也不得报错：${r.code}`);
  }
  // 反向断言：整镜跑一遍，凡是 detail.rel='unknown' 的命中都不允许是 fail
  const full = validateShot(c);
  const bad = full.hits
    .filter((h) => h.level === 'fail')
    .flatMap((h) => (h.detail.items ?? []).map((i) => ({ ...i, rule_id: h.rule_id })))
    .filter((i) => i.detail?.rel === 'unknown');
  assert.deepEqual(bad, [], 'unknown 字段不得产出 FAIL（S-20/S-25）');
});
