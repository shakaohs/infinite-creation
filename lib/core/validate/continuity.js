// 连续性规则（P5）—— S-05～S-14、S-18～S-21、V-17、V-18
//
// 这一层有一个前提必须写在最前面：**跨镜状态由求解器算**（P6），P5 不重新求解。
// 所以 S-08～S-12、S-14 的判定输入是 `shot_states.conflicts`（求解器已经把"哪一镜哪个人跳了"写成
// 结构化条目），P5 的活是"把每条冲突归到正确的规则编号上"，而不是自己再算一遍跳变。
// 自己再算一遍的后果是：两套阈值（求解器 0.5m、QC 0.3m）同时存在，同一镜会被判两次、两次还可能相反。
//
// 轴线判定同样只用**可判定**的量：`axis_lock.axis_line` + `cam_pos`。缺一项就走 S-07 的
// `AXIS_UNVERIFIED` 出口 —— 缺数据时"看起来没问题"是假象，不能当 PASS。
//
// S-07 承担**两个**诊断（D02-06 §4.8.1 + §6.4），但只产出**一条**结果（§8.5.2 QL-1）：
//   · 轴锁本身不完整（`axis_lock` 缺失，或有 `pair/left/right` 但没有**合法** `axis_line`）→
//     `AXIS_LOCK_INCOMPLETE`（WARN）。这是"场次基线写得不全"，是**可修的缺陷**，不是"数据不足"；
//   · 轴线/机位/尺寸不足导致判不了 → `AXIS_UNVERIFIED` / `SCREEN_LR_UNVERIFIED`（INFO，数据不足）。
// 两者可以同时成立（缺 `axis_line` 必然同时导致不可验证）。聚合层按 QL-1 取最高档，
// 因此那一条 `level='warn'`、`code='AXIS_LOCK_INCOMPLETE'`，而两条 INFO 作为**字段级命中**
// 保留在同一条的 `detail.items[]` 里 —— 既没有丢掉"不可验证"的证据，也没有多出第二条 S-07。
import { cmpStr } from '../hash/cmp-str.js';
import {
  FAIL, WARN, INFO, f, found, insufficient, notApplicable, pass,
  activeAreaOf, axisLineOf, dist2, isNum, num, posOf, quant, rectOf, sideOf, toArr, toObj, fixturesOf, inRect,
} from './common.js';

/** 轴线判定所需的三项（缺任一 → S-07 报不可验证） */
export const AXIS_INPUTS = Object.freeze(['scene_states.axis_lock.axis_line', 'cam_pos', 'cam_target']);

/** 冲突码 → 规则编号（求解器写 `conflicts[].code`，P5 只做归属，不重算） */
export const CONFLICT_ROUTE = Object.freeze({
  POSITION_JUMP: 'S-08',
  TELEPORT: 'S-08',
  POSTURE_JUMP: 'S-09',
  HAND_JUMP: 'S-10',
  PROP_APPEAR: 'S-11',
  PROP_REVIVE: 'S-12',
  CHAR_POP: 'S-14',
});

/** 本镜求解冲突（数组） */
function conflictsOf(shotState) {
  return toArr(shotState?.conflicts).filter((c) => c && typeof c === 'object');
}

/** 该镜状态是否可判（`state_in` / `state_out` 都非空） */
function stateKnown(shotState) {
  const st = shotState && typeof shotState === 'object' ? shotState : null;
  if (!st) return false;
  return ['state_in', 'state_out'].every((k) => {
    const v = toObj(st[k]);
    return Object.keys(v).length > 0;
  });
}

/**
 * 把冲突码归到某条规则上；无该码的冲突 → PASS；状态未知 → INFO。
 * 五个跳变类规则共用这一段（**只此一份**，避免各自的"未知出口"写法不一致）。
 */
