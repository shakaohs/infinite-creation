# D02-11 · P4 posRel 搬迁 / 枚举表 / Schema 基础校验 实施报告

> 上游依据：`docs/D02/D02-06-阶段3核心创作能力实施任务书.md`（V7）§4.7.1、§6.1、§6.2、§7.1、§7.13、§17 P4
> 字段与枚举依据：`docs/D01/D01-02`、`D01-03`、`D01-04`
> 本轮只做基础能力（纯函数），**未实现 P5 的 69 条 QC 规则，也未创建 `validateShot` 统一执行器**。

---

## 一、基线与提交

| 项 | 值 |
|---|---|
| 实施前基线 SHA | `efc754deef26308be76c640132d773b8448472aa`（P3 含复审修复，`shakaohs/main` 一致） |
| 实施提交 SHA | `e5f50c8`（10 文件：3 改 + 7 新增） |
| 复审修复基线 | `5b341feb1ec34db0b1d13daf33db1caa72ebeeca`（= P4 首轮交付点） |
| 复审修复提交 SHA | `5e381e0`（4 文件：`enums.js` +15/−1、`schema.js` +12/−0、`stage3-p4-enums.test.mjs` +55、`stage3-p4-schema.test.mjs` +51） |
| DDL / DML | **0 条**（未建表、未改列、未写库） |
| 真实库 | `data/ic.db` / `-wal` / `-shm` 三文件 SHA-256 与 `-shm` mtime 全程未变 |

---

## 二、文件变化清单

| 文件 | 类型 | 行数 | 职责 |
|---|---|---:|---|
| `lib/core/continuity/pos-rel.js` | 新增 | 53 | `posRel` / `posRelDetail` **原样搬迁**（五级优先级 + 两种矛盾告警） |
| `lib/core/hash/source-spec-hash.js` | 改 | +5 / −30 | 删掉两份实现，改为从新文件导入并原样再导出 |
| `lib/core/validate/enums.js` | 新增 | 314 | D01 冻结枚举表（**24 个扁平字段** + 2 个结构化字段）、`check` / `isValid` / `checkObject` |
| `lib/core/validate/schema.js` | 新增 | 594 | S 级推导与必填、类型与范围（含 `norm_xyz∈[0,1]³`）、V-13、V-19、V-20、V-22 |
| `lib/core/index.js` | 改 | +3 | `export * as enums` / `export * as schema`（命名空间导出，避免 `check`/`isValid` 这类通用名污染顶层） |
| `tests/fixtures/pos-rel-matrix.mjs` | 新增 | 35 | 13 行判定矩阵 + 2 条告警用例（R-44 与 P4 共用） |
| `tests/stage1-hash.test.mjs` | 改 | +10 / −17 | R-44 改为遍历共享 fixture，断言不变 |
| `tests/stage3-p4-pos-rel.test.mjs` | 新增 | 139 | 搬迁回归（11 条） |
| `tests/stage3-p4-enums.test.mjs` | 新增 | 217 | 枚举表（**12 条**） |
| `tests/stage3-p4-schema.test.mjs` | 新增 | 443 | Schema 五项 + 坐标范围（**30 条**） |

未改：P0/P1/P2/P3 的任何实现、`lib/core/schema/tables.js`（DDL 冻结）、其他 D02 文档。

---

## 三、`posRel` 搬迁说明与旧导出兼容证明

### 3.1 搬迁只搬位置

| 项 | 处理 |
|---|---|
| 函数体 | **逐字未改**（五级优先级顺序、`z=0` 判定、`[] .every(Number.isFinite)` 全部原样） |
| 原文件 | `source-spec-hash.js` 顶部 `import { posRel } from '../continuity/pos-rel.js'`，并 `export { posRel, posRelDetail } from '../continuity/pos-rel.js'` |
| `buildSourcePayload()` | 继续调用 `posRel()`（第 212 行），**Hash 输入一字未动** |
| `hash/index.js` | 导出清单未改（仍从 `source-spec-hash.js` 取 `posRel` / `posRelDetail`） |
| `lib/core/index.js` | 公开导出仍含 `posRel` / `posRelDetail`（经 hash 块） |
| 其他调用方 | **无需改导入路径** |

### 3.2 兼容性证明（不是口头保证）

