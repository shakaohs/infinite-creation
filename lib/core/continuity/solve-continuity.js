// 连续性求解器（P6 · D01-06 §2.1 / D01-04 §5.5 Step 1–6 / D02-06 §7.2–§7.10）
//
// 边界（违反任一条即返工，见 §7.8.5）：
//   · **纯函数**：不读库、不写库、不读时钟、不读 `process.env`（L-3/SH-5）；
//   · **只处理一个场次**：跨场不串状态（ORD-3），调用方只传同一 `scene_key` 的镜；
//   · **不改创作数据**：只产出 `states`，绝不回写 `story_shots` / `shot_blockings`（§7.9）；
//   · **不吞错**：内部异常一律抛 `CONTINUITY_SOLVER_FAILED`，绝不返回空 `states`（§7.9）。
//
// 三值逻辑是这一层的核心（D01-04 §5.4）：`known` / `inferred` / `unknown` / `not_applicable`。
// `inferred` 只能 WARN、`unknown` 既不 PASS 也不 FAIL —— 用未知去判创作者有罪，是最贵的一类 bug：
// 它逼人把"不知道"填成猜测值来消红灯。
import { cmpStr } from '../hash/cmp-str.js';
import { posRel } from './pos-rel.js';
import { solverInputHash, normalizeShotMeta, SOLVE_META_FIELDS, SOLVER_VERSION } from './solve-hash.js';
import { solveError as fail } from './solver-error.js';
import { assertSolverInput, assertAnnotationOnly } from './solver-input.js';

/** 位置跳变下限（归一化，D01-04 §5.5 Step 3） */
export const POS_JUMP_MIN = 0.15;
/** 瞬移下限 */
export const TELEPORT_MIN = 1.5;
/** 轨迹端点容差（与 P5 S-18 同口径） */
export const TRACK_TOL = 0.02;
/** 可靠性 → 置信度初值（D01-04 §5.7 步 0：manual known 0.95 / ai inferred 0.40） */
export const REL_CONF = Object.freeze({ known: 0.95, inferred: 0.4, unknown: 0 });
/** 沿用上镜时的衰减系数（D01-04 §5.7：0.95×0.9 = 0.855） */
export const CARRY_DECAY = 0.9;
/** 时间量子 */
const TQ = 0.001;
const quant = (x) => Math.round(Number(x) * 1000) / 1000;

/** 断裂类冲突码（P5 的 `CONFLICT_ROUTE` 只认这七个 → 必须只有它们进 `conflicts`） */
export const BREAK_CODES = Object.freeze([
  'CHAR_POP', 'POSITION_JUMP', 'TELEPORT', 'POSTURE_JUMP', 'HAND_JUMP', 'PROP_APPEAR', 'PROP_REVIVE',
]);

const arr = (v) => {
  if (Array.isArray(v)) return v;
  if (typeof v !== 'string' || !v.trim()) return [];
  try { const x = JSON.parse(v); return Array.isArray(x) ? x : []; } catch { return []; }
};
const obj = (v) => {
  if (v && typeof v === 'object' && !Array.isArray(v)) return v;
  if (typeof v !== 'string' || !v.trim()) return {};
  try { const x = JSON.parse(v); return x && typeof x === 'object' && !Array.isArray(x) ? x : {}; } catch { return {}; }
};
const num = (v) => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Number(v) : null);
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const clone = (v) => (v === null || typeof v !== 'object' ? v : JSON.parse(JSON.stringify(v)));

// `fail` 由 `solver-error.js` 提供（唯一一份错误工厂），此处保留同名以便调用点不变。

/** 值的可靠性：有值 + `manual` → known，有值 + 其它来源 → inferred，无值 → unknown */
function relOfValue(v, specSource) {
  if (v === null || v === undefined || v === '') return 'unknown';
  return specSource === 'manual' ? 'known' : 'inferred';
}

/** 动作区间（量化） */
function intervalOf(a) {
  const from = quant(num(a?.t_from) ?? 0);
  const to = quant(num(a?.t_to) ?? from);
  return { from, to };
}