function conflictRule(shotState, codes, field, expected) {
  const list = conflictsOf(shotState);
  const mine = list.filter((c) => codes.includes(String(c.code ?? '')));
  if (mine.length) {
    return found(mine.map((c) => f(FAIL, String(c.code ?? codes[0]), field, expected, {
      character_id: String(c.character_id ?? c.actor_id ?? ''),
      prop_id: String(c.prop_id ?? ''),
      detail: String(c.detail ?? c.message ?? ''),
      rel: 'known',
    })));
  }
  if (!stateKnown(shotState)) {
    return insufficient('STATE_UNKNOWN', 'shot_states.state_in/state_out', '求解器给出首尾状态后才可判跳变', { rel: 'unknown' });
  }
  return pass();
}

/**
 * S-05 越轴（`AXIS_SIDE` 换侧 **且** `SCREEN_LR` 翻转，且无 `cross_allowed`）→ FAIL `LEFT_RIGHT_FLIP`。
 *
 * 判定链（每一步都只用可判定的量）：
 *  ① `cam_pos` 是**米制**、`axis_line`/`norm_*` 是**归一化** → 先用 `active_area` 把机位换到归一化平面；
 *  ② `sideCam = side(axis_line, camNorm)`，`sideChar = side(axis_line, 角色坐标)`；两者不同 = 换侧；
 *  ③ 画面左右 = 以机位前向为基准的 2D 叉积，比较 `axis_lock.left/right` 声明的物理左右在屏幕上是否反了；
 *  ④ `cross_allowed` 里覆盖本镜 → 合法。
 *
 * 缺 `axis_line`/`cam_pos`/`active_area` → 不适用（S-07 报 `AXIS_UNVERIFIED`）；
 * 换侧但 `cam_target` 不可解析（P-B 半完整）→ 不适用（S-06 报 INFO，**不判 FAIL**）。
 *
 * @param {{shot:object, blockings?:Array, sceneState?:object, prevShot?:object}} ctx
 */
export function checkAxis(ctx = {}) {
  const geo = axisGeometry(ctx);
  if (geo.na) return notApplicable(geo.na);
  if (geo.allowed || !geo.crossed) return pass();
  if (!geo.flippedKnown) return notApplicable('机位换侧，但 cam_target 不可解析 → 只能判换侧，不能判画面左右（P-B，S-06 报 INFO）');
  if (!geo.flipped) return notApplicable('换侧但画面左右未翻转（S-06 覆盖）');
  return found([f(FAIL, 'LEFT_RIGHT_FLIP', 'scene_states.axis_lock', '越轴必须显式声明 cross_allowed(type + reason)', {
    camera_side: geo.camSide, character_side: geo.charSide, character_id: geo.charId,
    declared_left: geo.left, declared_right: geo.right,
    cross_allowed: geo.crossAllowed.map((c) => String(c?.type ?? '')),
  })]);
}

/**
 * S-06 `AXIS_SIDE` 换侧但 `SCREEN_LR` 未翻转（INFO `AXIS_CROSS_SOFT`）。
 *
 * 不是错：观众看到的左右关系没变，只是机位与轴线的关系变了。记 INFO 供人工复核。
 * 换侧但 `cam_target` 不可解析时也走这条（`detail.lr_unverified=true`）——**不可验证不是通过**。
 *
 * @param {{shot:object, blockings?:Array, sceneState?:object, prevShot?:object}} ctx
 */
export function checkAxisSoft(ctx = {}) {
  const geo = axisGeometry(ctx);
  if (geo.na) return notApplicable(geo.na);
  if (geo.allowed || !geo.crossed) return pass();
  if (geo.flippedKnown && geo.flipped) return pass(); // 真正的越轴由 S-05 判
  return found([f(INFO, 'AXIS_CROSS_SOFT', 'scene_states.axis_lock', '换侧但未翻转：确认不是误置机位', {
    camera_side: geo.camSide, character_side: geo.charSide, character_id: geo.charId,
    lr_unverified: !geo.flippedKnown,
  })]);
}