| 证据 | 说明 |
|---|---|
| 同一个函数引用 | `hash.posRel === continuity.posRel === core.posRel`（P4-T01/T05 断言引用相等，副本不可能相等） |
| 只有一处定义 | 遍历 `lib/` 全部 `.js/.mjs`，`function posRel(` 只命中 `lib/core/continuity/pos-rel.js`（P4-T05） |
| 同一份矩阵数据 | 13 行取自 `tests/fixtures/pos-rel-matrix.mjs`，R-44（老路径）与 P4-T02（新路径）**读同一份数组** |
| 站位白名单不变 | `buildSourcePayload` 的 block 字段清单断言逐字不变（P4-T06c） |

### 3.3 五级优先级（原样保留，删除任何一级都会改变判定）

```
① 显式 not_applicable          → not_applicable（先于缺失检查）
② 显式 unknown                 → unknown
③ x/y/z 任一缺失或非有限数      → unknown（显式 known 不能翻案）
④ 坐标完整且显式 known/inferred → 采信显式值
⑤ 无 meta → manual=known / legacy=unknown / 其他=inferred
```

`z = 0` 合法（只判 `== null` 与 `Number.isFinite`，不做真值判断）。**BL-05** 就是第③级：`norm_xyz` 全 NULL 时一律 `unknown`，不按来源推导成 `inferred`。

---

## 四、枚举来源与字段覆盖清单

### 4.1 覆盖的字段（24 个扁平 + 2 个结构化）

| 字段 | 值数 | 来源 | 备注 |
|---|---:|---|---|
| `purpose` | 7 | D01-02 §二 | 必填 |
| `dialogue_function` | 7 | D01-02 §二 | D01 默认 `''`，故允许空 |
| `shot_size` | 9 | D01-02 §4.1 | 有序（`ordered: true` 供相邻档判定） |
| `cam_direction` | 5 | D01-02 §4.2 | — |
| `cam_height` | 8 | D01-02 §4.3 | **不含 `dutch`**（已由 `cam_roll_deg` 表达） |
| `movement` | **22** | D01-02 §4.4 | 见 §4.2 计数说明 |
| `movement_amp` | 4 | D01-02 §四 D11 | — |
| `composition_rule` | 7 | D01-02 §4.5 | 默认 `''`，允许空 |
| `speakers.type` | 5 | D01-02 §6.1 | `on_screen`/`off_screen`/`phone`/`narrator`/`dub` |
| `speed_ramp` | 5 | D01-02 §十 | 默认 `none` |
| `time_slices.kind` | 3 | D01-02 §十 | `action`/`hold`/`dialogue` |
| `action_type` | 6 | D01-03 §三 | — |
| `tier` | 3 | D01-03 §三 | — |
| `cog` | 7 | D01-03 §三 | — |
| `speed.profile` | 5 | D01-03 §3.5 | — |
| `contact.impulse` | 3 | D01-03 §3.7 | — |
| `posture` | 8 | D01-04 §四 | — |
| `power_level` | 3 | D01-04 §四 | — |
| `cross_allowed.type` | 5 | D01-04 §3.3 | — |
| `crowd_switch` | 3 | D01-04 §三 | 可空（未声明群像） |
| `prop.state` | 6 | D01-04 §十 | `absent` 是"键不存在"，不是值 |
| `state.rel` | 4 | D01-04 §5.2 | `known`/`inferred`/`unknown`/`not_applicable` |
| `asset.role` | 6 | D01-05 §4.6 | 与 P3 的 `SHOT_ASSET_ROLES` 同源 |
| `spec_source` | 4 | D01-02 §十一 | `ai`/`import`/`manual`/`legacy`；DDL `DEFAULT 'ai'`，故空值放行（复审补齐） |
| `state_source` | 3 | D01-04 §5.1 | `solved`/`none`/`manual`；DDL `DEFAULT 'none'`，故空值放行（复审补齐） |
| `facing`（结构化） | 4 方位 + 角度 | D01-04 §四 | 接受 `N` / `N+30` / `N-45` / `{dir,deg}`，deg 限 ±180 |
| `occlusion`（结构化） | 3 + `partial(部位)` | D01-04 §四 | 裸 `partial` 不合法（必须说清部位） |

### 4.2 一处必须记录的计数矛盾

D01-02 §4.4 标题写「`movement` 运镜（21 值）」，但该表**逐项点数是 22**：静止 1 + 平移 6 + 纵深 6 + 变焦 4 + 手持 3 + 特殊 2。

处理：**按逐项列出的值走（22 个）**，并在 `enums.js` 里写明原因。理由与 §4.3「7 值 → 8 值」笔误同源——标题写错只是难看，按标题删掉一个值会让**合法运镜被拒**。这条已登记为 `U-P4-6`，交审核确认是否需要回改 D01（D01 已冻结，本轮不改）。