/**
 * 场次基线（D01-04 §5.5 Step 1）：`axis_lock` + 首镜 `shot_blockings`。
 *
 * 三者都缺 → 该字段 `unknown`，**绝不编造**（§7.4）：
 *  · `axis_lock.left/right` → `chars.<id>.pos_rel` 的左右归属；
 *  · 首镜 `position_abs` → `pos` 的方位线索（本实现记进 `pos_abs`，供后续比对）；
 *  · 首镜 `norm_*` 三分量齐 → `pos`（可靠性按 `posRel` 五级判定）。
 */
function sceneBaseline(sceneState, shot) {
  const lock = obj(sceneState?.axis_lock);
  const left = String(lock.left ?? '');
  const right = String(lock.right ?? '');
  const specSource = String(shot?.spec_source ?? '');
  const chars = {};
  const meta = {};
  for (const b of arr(shot?.blockings).filter((x) => x && typeof x === 'object')) {
    const id = String(b.character_id ?? '');
    if (!id) continue;
    const x = isNum(b.norm_x) ? b.norm_x : null;
    const y = isNum(b.norm_y) ? b.norm_y : null;
    const z = isNum(b.norm_z) ? b.norm_z : null;
    const rel = posRel({ x, y, z, specSource });
    chars[id] = {
      in_frame: Number(b.in_frame) === 1 ? 1 : 0,
      pos: rel === 'unknown' || rel === 'not_applicable' ? null : [x, y, z],
      pos_rel: id === left ? 'left' : id === right ? 'right' : '',
      pos_abs: String(b.position_abs ?? ''),
      posture: b.posture ?? null,
      facing: b.facing ?? null,
      hand: b.hand_state ?? null,
      gaze: b.gaze_target ?? null,
    };
    meta[`chars.${id}.pos`] = { rel, src: 'scene_baseline', conf: rel === 'known' ? 1 : 0.5, ver: 0 };
    for (const k of ['posture', 'facing', 'hand', 'gaze']) {
      const field = k === 'hand' ? 'hand' : k === 'gaze' ? 'gaze' : k;
      meta[`chars.${id}.${field}`] = { rel: relOfValue(chars[id][field], specSource), src: 'scene_baseline', conf: 1, ver: 0 };
    }
  }
  return { state: { chars, props: {}, env: { time_of_day: sceneState?.time_of_day ?? null } }, meta };
}

/** 该方案的最大单轴距离（米）。`active_area` 缺失/非法 → null（**不猜场景尺寸**） */
function metricDelta(dx, dy, area) {
  const w = Number(Array.isArray(area) ? area[0] : NaN);
  const h = Number(Array.isArray(area) ? area[1] : NaN);
  if (!(w > 0) || !(h > 0)) return null;
  return Math.max(Math.abs(dx) * w, Math.abs(dy) * h);
}

/** `scene_states.coord_system.active_area = [width_m, height_m, depth_m]` */
function activeAreaOf(sceneState) {
  const a = obj(sceneState?.coord_system).active_area;
  return Array.isArray(a) && a.length >= 2 ? a : null;
}

/** 该镜是否有某类动作（动作覆盖判定用） */
function hasAction(actions, pred) {
  return arr(actions).some((a) => a && typeof a === 'object' && pred(a));
}

/**
 * 求解一个场次（D01-06 §2.1 签名逐字）。
 *
 * @param {{projectId:string, sceneKey:string, shots:Array, sceneState?:object}} p
 * @returns {{states:object, sceneConflicts:Array, hash:string}}
 * @throws {Error} `code='CONTINUITY_SOLVER_FAILED'`
 */