/**
 * 轴锁缺口：`null` = `axis_lock` 与 `axis_line` 都完整可用；否则返回诊断 detail。
 *
 * 只判"能不能用"，**不补默认值、不从画面左右反推物理左右**（D01-04 §5.4）：
 * `pair/left/right` 齐全但没有 `axis_line` 时，轴线方向依然是未知的，
 * 用它去推"谁在物理左边"= 拿画面里看到的左右当空间事实。
 *
 * 四种缺口分开记（`source`），便于 LLM 与人工分别修：
 *  · `scene_state_missing` —— 连 `scene_states` 行都没传进来（P2 已在写入期拦，出现在这里即数据缺陷）；
 *  · `axis_lock_missing`  —— 有场次行但 `axis_lock` 缺失/空对象；
 *  · `axis_line_absent`   —— `axis_lock` 有其它键，但 `axis_line` 没给；
 *  · `axis_line_malformed`—— `axis_line` 给了但不合法（不是两点 / 分量非有限数 / 两点重合）。
 *
 * @param {object|null} sceneState
 * @returns {{source:string, missing:string[], axis_lock:string, axis_line:string}|null}
 */
function axisLockGap(sceneState) {
  if (!sceneState || typeof sceneState !== 'object' || Array.isArray(sceneState)) {
    return { source: 'scene_state_missing', missing: ['scene_states'], axis_lock: 'absent', axis_line: 'absent' };
  }
  const rank = Object.keys(toObj(sceneState.axis_lock)).length > 0 ? 'present' : 'absent';
  if (rank === 'absent') {
    return { source: 'axis_lock_missing', missing: ['scene_states.axis_lock'], axis_lock: 'absent', axis_line: 'absent' };
  }
  // **唯一**的"合法轴线"判据就是 `axisLineOf`（common.js），此处不另写一套
  if (axisLineOf(sceneState)) return null;
  const raw = toObj(sceneState.axis_lock).axis_line;
  const absent = raw === undefined || raw === null || raw === ''
    || (Array.isArray(raw) && raw.length === 0);
  return {
    source: absent ? 'axis_line_absent' : 'axis_line_malformed',
    missing: ['scene_states.axis_lock.axis_line'],
    axis_lock: 'present',
    axis_line: absent ? 'absent' : 'malformed',
  };
}

/**
 * S-07 轴锁不完整 / 轴线不可验证（`AXIS_LOCK_INCOMPLETE` WARN + 两条 INFO）。
 *
 * 两个检测器分开报（D01-02 §4.6 P-A~P-D 表）：
 *  · `AXIS_UNVERIFIED`：缺 `axis_line` / `cam_pos` / `active_area` 任一项，侧别算不出来；
 *  · `SCREEN_LR_UNVERIFIED`：再加 `cam_target` 不可解析，画面左右算不出来。
 * 这是"数据不足"的**唯一出口**：其它规则遇到缺机位数据时不得自行判 PASS。
 *
 * 另有 §4.8.1 的 `AXIS_LOCK_INCOMPLETE`（WARN）：轴锁写得不全（**允许落库**，但要告警），
 * 与上面两条 INFO 同属这一条规则结果（QL-1），由 `toEntry` 取最高档聚合成一条。
 *
 * @param {{shot:object, sceneState?:object, blockings?:Array}} ctx
 */
