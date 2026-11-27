// 机位与摄影规则（P5）—— V-05～V-08、V-11、V-14～V-16、V-21、S-15、S-22、S-23
//
// 这一层只判"摄影参数与内容/物理是否自洽"：景别写的内容放不放得下、机位配额有没有超、
// 焦段与视场角、机位距离与坐标换算。**不判定画面好不好看**——那是 INFO 建议的活。
//
// 所有"算不出来"的分支都必须走 INFO 出口（`COORD_SYSTEM_INCOMPLETE` 等），
// 不得因为缺 `active_area` 就判 FAIL（S-20/S-21 的同一条精神：缺数据不是创作错误）。
import { cmpStr } from '../hash/cmp-str.js';
import {
  FAIL, WARN, INFO, f, found, insufficient, notApplicable, pass,
  activeAreaOf, isBlank, isNum, num, numOrNull, posOf, toArr, toObj, dist2, quant,
} from './common.js';

/** 特写族（含近景）：写脚/鞋/地面就说明景别与内容不相容 */
export const CLOSE_FAMILY = Object.freeze(['medium_close', 'close', 'close_up', 'extreme_close']);
/** 全景族：写唇线/睫毛就说明景别与内容不相容 */
export const WIDE_FAMILY = Object.freeze(['extreme_wide', 'wide', 'full', 'medium_full']);

/** V-05 词表：**只看画面内容里明确写出的身体部位**，不做语义推断 */
const LOWER_BODY_WORDS = Object.freeze(['脚', '鞋', '膝', '小腿', '大腿', '腿', '地面', '脚尖', '脚踝']);
const FACE_WORDS = Object.freeze(['唇线', '嘴唇', '唇', '睫毛', '瞳孔', '眼', '嘴角', '鼻尖', '下颌', '眼角']);

/** V-14 完整度标注覆盖的 14 个摄影机字段（D01-02 §4.6） */
export const CAM_FIELDS = Object.freeze([
  'shot_size', 'cam_direction', 'cam_height', 'cam_roll_deg',
  'cam_pos', 'cam_target', 'cam_distance_m',
  'lens_mm', 'fov_deg',
  'movement', 'movement_amp', 'cam_path',
  'composition_rule', 'cam_note',
]);

/** 35mm 全画幅水平片门 36mm —— 焦段↔视场角与取景宽度的唯一换算基准 */
export const SENSOR_WIDTH_M = 0.036;

const containsAny = (text, words) => words.some((w) => text.includes(w));

/**
 * V-05 景别-内容相容（FAIL）。
 *
 * 两条明写的冲突（D01-02 §十三）：
 *  · 特写族写下半身（脚/鞋/膝/地面）—— 画框里根本没有它；
 *  · 全景族写面部细节（唇线/睫毛/瞳孔）—— 那么远的距离看不清。
 *
 * `visual_content` 为空 → INFO（数据不足），不判 PASS 也不判 FAIL：没写内容不等于写错内容。
 *
 * @param {{shot:object}} ctx
 */
export function checkSizeContent(ctx = {}) {
  const shot = ctx.shot ?? {};
  const size = String(shot.shot_size ?? '');
  const text = String(shot.visual_content ?? '');
  if (!text.trim()) {
    return insufficient('VISUAL_CONTENT_EMPTY', 'visual_content', '写明画面内容后本规则才可判定');
  }
  const hits = [];
  if (CLOSE_FAMILY.includes(size) && containsAny(text, LOWER_BODY_WORDS)) {
    hits.push(f(FAIL, 'SIZE_CONTENT_MISMATCH', 'shot_size', `${size} 的画框不含下半身，visual_content 不得写脚/腿/地面`, {
      shot_size: size, visual_content: text.slice(0, 120),
    }));
  }
  if (WIDE_FAMILY.includes(size) && containsAny(text, FACE_WORDS)) {
    hits.push(f(FAIL, 'SIZE_CONTENT_MISMATCH', 'shot_size', `${size} 的距离看不清面部细节，visual_content 不得写唇线/睫毛`, {
      shot_size: size, visual_content: text.slice(0, 120),
    }));
  }
  return found(hits);
}