export function solveContinuity({ projectId, sceneKey, shots, sceneState } = {}) {
  if (!Array.isArray(shots)) throw fail('solveContinuity：shots 必须是数组（不得传 undefined）');
  if (!sceneKey) throw fail('solveContinuity：缺少 sceneKey（一个求解批次只处理一个场次）');

  // 输入契约（D02-17 §四.6/4.7）：`id` / `global_no` / `scene_key` 缺一项就拒绝。
  // 放在 Hash 之前：坏输入不该先算出一个 Hash 再报错（那个 Hash 会被误当成"有效输入的指纹"）。
  // 这一层也是 P8 组装层可以直接复用的门（`assertSolverInput`），避免"只在求解器里兜底、
  // 组装层照旧乱塞"。
  assertSolverInput({ shots, sceneKey });

  const hash = solverInputHash({ projectId, sceneKey, shots, sceneState });

  let list;
  try {
    // `assertSolverInput` 已保证每个元素都是普通对象（D02-18 R3：非法元素整批拒绝，
    // 不再 `filter()` 静默丢弃），所以这里不再过滤，只排序。
    list = shots
      // ORD-1：权威序是 `global_no`（不是 shot_no、不是 created_at、不是 prev_shot_id）
      .slice()
      .sort((a, b) => a.global_no - b.global_no || cmpStr(a.id, b.id));
  } catch (e) {
    throw fail(`solveContinuity：镜头排序失败（${e && e.message}）`);
  }

  const states = {};
  const sceneConflicts = [];
  let prev = null;

  for (const shot of list) {
    if (!shot.id) throw fail('solveContinuity：镜头缺少 id');
    const one = solveOne({ shot, prev, sceneState, sceneKey, hash });
    states[String(shot.id)] = one;
    for (const c of one.conflicts) sceneConflicts.push({ ...c, scene_key: sceneKey, shot_id: String(shot.id) });
    prev = one;
  }

  return { states, sceneConflicts, hash };
}