export function checkAxisVerifiable(ctx = {}) {
  const aa = activeAreaOf(ctx.sceneState);
  const line = axisLineOf(ctx.sceneState);
  const cam = posOf(ctx.shot?.cam_pos);
  const axisMissing = [];
  if (!line) axisMissing.push('scene_states.axis_lock.axis_line');
  if (!cam.complete) axisMissing.push('cam_pos');
  if (!aa) axisMissing.push('scene_states.coord_system.active_area');
  const tgt = resolveTargetNorm(ctx, aa);
  const lrMissing = [...axisMissing];
  if (!tgt) lrMissing.push('cam_target');
  const hits = [];
  // 轴锁缺口排在最前：它档位最高，是这一条结果的主因（`code`/`field`/`expected` 取它）
  const gap = axisLockGap(ctx.sceneState);
  if (gap) {
    hits.push(f(WARN, 'AXIS_LOCK_INCOMPLETE', 'scene_states.axis_lock.axis_line', 'axis_lock 给出归一化平面上的两个不同点作为 axis_line（pair/left/right 不能替代轴线）', gap));
  }
  if (axisMissing.length) {
    hits.push(f(INFO, 'AXIS_UNVERIFIED', 'scene_states.axis_lock.axis_line', `补齐 ${axisMissing.join(' / ')} 后才可判越轴`, { missing: axisMissing }));
  }
  if (lrMissing.length) {
    hits.push(f(INFO, 'SCREEN_LR_UNVERIFIED', 'cam_pos', `补齐 ${lrMissing.join(' / ')} 后才可判画面左右`, { missing: lrMissing }));
  }
  return found(hits);
}

/**
 * 把 `cam_target` 解析成**归一化平面坐标**。
 *
 * D01-02 §4.0 G3 允许两种写法：实体 id（取其 `anchor_point` —— 这里用该角色站位行的 `norm_x/y`）
 * 或 `{x,y,z}`（米制，按 `active_area` 换算）。解析不出来就返回 `null`，由 S-07 报不可验证。
 */
function resolveTargetNorm(ctx, aa) {
  const raw = ctx.shot?.cam_target;
  if (typeof raw === 'string') {
    const id = raw.trim();
    if (!id) return null;
    const row = toArr(ctx.blockings).find((b) => b && String(b.character_id ?? '') === id);
    if (row && isNum(row.norm_x) && isNum(row.norm_y)) {
      return { x: num(row.norm_x), y: num(row.norm_y), src: 'blocking' };
    }
    return null;
  }
  const p = posOf(raw);
  if (p.complete && aa) return { x: p.x / aa.width_m, y: p.y / aa.height_m, z: p.z, src: 'coords' };
  return null;
}

/** 轴线几何：换侧 / 翻转 / 是否被白名单放行；`na` 表示输入不足 */
function axisGeometry(ctx) {
  const line = axisLineOf(ctx.sceneState);
  if (!line) return { na: '缺 axis_line（S-07 报不可验证）' };
  const aa = activeAreaOf(ctx.sceneState);
  if (!aa) return { na: '缺 active_area：米制 cam_pos 无法换到归一化平面（S-07 报不可验证）' };
  const camM = posOf(ctx.shot?.cam_pos);
  if (!camM.complete) return { na: '缺 cam_pos（S-07 报不可验证）' };
  const rows = toArr(ctx.blockings).filter((b) => b && Number(b.in_frame) === 1 && isNum(b.norm_x) && isNum(b.norm_y));
  if (!rows.length) return { na: '本镜没有画内人物坐标' };

  const camNorm = { x: camM.x / aa.width_m, y: camM.y / aa.height_m };
  const lock = line.lock ?? {};
  const pair = toArr(lock.pair).map((x) => String(x ?? ''));
  const focus = rows.filter((b) => pair.length === 0 || pair.includes(String(b.character_id ?? '')));
  const subject = (focus.length ? focus : rows).slice().sort((a, b) => cmpStr(a.character_id, b.character_id))[0];
  const charNorm = { x: num(subject.norm_x), y: num(subject.norm_y) };

  const camSide = sideOf(line, camNorm);
  const charSide = sideOf(line, charNorm);
  const crossed = camSide !== 0 && charSide !== 0 && camSide !== charSide;

  const tgtNorm = resolveTargetNorm(ctx, aa);
  const declaredLeft = String(lock.left ?? pair[0] ?? '');
  const declaredRight = String(lock.right ?? pair[1] ?? '');
  const normOf = (id) => {
    const b = rows.find((r) => String(r.character_id ?? '') === id);
    return b ? { x: num(b.norm_x), y: num(b.norm_y) } : null;
  };
  const screenX = (pos) => {
    if (!tgtNorm || !pos) return null;
    const fx = tgtNorm.x - camNorm.x;
    const fy = tgtNorm.y - camNorm.y;
    return fx * (pos.y - camNorm.y) - fy * (pos.x - camNorm.x);
  };
  const lp = normOf(declaredLeft);
  const rp = normOf(declaredRight);
  const sl = screenX(lp);
  const sr = screenX(rp);
  const flippedKnown = sl !== null && sr !== null && sl !== sr;
  const flipped = flippedKnown && sl > sr;

  const crossAllowed = toArr(lock.cross_allowed).filter((c) => c && typeof c === 'object');
  const shotId = String(ctx.shot?.id ?? '');
  const prevId = String(ctx.prevShot?.id ?? '');
  const allowed = crossAllowed.some((c) => {
    const after = String(c.after_shot ?? '');
    // `after_shot` 空 = 全章放行；给定则对本镜或其前一镜之后生效
    return !after || after === shotId || after === prevId;
  });

  return {
    camSide, charSide, crossed, flippedKnown, flipped, allowed,
    charId: String(subject.character_id ?? ''),
    left: declaredLeft, right: declaredRight, crossAllowed,
  };
}