/**
 * V-06 机位配额（WARN，章级）。
 *
 * 三条配额（D01-02 §十三）：`cam_roll_deg≠0` ≤ 1 集；大仰/大俯各 ≤ 3；`profile` ≤ 15%。
 * 章内不足 3 镜时配额无意义 → 不适用。
 *
 * @param {{shot:object, chapterShots?:Array}} ctx
 */
export function checkQuota(ctx = {}) {
  const list = toArr(ctx.chapterShots).filter((s) => s && typeof s === 'object');
  if (list.length < 3) return notApplicable(`章内仅 ${list.length} 镜，配额无统计意义`);
  const roll = list.filter((s) => Math.abs(num(s.cam_roll_deg)) > 0).length;
  const low = list.filter((s) => String(s.cam_height ?? '') === 'extreme_low').length;
  const high = list.filter((s) => String(s.cam_height ?? '') === 'extreme_high').length;
  const profile = list.filter((s) => String(s.cam_direction ?? '') === 'profile').length;
  const profileRatio = profile / list.length;
  const hits = [];
  if (roll > 1) {
    hits.push(f(WARN, 'QUOTA_ROLL_EXCEEDED', 'chapter.cam_roll_deg', '全章 cam_roll_deg≠0 的镜 ≤ 1', { count: roll, total: list.length }));
  }
  if (low > 3) hits.push(f(WARN, 'QUOTA_EXTREME_LOW_EXCEEDED', 'chapter.cam_height', '全章 extreme_low ≤ 3', { count: low, total: list.length }));
  if (high > 3) hits.push(f(WARN, 'QUOTA_EXTREME_HIGH_EXCEEDED', 'chapter.cam_height', '全章 extreme_high ≤ 3', { count: high, total: list.length }));
  if (profileRatio > 0.15) {
    hits.push(f(WARN, 'QUOTA_PROFILE_EXCEEDED', 'chapter.cam_direction', '全章 profile ≤ 15%', {
      count: profile, total: list.length, ratio: Math.round(profileRatio * 1000) / 1000,
    }));
  }
  return found(hits);
}

/** 章内按 `shot_no` 稳定排序（同号退化到 `id`，禁 `localeCompare`） */
function orderedChapter(list) {
  return list.slice().sort((a, b) => (num(a.shot_no) - num(b.shot_no)) || cmpStr(a.id, b.id));
}

/**
 * V-07 景别重复（WARN）：连续 3 镜同档。
 *
 * 只在"含本镜的三连窗"里判：别的窗口重复与本镜无关，报在本镜上会让 LLM 改错镜。
 *
 * @param {{shot:object, chapterShots?:Array}} ctx
 */
export function checkRepeat(ctx = {}) {
  const list = orderedChapter(toArr(ctx.chapterShots).filter((s) => s && typeof s === 'object'));
  const id = String(ctx.shot?.id ?? '');
  const idx = list.findIndex((s) => String(s.id ?? '') === id);
  if (list.length < 3 || idx < 0) return notApplicable(`章内 ${list.length} 镜（或本镜不在章内），三连窗不可判`);
  const size = String(ctx.shot?.shot_size ?? '');
  const hits = [];
  for (let start = Math.max(0, idx - 2); start + 2 < list.length; start += 1) {
    if (start > idx) break;
    const win = list.slice(start, start + 3);
    if (!win.some((s) => String(s.id ?? '') === id)) continue;
    if (win.every((s) => String(s.shot_size ?? '') === size) && size) {
      hits.push(f(WARN, 'REPEAT_SHOT_SIZE', 'shot_size', '连续 3 镜不得同档（相邻镜至少换一档）', {
        shot_size: size, window: win.map((s) => String(s.id ?? '')),
      }));
      break;
    }
  }
  return found(hits);
}