/** 单镜求解（Step 1–6） */
function solveOne({ shot, prev, sceneState, sceneKey, hash }) {
  const specSource = String(shot.spec_source ?? '');
  const ver = num(shot.spec_version) ?? 0;
  const actions = arr(shot.actions).filter((a) => a && typeof a === 'object');
  const blockings = arr(shot.blockings).filter((b) => b && typeof b === 'object');
  const conflicts = [];
  const diagnostics = [];
  const timeJump = Number(shot.time_jump) === 1;
  // `norm_*` 是归一化、阈值是**米**（D01-04 §5.5：0.15 m 自然微调 / 1.5 m 瞬移），
  // 换算只走 `active_area`；缺它就不判跳变（猜尺寸 = 用假数据判创作有罪）。
  const area = activeAreaOf(sceneState);

  // ── Step 1：取前镜状态（深拷贝），无前镜 → 场次基线 ──────────────────────
  const isFirst = !prev;
  const base = isFirst ? sceneBaseline(sceneState, shot) : null;
  const stateIn = isFirst ? clone(base.state) : clone(prev.out);
  const metaIn = isFirst ? clone(base.meta) : clone(prev.meta);
  const derivedFrom = isFirst ? 'scene_baseline' : `prev_shot:${prev.id}`;

  // 版本戳：继承来的条目更新为本镜版本（§7.5 Step 1）
  // 同时把"上一镜自己填的"改标为 `prev_shot:<id>`：只有跨镜沿用才叫 carried，
  // 否则 `src` 会一直挂着最早那镜的 `blocking:*`，`meta.src` 就失去追溯意义（§5.7 预期输出）。
  for (const k of Object.keys(metaIn)) {
    if (k === '__solver') continue;
    const e = metaIn[k] ?? {};
    const src = String(e.src ?? '');
    metaIn[k] = {
      ...e,
      ver,
      // `carried:x` / `prev_shot:x` 都保留原值：改写成 `prev_shot:<本镜前镜>` 会丢掉继承链起点，
      // 于是 `carried:sh_40` 退化成一跳一拷的 `carried:sh_41`，追溯就断了（§5.7 预期）。
      src: isFirst || /^(?:carried|prev_shot):/.test(src) ? src : `prev_shot:${prev.id}`,
    };
  }

  // 本镜的可靠性标注（决定见 D02-16 §三 / U-P6-8）：
  // `shots[].meta` 是**调用方附加到复合镜头对象上的可选字段**，数据库里没有对应列
  // （`story_shots` 48 列实测无 `meta`；`shot_states.meta` 才是正式持久化的那一列，TEXT DEFAULT '{}'）。
  // P8 组装求解输入时可以把 `shot_states.meta` 的内容搬到这里，但那是**同一个来源的一次搬运**，
  // 不是第二条独立的真值通道 —— 不得让两个来源在这里互相覆盖。
  //
  // 为什么要认它：适配期可能已把某字段显式标成 `unknown`（D01-04 §5.2.1「显式标记最高优先」），
  // 求解器必须认这个标记 —— 否则"显式 unknown"会被当成"有值且可信"，凭空造出一个跳变。
  //
  // 归一化与 `solverInputHash()` **共用 `normalizeShotMeta()`**（P6-R1）：两处各写一套，
  // 就会出现"Hash 覆盖的输入"与"求解器实际读的输入"不是同一份，而那种偏差只能靠人眼发现。
  // 合并时**只覆盖非空字段**：`normalizeShotMeta` 会把缺省项填成 null，
  // 直接展开会把继承来的 `conf` 抹成 0（于是每次继承都丢失置信度）。
  const seed = normalizeShotMeta(shot.meta);
  // 来源边界（D02-17 §四.3）：`shots[].meta` 只收输入标注，`src` 带求解器产出的前缀即为
  // "把 `shot_states.meta` 整体回搬"—— 那会让值被改写、继承链起点被伪造、置信度被换基。
  assertAnnotationOnly(shot.id, seed);
  for (const k of Object.keys(seed)) {
    const one = { ...(metaIn[k] ?? {}) };
    for (const f of SOLVE_META_FIELDS) {
      if (seed[k][f] !== null && seed[k][f] !== undefined) one[f] = seed[k][f];
    }
    metaIn[k] = one;
  }
  /** 本镜对该字段的显式可靠性（没有则 undefined） */
  const seededRel = (id, key) => {
    const r = seed[`chars.${id}.${key}`]?.rel;
    return r === undefined || r === null || r === '' ? undefined : String(r);
  };
  // ── Step 2：time_jump 只跳过"差异校验"，不跳状态复制与动作覆盖 ─────────
  if (timeJump) {
    diagnostics.push({
      code: 'TIME_JUMP_SKIPPED', level: 'info', field: 'time_jump', shot_id: String(shot.id),
      detail: { note: 'time_jump=1：跳过位置/姿态/道具/服装的差异判定（状态复制与动作覆盖照常）' },
    });
  }

  const locomotion = hasAction(actions, (a) => String(a.action_type ?? '') === 'locomotion');
  const cogMove = hasAction(actions, (a) => ['rise', 'lower'].includes(String(a.cog ?? '')));
  const manipulation = hasAction(actions, (a) => String(a.action_type ?? '') === 'manipulation');
  const turn = hasAction(actions, (a) => /\bturn\b/i.test(String(a.action_type ?? '')));

  // ── Step 3：逐人比对（三值逻辑约束，D01-04 §5.5 Step 3 + §5.7 算例）───
  //
  // 这一段的核心是**"本镜没给值"与"本镜给了个不可信的值"是两种不同的事**，但结论相同：
  // 值沿用上镜（`src='carried:<origin>'`，置信度 ×0.9），并且只报 INFO/WARN，**绝不判 FAIL**。
  // 反例（这条最容易写错）：把 `rel='unknown'` 的观测值直接写进 `state_out`，
  // 于是"缺失"变成了一个具体坐标 —— 下一镜拿去比对，凭空造出一个跳变。
  const seen = new Set();
  for (const b of blockings) {
    const id = String(b.character_id ?? '');
    if (!id) continue;
    seen.add(id);
    const inFrame = Number(b.in_frame) === 1 ? 1 : 0;
    const hasPos = isNum(b.norm_x) && isNum(b.norm_y) && isNum(b.norm_z);
    const posRelObs = posRel({
      x: hasPos ? b.norm_x : null,
      y: hasPos ? b.norm_y : null,
      z: hasPos ? b.norm_z : null,
      // 本镜已带 meta（求解器回写场景）时，`unknown` 标记最高优先（D01-04 §5.2.1）
      metaEntry: metaIn[`chars.${id}.pos`],
      specSource,
    });
    const prevEntry = stateIn.chars[id];

    if (!prevEntry) {
      // 新人入画：该人全字段 `unknown`（不判冲突，也不编造坐标）
      stateIn.chars[id] = { in_frame: inFrame, pos: null, pos_rel: '', pos_abs: '', posture: null, facing: null, hand: null, gaze: null };
      for (const f of ['pos', 'posture', 'facing', 'hand', 'gaze']) {
        metaIn[`chars.${id}.${f}`] = { rel: 'unknown', src: 'rule:new_in_frame', conf: 0, ver };
      }
      diagnostics.push({
        code: 'STATE_UNKNOWN', level: 'info', shot_id: String(shot.id), character_id: id,
        field: `chars.${id}`, detail: { rel: 'unknown', note: '本镜新入画：场次内无该人历史状态' },
      });
    }

    const inEntry = stateIn.chars[id] ?? {};
    /** 继承链的起点镜：`carried:x` / `prev_shot:x` 都继续指向 x，否则指向前镜 */
    const originOf = (field) => {
      const src = String(metaIn[`chars.${id}.${field}`]?.src ?? '');
      const m = /^(?:carried|prev_shot):(.+)$/.exec(src);
      return m ? m[1] : String(prev?.id ?? '');
    };
    const inRelOf = (field) => String(metaIn[`chars.${id}.${field}`]?.rel ?? 'unknown');
    const inConfOf = (field) => {
      const c = Number(metaIn[`chars.${id}.${field}`]?.conf);
      return Number.isFinite(c) ? c : 0;
    };

    /**
     * 一个字段的处理：观测值 → state_out + meta。
     *
     * @param {string} key `pos` / `posture` / `facing` / `hand` / `gaze`
     * @param {*} obs 本镜观测值（缺失为 null）
     * @param {string} rel 观测值的可靠性
     * @param {(a:any,b:any)=>boolean} same 相等判定（pos 用坐标比较）
     * @param {boolean} reportUnknown 缺值/不可信时是否报 INFO（`pos`/`posture` 报，其余只继承）
     */
    const applyField = (key, obs, rel, same, reportUnknown) => {
      const inherited = inEntry[key] === undefined ? null : inEntry[key];
      const inRel = inRelOf(key);
      const note = key === 'pos' ? '位置' : key === 'posture' ? '姿态' : key === 'facing' ? '朝向' : key === 'hand' ? '手位' : '视线';

      // ① 没给值 / 给了不可信的值 → 沿用上镜，报 INFO，不判冲突
      if (obs === null || rel === 'unknown' || rel === 'not_applicable') {
        if (reportUnknown) {
          diagnostics.push({
            code: 'STATE_UNKNOWN', level: 'info', shot_id: String(shot.id), character_id: id,
            field: `chars.${id}.${key}`,
            detail: {
              rel, reason: obs === null ? 'missing' : 'untrusted',
              carried_from: inherited === null ? null : originOf(key),
              note: inherited === null
                ? `本镜未提供${note}，且无历史值可沿用；不判定${note}变化`
                : `本镜未提供可信${note}，沿用 ${originOf(key)} 的值；不判定${note}变化`,
            },
          });
        }
        if (inherited === null) {
          stateOutPlaceholder(stateIn.chars[id], key);
        } else {
          // 值不动，只记"这是继承来的"：conf ×0.9，rel 保持上镜的可靠性
          metaIn[`chars.${id}.${key}`] = { rel: inRel, src: `carried:${originOf(key)}`, conf: quant(inConfOf(key) * CARRY_DECAY), ver };
        }
        return;
      }

      // ② 可信值 → 先比对（只在"两侧都 known"时才可能判 FAIL）
      if (inherited !== null && !same(obs, inherited)) {
        if (key === 'pos') {
          const dM = metricDelta(obs[0] - inherited[0], obs[1] - inherited[1], area);
          if (dM === null) {
            // 没有 `active_area` 就换算不出米制距离 → 报数据不足，不判跳变
            diagnostics.push({
              code: 'COORD_SYSTEM_INCOMPLETE', level: 'info', shot_id: String(shot.id), character_id: id,
              field: 'scene_states.coord_system.active_area',
              detail: { from: inherited, to: obs, note: '缺 active_area，无法把归一化差换算成米；不判位置跳变' },
            });
            return;
          }
          const limit = dM > TELEPORT_MIN ? 'TELEPORT' : 'POSITION_JUMP';
          if (rel === 'known' && inRel === 'known' && !timeJump && !locomotion) {
            conflicts.push({
              code: limit, level: 'fail', character_id: id, field: `chars.${id}.pos`,
              detail: { delta_m: quant(dM), delta_norm: quant(Math.max(Math.abs(obs[0] - inherited[0]), Math.abs(obs[1] - inherited[1]))), from: inherited, to: obs, has_locomotion: false },
            });
          } else if (rel === 'inferred' || inRel === 'inferred') {
            diagnostics.push({ code: 'INCONSISTENT_INFERRED', level: 'warn', shot_id: String(shot.id), character_id: id, field: `chars.${id}.pos`, detail: { rel_in: inRel, rel_obs: rel, from: inherited, to: obs } });
          } else if (rel === 'known' && inRel === 'known' && timeJump) {
            // time_jump 已单独记 TIME_JUMP_SKIPPED，这里不再重复
          } else if (rel === 'known' && inRel === 'known' && locomotion) {
            // 位移动作覆盖本次变化
          } else {
            diagnostics.push({ code: 'STATE_UNKNOWN', level: 'info', shot_id: String(shot.id), character_id: id, field: `chars.${id}.pos`, detail: { rel_in: inRel, rel_obs: rel, note: '可靠性不足，不判跳变' } });
          }
        } else if (key === 'posture') {
          if (rel === 'known' && inRel === 'known' && !timeJump && !cogMove) {
            conflicts.push({ code: 'POSTURE_JUMP', level: 'fail', character_id: id, field: `chars.${id}.posture`, detail: { from: inherited, to: obs, has_cog: false } });
          } else if (rel === 'inferred' || inRel === 'inferred') {
            diagnostics.push({ code: 'INCONSISTENT_INFERRED', level: 'warn', shot_id: String(shot.id), character_id: id, field: `chars.${id}.posture`, detail: { rel_in: inRel, rel_obs: rel, from: inherited, to: obs } });
          }
        } else if (key === 'hand') {
          if (rel === 'known' && inRel === 'known' && !timeJump && !manipulation) {
            conflicts.push({ code: 'HAND_JUMP', level: 'fail', character_id: id, field: `chars.${id}.hand`, detail: { from: inherited, to: obs, has_manipulation: false } });
          }
        } else if (key === 'facing') {
          // `facing` 是枚举、没有角度 → 一律按"变了"处理并降到 WARN（不判 FAIL）
          if (!timeJump && !turn) {
            diagnostics.push({ code: 'FACING_FLIP', level: 'warn', shot_id: String(shot.id), character_id: id, field: `chars.${id}.facing`, detail: { from: inherited, to: obs, has_turn: false } });
          }
        }
        // `gaze` 变化始终允许（D01-04 §5.5 Step 3 末行）
      }

      // ③ 观测值与继承值**相同**且观测值本身不够可信 → 什么都没变，保留继承条目
      // （D01-04 §5.7 sh_41：posture ai=standing 与继承 known=standing 相同 →
      //   `src` 仍是 `prev_shot:sh_40`、`conf` 仍 0.95，不能因为"本镜又说了一遍"就衰减）
      if (inherited !== null && same(obs, inherited) && rel !== 'known') return;

      // ④ 写入决策：**推断值不得覆盖一个更可信的已知值**
      if (rel === 'known' || inherited === null || inRel !== 'known') {
        const conf = key === 'pos'
          ? (isNum(b.norm_confidence) ? Number(b.norm_confidence) : rel === 'known' ? REL_CONF.known : REL_CONF.inferred)
          : (rel === 'known' ? REL_CONF.known : REL_CONF.inferred);
        stateIn.chars[id] = { ...(stateIn.chars[id] ?? {}), [key]: obs };
        metaIn[`chars.${id}.${key}`] = { rel, src: `blocking:${id}`, conf: quant(conf), ver };
        return;
      }
      // 推断值 vs 继承的已知值：值不动（§5.7 步 4"推断值不写入 state_out"）
      metaIn[`chars.${id}.${key}`] = { rel: inRel, src: `carried:${originOf(key)}`, conf: quant(inConfOf(key) * CARRY_DECAY), ver };
    };

    /** 无历史值时把字段显式置空（不是补 0、不是补默认） */
    function stateOutPlaceholder(chars, key) {
      chars[key] = null;
      metaIn[`chars.${id}.${key}`] = { rel: 'unknown', src: `rule:no_value`, conf: 0, ver };
    }

    applyField('pos', hasPos ? [b.norm_x, b.norm_y, b.norm_z] : null,
      seededRel(id, 'pos') ?? (hasPos ? posRelObs : 'unknown'),
      (a, c) => {
        const d = metricDelta(a[0] - c[0], a[1] - c[1], area);
        return d !== null && d <= POS_JUMP_MIN;
      }, true);
    applyField('posture', b.posture ?? null, seededRel(id, 'posture') ?? relOfValue(b.posture, specSource), (a, c) => a === c, true);
    applyField('facing', b.facing ?? null, seededRel(id, 'facing') ?? relOfValue(b.facing, specSource), (a, c) => a === c, false);
    applyField('hand', b.hand_state ?? null, seededRel(id, 'hand') ?? relOfValue(b.hand_state, specSource), (a, c) => a === c, false);
    applyField('gaze', b.gaze_target ?? null, seededRel(id, 'gaze') ?? relOfValue(b.gaze_target, specSource), (a, c) => a === c, false);

    // 画内标记与方位描述始终取本镜观测（它们不是"可信度"字段）
    stateIn.chars[id] = {
      in_frame: inFrame,
      ...stateIn.chars[id],
      pos_rel: inEntry.pos_rel ?? '',
      pos_abs: String(b.position_abs ?? inEntry.pos_abs ?? ''),
    };
  }

  // CHAR_POP：前镜在画（in_frame=1）而本镜没有该人 → 凭空消失
  if (!timeJump) {
    for (const id of Object.keys(stateIn.chars).sort(cmpStr)) {
      if (seen.has(id)) continue;
      const before = prev?.out?.chars?.[id];
      if (before && Number(before.in_frame) === 1) {
        conflicts.push({ code: 'CHAR_POP', level: 'fail', character_id: id, field: `chars.${id}.in_frame`, detail: { from_in_frame: 1, to_in_frame: 0 } });
      }
      stateIn.chars[id] = { ...stateIn.chars[id], in_frame: 0 };
    }
  }

  // ── Step 4：道具比对 ────────────────────────────────────────────────────
  const touchedProps = new Map(); // prop_id → 首个接触它的动作
  for (const a of actions) {
    const c = obj(a.contact_json ?? a.contact);
    if (String(c.target_type ?? '') === 'prop' && c.target_id) {
      const pid = String(c.target_id);
      if (!touchedProps.has(pid)) touchedProps.set(pid, a);
    }
    for (const d of arr(obj(a.result_json ?? a.result).prop_delta)) {
      if (d && d.prop_id && !touchedProps.has(String(d.prop_id))) touchedProps.set(String(d.prop_id), a);
    }
  }
  if (!timeJump) {
    for (const pid of [...touchedProps.keys()].sort(cmpStr)) {
      const cur = stateIn.props[pid];
      if (!cur) {
        conflicts.push({ code: 'PROP_APPEAR', level: 'fail', prop_id: pid, field: `props.${pid}`, detail: { action_id: String(touchedProps.get(pid)?.id ?? ''), note: '道具未在 state_in 中，凭空出现' } });
        continue;
      }
      if (['consumed', 'broken', 'destroyed'].includes(String(cur.state ?? ''))) {
        conflicts.push({ code: 'PROP_REVIVE', level: 'fail', prop_id: pid, field: `props.${pid}.state`, detail: { state: String(cur.state), action_id: String(touchedProps.get(pid)?.id ?? '') } });
      }
    }
  }

  // ── Step 5：`state_out = state_in`，按 `t_from` 升序应用动作结果 ────────
  const stateOut = clone(stateIn);
  const metaOut = clone(metaIn);
  const ordered = actions
    .map((a) => ({ a, ...intervalOf(a) }))
    .sort((p, q) => p.from - q.from || cmpStr(p.a.id, q.a.id));

  for (const { a } of ordered) {
    const aid = String(a.id ?? '');
    const result = obj(a.result_json ?? a.result);
    // char_delta：`{ chars: {id: {pos|posture|facing|hand|gaze}} }`
    for (const [cid, delta] of Object.entries(obj(result.char_delta))) {
      const cur = stateOut.chars[cid] ?? { in_frame: 1, pos: null, pos_rel: '', pos_abs: '', posture: null, facing: null, hand: null, gaze: null };
      const next = { ...cur };
      for (const f of ['posture', 'facing', 'hand', 'gaze']) {
        if (delta?.[f] !== undefined && delta?.[f] !== null) next[f] = delta[f];
      }
      if (Array.isArray(delta?.pos) && delta.pos.length >= 2) next.pos = [num(delta.pos[0]), num(delta.pos[1]), num(delta.pos[2]) ?? 0];
      stateOut.chars[cid] = next;
      for (const f of ['pos', 'posture', 'facing', 'hand', 'gaze']) {
        if (delta?.[f] !== undefined && delta?.[f] !== null) {
          metaOut[`chars.${cid}.${f}`] = { rel: 'known', src: `action:${aid}`, conf: 1, ver };
        }
      }
    }
    // prop_delta：`[{prop_id, to:{state, owner, condition}}]`
    for (const d of arr(result.prop_delta)) {
      if (!d || !d.prop_id) continue;
      const pid = String(d.prop_id);
      const to = obj(d.to);
      stateOut.props[pid] = { ...(stateOut.props[pid] ?? {}), ...to };
      for (const f of Object.keys(to).sort(cmpStr)) {
        metaOut[`props.${pid}.${f}`] = { rel: 'known', src: `action:${aid}`, conf: 1, ver };
      }
    }
    // env_delta
    for (const [k, v] of Object.entries(obj(result.env_delta))) {
      stateOut.env[k] = v;
      metaOut[`env.${k}`] = { rel: 'known', src: `action:${aid}`, conf: 1, ver };
    }
    // end_state 覆盖 pos/posture/facing/hand
    const actor = String(a.actor_id ?? '');
    const end = obj(a.end_state ?? a.end_state_json);
    if (actor && Object.keys(end).length) {
      const cur = stateOut.chars[actor] ?? { in_frame: 1, pos: null, pos_rel: '', pos_abs: '', posture: null, facing: null, hand: null, gaze: null };
      const next = { ...cur };
      if (Array.isArray(end.pos) && end.pos.length >= 2) next.pos = [num(end.pos[0]), num(end.pos[1]), num(end.pos[2]) ?? 0];
      for (const f of ['posture', 'facing', 'hand']) if (end[f] !== undefined && end[f] !== null) next[f] = end[f];
      stateOut.chars[actor] = next;
      if (Array.isArray(end.pos)) metaOut[`chars.${actor}.pos`] = { rel: 'known', src: `action:${aid}`, conf: 1, ver };
      for (const f of ['posture', 'facing', 'hand']) {
        if (end[f] !== undefined && end[f] !== null) metaOut[`chars.${actor}.${f}`] = { rel: 'known', src: `action:${aid}`, conf: 1, ver };
      }
    }
  }

  // ── Step 6：`position_track` 与动作 `path` 交叉校验 ────────────────────
  for (const b of blockings) {
    const id = String(b.character_id ?? '');
    const track = arr(b.position_track).filter((p) => p && typeof p === 'object');
    if (!id || track.length < 1) continue;
    const first = track[0];
    const last = track[track.length - 1];
    const outPos = stateOut.chars[id]?.pos ?? null;
    const relOut = String(metaOut[`chars.${id}.pos`]?.rel ?? 'unknown');
    const lastPos = [num(last.x), num(last.y), num(last.z) ?? 0];
    if (relOut === 'unknown' && isNum(lastPos[0]) && isNum(lastPos[1])) {
      // 坐标未知但轨迹给了终点 → 记为 `inferred`（**不冒充 known**）
      stateOut.chars[id] = { ...(stateOut.chars[id] ?? {}), pos: lastPos };
      metaOut[`chars.${id}.pos`] = { rel: 'inferred', src: 'rule:track_end', conf: 0.5, ver };
    } else if (outPos && isNum(lastPos[0]) && isNum(lastPos[1])) {
      const d = Math.max(Math.abs(outPos[0] - lastPos[0]), Math.abs(outPos[1] - lastPos[1]));
      if (quant(d) > TRACK_TOL) {
        diagnostics.push({
          code: 'TRACK_ENDS_MISMATCH', level: 'warn', shot_id: String(shot.id), character_id: id,
          field: `blockings.${id}.position_track`, detail: { delta: quant(d), track_first: [num(first.x), num(first.y)], track_last: lastPos, state_pos: outPos },
        });
      }
    }
  }

  // `__solver` 是保留命名空间（SH-1/SH-3），不参与可靠性统计
  metaOut.__solver = { hash, solver_version: SOLVER_VERSION };

  return {
    id: String(shot.id),
    in: stateIn,
    out: stateOut,
    meta: metaOut,
    meta_in: metaIn,
    derived_from: derivedFrom,
    conflicts,
    diagnostics,
  };
}