/**
 * S-08 位置跳变（FAIL `POSITION_JUMP` / `TELEPORT`）：来自求解器 `conflicts`。
 *
 * @param {{shotState?:object}} ctx
 */
export function checkPositionJump(ctx = {}) {
  return conflictRule(ctx.shotState, ['POSITION_JUMP', 'TELEPORT'], 'shot_states.conflicts', '相邻镜同一角色位置连续（或由动作覆盖）');
}

/**
 * S-09 姿态跳变（FAIL `POSTURE_JUMP`）。
 * @param {{shotState?:object}} ctx
 */
export function checkPostureJump(ctx = {}) {
  return conflictRule(ctx.shotState, ['POSTURE_JUMP'], 'shot_states.conflicts', '相邻镜姿态连续（或由动作覆盖）');
}

/**
 * S-10 手位跳变（FAIL `HAND_JUMP`）。
 * @param {{shotState?:object}} ctx
 */
export function checkHandJump(ctx = {}) {
  return conflictRule(ctx.shotState, ['HAND_JUMP'], 'shot_states.conflicts', '相邻镜手位连续（或由动作覆盖）');
}

/**
 * S-11 道具凭空出现（FAIL `PROP_APPEAR`）。
 * @param {{shotState?:object}} ctx
 */
export function checkPropAppear(ctx = {}) {
  return conflictRule(ctx.shotState, ['PROP_APPEAR'], 'shot_states.conflicts', '道具必须先被带入或已在场');
}

/**
 * S-12 道具复活（FAIL `PROP_REVIVE`）。
 * @param {{shotState?:object}} ctx
 */
export function checkPropRevive(ctx = {}) {
  return conflictRule(ctx.shotState, ['PROP_REVIVE'], 'shot_states.conflicts', '已 consumed/broken 的道具不得复活');
}

/**
 * S-13 服装跳变（FAIL `COSTUME_JUMP`）。
 *
 * 比对"本镜 costume 资产集合"与"上镜 costume 资产集合"。没有上镜对照 / 本镜无 costume 行 → 不适用。
 * 剧情内换装可显式放行：`ctx.costumeChangeAllowed === true`（对应 `cross_allowed` 的白名单精神）。
 *
 * @param {{shotAssets?:Array, prevShotAssets?:Array, costumeChangeAllowed?:boolean}} ctx
 */