### 4.3 严格禁止项的落实

| 禁止 | 落实 |
|---|---|
| `cam_height` 不得重新加入 `dutch` | 表里没有，且单列 `forbidden: ['dutch']` 供测试断言（P4-T07b） |
| 不得把 `cam_roll_deg` 当 `cam_height` 枚举 | 它是 REAL 范围字段，表里根本没有；`check('cam_roll_deg', …)` 返回 `ENUM_FIELD_UNKNOWN`（P4-T07f） |
| `facing` 不能只限四个字符串 | 结构化校验，接受角度与对象形式（P4-T07g） |
| 结构型字段不得当字符串枚举 | `occlusion` 单独走结构化校验；`time_slices`/`position_track`/`contact`/`norm_*` 一律不在枚举表（P4-T07f/h） |

---

## 五、Schema 函数与 V 系列对应关系

| 规则 | 函数 | 说明 |
|---|---|---|
| V-01 S 级推导 | `computeLevel` | 四条判据逐级提升（取最大），**忽略调用方传入的 `level`** 并回 `declared_ignored` |
| V-01 各级必填 | `checkRequired` | S0 → `BLOCKING_FIELD_MISSING`；S1~S4 → `SCHEMA_INVALID`；`axis_lock`/`crowd_switch`/`state_in out`/逐动作 `contact` 单独判 |
| 类型与范围 | `checkShotFields` / `checkBlockingFields` | 只做 D01 明写的范围（含 **`norm_x/norm_y/norm_z ∈ [0,1]³`**）；坐标三缺一 → `COORD_PARTIAL`（S-24 写入侧口径），**不把 NULL 补 0** |
| V-13 空镜台词 | `checkEmptyShot` | `is_insert=1` 时：`on_screen` 且 `in_frame=1` → FAIL；`off_screen` 但 `in_frame=1` → FAIL；纯空镜合法 |
| V-19 Meta 键 | `checkMetaKeys` | 四类路径逐段解析 + 实体存在性 + 字段白名单；`__solver` 单独放行，其他 `__` 键拒 |
| V-19 辅助 | `countReliabilityEntries` | 统计字段可靠性条目数（排除 `__solver`），供 P5/P6 复算 |
| V-20 时间切片 | `checkTimeSlices` | 首尾 + 相接 + 空洞 + 重叠，**零容差**；空数组 → INFO |
| V-22 静默修改 | `checkSilentChange` | `rel='unknown'` 却有确定值 → WARN；无 meta → INFO(N/A) |
| 聚合（仅本文件五类） | `checkSchema` | 返回 `{ level, basis, hits[] }`，**不是** P5 的 `validateShot` |

返回结构统一为 `{ level, code, field, expected, ...detail }`。`hit()` 里**约定字段最后写**——detail 放 `level` 会覆盖级别（本轮 T09a 就是被这条抓出来的）。

---

## 六、S0~S4 推导与测试结果

```
level = S0
chars_in_frame >= 2                              → ≥S1
chars_in_frame >= 3 || 有 prop 被 ≥2 人接触        → ≥S2
有 locomotion || position_track.length > 1        → ≥S3
有 combat || chars_total >= 5 || crowd_switch=A   → ≥S4
```

| 场景 | 结果 | 用例 |
|---|---|---|
| 1 人在画 | S0 | P4-T08a |
| 2 人在画 | S1 | P4-T08a |
| 3 人在画 | S2 | P4-T08a |
| 2 条同人接触同一道具 | 仍 S0（同一人不算"多人"） | P4-T08c |
| `env` 与 1 人接触道具 | 仍 S0（`env` 不是人） | P4-T08c |
| 2 人接触同一道具 | S2 | P4-T08c |
| `locomotion` / 轨迹 2 点 | S3 | P4-T08a |
| `combat` / 5 人 / `crowd_switch=A` | S4 | P4-T08a |
| **3 人在画 + combat** | **S4**（证明不是互斥 `else if`） | P4-T08b |
| 声明 `S0` 但数据是 S1 | 结果 S1 + `LEVEL_DECLARED_IGNORED` | P4-T10 |

必填集（P4-T09a~e）：S0 三项缺失逐一命中 `shot_blockings[0].facing` 这类可定位字段；S1 五项 + `scene_states.axis_lock`；S2 六项；S3 `position_track` + `shot_states.state_in/out`（**只报缺，不代造**，入参对象断言未被改写）；S4 `scene_states.crowd_switch` + `shot_actions[0].contact` + `instance_anchor`。