/**
 * V-08 特写比例（WARN）：章内人物特写占比 25%–40%。
 *
 * 章内 <5 镜 → 不适用（样本太小，比例没有意义）。
 *
 * @param {{shot:object, chapterShots?:Array}} ctx
 */
export function checkCloseUpRatio(ctx = {}) {
  const list = toArr(ctx.chapterShots).filter((s) => s && typeof s === 'object');
  if (list.length < 5) return notApplicable(`章内仅 ${list.length} 镜（<5），比例无统计意义`);
  const close = list.filter((s) => CLOSE_FAMILY.includes(String(s.shot_size ?? ''))).length;
  const ratio = close / list.length;
  if (ratio >= 0.25 && ratio <= 0.4) return pass();
  return found([
    f(WARN, 'CLOSEUP_RATIO_OUT_OF_RANGE', 'chapter.shot_size', '人物特写占全章 25%–40%', {
      close, total: list.length, ratio: Math.round(ratio * 1000) / 1000,
    }),
  ]);
}

/**
 * V-11 运镜-幅度一致（FAIL）。
 *
 * 非 `static` 不得 `amp=none`（"运镜了却写没有幅度"）；两个字段本身是必填，缺一即 FAIL。
 *
 * @param {{shot:object}} ctx
 */
export function checkMovementAmp(ctx = {}) {
  const shot = ctx.shot ?? {};
  const movement = String(shot.movement ?? '');
  const amp = String(shot.movement_amp ?? '');
  const hits = [];
  if (isBlank(shot.movement) || !movement) hits.push(f(FAIL, 'MOVEMENT_REQUIRED', 'movement', '必填（默认 static）', {}));
  if (isBlank(shot.movement_amp) || !amp) hits.push(f(FAIL, 'MOVEMENT_AMP_REQUIRED', 'movement_amp', '必填（默认 none）', {}));
  if (!hits.length && movement !== 'static' && amp === 'none') {
    hits.push(f(FAIL, 'MOVEMENT_AMP_MISMATCH', 'movement_amp', `${movement} 必须有幅度（none 只属于 static）`, { movement, movement_amp: amp }));
  }
  return found(hits);
}

/**
 * V-14 摄影机数据完整度标注（INFO）。
 *
 * 缺项不判错：它只回答"这一镜的摄影机数据能不能支撑机检"。缺的字段逐个列进 `detail.missing`。
 *
 * @param {{shot:object}} ctx
 */
export function annotateFill(ctx = {}) {
  const shot = ctx.shot ?? {};
  const missing = CAM_FIELDS.filter((k) => {
    const v = shot[k];
    if (Array.isArray(v)) return v.length === 0;
    return isBlank(v) || v === '';
  });
  if (!missing.length) return pass();
  return insufficient('CAM_FILL_INCOMPLETE', 'cam_*', `14 个摄影机字段齐备（缺 ${missing.length} 个）`, { missing });
}

/**
 * V-15 焦段-景别相容（WARN）：特写配广角（`lens_mm<35`）会让人脸变形。
 *
 * `lens_mm=0`（未指定）→ INFO，不判 WARN：没填焦段不等于填错焦段。
 *
 * @param {{shot:object}} ctx
 */
export function checkLensSize(ctx = {}) {
  const shot = ctx.shot ?? {};
  const lens = numOrNull(shot.lens_mm);
  const size = String(shot.shot_size ?? '');
  if (lens === null || lens === 0) {
    return insufficient('LENS_UNSPECIFIED', 'lens_mm', '写明焦段后本规则才可判定', { shot_size: size });
  }
  if (CLOSE_FAMILY.includes(size) && lens < 35) {
    return found([f(WARN, 'LENS_SIZE_MISMATCH', 'lens_mm', `${size} 建议 lens_mm ≥ 35（广角特写会变形）`, { lens_mm: lens, shot_size: size })]);
  }
  return pass();
}