export function checkCostume(ctx = {}) {
  const cur = toArr(ctx.shotAssets).filter((a) => String(a?.role ?? '') === 'costume').map((a) => String(a.asset_id ?? '')).sort(cmpStr);
  if (!cur.length) return notApplicable('本镜没有 costume 资产行');
  const prev = toArr(ctx.prevShotAssets).filter((a) => String(a?.role ?? '') === 'costume').map((a) => String(a.asset_id ?? '')).sort(cmpStr);
  if (!prev.length) return notApplicable('没有上镜 costume 对照，无法判断是否跳变');
  if (ctx.costumeChangeAllowed === true) return pass();
  if (cur.join('|') === prev.join('|')) return pass();
  return found([f(FAIL, 'COSTUME_JUMP', 'shot_assets(role=costume)', '相邻镜服装一致（或显式声明换装）', { prev, current: cur })]);
}

/**
 * S-14 画内/画外矛盾（FAIL `CHAR_POP`）。
 * @param {{shotState?:object}} ctx
 */
export function checkCharPop(ctx = {}) {
  return conflictRule(ctx.shotState, ['CHAR_POP'], 'shot_states.conflicts', '画内/画外必须与状态一致（不得凭空出现/消失）');
}

/**
 * S-18 `position_track` 首尾必须等于 `state_in` / `state_out` 的该角色位置（FAIL，±0.02）。
 *
 * @param {{blockings?:Array, shotState?:object}} ctx
 */
export function checkTrackEnds(ctx = {}) {
  const rows = toArr(ctx.blockings).filter((b) => b && toArr(b.position_track).length > 0);
  if (!rows.length) return notApplicable('本镜没有 position_track');
  const st = ctx.shotState && typeof ctx.shotState === 'object' ? ctx.shotState : null;
  if (!st) return insufficient('STATE_UNKNOWN', 'shot_states', '求解器给出首尾状态后才可核对轨迹端点', { rel: 'unknown' });
  const charsIn = toObj(toObj(st.state_in).chars);
  const charsOut = toObj(toObj(st.state_out).chars);
  const hits = [];
  for (const b of rows) {
    const id = String(b.character_id ?? '');
    const track = toArr(b.position_track).map((p) => posOf(p));
    const first = track[0];
    const last = track[track.length - 1];
    const inPos = posOf(toObj(charsIn[id]).pos);
    const outPos = posOf(toObj(charsOut[id]).pos);
    if (!inPos.complete || !outPos.complete) {
      hits.push(f(INFO, 'STATE_UNKNOWN', `shot_states.chars.${id}.pos`, '首尾状态齐备后才可核对轨迹端点', { character_id: id, rel: 'unknown' }));
      continue;
    }
    for (const [label, a, b2] of [['track[0]', first, inPos], ['track[last]', last, outPos]]) {
      const d = Math.max(Math.abs(a.x - b2.x), Math.abs(a.y - b2.y));
      if (quant(d) > 0.02) {
        hits.push(f(FAIL, 'TRACK_ENDS_MISMATCH', `shot_blockings(${id}).position_track`, `${label} 等于 state_${label === 'track[0]' ? 'in' : 'out'}.chars.${id}.pos（±0.02）`, {
          character_id: id, point: label, track_pos: [a.x, a.y, a.z], state_pos: [b2.x, b2.y, b2.z], delta: Math.round(d * 1000) / 1000,
        }));
      }
    }
  }
  return found(hits);
}

/**
 * S-19 `track` 相邻点跳变（>0.15）且中间没有 locomotion 动作覆盖（FAIL `TRACK_JUMP`）。
 *
 * @param {{blockings?:Array, actions?:Array}} ctx
 */