---

## 七、P4 专项测试逐条结果

| 编号 | 验收内容 | 结果 |
|---|---|---|
| P4-T01 | R-44 原有 13 行矩阵继续全绿 | **PASS**（`stage1-hash` 51 tests / 45 pass / 6 skip，R-44 通过） |
| P4-T02 | 新路径使用同一份 13 行 fixture，全绿 | PASS |
| P4-T03 | `posRelDetail` 两种告警正确 | PASS（另断言无矛盾时零告警） |
| P4-T04 | BL-05 缺失三维坐标必定 `unknown` | PASS（含 `spec_source=manual` + `meta.rel=known` 两种翻案尝试） |
| P4-T05 | `posRel` 只有一份实现 | PASS（函数引用相等 + 全仓 grep 只一处定义） |
| P4-T06 | Hash 原有导出与 `sourceSpecHash` 结果不变 | PASS（导出同一函数；payload 白名单字段逐字不变；同输入同 hash） |
| P4-T07 | D01 枚举表完整、合法值通过、非法值拒绝 | PASS（表数量逐项钉住；**24 个扁平字段**逐值遍历；`spec_source`/`state_source` 见 P4-T07l） |
| P4-T08 | S0~S4 按本镜数据正确推导 | PASS |
| P4-T09 | 五个 S 级对应必填集正确 | PASS |
| P4-T10 | 调用方伪造 S 级不能覆盖程序计算 | PASS |
| P4-T11 | V-13 空镜规则正确 | PASS |
| P4-T12 | V-19 合法通过、拼错/不存在拒绝 | PASS（8 类错路径分别命中不同 code） |
| P4-T13 | `__solver` 单独放行，其他 `__` 键不放行 | PASS（含 `__solver2`、`__solver_x`） |
| P4-T14 | V-20 首尾、连续、空洞、空数组边界 | PASS（含 1 微秒空洞） |
| P4-T15 | V-22 符合 Meta 可靠性语义 | PASS（无 meta → N/A；unknown 有值 → WARN；不改写 meta） |
| P4-T16 | 同输入结果稳定、不修改入参 | PASS（冻结对象 + 两次 deepEqual） |
| P4-T17 | 未改冻结 DDL、历史数据、P0~P3 实现 | PASS（`git status` 只有本轮 10 个文件） |
| P4-T18 | 全量新增失败数 = 0 | PASS（17 条与基线逐条同名同因） |

| P4-EXT3 | `norm_x/norm_y/norm_z ∈ [0,1]³`：0 与 1 通过，负数与 >1 拒绝 | PASS（三个分量 × 边界 2 × 非法 5，逐项断言 `field`/`got`） |
| P4-EXT4 | 范围检查不得替 NULL 补 0 | PASS（同空通过 / 部分空只报 `COORD_PARTIAL` / 非有限数仍拒 / 入参不被改写） |

单个文件计数：`stage3-p4-pos-rel` **11/11**、`stage3-p4-enums` **12/12**、`stage3-p4-schema` **30/30**（合计 53）。

---

## 八、全量测试四个数字（实施前后）

| 组 | tests | pass | fail | skip |
|---|---:|---:|---:|---:|
| 实施前（P3 + 复审修复） | 515 | 487 | 17 | 11 |
| 实施后（首轮） | 565 | 537 | 17 | 11 |
| **复审修复后** | **568** | **540** | 17 | 11 |
| 差值（相对 P3） | **+53** | **+53** | **0** | **0** |

- 新增 53 条 = pos-rel 11 + enums 12 + schema 30（含复审补的 P4-T07l / P4-EXT3 / P4-EXT4），全部通过。
- 17 条失败与基线 `diff` **为空**：仍是 legacy `shots` / 旧 `set_storyboard` / 换装兜底 / `freeComfy` 那批，**同名同因，不是本轮引入**。

---

## 九、测试隔离证明

| 项 | 做法 |
|---|---|
| 独立数据目录 | 三个测试文件各自 `fs.mkdtempSync(os.tmpdir()/ic-p4-*)`，在 import 任何 lib **之前**写 `IC_DATA_DIR` |
| 其他库来源 | `delete IC_DB_SQLITE_PATH / IC_DB / DATABASE_URL` |
| PostgreSQL | 未连接（无 `IC_DB=postgres`，也不设 `PG_TEST_URL`） |
| 真实项目数据 | 不读不写；本组模块是纯函数，测试全程没有 `getDb()` |
| 全量一轮后 | 真库三文件 SHA-256 不变、`-shm` mtime 不变（见 §十） |