/**
 * V-16 视场角与焦段一致（WARN）：`fov_deg` 与 `2·atan(18/lens)` 的偏差 ≤5%。
 *
 * 两者缺一 → INFO。换算用 35mm 全画幅水平片门 36mm —— 只有一个基准，避免"用哪个画幅"各说一套。
 *
 * @param {{shot:object}} ctx
 */
export function checkFovLens(ctx = {}) {
  const shot = ctx.shot ?? {};
  const lens = numOrNull(shot.lens_mm);
  const fov = numOrNull(shot.fov_deg);
  if (!lens || !fov || lens <= 0 || fov <= 0) {
    return insufficient('FOV_LENS_INCOMPLETE', 'fov_deg', 'fov_deg 与 lens_mm 同时给值才可判定', { lens_mm: lens, fov_deg: fov });
  }
  const expected = (2 * Math.atan((SENSOR_WIDTH_M / 2) / (lens / 1000)) * 180) / Math.PI;
  const dev = Math.abs(fov - expected) / expected;
  if (dev > 0.05) {
    return found([
      f(WARN, 'FOV_LENS_MISMATCH', 'fov_deg', `与 lens_mm=${lens} 对应的水平视场角 ${Math.round(expected * 10) / 10}° 偏差 ≤5%`, {
        fov_deg: fov, expected_deg: Math.round(expected * 10) / 10, deviation: Math.round(dev * 1000) / 1000,
      }),
    ]);
  }
  return pass();
}

/** 主主体：优先取画内、坐标完整、`character_id` 最小的站位（确定性，不按返回顺序） */
function primarySubject(blockings) {
  return toArr(blockings)
    .filter((b) => b && Number(b.in_frame) === 1 && posOf([b.norm_x, b.norm_y, b.norm_z]).complete)
    .slice()
    .sort((a, b) => cmpStr(a.character_id, b.character_id))[0] ?? null;
}

/**
 * V-21 `cam_pos` 与主主体 `norm_xyz` 的换算距离须与 `cam_distance_m` 一致（WARN，±0.05m）。
 *
 * **单位不能混**（D01-02 §4.0 G2）：`cam_pos` 是**米制世界坐标**，`norm_xyz` 是归一化；
 * 换算只走 `active_area`（`norm_x·width_m`、`norm_y·height_m`、`norm_z·depth_m|height_m`）。
 * 缺 `active_area` → INFO（没有换算基准，绝不猜默认尺寸）；缺 `cam_pos`/`cam_distance_m` → INFO。
 *
 * @param {{shot:object, blockings?:Array, sceneState?:object}} ctx
 */
export function checkCamPos(ctx = {}) {
  const shot = ctx.shot ?? {};
  const cam = posOf(shot.cam_pos);
  if (!cam.complete) return insufficient('CAM_POS_UNKNOWN', 'cam_pos', 'cam_pos 三分量齐备才可换算', {});
  const dist = numOrNull(shot.cam_distance_m);
  if (dist === null) return insufficient('CAM_DISTANCE_UNKNOWN', 'cam_distance_m', 'cam_distance_m 有值才可对照', {});
  const aa = activeAreaOf(ctx.sceneState);
  if (!aa) return insufficient('COORD_SYSTEM_INCOMPLETE', 'scene_states.coord_system.active_area', '给出 active_area 实际尺寸后才可做归一化↔米换算', {});
  const subject = primarySubject(ctx.blockings);
  if (!subject) return insufficient('SUBJECT_POS_UNKNOWN', 'shot_blockings.norm_xyz', '主主体坐标齐备才可算距离', {});
  const sx = num(subject.norm_x) * aa.width_m;
  const sy = num(subject.norm_y) * aa.height_m;
  const sz = num(subject.norm_z) * (aa.depth_m ?? aa.height_m);
  const measured = Math.hypot(cam.x - sx, cam.y - sy, cam.z - sz);
  if (Math.abs(measured - dist) > 0.05) {
    return found([
      f(WARN, 'CAM_POS_DISTANCE_MISMATCH', 'cam_distance_m', `与 cam_pos↔主体坐标换算距离（${Math.round(measured * 100) / 100}m）偏差 ≤0.05m`, {
        cam_distance_m: dist,
        measured_m: Math.round(measured * 100) / 100,
        subject_m: [Math.round(sx * 100) / 100, Math.round(sy * 100) / 100, Math.round(sz * 100) / 100],
      }),
    ]);
  }
  return pass();
}