export function checkTrackJump(ctx = {}) {
  const rows = toArr(ctx.blockings).filter((b) => b && toArr(b.position_track).length > 1);
  if (!rows.length) return notApplicable('本镜没有 position_track');
  const loco = toArr(ctx.actions).filter((a) => a && String(a.action_type ?? '') === 'locomotion');
  const hits = [];
  for (const b of rows) {
    const id = String(b.character_id ?? '');
    const pts = toArr(b.position_track).map((p) => ({ ...posOf(p), t: p?.t === undefined ? null : quant(Number(p.t)) }));
    for (let i = 1; i < pts.length; i += 1) {
      const d = dist2(pts[i - 1], pts[i]);
      if (d === null || quant(d) <= 0.15) continue;
      const covered = loco.some((a) => {
        const actor = String(a.actor_id ?? '');
        if (actor && actor !== id) return false;
        const from = quant(Number(a.t_from ?? 0));
        const to = quant(Number(a.t_to ?? 0));
        const t0 = pts[i - 1].t;
        const t1 = pts[i].t;
        if (t0 === null || t1 === null) return true; // 没有时间戳时，只要该角色有 locomotion 就算覆盖
        return Math.min(to, t1) > Math.max(from, t0) || (from <= t0 && to >= t1);
      });
      if (!covered) {
        hits.push(f(FAIL, 'TRACK_JUMP', `shot_blockings(${id}).position_track`, '相邻点跳变 >0.15 必须有 locomotion 动作覆盖', {
          character_id: id, segment: [i - 1, i], distance: Math.round(d * 1000) / 1000,
        }));
      }
    }
  }
  return found(hits);
}

/**
 * V-17 空间冲突（FAIL）：画内人物站在**不可交互的硬障碍**里。
 *
 * "可交互"= `can_lean` / `can_place` / `light_source` 任一为真（能靠、能放、是光源位），
 * 这类 zone 允许人在其中（床上、柜边、窗边）。全都没有的 fixtures 视为障碍物，人站进去就是穿模。
 *
 * @param {{blockings?:Array, sceneState?:object}} ctx
 */
export function checkSpatialConflict(ctx = {}) {
  const fixtures = fixturesOf(ctx.sceneState).map((fx) => ({ fx, rect: rectOf(fx.zone) })).filter((z) => z.rect);
  if (!fixtures.length) return insufficient('COORD_SYSTEM_INCOMPLETE', 'scene_states.fixtures[].zone', 'fixtures 给出 zone 后才可判空间冲突', {});
  const rows = toArr(ctx.blockings).filter((b) => b && Number(b.in_frame) === 1 && isNum(b.norm_x) && isNum(b.norm_y));
  if (!rows.length) return notApplicable('本镜没有画内人物坐标');
  const hits = [];
  for (const b of rows) {
    const pt = posOf([b.norm_x, b.norm_y, b.norm_z]);
    for (const { fx, rect } of fixtures) {
      const interactive = fx.can_lean === true || fx.can_place === true || fx.light_source === true || fx.movable === true;
      if (interactive) continue;
      if (inRect(pt, rect)) {
        hits.push(f(FAIL, 'SPATIAL_CONFLICT', `shot_blockings(${String(b.character_id ?? '')}).norm_x`, `不得站在障碍物 ${fx.id ?? '?'} 的 zone 内`, {
          character_id: String(b.character_id ?? ''), fixture_id: String(fx.id ?? ''), fixture_name: String(fx.name ?? ''),
        }));
      }
    }
  }
  return found(hits);
}

/**
 * V-18 状态断裂（FAIL `STATE_BREAK`）：求解器给出的冲突里出现任何跳变码。
 *
 * 与 S-08～S-14 的分工：本条是**汇总口径**（任意断裂都算断裂），那六条是**归因口径**
 * （具体是哪一类）。同一冲突会同时出现在两处，这是有意为之：报告要能一眼看出"这一镜有断裂"，
 * 也要能定位到"是位置还是姿态"。
 *
 * @param {{shotState?:object}} ctx
 */
export function checkStateBreak(ctx = {}) {
  const list = conflictsOf(ctx.shotState);
  if (!list.length) {
    if (!stateKnown(ctx.shotState)) {
      return insufficient('STATE_UNKNOWN', 'shot_states.state_in/state_out', '求解器给出首尾状态后才可判状态断裂', { rel: 'unknown' });
    }
    return pass();
  }
  return found(list.map((c) => f(FAIL, 'STATE_BREAK', 'shot_states.conflicts', '相邻镜状态连续（无断裂）', {
    code: String(c.code ?? ''), character_id: String(c.character_id ?? ''), prop_id: String(c.prop_id ?? ''),
  })));
}