---

## 十、DDL / DML / 真实库

| 文件 | 全量前（前 16 位） | 全量后 | 结论 |
|---|---|---|---|
| `data/ic.db` | `b2ebdb5435fcf573` | `b2ebdb5435fcf573` | 未变 |
| `data/ic.db-wal` | `2711665da7a28f79` | `2711665da7a28f79` | 未变 |
| `data/ic.db-shm` | `22d611033e2ce424` | `22d611033e2ce424` | 未变（mtime `1795744805` 不变） |

本轮 **0 条 DDL、0 条 DML**；未新增表/列/索引；未删改任何历史数据。

---

## 十一、是否提前实现了 P5 内容

**否。** 逐项对照：

| P5 内容 | 本轮状态 |
|---|---|
| 69 条 QC 规则完整校验 | 未实现（只做了 V-01/V-13/V-19/V-20/V-22 五类基础检查 + V-02 的枚举数据源） |
| `validateShot(ctx)` 统一执行器 | 未创建（`checkSchema` 只聚合本文件五类，P4-T16b 断言不出现任何 P5 规则码） |
| `action.js` / `blocking.js` / `camera.js` / `asset.js` / 完整 `continuity.js` | 未创建 |
| `solveContinuity()` / `analyzeActionTime()` | 未实现 |
| `qc_reports` 写入、规则聚合、继承、运行时编排 | 未实现 |
| 改 Agent 工具 / API 路由 / Skill / 业务写入流程 | 未改 |

---

## 十二、未解决事项

### A 级（阻断）

无。

### B 级（后续实施约束）

| 编号 | 问题 | 影响 | 处置 |
|---|---|---|---|
| U-P4-1 | `enums.check` 的字段名是**扁平键**（`'speed.profile'`、`'time_slices.kind'`），P5 从行对象调用时需要自己做一层映射 | P5 若直接传行对象会得到 `ENUM_FIELD_UNKNOWN` | P5 在 `validateShot` 里做映射；映射表建议直接复用 `fieldNames()` |
| U-P4-2 | `checkRequired` 需要上游把 `blockings` / `actions` / `sceneState` / `shotState` 取好再传（本模块不读库） | 取数口径错会得出错误的 S 级 | P8/P9 的调用点必须用**本镜**数据，不用同章缓存 |
| U-P4-3 | `checkEmptyShot` 对"未登记说话人"一律不判 | 真正的"说话人不存在"要靠 V-03/V-04（P5） | 已在 P5 范围登记，不在此处补 |

### C 级（记录即可）

| 编号 | 问题 | 说明 |
|---|---|---|
| U-P4-4 | `facing` 的分隔符写法（`N+30` / `N-45` / `{dir,deg}`）是 D01 未规定的实现选择 | D01 只写"四方位 + 角度"；本轮取三种等价写法并限 `±180`。若上游已有既定格式，改 `checkFacing` 一处即可 |
| U-P4-5 | `occlusion` 的部位写法同样有三种（`partial:arm` / `partial(arm)` / `{type,part}`） | 同上，单点可改 |
| U-P4-6 | D01-02 §4.4 标题「21 值」与逐项 22 值不一致 | 本轮按逐项 22 实现（删值会让合法运镜被拒），D01 已冻结未改；是否需要回改文档交审核决定 |
| U-P4-7 | `checkSchema` 的 `hits` 排序按 `(field, code, level)` 字典序 | 便于确定性断言；若 P5 需要"按规则严重度排序"，在 P5 聚合层再排 |

---

## 十三、复审补记：两个枚举字段 + 三维归一化坐标范围

复审指出 P4 首轮漏了两处，均已确认属实，本轮只补这两处（未动 `posRel`、未动 P0~P3、未进 P5）。

### 13.1 缺口一：枚举表漏了 `spec_source` / `state_source`