/**
 * S-15 取景半径不足（WARN）。
 *
 * 画面在该距离处的水平可容纳宽度 = `distance · 36mm / lens`；主体占据的水平范围由
 * `norm_x` 极差 × `active_area.width_m` 换算。装不下 → WARN（不是 FAIL：可以改焦段，也可以改站位）。
 *
 * @param {{shot:object, blockings?:Array, sceneState?:object}} ctx
 */
export function checkFraming(ctx = {}) {
  const shot = ctx.shot ?? {};
  const lens = numOrNull(shot.lens_mm);
  const aa = activeAreaOf(ctx.sceneState);
  const inFrame = toArr(ctx.blockings).filter((b) => b && Number(b.in_frame) === 1 && isNum(b.norm_x));
  if (!lens || lens <= 0) return insufficient('LENS_UNSPECIFIED', 'lens_mm', '写明焦段后才可算取景宽度', {});
  if (!aa) return insufficient('COORD_SYSTEM_INCOMPLETE', 'scene_states.coord_system.active_area', '给出 active_area 后才可把归一化坐标换算成米', {});
  if (!inFrame.length) return insufficient('SUBJECT_POS_UNKNOWN', 'shot_blockings.norm_x', '画内人物坐标齐备后才可算主体宽度', {});
  const dist = numOrNull(shot.distance_to_camera ?? inFrame[0].distance_to_camera);
  if (dist === null || dist <= 0) {
    return insufficient('CAM_DISTANCE_UNKNOWN', 'distance_to_camera', '给出到机位距离后才可算取景宽度', {});
  }
  const xs = inFrame.map((b) => num(b.norm_x));
  const spanM = (Math.max(...xs) - Math.min(...xs)) * aa.width_m;
  const frameW = (dist * SENSOR_WIDTH_M) / (lens / 1000);
  if (frameW + 1e-9 < spanM) {
    return found([
      f(WARN, 'FRAMING_TOO_TIGHT', 'distance_to_camera', `该距离/焦段可容纳水平 ${Math.round(frameW * 100) / 100}m，主体占 ${Math.round(spanM * 100) / 100}m`, {
        frame_width_m: Math.round(frameW * 100) / 100, subject_span_m: Math.round(spanM * 100) / 100,
        distance_to_camera: dist, lens_mm: lens,
      }),
    ]);
  }
  return pass();
}

/**
 * S-22 `cam_roll_deg ≠ 0` 但目标机型未声明滚转符号（WARN `ROLL_UNVERIFIED`）。
 *
 * 滚转的正负号在不同机型上相反：`roll_sign_verified=false` 时，"左倾 5°"可能被渲成右倾。
 * 没有 `target_profiles` 信息 → INFO `ROLL_SIGN_UNKNOWN`（数据不足出口，不是 PASS）。
 *
 * @param {{shot:object, targetProfile?:object}} ctx
 */
export function checkRoll(ctx = {}) {
  const shot = ctx.shot ?? {};
  const roll = num(shot.cam_roll_deg);
  if (Math.abs(roll) < 1e-9) return pass();
  const profile = ctx.targetProfile && typeof ctx.targetProfile === 'object' ? ctx.targetProfile : null;
  if (!profile) return insufficient('ROLL_SIGN_UNKNOWN', 'cam_roll_deg', '给出 target_profiles 的 roll_sign_verified 后才可判定滚转方向', { cam_roll_deg: roll });
  if (profile.roll_sign_verified === false) {
    return found([
      f(WARN, 'ROLL_UNVERIFIED', 'cam_roll_deg', 'roll_sign_verified=true 或 cam_roll_deg=0', {
        cam_roll_deg: roll, roll_sign_verified: false,
      }),
    ]);
  }
  return pass();
}