/**
 * S-20 **对任何 `unknown` 字段产出 FAIL**（QC 自身约束，反向断言）。
 *
 * 扫其它规则的命中：`level='fail'` 且 `detail.rel='unknown'` → 这是 QC 的 bug，不是创作的错。
 * 正常情况下恒 PASS；测试断言"0 命中"。
 *
 * @param {{__audit?:Array}} ctx
 */
export function checkNoFailOnUnknown(ctx = {}) {
  const hits = [];
  for (const item of toArr(ctx.__audit)) {
    if (!item || item.level !== FAIL) continue;
    if (String(item?.detail?.rel ?? '') !== 'unknown') continue;
    hits.push(f(FAIL, 'QC_UNKNOWN_AS_KNOWN', item.field, 'unknown 字段不得产出 FAIL（S-20）', {
      rule_id: String(item.rule_id ?? ''), code: String(item.code ?? ''),
    }));
  }
  return found(hits);
}

/**
 * S-21 **对任何 `inferred` 字段产出 FAIL**（QC 自身约束，反向断言；只可 WARN `INCONSISTENT_INFERRED`）。
 *
 * @param {{__audit?:Array}} ctx
 */
export function checkNoFailOnInferred(ctx = {}) {
  const hits = [];
  for (const item of toArr(ctx.__audit)) {
    if (!item || item.level !== FAIL) continue;
    if (String(item?.detail?.rel ?? '') !== 'inferred') continue;
    hits.push(f(FAIL, 'QC_INFERRED_AS_FAIL', item.field, 'inferred 字段不得产出 FAIL，只可 WARN（S-21）', {
      rule_id: String(item.rule_id ?? ''), code: String(item.code ?? ''),
    }));
  }
  return found(hits);
}

export const RULES = [
  { id: 'S-05', level: 'FAIL', title: '越轴（换侧 + 左右翻转）', run: checkAxis },
  { id: 'S-06', level: 'INFO', title: '换侧但未翻转（软跨轴）', run: checkAxisSoft },
  // 基准档位仍按 D01 的 S-07 = INFO；轴锁不完整的 WARN 是 §4.8.1 挂在本条上的加重档，
  // 只在真的缺 `axis_line` 时出现（QL-1 逐字段取最高档），不改 D01 的档位表
  { id: 'S-07', level: 'INFO', title: '轴线不可验证 / 轴锁不完整', run: checkAxisVerifiable },
  { id: 'S-08', level: 'FAIL', title: '位置跳变', run: checkPositionJump },
  { id: 'S-09', level: 'FAIL', title: '姿态跳变', run: checkPostureJump },
  { id: 'S-10', level: 'FAIL', title: '手位跳变', run: checkHandJump },
  { id: 'S-11', level: 'FAIL', title: '道具凭空出现', run: checkPropAppear },
  { id: 'S-12', level: 'FAIL', title: '道具复活', run: checkPropRevive },
  { id: 'S-13', level: 'FAIL', title: '服装跳变', run: checkCostume },
  { id: 'S-14', level: 'FAIL', title: '画内/画外矛盾', run: checkCharPop },
  { id: 'S-18', level: 'FAIL', title: 'track 首尾与状态不符', run: checkTrackEnds },
  { id: 'S-19', level: 'FAIL', title: 'track 相邻点跳变无动作', run: checkTrackJump },
  { id: 'S-20', level: 'FAIL', title: '不得对 unknown 判 FAIL（QC 自身）', run: checkNoFailOnUnknown },
  { id: 'S-21', level: 'FAIL', title: '不得对 inferred 判 FAIL（QC 自身）', run: checkNoFailOnInferred },
  { id: 'V-17', level: 'FAIL', title: '空间冲突（站位穿障碍）', run: checkSpatialConflict },
  { id: 'V-18', level: 'FAIL', title: '状态断裂', run: checkStateBreak },
];