| 项 | 内容 |
|---|---|
| 漏项 | `ENUMS` 里没有 `spec_source`（D01-02 §十一）与 `state_source`（D01-04 §5.1） |
| 后果 | 这两个字段的取值是**封闭集合**，且 `spec_source` 直接决定 `posRel` 第⑤级推导（`manual → known` / `legacy → unknown` / 其余 `inferred`）。放行任意字符串等于让"来源"这层可靠性语义失效 |
| 修复 | `enums.js` +15/−1：两份枚举进 `ENUMS`，自动进入 `fieldNames()` / `checkObject()` 体系，走同一个 `check()` |
| 空值口径 | 两者在 D01-05 都有 DDL 默认值（`spec_source TEXT DEFAULT 'ai'`、`state_source TEXT DEFAULT 'none'`）→ `allowEmpty: true`。报"必填缺失"会把默认值场景误判成数据缺陷 |
| 未动 | 其余 22 个枚举字段、`STRUCTURED` 两项、`check()` 的返回结构一字未改 |

### 13.2 缺口二：`norm_xyz` 没查范围

| 项 | 内容 |
|---|---|
| 漏项 | `checkBlockingFields` 对 `norm_x/norm_y/norm_z` 只判"有限数"，没判 D01-04 §四 明写的 `∈ [0,1]³` |
| 后果 | `1.5` / `-0.2` 被放行。下游（S-15 取景半径、越轴判定、渲染归一化）都把它当 0..1 用，出界值到那里才炸，且现场看不出是写入侧换了坐标系 |
| 修复 | `schema.js` +12/−0：新增一个只判"非空且有限"分量的范围循环，`0` 与 `1` 是合法边界，`<0` / `>1` → `SCHEMA_INVALID`（`field` 定位到 `shot_blockings[i].norm_x`，`got` 原样回显） |
| NULL 处理 | **不补 0**：三者同空合法、部分为空仍只报 `COORD_PARTIAL`（S-24 整体性规则）。范围循环只判"已经给了值"的分量，所以"部分空 + 有值分量越界"会同时报两条——整体性错误与范围错误不能互相掩盖 |
| 未动 | `posRel` 五级优先级、`distance_to_camera`（D01 未给上界，只判有限数）、`COORD_PARTIAL` 的判定与 code |

### 13.3 新增测试与 A/B 实证

| 编号 | 覆盖 |
|---|---|
| **P4-T07l** | 两字段值域逐字等于 D01（含 `source` 字段）；全部合法值通过；非法值（含"串用另一字段的值"：`spec_source='solved'`、`state_source='legacy'`）报 `ENUM_INVALID` 且 `expected` 列全；空值三种放行；进 `fieldNames`/`checkObject`；对象塞进字符串枚举报 `ENUM_TYPE_INVALID` |
| **P4-EXT3** | 三个分量 × `{0, 1}` 边界通过；× `{-0.1, -1, 1.0001, 1.5, 2}` 全部拒绝，逐项断言 `field`/`got`；三分量同时出界报三条（不是报第一条就收工） |
| **P4-EXT4** | 三者同空通过、未给坐标通过；三种"部分为空"只报 `COORD_PARTIAL`；部分为空 + 越界 → `SCHEMA_INVALID` + `COORD_PARTIAL`；非有限数（`NaN`/`±Infinity`/`'0.5'`）仍按类型拒；冻结入参不被改写（尤其 `null` 不得变 `0`） |

**A/B**（同一份测试，只换 `enums.js` / `schema.js`）：

| 版本 | 结果 |
|---|---|
| 首轮实现（`5b341fe`） | `P4-T07l` / `P4-EXT3` / `P4-EXT4` **3 条全红**（`ENUM_FIELD_UNKNOWN`、越界值被放行） |
| 本轮修复后 | **53 / 53 pass**（pos-rel 11 + enums 12 + schema 30） |

### 13.4 全量对照（修复后重跑，提交 `5e381e0`）

| 组 | tests | pass | fail | skip |
|---|---:|---:|---:|---:|
| P3 基线 | 515 | 487 | 17 | 11 |
| P4 首轮 | 565 | 537 | 17 | 11 |
| **P4 复审修复后** | **568** | **540** | 17 | 11 |

17 条失败与基线 `diff` **为空**（同名同因，未新增）。真库三文件 SHA-256 与修复前基线逐字相同（`b2ebdb54…` / `2711665d…` / `22d61103…`），`-shm` mtime `1795744805 → 1795744805`；**0 条 DDL、0 条 DML**。

### 13.5 本次修复带出的记录项

`U-P4-8`（C 级）：`norm_z` 的 `[0,1]` 是否该按"离地高度"单独放宽，D01-04 §四 目前只写 `norm_xyz ∈ [0,1]³`，本轮按原文一刀切。若后续把 `norm_z` 改成"米制高度"或允许 `-1..1`（地面以下），改 `checkBlockingFields` 里那一个循环即可，不涉及其他函数。
