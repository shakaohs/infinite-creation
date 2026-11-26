// adaptationHash（D01-06 §4.3）：只覆盖"切分方案"
//
// 刻意**不包含** sourceSpecHash：若把源 hash 混进来，"切分方案本身有没有变"就无法单独回答。
// 组合关系由 compiledHash 承担。
//
// 关于 G0 四项锁（mode / aspect / base / assetMode）：**本 hash 不含它们**。
// payload 只有下面六个键，锁值不在其中。因此：
//   · 不能通过 adaptationHash 证明"两边的锁一致"；
//   · 有人绕过代码 UPDATE 了 adaptation_locks，本 hash 一个字都不变。
// 锁的一致性由 D02-03 V3 §八 的"锁不可变 + 改锁即新版本 + 巡检"保证，不是 hash 的职责。
// 谁在测试或文档里写"hash 相同所以锁相同"，就是错的（R-06 / 任务书 §5.4 特别约束）。
import { createHash } from 'node:crypto';
import { canonicalStringify, num, numOrNull } from './canonical-stringify.js';
import { jsonObj } from './source-spec-hash.js';

function sha256(s) {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

export function buildAdaptationPayload({ adaptation = {}, units = [], fragments = [] } = {}) {
  return {
    hashKind: 'd01.adaptation',
    adaptationVersion: num(adaptation.adaptation_version),
    track: adaptation.track,
    profileVer: adaptation.profile_ver,
    profileParams: {
      max: num(adaptation.profile_max),
      shortFloor: num(adaptation.profile_short_floor),
      minSlice: num(adaptation.profile_min_slice),
      // 缺失 → null，不补默认值（补默认值等于伪造"这套 profile 有 tailHoldMax"）
      tailHoldMax: numOrNull(adaptation.profile_tail_hold_max),
    },
    // 段缝策略（含 tailHold）。只接 seam 语义，不接 G0 锁
    seamPolicy: jsonObj(adaptation.seam_policy_json ?? adaptation.seam_policy),
    units: units
      .slice()
      .sort((a, b) => num(a.unit_no) - num(b.unit_no))
      .map((u) => ({
        unitNo: num(u.unit_no),
        unitDuration: num(u.unit_duration),
        shots: fragments
          .filter((f) => f.unit_id === u.id)
          .sort((a, b) => num(a.order_no) - num(b.order_no))
          .map((f) => ({
            shotId: f.shot_id,
            orderNo: num(f.order_no),
            tFrom: num(f.t_from),
            tTo: num(f.t_to),
            reason: f.split_reason,
          })),
      })),
  };
}

export function adaptationHash(args) {
  return 'sha256:' + sha256(canonicalStringify(buildAdaptationPayload(args)));
}