/**
 * S-23 正俯/正仰（`forward ∥ worldUp`）→ INFO `CAM_BASIS_DEGENERATE`：此时 `SCREEN_LR` 无定义。
 *
 * 坐标系约定（D01-04 §3.1 `grid`）：`x` 东西、`y` 南北、`z` 地面→天花板，故 worldUp = (0,0,1)。
 * 缺 `cam_pos`/`cam_target` → 不适用（由 S-07 出口统一报不可验证）。
 *
 * @param {{shot:object}} ctx
 */
export function checkCamBasis(ctx = {}) {
  const shot = ctx.shot ?? {};
  const pos = posOf(shot.cam_pos);
  if (!pos.complete) return notApplicable('缺 cam_pos（S-07 报不可验证）');
  const tgtRaw = shot.cam_target;
  let tgt = null;
  if (typeof tgtRaw === 'string') {
    // 实体 id → 该角色站位坐标（归一化）→ 米；没有 active_area 就不换算，交给 S-07
    const row = toArr(ctx.blockings).find((b) => b && String(b.character_id ?? '') === String(tgtRaw).trim());
    const aa = activeAreaOf(ctx.sceneState);
    if (!row || !aa || !isNum(row.norm_x) || !isNum(row.norm_y)) return notApplicable('cam_target 指向的实体无坐标（S-07 报不可验证）');
    tgt = { x: num(row.norm_x) * aa.width_m, y: num(row.norm_y) * aa.height_m, z: num(row.norm_z) * (aa.depth_m ?? aa.height_m), complete: true };
  } else {
    tgt = posOf(tgtRaw);
  }
  if (!tgt || !tgt.complete) return notApplicable('缺可解析的 cam_target（S-07 报不可验证）');
  const horiz = Math.hypot(tgt.x - pos.x, tgt.y - pos.y);
  if (quant(horiz) <= 0) {
    return insufficient('CAM_BASIS_DEGENERATE', 'cam_pos', '机位前向不得与 worldUp 平行（正俯/正仰）', {
      cam_pos: [pos.x, pos.y, pos.z], cam_target: [tgt.x, tgt.y, tgt.z],
    });
  }
  return pass();
}

export const RULES = [
  { id: 'V-05', level: 'FAIL', title: '景别-内容相容', run: checkSizeContent },
  { id: 'V-06', level: 'WARN', title: '机位配额（章级）', run: checkQuota },
  { id: 'V-07', level: 'WARN', title: '景别重复（连续 3 镜）', run: checkRepeat },
  { id: 'V-08', level: 'WARN', title: '特写比例（章级）', run: checkCloseUpRatio },
  { id: 'V-11', level: 'FAIL', title: '运镜-幅度一致', run: checkMovementAmp },
  { id: 'V-14', level: 'INFO', title: '摄影机数据完整度标注', run: annotateFill },
  { id: 'V-15', level: 'WARN', title: '焦段-景别相容', run: checkLensSize },
  { id: 'V-16', level: 'WARN', title: '视场角与焦段一致', run: checkFovLens },
  { id: 'V-21', level: 'WARN', title: 'cam_pos 与主体坐标换算一致', run: checkCamPos },
  { id: 'S-15', level: 'WARN', title: '取景半径不足', run: checkFraming },
  { id: 'S-22', level: 'WARN', title: '滚转符号未验证', run: checkRoll },
  { id: 'S-23', level: 'INFO', title: '正俯/正仰导致机位基退化', run: checkCamBasis },
];

/** 判定"该距离能否装下该主体"的纯函数版（供测试与 S-15 复用同一算式） */
export const frameWidthAt = (distance_m, lens_mm) => (num(distance_m) * SENSOR_WIDTH_M) / (num(lens_mm) / 1000);

/** 主主体导出（供 A-06 等跨镜规则挑"主体"时复用同一口径） */
export { primarySubject };
