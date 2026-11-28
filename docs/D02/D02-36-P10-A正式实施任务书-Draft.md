# D02-36 · P10-A 正式实施任务书（Draft）

> **状态：Draft（未冻结）。不得作为施工依据。**
> 冻结条件见 §12.3；在 19 项决策获批、Gate P1~P7 全部满足之前，本文件只用于**评审与排期**，不产生任何实施授权。
> **基线**：`bf72d30`（D02-34）。本轮零代码、零 DDL、零 `schema-manifest.json`、零正式规范、零真实库写入。
> **架构基线**：19 项决策（D02-35 审批包）+ D02-33/D02-34 的最终口径。**D02-34 已修订的锁协议、A3 差集、V4/V5 验收定义一律作最新版本，不得恢复旧定义。**
> **配套**：`docs/D02/D02-35-P10-A-19项架构决策正式审批包.md`。

---

## 零、本 Draft 的效力与使用方式

### 0.1 能做什么 / 不能做什么

| 能做 | 不能做 |
|---|---|
| 作为 19 项决策的落地映射（哪项决策落到哪个文件） | 不能据此开始编码 |
| 作为 Gate 与验收的排期依据 | 不能据此宣称任何 Gate 已满足 |
| 作为实施报告的结构模板（逐项对照） | 不能替代 D02-33/D02-34 的契约文本 |

### 0.2 权威链（冲突时按此顺序）

1. `docs/D01`（冻结规范）与 `docs/D02/D02-06`（阶段 3 任务书，其中 §8.2.4 待 D-30-03 修订）；
2. D02-35 审批包（19 项决策的呈报文本）；
3. D02-33 §2~§6 + **D02-34 §2/§3/§4**（最终契约，覆盖更早报告）；
4. 本 Draft。

### 0.3 编号体系（不得混用）

| 前缀 | 含义 | 数量 |
|---|---|---|
| `D-30-nn` / `D-31-nn` | 架构决策 | 19，全部待审批 |
| `P1~P7` | 编码启动 Gate（执行层） | 7 |
| `A-0n / B-0n / C-0n / D-0n / E-0n / F-0n` | 本任务书的工作项 | 38 |
| `IMP-01~04` | 三项签名改动 + 内容寻址 | 4 |
| `TST-CA/CFG/AUD/LOCK/VAL-nn` | 测试用例 | 55（全部未执行） |
| `V1~V8` | 实施验收项 | 8 |
| `A1~A8` | 审计对象 | 8 |
| `F1~F21` | 引擎配置字段 | 21 个语义槽 |
| `S1~S5` | 上线顺序（见 §0.4） | 5 |
| `S-01~S-03` | 启动/生命周期写入入口（§4.5） | 3 |
| `U-3x-n` | 未决/未验证事项 | 见 §8.5 |

**三处易混的形近编号（写死区分，避免评审时误读）**：

| 带连字符 | 不带连字符 |
|---|---|
| `A-01~A-08` = 阶段 A 工作项 | `A1~A8` = 审计对象 |
| `S-01~S-03` = 启动写入入口 | `S1~S5` = 上线顺序 |
| `D-01~D-07` = 阶段 D 工作项 | `D-30-nn` / `D-31-nn` = 架构决策 |

### 0.4 一条不可调换的铁律：先接写链，后开门禁

```
S1  Stage 3 写入链可用（story_shots / shot_assets / blocking / actions / 场次）
S2  投影 projectRenderUnits() + 参数入口 ShotParams.update()
S3  shot_videos.input_hash + seg-2 + 候选落库
S4  导出/合成/整章生成的有效性判定升级
S5  最后：Shots.* 加 writer 必填与 structured_spec=1 拒写门禁
```

**理由**：S1~S4 是「新增能力」，任何一步出问题都能靠「不启用」回退；S5 是「收紧既有能力」，一旦先做，新项目（默认 `structured_spec=1`）立刻进入「门禁已上、写链未通」的死区 —— 用户什么都写不了。**顺序颠倒即事故。**

---

## 一、实施目标与范围

### 1.1 七个目标

| # | 目标 | 可验证标志 |
|---:|---|---|
| 1 | Stage 3 结构化创作数据正式接入生产链 | `story_shots`/`shot_assets`/`shot_blockings`/`shot_actions`/`scene_states` 在生产路径上有真实写入者，且都带审计 |
| 2 | 结构化创作镜头与生成段建立稳定映射 | `story_shots.segment_id` 生效，1:N 可查、可重投影、可删段保候选 |
| 3 | 统一创作数据写入权限 | 4 类 writer + 2 个专用入口（投影、参数），缺失 fail-closed，字段组门禁可静态断言 |
| 4 | 建立投影、版本指纹与产物有效性判定 | `seg-2` 指纹落 `shot_videos.input_hash`；4 处出口拦截过期与来源未知 |
| 5 | 接入连续性求解与 QC 结果 | `continuity_runs` 按 uid 定位、三态读取；`shot_states`/`qc_reports` 只由求解与 QC 写 |
| 6 | 建立可靠的审计与并发一致性保障 | A1~A8 审计矩阵生效；`txProject`/`txProjects` 唯入口；`global_no` 在锁内分配 |
| 7 | 保持 legacy 项目正常工作 | `structured_spec=0` 行为零变化；17 条历史失败不增不减 |

### 1.2 范围内

- 阶段 A~F 的全部 38 个工作项（§三）。
- 19 项决策的实现（不含被拒项）。
- 55 项测试的设计、实现与执行（本轮只到「设计」）。
- 正式规范修订：**仅** D02-06 §8.2.4 三处正文（D-30-03）。

### 1.3 范围外（明确不做，防止范围膨胀）

| 不做 | 理由 |
|---|---|
| 双轨**生成编译**的完整实现（同一创作输入编译成两条赛道的产物） | 属阶段 4+；P10-A 只做「A 轨接管 + 共同创作输入可验证」 |
| `orphaned` 视频状态枚举 | 会破 `chapterStats` 的 `done===rows.length` 与 `assemble` 的 `every(done)`（D-30-11） |
| 结构化项目的**内容回滚**系统 | 长期边界（D-30-15）：回滚是整行复原，会绕过全部门禁 |
| `shot_assets`/`shot_blockings` 的**回滚** | 多列主键，`applyInverse` 结构不支持（`ROLLBACK_UNSUPPORTED_ENTITY`） |
| 给 `story_shots` 加 `mode`/三图/`video_prompt` 列 | 段级参数，加在镜表会立刻产生「同段多镜参数冲突」（D-30-07） |
| 新建 `render_params` 表 | 等于把阶段 4 的 `render_units` 提前建一半 |
| 任务调度/重试子系统 | `continuity_runs` 只有「分配号在一个事务里」（RC-6） |
| 切换 PG 为默认 provider | P10-A 只需「PG 可跑通验收」，不要求生产切换 |

### 1.4 双轨关系（必须准确表述）

同一套剧本、资产、导演与分镜数据，最终要分别编译为两条生成赛道：

| 赛道 | 编译目标 | P10-A 的状态 |
|---|---|---|
| **A 轨（Stage 3 结构化）** | `story_shots` + 资产引用 + 站位 + 动作 → 投影为生成段 → 渲染 | **P10-A 接管** |
| **B 轨（legacy）** | `shots` 创作列（`*_ids`/`blocking`/`sub_shots`）→ 渲染 | 保持现状，零改动 |

**P10-A 交付的是「共同创作输入」的可验证性**：同一份 Stage 3 数据既能投影成 legacy 段形状，也能被将来的双轨编译器消费。**不交付双轨编译本身**——把双轨编译提前算进 P10-A，会让本轮的目标从「接管写入」漂移成「重写生成架构」。

### 1.5 完成定义（DoD）

同时满足以下 6 条才算 P10-A 完成：

1. 19 项决策全部「批准」，且 14 项 Gate 决策的实现在代码中可定位；
2. Gate P1~P7 全部满足（含 PG 真库实跑）；
3. V1~V8 全部通过，且 V5-G 中未落地对象如实标「待实现」；
4. 55 项测试全部执行并留证（不允许「设计完成」代替「已执行」）；
5. 全量回归 `950 / 922 / 17 / 11`，17 条同名同因，新增失败 0；
6. 真实库零写入（除用户主动建项目的正常业务写入），且实施报告附三文件 SHA 前后对比。

---

## 二、实体权威与数据流

### 2.1 权威矩阵（12 个对象，冻结）

| 对象 | 表 | 唯一写入权威 | 只读方 | 备注 |
|---|---|---|---|---|
| 项目 | `projects` | `Projects.update`（`writer` 语义由调用方给） | 全链 | `structured_spec` 只由 `structured-spec.js` 读写 |
| 剧本原文 | `chapters.script` / `projects.novel` | `Chapters.*` / `Projects.*` | 分镜生成 | 不由 Stage 3 写 |
| 场次基线 | `scene_states` | `upsertSceneStates`（`txProject`） | 求解、投影、Agent | 身份 = `id`（`scene_uid`） |
| Stage 3 创作镜 | `story_shots` | Stage 3 写入器（`insertStoryShot`/更新器，`txProject`） | 投影、求解、QC、读侧 | 身份 = `id` |
| 生成段 | `shots` | **投影**写 A 组；`ShotParams` 写 B 组；生成链写 C 组；`system` 写 E 组 | 生成链、导出、统计 | 身份 = `id`；不存镜的描述 |
| 镜的资产引用 | `shot_assets` | `writeShotAssets`（差集审计，`txProject`） | 投影、渲染绑定 | 复合主键，无 `project_id` |
| 资产实体 | `assets` | `Assets.*` | 引用、渲染 | 可复用，不复刻 |
| 站位 | `shot_blockings` | 新增写入器（`txProject`） | 投影、求解 | 复合主键 |
| 动作 | `shot_actions` | 新增写入器（`txProject`） | 投影、求解 | 单列主键，无 `project_id` |
| 连续性求解结果 | `shot_states` | 求解器（P9 已建） | QC、读侧 | 派生，非人工输入 |
| QC 报告 | `qc_reports` | QC 规则执行器（P9 已建） | 读侧、导出前置 | 派生 |
| 创作版本快照 | `shot_videos.input_hash` | 生成链在**渲染开始时**写入 | 过期判定 | 见 §五 |

### 2.2 数据流

```
剧本原文 → (分镜生成) → story_shots ─┬─→ shot_assets（资产引用）
                                     ├─→ shot_blockings（站位）
                                     ├─→ shot_actions（动作）
                                     └─→ scene_states（场次基线，按 scene_uid）
                                              │
                                              ├─(求解)→ shot_states ─(QC)→ qc_reports
                                              │
                                              └─(投影 projectRenderUnits)→ shots（A 组 17 列）
                                                                              │
                                                        ┌─────────────────────┤
                                                        │                     │
                                              (ShotParams) → B 组 5 列   (生成链) → C 组 6 列
                                                        │                     │
                                                        └────→ segmentInputHash（渲染开始时冻结）
                                                                              │
                                                                    shot_videos.input_hash
                                                                              │
                                                          过期判定（4 处出口拦截）
```

### 2.3 三条禁止（违反即回滚该次提交）

1. **禁止把求解结果回搬为人工输入**：`shot_states`、`qc_reports`、`continuity_runs` 的任何内容不得写回 `story_shots`/`shots` 的创作列。
2. **禁止同一项目在两套创作权威上独立写入**：`structured_spec=1` 时 `shots` 的 A 组只能由投影写；`=0` 时 Stage 3 表必须保持为空（不由应用层写，`set_scene_state` 已有门禁）。
3. **禁止投影写 B/C/E 组，禁止参数入口写 A 组**：两条 SQL 的列清单互不可见（D-30-04 / D-30-07）。

### 2.4 模式边界

| 能力 | `structured_spec=0` | `structured_spec=1` |
|---|---|---|
| 创作 A 组写入 | `Shots.*(writer='creative')` | Stage 3 写入器 → 投影 |
| 段级参数 B 组 | `Shots.update(writer='creative')` | `ShotParams.update()`（唯一） |
| 产物 C 组 | `Shots.update(writer='render')` | 同左（部分列） |
| 项目参数 E 组 | `Shots.update(writer='system')` | 同左；`resolution`/`aspect_ratio` 权威在 `projects` |
| Stage 3 表 | 必须为空 | 唯一创作源 |
| 内容回滚 | 允许（现状） | **409** |
| 单镜 A 组编辑 | `update_shot(shot_id)` | `update_shot(shot_id, story_shot_id)` |
| 降级 | — | 仅运维脚本 + 五表全空 |

---

## 三、分阶段实施

### 3.0 阶段总览

| 阶段 | 内容 | 对应决策 | 硬依赖 | 退出条件 |
|---|---|---|---|---|
| **A** | 基础设施与数据契约（DDL、manifest、锁、审计元数据、指纹与命名骨架） | D-30-01/02/03/08/09/13/15、D-31-02 | Gate P1/P3/P4 | 迁移可空库跑通；锁与审计单测在 SQLite 绿；PG 五交错实跑通过（P2） |
| **B** | Stage 3 创作写入链（场次、镜、资产引用、站位、动作） | D-30-02/15、D-30-14 | A | 五个写入器均有生产调用方；A1~A5 审计按矩阵生效 |
| **C** | 生成段投影与写权限 | D-30-01/04/07/11、D-31-03 | A、B | 投影与参数入口上线；writer 门禁生效；旧入口完成分流 |
| **D** | 生成输入冻结与产物有效性 | D-30-05/06/08/09/10、D-31-01/02 | A、C | IMP-01~04 落地；`input_hash` 落库；4 处出口拦截 |
| **E** | 连续性与 QC 接管 | D-30-03/12 | A、B | `continuity_runs` 按 uid 写入与三态读取；PF-1 单列验收 |
| **F** | 生产接管与回归 | D-31-04、D-30-14 | A~E | 首结构化项目跑通；降级脚本可用；全量回归达标 |

### 3.1 阶段 A · 基础设施与数据契约

**目标**：把「表结构 + 锁 + 审计骨架 + 指纹骨架 + 命名骨架」一次到位，后续阶段不再改 DDL。

**工作项（结构面）**

| ID | 文件 | 修改目标 | 接口 | DB 变化 |
|---|---|---|---|---|
| A-01 | `lib/core/schema/tables.js`、`lib/core/db.js`（迁移段） | `story_shots` 增 `segment_id TEXT DEFAULT ''`、`scene_uid TEXT DEFAULT ''` | 无（列级） | +2 列 +2 索引（`(project_id,segment_id)`、`(project_id,scene_uid)`） |
| A-02 | 同上 | `continuity_runs` 的 `scene_key` → `scene_uid` | 无 | 1 列改名 + 2 索引重建 |
| A-03 | 同上 | `shot_videos` 增 `input_hash TEXT DEFAULT ''` | 无 | +1 列 |
| A-04 | `scripts/schema/gen-manifest.mjs`、`verify-manifest.mjs`、`lib/core/schema-manifest.json` | 把 `shot_videos` 与 `continuity_runs` 纳入登记；同步三张表的列集 | manifest 生成/校验 | 无 DDL，只改登记 |
| A-05 | `lib/core/db.js`（事务段） | 新增 `txProject`/`txProjects`、6 个错误码、`lockedProjects` 冻结 | `txProject(projectId, fn)`、`txProjects(ids, fn)` | 无 |
| A-06 | `lib/core/changelog.js` | `ENTITY_META.pk` 支持数组；`rawGet` 支持数组键；`projectIdOf` 反查；`applyInverse` 多列主键抛错 | `recordChange` 签名不变 | 无（可能补 `change_logs` 索引） |
| A-07 | 新增 `lib/core/render/input-hash.js` | `SEG_INPUTHASH_ALGO='seg-2'`、`PROMPT_BUILD_VER='pb-1'`、`canonicalJson`、`hashProjectionOf` 骨架 | `segmentInputHash(snapshot)`、`hashProjectionOf(exec)` | 无 |
| A-08 | `lib/core/refs.js`（新增命名函数） | 内容寻址命名：`ic-<64hex><ext>` + 扩展名规范化（嗅探/兜底/失败关闭） | `objectNameOf(buf, hintPath)` | 无 |

**工作项（执行与验收面）**

| ID | 上游依赖 | 下游调用方 | 测试文件 | 测试命令 | 验收证据 | 回滚 |
|---|---|---|---|---|---|---|
| A-01 | D-30-01/02 批准 | 投影、读侧、求解 | `tests/d02-36-a01.test.mjs` | `IC_DATA_DIR=<临时目录> node scripts/test-runner.mjs` | `PRAGMA table_info(story_shots)` 含两列；空库迁移成功日志 | 删列（SQLite 需重建表）；本项目存量 0 行，实际操作为空 |
| A-02 | D-30-03 批准 + 规范修订 | 求解写入/读取 | `tests/d02-36-a02.test.mjs` | 同上 | 列名与两索引 DDL；读法单测 | 反向改名；表 0 行 |
| A-03 | D-30-08 批准 | 生成链、判定 | `tests/d02-36-a03.test.mjs` | 同上 | `PRAGMA table_info(shot_videos)` 含 `input_hash` | 删列；历史 2 行值为 `''` |
| A-04 | A-01~A-03 | 全部后续阶段 | `tests/schema-manifest.test.mjs` | `node scripts/schema/verify-manifest.mjs` | 校验通过的输出 | 回退 manifest 文件 |
| A-05 | D-30-13 批准 | B/C/D/E 全部写入 | `tests/tst-lock-06~13.test.mjs` | 同上（PG 用 `db.provider=postgres`） | 错误码断言 + 取锁序列 spy 日志 | 删除新函数，恢复 `tx()` 调用 |
| A-06 | D-30-15 批准 | Stage 3 四个写入器 | `tests/tst-aud-01~15.test.mjs` | 同上 | 日志条数与 before/after | 恢复单列主键实现（仅当未接入 Stage 3） |
| A-07 | A-06 | D-05 的候选落库 | `tests/tst-cfg-01~17.test.mjs` | 同上 | 键集断言 + 固定向量 | 删除模块（未被调用时） |
| A-08 | 无 | D-04 | `tests/tst-ca-01~06.test.mjs` | 同上 | 名字正则 + 长度断言 | 删除函数 |

**阶段 A 验收**：① 空库可完整迁移，`verify-manifest` 通过；② `TST-LOCK-06~13` 在 SQLite 全绿；③ `TST-LOCK-11~13` 在 **PG 真库**通过（否则 P2 不满足，阶段 A 不得宣告完成）；④ `TST-AUD` 中 A1/A7 部分绿（A2~A5 待 B 阶段）。

**退出条件**：DDL 冻结（此后任何列变更都要走独立决策）。

### 3.2 阶段 B · Stage 3 创作写入链

**目标**：让「用户第一次建场次/镜头」在生产路径上可写，且写进去就有审计。

**工作项（结构面）**

| ID | 文件 | 修改目标 | 接口 | DB 变化 |
|---|---|---|---|---|
| B-01 | `lib/core/scene-state.js` | `upsertSceneStates` 支持按 `scene_uid` 定位；改 `txProject`；补 A1 审计（`state_rev` 进 VOLATILE） | `upsertSceneStates(projectId, rows, {origin})` | 无 |
| B-02 | `lib/core/render/global-no.js` | `insertStoryShot` 允许列加 `segment_id`/`scene_uid`；补 A2 审计；`global_no` 在锁内 `MAX+1` | `insertStoryShot(...)` | 无 |
| B-03 | `lib/core/render/shot-assets.js` | `writeShotAssets` 改差集审计（D02-34 §3.3 算法）+ `txProject` | 签名不变 | 无 |
| B-04 | 新增 `lib/core/render/shot-blockings.js` | 站位写入器（差集审计，复合主键） | `writeShotBlockings(shotId, rows)` | 无 |
| B-05 | 新增 `lib/core/render/shot-actions.js` | 动作写入器（行级审计） | `writeShotActions(shotId, rows)` | 无 |
| B-06 | `lib/agent/tools.js`（`hSetStoryboard`） | 加 `structured_spec=1` 分支：写 `story_shots` 而非 legacy `shots`；未接投影前**只写 Stage 3**（S1 早于 S2） | `set_storyboard` 参数不变 | 无 |

**工作项（执行与验收面）**

| ID | 上游依赖 | 下游调用方 | 测试文件 | 测试命令 | 验收证据 | 回滚 |
|---|---|---|---|---|---|---|
| B-01 | A-01/A-05/A-06 | 场次列表、投影、求解 | `tests/d02-36-b01.test.mjs` | `IC_DATA_DIR=<tmp> node scripts/test-runner.mjs` | 改 key 不改 uid 的用例；A1 日志条数 | 恢复按 key 定位（同时回退 A-01） |
| B-02 | A-01/A-05/A-06 | 分镜生成、投影 | `tests/d02-36-b02.test.mjs` | 同上 | `segment_id` 落库；撞号在锁内串行 | 移除新增允许列 |
| B-03 | A-06 | 投影、渲染绑定 | `tests/tst-aud-08~15.test.mjs` | 同上 | 8 条差集用例（含互换顺序 = 2 条 update） | 恢复整组删除即记日志（不建议） |
| B-04 | A-06 | 投影、求解 | `tests/d02-36-b04.test.mjs` | 同上 | 差集用例；复合主键 `rawGet` 取对行 | 停用（回 `shot_blockings` 文本路径） |
| B-05 | A-06 | 投影、求解 | `tests/d02-36-b05.test.mjs` | 同上 | 行级 create/update/delete | 同上 |
| B-06 | B-01/B-02 | C 阶段投影 | `tests/set-storyboard-structured.test.mjs` | 同上 | 结构化项目写入 `story_shots`，`shots` 不变 | 关掉分支（回到 legacy 写入） |

**阶段 B 验收**：A1/A2/A3/A4/A5 审计逐项按矩阵生效；V5-G 中已落地对象补齐；`set_storyboard` 的结构化分支不产生 legacy `shots` 行。

**注意（写死的顺序）**：B 阶段**不接投影**。此时结构化项目会出现「Stage 3 有镜、`shots` 没有段」的中间态，界面分镜列表为空 —— 这是 S1 阶段的**已知中间态**，必须在 B 阶段报告里明确写「此阶段结构化项目不可用于出片」，不得假装完整。

### 3.3 阶段 C · 生成段投影与写权限

**目标**：把 Stage 3 数据投影成生成段；同时把「谁能写哪些字段」用代码边界冻结。

**工作项（结构面）**

| ID | 文件 | 修改目标 | 接口 | DB 变化 |
|---|---|---|---|---|
| C-01 | 新增 `lib/core/render/project-units.js` | `projectRenderUnits`：A 组 17 列白名单 + 建行 `status='pending'`/`error=''`；幂等 `ON CONFLICT(id) DO UPDATE`；段内 `idx` 排序；0 镜段走专用删除 | `projectSceneUnits({projectId, chapterId, sceneUid, units, writer})` | 无 |
| C-02 | 新增 `lib/core/render/unit-params.js` | `ShotParams.update`：5 列白名单 + 校验 + 写 `change_logs` | `ShotParams.update(unitId, fields, {origin})` | 无 |
| C-03 | `lib/core/db.js`（`Shots.create/insertAt/update/remove`） | `writer` 必填 fail-closed；四方法统一**部分列 UPDATE**；三态语义（键缺失不清空、`undefined` 不清空、`''`/`null` 显式清空） | 四方法签名 +`opts.writer` | 无 |
| C-04 | `lib/core/db.js` 或 `shot-write.js` | `legacyShotWrite(source, fn)`：要求非空 `source`，内部 `writer='creative'`，计数 `LEGACY_WRITER_CALL`；**不持有也不接受 `projectId`**；门禁在 `Shots.*` 内按行解析项目 | `legacyShotWrite(source, fn)` | 无 |
| C-05 | `lib/agent/tools.js`（`update_shot`、`get_shot`） | 加可选 `story_shot_id`；读侧返回 `story_shots[]`；三个错误码 | `update_shot(shot_id, story_shot_id?, patch)` | 无 |
| C-06 | `app/api/projects/[id]/shots/route.js`、`[sid]/route.js` | `POST` 复合入口（三步一事务）；`PATCH` 三分流（B→参数、A→400 提示走 Stage 3、C/E→400） | HTTP 契约不变，错误码新增 | 无 |
| C-07 | `project-units.js` + 静态测试 | 段 0 镜删除用**裸 SQL**；静态断言「`project-units.js` 内 `Shots.remove` 出现 0 次」 | 无 | 无 |

**工作项（执行与验收面）**

| ID | 上游依赖 | 下游调用方 | 测试文件 | 测试命令 | 验收证据 | 回滚 |
|---|---|---|---|---|---|---|
| C-01 | A-01、B-01/B-02/B-03 | `set_storyboard` 分支、`update_shot`、HTTP | `tests/d02-36-c01.test.mjs` | `IC_DATA_DIR=<tmp> node scripts/test-runner.mjs` | 一镜一段/一段多镜两用例；A6 日志增量 0 | 停用投影（回到 B 阶段中间态） |
| C-02 | A-06、C-03 | `PATCH`、`update_shot`、提示词工具 | `tests/tst-aud-07.test.mjs` | 同上 | 5 列白名单；越界路径拒绝；1 条 update | 停用（参数改回 legacy 写） |
| C-03 | D-30-04 批准 | 全部 `Shots.*` 调用方（20 处写入点） | `tests/tst-aud-01~06.test.mjs` | 同上 | 缺 `writer` 抛错且不写库；省略键不覆盖 | 恢复全列 UPDATE（不推荐） |
| C-04 | C-03 | 20 个旧写入点 | `tests/legacy-writer.test.mjs` | 同上 | 包装器计数归零；`=1` 下拒写 | 删除包装器（需先全部显式传 writer） |
| C-05 | A-01、C-01 | Agent 单镜改稿 | `tests/update-shot-structured.test.mjs` | 同上 | 三错误码 + A+B 混合单事务 | 移除参数（回到整批改） |
| C-06 | C-01/C-02 | 前端、Agent | `tests/post-shots-structured.test.mjs` | 同上 | 三步同事务；失败整体回滚 | 恢复 `POST` 裸建（会破坏边界） |
| C-07 | C-01 | 删镜路径 | `tests/static-no-shots-remove.test.mjs` | 同上 | 静态断言计数 = 0 | 无（结构性约束） |

**阶段 C 验收**：任一 Structured 项目可以从 Stage 3 完整投影出段行；`Shots.*` 缺失 `writer` 一律拒绝；`PATCH` 三分流生效；删镜不丢候选（且如实记录「候选不可见」）。

### 3.4 阶段 D · 生成输入冻结与产物有效性

**目标**：让「候选的 `input_hash`」与「实际执行的输入」是同一份；让过期视频出不了成片。

**工作项（结构面）**

| ID | 文件 | 修改目标 | 接口 | DB 变化 |
|---|---|---|---|---|
| D-01 | `lib/core/backend.js`（`uploadTaskInput`） | 收 **buffer**，返回 `{name, sha256, bytes}`；Hash 与上传共用同一份字节（IMP-01） | `uploadTaskInput(projectId, buf, name, mime)` | 无 |
| D-02 | `lib/core/engine-runner.js`（`dataUrlOf`） | 收**冻结的 dataUrl**，不再执行期 `readFileSync`（IMP-02） | `dataUrlOf(frozen)` | 无 |
| D-03 | `lib/core/workflow-runner.js`（`buildWorkflow`） | 收 `sourceText`，一次读取、多次使用（IMP-03） | `buildWorkflow(spec, params, sourceText)` | 无 |
| D-04 | `lib/core/refs.js`、`lib/core/comfyui.js` | 内容寻址命名落地；`overwrite` 语义改为「同身份幂等写」；严格模式留开关但默认关（IMP-04） | `uploadToInput` 内部 | 无 |
| D-05 | `lib/agent/tools.js`（`prepareShotForRender`、`renderShotCandidate`） | 产出 `inputSnapshot`（payload + hash）；`ShotVideos.create` 只落 `prepared.inputSnapshot.hash` | 内部 | 写 `shot_videos.input_hash` |
| D-06 | `lib/agent/tools.js`（生成链回写、`3414` 筛选） | 停写 `video_prompt`/`resolution`/`aspect_ratio`；过期筛选改 `input_hash` 比较 + 字段比较短路 | 内部 | 无 |
| D-07 | 导出路由、`assemble`、BGM 前置、整章筛选 | 4 处拦截 + 1 处统计；共用同一个 `isVideoUsable` 判定函数 | `isVideoUsable(shot, candidate)` | 无 |

**工作项（执行与验收面）**

| ID | 上游依赖 | 下游调用方 | 测试文件 | 测试命令 | 验收证据 | 回滚 |
|---|---|---|---|---|---|---|
| D-01 | A-08 | `refs.js`、RH 上传 | `tests/tst-ca-01~06.test.mjs` | `IC_DATA_DIR=<tmp> node scripts/test-runner.mjs` | 6 处调用点全部传 buffer；sha256 一致 | 恢复传路径（指纹不可信） |
| D-02 | D-01 | 外接引擎通道 | `tests/tst-ca-05.test.mjs` | 同上 | 换文件后执行仍用冻结值（反例 1） | 恢复执行期读盘 |
| D-03 | D-01 | native/RH 工作流 | `tests/tst-ca-06.test.mjs` | 同上 | 同名覆盖后仍用冻结源（反例 2） | 恢复每次重读 |
| D-04 | A-08、D-01 | 三通道 | `tests/tst-ca-01~04.test.mjs` | 同上 | 名字正则；同名不同字节不可能 | 恢复旧命名（跨任务覆盖回来） |
| D-05 | A-07、D-01~D-04 | `ShotVideos.create`、判定 | `tests/tst-val-01.test.mjs` | 同上 | 反例：渲染中改台词 ⇒ 候选判过期 | 停止写入（判定退化为字符串比较） |
| D-06 | D-05 | 整章生成 | `tests/tst-val-02.test.mjs` | 同上 | 不再全量重渲；日志无漂移误判 | 恢复写三键 |
| D-07 | D-05 | 导出、合成、BGM、整章 | `tests/tst-val-03~04.test.mjs` | 同上 | 4 处拦截断言；`input_hash=''` 拒导出 | 移除拦截（不建议） |

**阶段 D 验收**：V1（内容寻址）、V2（快照一致性）、V3（指纹覆盖）、V6（行为替换）、V7（fail-closed）全部通过；两个反例的测试为**结构性不可达**而非「碰巧没发生」。

### 3.5 阶段 E · 连续性与 QC 接管

**目标**：`continuity_runs` 按 `scene_uid` 写入与读取；求解与 QC 读真实 Stage 3 数据；失败不留半完成状态。

**工作项（结构面）**

| ID | 文件 | 修改目标 | 接口 | DB 变化 |
|---|---|---|---|---|
| E-01 | 求解边界模块（新增或并入 `lib/core/continuity/`） | `continuity_runs` 写入：`run_no` 事务内分配（RC-1/RC-2）；成功与状态同事务、失败单独短事务 | `recordContinuityRun(...)` | 写 `continuity_runs` |
| E-02 | 同模块 | 三态读取 `available/degraded/unknown` + 最新一条（`run_no` 最大，非 `created_at`） | `lastContinuityRun(projectId, sceneUid)` | 无 |
| E-03 | 求解输入组装 | 从 `story_shots`/`shot_assets`/`shot_blockings`/`shot_actions` 读真实数据；只给 `scene_key` 时写入期解析 uid，解析失败即拒跑（U-35-1） | 内部 | 无 |
| E-04 | `lib/core/continuity/*`（`shot_states` 持久化） | 读侧扩展：结构化项目按段/镜写 `shot_states`；不改既有列 | 内部 | 无 |
| E-05 | 启动修复（`db.js` 启动段或独立 scanner） | 崩溃后扫描：未完成 `continuity_runs` 由**启动扫描**判定，不由崩溃进程自己写失败 | `scanInterruptedRuns()` | 写 `continuity_runs` 状态 |

**工作项（执行与验收面）**

| ID | 上游依赖 | 下游调用方 | 测试文件 | 测试命令 | 验收证据 | 回滚 |
|---|---|---|---|---|---|---|
| E-01 | A-02/A-05 | 求解、读侧 | `tests/d02-36-e01.test.mjs` | `IC_DATA_DIR=<tmp> node scripts/test-runner.mjs` | 并发两写不撞 `run_no`；失败记录独立提交 | 停写（回到 `degraded`） |
| E-02 | E-01 | API、UI | `tests/d02-36-e02.test.mjs` | 同上 | 三态各自用例；`latest` 为空 ≠ `ok` | 同上 |
| E-03 | B-01~B-05 | 求解 | `tests/d02-36-e03.test.mjs` | 同上 | 真实 Stage 3 数据产出的求解输入快照 | 回到 legacy 读 |
| E-04 | E-03 | QC、读侧 | `tests/d02-36-e04.test.mjs` | 同上 | `shot_states` 行数与内容 | 停写（状态退回内存） |
| E-05 | E-01 | 启动流程 | `tests/d02-36-e05.test.mjs` | 同上 | 模拟中断后扫描修复；锁不残留 | 移除扫描（僵尸记录留存） |

**阶段 E 验收**：PF-1（D-30-12）**单列验收**，三态之一：「未批 / 已批 / 已批且验收通过」；未批前所有连续性相关能力只能给 `degraded`，**永不给 `current`**。

**状态值域纪律**：`continuity_runs.status` 只允许 `ok`/`failed`；能力状态（`available`/`degraded`/`unknown`）**不是**该列的值，二者不得混用。

### 3.6 阶段 F · 生产接管与回归

**目标**：第一个结构化项目真实跑通；降级路径可用；全量回归达标。

**工作项（结构面）**

| ID | 文件 | 修改目标 | 接口 | DB 变化 |
|---|---|---|---|---|
| F-01 | 无（演练 + 文档） | 激活路径：建项目即 `=1`、空态合法、无初始化步骤；首项目演练脚本化 | 无 | 无 |
| F-02 | 新增 `scripts/set-structured-spec.mjs` | 降级脚本：五表 + `shot_videos` 全空前置；调 `setStructuredSpec`；审计沿用 | CLI | 写 `projects.structured_spec` |
| F-03 | 验证脚本/报告 | 双轨共同创作输入：同一 Stage 3 数据 → legacy 段形状 → 可渲染 | 无 | 无 |
| F-04 | 全量测试 | 回归 + 17 条逐条对比 | 无 | 无 |
| F-05 | `docs/D02`、运维手册 | 激活/降级/回滚/排障手册 | 无 | 无 |

**工作项（执行与验收面）**

| ID | 上游依赖 | 下游调用方 | 测试文件 | 测试命令 | 验收证据 | 回滚 |
|---|---|---|---|---|---|---|
| F-01 | A~E | 用户建项目 | 手工演练 + 脚本 | `IC_DATA_DIR=<tmp> node scripts/test-runner.mjs` | 首项目全流程截图与日志 | 删项目（隔离库） |
| F-02 | D-31-04 批准 | 运维 | `tests/d02-36-f02.test.mjs` | `node scripts/set-structured-spec.mjs --project <id>` | 空表可降级；有内容拒；审计行 | 反向执行（重新开启） |
| F-03 | C、D | 验收 | `tests/d02-36-f03.test.mjs` | 同上 | 同一输入两条编译路径的产物对照 | 无 |
| F-04 | A~E | 验收 | 全量 | `IC_DATA_DIR=<tmp> node scripts/test-runner.mjs` | `950 / 922 / 17 / 11` + 17 条 diff 为空 | 不适用 |
| F-05 | 全部 | 运维 | 文档审阅 | — | 手册可照做 | 不适用 |

**阶段 F 验收**：首结构化项目能从建项目 → 建场次 → 建镜 → 投影 → 渲染 → 导出完整跑通；降级脚本在空表上可用、在有内容时拒绝；全量回归达标。

---

## 四、写入权限矩阵

### 4.1 字段分组（`shots` 35 列；17 / 5 / 6 / 4 / 3）

| 组 | 数量 | 字段 |
|---|---:|---|
| **A 创作**（Stage 3 有落点 16 + 遗留 1） | **17** | `idx`、`chapter`、`scene_name`、`camera`、`visual`、`dialogue`、`narration`、`sub_shots`、`blocking`、`duration`、`character_ids`、`scene_ids`、`prop_ids`、`costume_ids`、`age_ids`、`audio_ids`、`refs` |
| **B 段级生成参数** | **5** | `video_prompt`、`mode`、`first_frame_path`、`last_frame_path`、`reference_image_path` |
| **C 产物** | **6** | `video_prompt_used`、`video_path`、`seed`、`status`、`error`、`prompt_id` |
| **D 系统** | **4** | `id`、`project_id`、`created_at`、`updated_at` |
| **E 快照/兼容** | **3** | `resolution`、`aspect_ratio`、`parent_shot_id` |

`refs` 是 A 组唯一的**遗留字段**：无 Stage 3 落点、无生成消费方 ⇒ 结构化项目**拒绝写入**（报错，不静默忽略）。

### 4.2 writer × 组（四方法统一部分列 UPDATE）

| writer | A（17） | B（5） | C（6） | D（4） | E（3） |
|---|---|---|---|---|---|
| `creative`（`=0`） | ✅ | ✅ | ❌ | 仅 `updated_at` | ❌ |
| `creative`（`=1`） | ❌（转 Stage 3） | ❌（转参数入口） | ❌ | 仅 `updated_at` | ❌ |
| `render` | ❌ | ❌ | ✅ | 仅 `updated_at` | ❌ |
| `system` | ❌ | ❌ | ❌ | `updated_at` | ✅ |
| 投影（不属 writer） | ✅ | ❌ | 建行仅 `status`/`error` | ❌ | ❌ |
| `ShotParams`（不属 writer） | ❌ | ✅ | ❌ | `updated_at` | ❌ |

**writer / 专用入口 × 表 × 操作（谁能碰哪张表）**

| 写者 | 表 | 操作 | 字段范围 |
|---|---|---|---|
| `creative` | `shots`（仅 `=0`） | INSERT / UPDATE / DELETE | A 组 + B 组（`=0` 下） |
| `creative` | `story_shots`、`shot_assets`、`shot_blockings`、`shot_actions`、`scene_states`（仅 `=1`） | INSERT / UPDATE / DELETE | 各表业务列（经 Stage 3 写入器） |
| `render` | `shots` | UPDATE（部分列） | C 组 6 列 |
| `render` | `shot_videos` | INSERT（`ShotVideos.create`，含 `input_hash`）/ UPDATE（`selected`，经 `setSelected`） | 候选行 |
| `system` | `shots` | UPDATE（部分列） | E 组 3 列 + `updated_at`；启动修复仅 `status`/`error` |
| `system` | `projects` | UPDATE | 项目参数（含 `video_resolution`/`video_aspect_ratio`/`video_width`/`video_height`） |
| 投影 `projectRenderUnits` | `shots` | INSERT / UPDATE（`ON CONFLICT(id)`）/ 专用 DELETE | A 组 17 列 + 建行 `status`/`error` |
| 投影 `projectRenderUnits` | `story_shots` | UPDATE | **仅 `segment_id`**（回写段归属；段内顺序写 `shots.idx`，属 A 组） |
| `ShotParams.update` | `shots` | UPDATE（5 列白名单） | B 组 5 列 + `updated_at` |
| 求解器 | `shot_states`、`continuity_runs` | INSERT / UPDATE | 求解产物与执行记录（A8，不记日志） |
| QC 执行器 | `qc_reports` | INSERT | 报告（A8，不记日志） |

> **一处必须定的细节（登记 U-36-2，不阻断编码）**：投影回写 `story_shots.segment_id` 会触发 A2 的 update 审计，若每次重投影都为每个镜产生一条日志，会把内容日志淹掉。建议把 `segment_id` 写入 `VOLATILE.story_shot`（它是投影派生的归属指针，不是创作内容）；此判断在 B/C 阶段落地时确认，不由本 Draft 单方面决定。

### 4.3 四个服务方法的门禁形态

| 方法 | 门禁 | 结构化 `=1` 行为 |
|---|---|---|
| `Shots.create` | `writer` 必填 + 组校验 | **拒绝**（段行只由投影建） |
| `Shots.insertAt` | 同上 | **拒绝**（插入分镜走复合入口） |
| `Shots.update` | `writer` 必填 + `Object.keys(fields)` 分组校验 + 部分列 SQL | A 组拒（转 Stage 3）、B 组拒（转参数入口）、C 组仅 `render`、E 组仅 `system` |
| `Shots.remove` | `writer` 必填 | **拒绝**（删镜走 Stage 3；删段行走投影专用裸 SQL） |

**三态语义（写死，D02-31 §7.4）**：`fields` 里**键缺失** ⇒ 不写该列；**值为 `undefined`** ⇒ 不写该列；**值为 `''`/`null`** ⇒ 显式清空。**禁止**「缺失即落默认」——`status:null` 会静默重置成 `pending`，属危险行为，必须在同一次改动里堵掉。

### 4.4 七条硬规则

| # | 规则 | 违反后果 |
|---:|---|---|
| 1 | `writer` 缺失 **fail-closed**，不写库、不默认 `creative` | 兼容包装器重新获得全部权限 |
| 2 | 结构化项目**不得**通过 legacy `Shots.*` 写 A 组 | 两套创作权威并存，投影覆盖用户改动 |
| 3 | 投影**不得**借 `system` writer 规避权限 | 投影若获得 system 权限即可写 E 组，破坏项目级权威 |
| 4 | 生成侧**不得**覆盖创作侧权威字段（A/B 组） | 每次渲染都产生漂移误判 + 用户修改被覆盖 |
| 5 | Agent 单镜更新必须区分 `shot_id`（段）与 `story_shot_id`（镜） | 改错镜且无从察觉 |
| 6 | `legacyShotWrite(source, fn)` 的 `source` **仅用于审计**，不构成授权凭据 | 「填个非空 source 就能写」= 门禁形同虚设 |
| 7 | 包装器**不持有、也不接受** `projectId` | 接受 `projectId` 等于开一条绕过口（门禁按行解析项目，不信任调用方声明） |

### 4.5 入口处置清单

**四个口径不可相加**：业务入口 21（HTTP 13 + Agent 7 + 任务阶段 1）+ 启动/生命周期 3 + 服务层方法 8 + 直写 SQL 7。业务入口内部的多次服务调用只计 1；启动入口与它执行的 SQL 是同一写入的两个视角。

**业务入口（21）**

| ID | 位置 | 调用方 | `=1` 处置 |
|---|---|---|---|
| H-01 | `shots/route.js:59` | HTTP | 拒绝裸建 → 复合入口 |
| H-02 | `shots/[sid]/route.js:35` | HTTP | 三分流：B→参数、A→400、C/E→400 |
| H-03 | `shots/[sid]/route.js:48` | HTTP | 拒绝 → Stage 3 删镜 |
| H-04 | `videos/[vid]/route.js:23~25` | HTTP | 允许（`render` + 部分列） |
| H-05 | `select/route.js:18` | HTTP | 允许（同上） |
| H-06 | `storyboard/route.js:64/67` | HTTP | 转 Stage 3（整章重写） |
| H-07 | `storyboard/import/route.js:109` | HTTP | 转 Stage 3 |
| H-08 | `chapters/[cid]/route.js:32` | HTTP | 转 Stage 3（改 `chapter_id` + 重投影） |
| H-09 | `chapters/[cid]/route.js:57` | HTTP | 允许，但同事务删 Stage 3 |
| H-10 | `chapters/[cid]/regenerate/route.js:30` | HTTP | 转 Stage 3（删本章 `story_shots`） |
| H-11 | `projects/[id]/route.js:26` | HTTP | 允许（`system`，E 组） |
| H-12 | `projects/[id]/route.js`（DELETE） | HTTP | 允许，但同删 Stage 3 |
| H-13 | `logs/rollback/route.js:17` | HTTP | **409** |
| A-01 | `tools.js:2040`（写入段 2188/2256/2260） | Agent | 转 Stage 3 + 投影 + 参数 |
| A-02 | `tools.js:2357` | Agent | 分流（A→Stage 3、B→参数） |
| A-03 | `tools.js:2472/2564` | Agent | B→参数；C 保留 |
| A-04 | `tools.js:2513/2520/2534/2538/2539/2541` | Agent/内部 | 允许（`render` + 候选带 `input_hash`） |
| A-05 | `tools.js:3469/3470/3474/3484` | Agent | 允许 + 筛选改指纹 |
| A-06 | `tools.js:2970` | Agent | 转参数入口 |
| A-07 | `tools.js:3158/3366` | Agent | 转参数入口 |
| J-01 | `stages.js:306` | 任务阶段 | 转 Stage 3（写 `shot_assets`） |

**启动/生命周期（3，均直写）**

| ID | 位置 | 写入 | `=1` 处置 |
|---|---|---|---|
| S-01 | `db.js:400` | `video_prompt_used` 历史补值 | 保留（仅 C 组） |
| S-02 | `db.js:413` | `chapter='第1章'` 回填 | **结构化跳过**（`chapter` 由投影写） |
| S-03 | `db.js:516` | `status` 复位 | 保留（仅 C 组） |

**服务层方法（8）**：`Shots.create/insertAt/update/remove`、`ShotVideos.create/remove/deleteByShot/setSelected`。前四者加 `writer` 与组门禁；`ShotVideos.create` 加 `input_hash`；后三者签名不变（但投影**不得**调用 `deleteByShot`）。

**直写 SQL（7）**：Q-01 `DELETE FROM <table> WHERE <pk>=?`、Q-02 整行复原（`INSERT OR REPLACE`/`ON CONFLICT DO UPDATE`，**最危险**）、Q-03/Q-04/Q-05 启动三条、Q-06/Q-07 项目/章节级联删除。结构化处置：Q-01/Q-02 整条路径拒绝；Q-04 跳过；Q-06/Q-07 同删 Stage 3。

### 4.6 复合入口 `POST /shots` 的三步事务

```
txProject(projectId, () => {
  ① insertStoryShot(...)         // 写 story_shots（A 组内容）
  ② projectRenderUnits(...)      // 建段 + 回写 segment_id
  ③ ShotParams.update(...)       // mode + 三张图
})
```

返回新段 id 与 `story_shot_id`。三步任一步失败 ⇒ 整体回滚（不允许「镜建了段没建」的中间态）。`insert_at` 语义映射为「新镜的 `global_no` 插在该位置 + 全段重投影」。

---

## 五、生成输入指纹

### 5.1 组定义与语义

| 组 | 是否进指纹 | 说明 |
|---|---|---|
| A 创作 17 列 | 进（经 `covered`，且仅当 fallback 提示词路径真正使用） | 超集声明见 §5.8 |
| B 段级参数 5 | 进（`prompt`、`mode`、三图的内容摘要） | 三图进的是**文件内容**，不是路径 |
| C 产物 6 | **不进** | 产物不能成为自己的输入 |
| E 快照 3 | **生效值**进（`resolution`/`aspectRatio` 取项目权威值） | 不读 `shots` 快照 |
| `seed` | **不进** | 每候选一次随机，含它等于生成完立刻过期 |

### 5.2 `seg-2` 结构（可直接照此实现）

```
sha256(canonicalJson({
  algo: 'seg-2',
  exec: hashProjectionOf(exec),          // 见 §5.3，白名单构造
  promptBuild: 'pb-1',
  prompt: <送模型的提示词原文（编译前）>,
  output: { resolution, workflowResolution, aspectRatio, width, height, scale },
  timing: { seconds },                    // 1 位小数
  mode: <生效后的 mode>,
  media: [ { i, type, role, ref, sha256, bytes } ],   // i 即参考编号
  covered: [ { id, globalNo, duration, dialogue, narration, visual, camera,
               subShots, blocking, characterIds, sceneIds, propIds,
               costumeIds, ageIds, audioIds } ]
}))
```

存储值 `'seg-2:' + hex`。规范化：键按 `cmpStr` 升序；`media` 用绑定顺序；`covered` 按 `global_no` 升序、同号按 `id`；UTF-8 不做 NFC；缺失键不出现、显式空串写 `''`。

**排除清单**：`seed`、`filename_prefix`、上传后的平台文件名、`prompt_id`、`status`/`error`/`video_path`/`video_prompt_used`、`updated_at`、`scene_name`、`chapter`、`idx`、`shots.refs`。

### 5.3 `ExecConfig` 与 `HashProjection` 是两个结构

| 结构 | 内容 | 生命周期 |
|---|---|---|
| `ExecConfig` | 引擎 21 个语义槽 + 后端判别 + **秘密**（`apiKey`） | 只在内存，随渲染丢弃；**永不落库、永不整体进日志** |
| `HashProjection` | 白名单：`{ backend, provider, hardware, endpoint, engine: null 或 { id, family, model, baseUrlSha256, submitPath, outputUrlPath, templateSha256, extraHeadersSha256, syncMode }, specId, specKind, promptFormat, specSha256 }` | 随 `input_hash` 落库（仅摘要） |

**构造规则（H1~H6）**：逐字段显式赋值；禁 `{...exec}`；禁 `delete p.apiKey`；单测断言键集等于冻结列表；新增字段默认不进（要进必须同时改白名单与 `SEG_INPUTHASH_ALGO`）；构造函数体内不得读取 `apiKey`；白名单变更必然升版本。

**21 个语义槽的四态**（F18 为 `doneValues`/`failValues` 两键按一槽计）：9 进投影（F1 `id`、F3 `kind`→`family`、F6 `baseUrl`、F7 `model`、F11 `submitPath`、F12 `requestTemplate`、F19 `outputUrlPath`、F20 `extraHeaders`、F21 `syncMode`）；1 明确排除（F8 `apiKey`）；11 不进但保存（F2 `name`、F4 `enabled`、F5 `tasks`、F9 `authHeader`、F10 `authPrefix`、F13 `taskIdPath`、F14 `pollPath`、F15 `pollMethod`、F16 `pollBody`、F17 `statusPath`、F18 `doneValues`/`failValues`）。

### 5.4 媒体与绑定集

- 指纹里的 `media[]` 是**实际绑定集**，不是声明集：换装/年龄替换角色图、超 7 图截断道具、缺文件跳过，都会改变绑定集。
- `sha256` 对**本地文件字节**算，不对上传后的名字算。
- 缺失文件写 `'missing'` 哨兵（生成期本就会抛错，但指纹要能表达「文件没了」）。
- 缓存键 `(absPath, size, mtimeMs)`；**渲染时强制实算**，判定时允许命中缓存。

### 5.5 时点契约（八问）

| # | 问题 | 答案 |
|---:|---|---|
| 1 | Hash 计算时点 | `prepareShotForRender` 内，媒体/工作流/配置**各读一次**之后立即算 |
| 2 | 媒体实际读取时点 | 同一次读取；buffer 既用于 Hash 也用于上传（IMP-01） |
| 3 | 工作流配置读取时点 | 同一次读取；源文本传入 `buildWorkflow`（IMP-03） |
| 4 | 外接引擎配置读取时点 | 准备阶段快照；`dataUrlOf` 收冻结值（IMP-02） |
| 5 | `runWorkflow()` 消费什么 | 只消费冻结后的快照，不再回读文件或数据库 |
| 6 | `ShotVideos.create()` 的 Hash 来源 | `prepared.inputSnapshot.hash`，**唯一来源** |
| 7 | 中途被替换怎么办 | 不影响本次渲染（已冻结）；下一次渲染自然算出新指纹 ⇒ 旧候选过期 |
| 8 | 是否允许自动重试 | 允许，但**必须重新生成快照**；重试不得复用上一次的 `inputSnapshot` |

### 5.6 三条禁令 + 一个必测反例

**禁令**：① 禁止在渲染结束后回读数据库重算指纹；② 禁止把 `seed` 放进指纹；③ 禁止在候选创建失败时补写「事后指纹」。

**必测反例**：stub `runWorkflow` 在提交后、返回前修改 `shots.dialogue`；断言候选落库的 `input_hash` **不等于**渲染结束后的现算指纹（即该候选被判过期）——而不是相等。

**另两个反例（V2）**：① Hash 完成后、媒体上传前替换图片文件 ⇒ 上传的仍是冻结字节；② Hash 完成后、工作流执行前覆盖同名自定义工作流 ⇒ 执行的仍是冻结源文本。

### 5.7 语义边界（不得松口）

`input_hash` 是「渲染时刻的段输入版本」，**不是**「模型输入字节证明」。`covered` 是超集（A 组内容只在 fallback 提示词路径下才真正成为模型输入）。对外展示、导出说明、错误信息都不得把它描述成「这份视频就是由这些字节生成的」。

---

## 六、审计、锁与回滚

### 6.1 并发协议

**唯一入口**：`txProject(projectId, fn)`。所有源数据写入必须在其内。

| 项 | SQLite | PostgreSQL |
|---|---|---|
| 互斥 | `BEGIN IMMEDIATE`（库级） | `pg_advisory_xact_lock(hashtextextended(id,0))`（项目级） |
| 超时 | `busy_timeout=5000` | `SET LOCAL lock_timeout='5s'` |
| 项目锁作用 | 仅契约记账 | 真实互斥 |
| 释放 | `COMMIT`/`ROLLBACK` | 随事务自动释放，崩溃不残留 |

**8 条规则**：`txProjects` 只能最外层；集合开门前一次定死；`cmpStr` 排序取锁；事务内不得增锁（`Object.freeze`）；已持锁后调 `txProjects` 一律拒绝；同项目嵌套复用；多项目必须在最外层声明完整集合；无法提前确定集合的操作**拒绝**并要求调整事务边界。

**6 个错误码（封闭集）**：`TX_MUST_BE_IMMEDIATE`、`TX_CROSS_PROJECT_NESTED`、`TX_NESTED_MULTI_PROJECT`、`TX_TOO_MANY_PROJECTS`、`TX_EMPTY_PROJECT_SET`、`TX_LOCK_SET_CORRUPT`。

**必须参加的写入方（S1~S10）**：`upsertSceneStates`、`writeStoryShotWithAssets`/`insertStoryShot`、`renumberTwoPhase`/`appendStoryShots`、`writeShotAssets`、`shot_blockings`/`shot_actions` 写入器、`Projects.update`、`setStructuredSpec`、`projectRenderUnits`、`ShotParams.update`、`rollbackLogs`（结构化 409 故不参与）。

**25 处 `tx(() =>`（`lib` 21 + `app` 4）**：P10-A 开工前必须逐处判定「保持 `tx` / 升级 `txProject` / 改 `txProjects`」并写理由 —— 这是 Gate P5，未完成不得开工。

### 6.2 A1~A8 审计矩阵

| # | 对象 | 表 | 实体标识 | create | update | delete | VOLATILE |
|---|---|---|---|---|---|---|---|
| A1 | 场次基线 | `scene_states` | `id` | 应有 | 应有 | **不适用**（无删除接口） | `state_rev`、`updated_at` |
| A2 | 镜 | `story_shots` | `id` | 待实现 | 待实现 | 待实现 | `updated_at`、`voice_ids` |
| A3 | 资产引用 | `shot_assets` | `(shot_id, role, asset_id)` | 差集 added | 差集 changed（`order_no`/`variant_of`） | 差集 removed | 无（表无时间列） |
| A4 | 站位 | `shot_blockings` | `(shot_id, character_id)` | 待实现（差集） | 待实现 | 待实现 | 无 |
| A5 | 动作 | `shot_actions` | `id` | 待实现 | 待实现 | 待实现 | 无 |
| A6 | 投影字段 | `shots` | `id` | **应无** | **应无** | **应无** | — |
| A7 | 段级参数 | `shots` | `id` | 不适用 | 应有 | 不适用 | 用既有 `VOLATILE.shot`（不含这 5 列 ⇒ 会记） |
| A8 | 派生/执行/求解产物 | `render_units`/`render_unit_shots`/`prompt_packages`/`continuity_runs`/`shot_states` | — | **应无** | **应无** | **应无** | — |

**审计失败与业务同事务回滚**（fail-closed）：「改了但查不到」与「没改」事后不可区分，而审计的全部价值就是区分这两件事。

### 6.3 复合主键改造（前置项，不可跳）

| 表 | 主键 | 有 `id` | 有 `project_id` |
|---|---|---|---|
| `shot_assets` | `(shot_id, role, asset_id)` | 无 | 无 |
| `shot_blockings` | `(shot_id, character_id)` | 无 | 无 |
| `shot_actions` | `id` | 有 | 无（经 `shot_id` 反查） |

**必须改三处**：`ENTITY_META.pk` 支持数组；`rawGet` 支持数组键（单列时行为不变）；`projectIdOf` 对复合表走 `story_shots` 反查；`applyInverse` 对多列主键**一律抛** `ROLLBACK_UNSUPPORTED_ENTITY`。

**为什么不能跳**：`WHERE pk=?` 对复合表会匹配多行、`get()` 静默返回第一行（审计快照写错行且看不出错）；`ON CONFLICT (pk)` 直接 SQL 报错。

**四项源码缺口（实施时必须逐条改，不得假设现有审计系统已支持）**

| # | 缺口 | 现状证据 | 本次要做的 |
|---:|---|---|---|
| 1 | `ENTITY_META` 未登记任何 Stage 3 实体（含 `shot_asset`） | 只有 6 个实体：`project`/`chapter`/`shot`/`asset`/`reference`/`render_selection` | 按 A1~A5 逐个补条目 + `VOLATILE` |
| 2 | `recordChange()` 对未登记实体**静默返回 null** | 无异常、无日志、调用方以为成功 | 补登记后该路径不该再被走到；**是否把「未登记」升级为抛错属新增行为，需用户另行确认**（登记 U-36-1）。在确认前，最低要求是 `console.warn` + 计数，不得静默 |
| 3 | `rawGet()` 只支持单列主键 | 拼 `WHERE <pk> = ?` | 支持数组键；单列时行为不变 |
| 4 | 复合主键实体的回滚策略未定 | `applyInverse` 拼 `ON CONFLICT (<pk>)` | 多列主键**一律** `ROLLBACK_UNSUPPORTED_ENTITY` |

> 缺口 2 的改造会波及既有 6 个实体的调用方：改造前必须先确认这 6 个实体在 `ENTITY_META` 中的键名与调用方传入的 `entity` 完全一致，否则会把原本「静默跳过」的调用变成抛错。这是一处**必须配回归**的改动。### 6.4 A3 差集算法（D02-34 §3.3，唯一）

```
txProject(projectId, () => {
  before = SELECT * FROM shot_assets WHERE shot_id=? ORDER BY role, order_no
  after  = 解析出的规范行
  added/removed/changed 基于键 (role, asset_id) 计算
  记录：removed→delete、added→create、changed→update（before/after 全行）
  物理写入：仍为 DELETE 全组 + INSERT 全组（不改）
})
```

| 变化 | 审计 | 条数 |
|---|---|---|
| 完全相同 | 不记录 | 0 |
| 仅 `order_no` 或仅 `variant_of` | update | 1/行 |
| 两者同变 | 仍 1 条 update | 1/行 |
| `asset_id` 或 `role` 变 | 旧键 delete + 新键 create | 2 |
| 新增/删除绑定 | create / delete | 1/行 |

**上界**：`日志条数 = |added| + |removed| + |changed| ≤ |before| + |after|`（进测试）。**计算必须在物理写入之前、同一事务内**。

### 6.5 回滚边界

| 场景 | 行为 |
|---|---|
| 结构化项目内容回滚 | **409**，长期边界；UI 文案固定 |
| 多列主键实体（`shot_assets`/`shot_blockings`） | `ROLLBACK_UNSUPPORTED_ENTITY`，任何项目都拒 |
| 旧项目（`=0`）回滚 | 行为不变 |
| 成片文件 | 备份目录 + restore 复制为新文件，不覆盖现有成片 |
| Stage 3 版本恢复机制 | **不做，且不在 P10 范围内** |

---

## 七、连续性运行记录与恢复

### 7.1 表结构与生命周期（8 列 2 索引）

| 列 | 类型 | 说明 |
|---|---|---|
| `id` | TEXT PK | `uid()` |
| `project_id` | TEXT NOT NULL | 归属 |
| `scene_uid` | TEXT NOT NULL | **身份**（D-30-03 改名后） |
| `run_no` | INTEGER NOT NULL | 项目+场次内递增，成功与失败共用序列 |
| `input_hash` | TEXT NOT NULL | 与 `solverInputHash()` 同一个函数，`sha256:` 前缀 |
| `status` | TEXT NOT NULL | **只有** `ok` / `failed` |
| `error_code` | TEXT DEFAULT '' | `ok` 时 `''` |
| `created_at` | INTEGER | 同事务取同一个 `now()` |

索引：`UNIQUE (project_id, scene_uid, run_no)`、`INDEX (project_id, scene_uid, run_no DESC)`。

**不建外键、不进 `changelog`、不参与 QC 统计、不进 `version` 类接口。**

### 7.2 写入时机与分配纪律

| 场景 | 写什么 |
|---|---|
| 求解成功 | 一行 `ok`，**与 `shot_states` 写入同事务**（失败一起回滚） |
| 求解抛错 | 一行 `failed`，**单独短事务立即提交** |
| 同输入重跑成功 | 新一行 `ok`，`run_no+1`，旧 `failed` 自动不再是最新 |

**RC-1~RC-6**：`run_no` 分配必须在事务内；禁止裸 `SELECT MAX(run_no)+1`；「最新」只认 `run_no` 最大（不认 `created_at`）；失败与成功不得错序覆盖；重试耗尽 ⇒ `CONTINUITY_RUN_RECORD_FAILED`，**不得**在没有执行记录时继续写状态；不得扩展成调度/重试子系统。

### 7.3 崩溃恢复（不依赖崩溃进程自己写失败）

```
启动扫描：
  1. 找 status 仍为「进行中」语义的记录（由 run 的存在性与 shot_states 的缺失共同判定）
  2. 补写 failed + error_code = CONTINUITY_RUN_INTERRUPTED
  3. 不修改任何 shot_states（求解结果本就应缺失）
```

**关键**：崩溃的进程无法写自己的失败状态，因此判定必须由**下一次启动**完成；扫描必须是幂等的（重复扫描不产生重复记录）。

### 7.4 三态读取（唯一口径）

```
capability = probeContinuityTracking()
unknown   → { status:'unknown' }
degraded  → { status:'degraded' }
available → latest = 按 run_no DESC LIMIT 1
            lastRun = latest ?? { status:'' }     // '' = 该场从未求解，不得当成 ok
```

三条读法：`latest` 为空 = 从未求解（等同 `unavailable`）；`status=''` 只在 `available` 下有意义且**不得**解释为 `ok`；读表抛错一律 `unknown`（fail-closed），不得退化成「没有失败」。

### 7.5 失败不得留下半完成状态（求解与 QC 各自的口径）

| 失败类型 | 允许留下的 | 严禁留下的 |
|---|---|---|
| 连续性求解失败 | 一行 `continuity_runs(status='failed', error_code=...)`；**不写** `shot_states` | 「有 `shot_states` 但无 run 记录」；「有 run 记录但状态为 `ok` 却无状态行」 |
| QC 执行失败 | 一行失败标记（按既有 QC 失败通道）；**不生成** `qc_reports` | 用旧 PASS 报告冒充当前结论 |
| 段投影失败 | 整批回滚，返 `UNIT_PROJECTION_FAILED`（带 chapterId + 首个失败 unitId） | 「部分段已写、部分未写」且无标记 |
| 参数写入失败 | 整事务回滚（含同一事务内的 Stage 3 更新） | 「台词改了但 mode 没改」的中间态 |

**一条硬规则**：允许「没有结果」，不允许「有看起来像结果的东西」。这正是 `continuity_runs` 必须单独存在的理由。

### 7.6 `scene_uid` 规范变更的前置

D02-06 §8.2.4 的三处正文（列名表、索引说明、读法代码块）**必须与本阶段的 DDL 同一次提交改完**。未取得 D-30-03 批准前，本阶段只能以 `degraded` 交付，不得给 `current`。

### 7.7 PF-1（D-30-12）单列验收

验收报告必须单列一行，三态之一：`未批` / `已批` / `已批且验收通过`。**不得**用「P9 已通过」覆盖它。

---

## 八、Gate 启动条件

### 8.1 两层 Gate，不得混淆

| 层 | 数量 | 内容 | 判据来源 |
|---|---:|---|---|
| **L1 决策层** | **14** | D-30-01/02/03/04/05/07/08/09/10/11/13 + D-31-01/02/03 | 用户批准记录 |
| **L2 执行层** | **7** | P1~P7 | 环境 + 测试执行 + 清单 |

**禁止**把「14 项决策批准」当成「7 项执行 Gate 满足」，也禁止把两者相加成「21 项」。**用户批准 19 项决策 ≠ 编码自动放行**：P2/P4/P5/P6/P7 与批准无关，属独立的工程前置。

### 8.2 L1 决策层 14 项（逐项可勾）

| 编号 | 决策 | 前置 | 负责模块 | 验证方式 | 预期结果 | 失败处理 | 阻断编码 |
|---|---|---|---|---|---|---|---|
| D-30-01 | `segment_id` 多端身份 | 无 | `schema/tables.js`、`project-units.js` | 迁移 + 投影用例 | 一镜一段/一段多镜两用例绿 | 退回设计（C 阶段挂起） | **是** |
| D-30-02 | 场次身份 `scene_uid` | 无 | `scene-state.js` | 改 key 不改 uid 用例 | 改名不换身份 | 退回（E 阶段挂起） | **是** |
| D-30-03 | `continuity_runs` 改 uid + 规范修订 | D-30-02 | D02-06 §8.2.4、DDL | 规范 diff + 读法用例 | 三处正文与代码一致 | 退回（E 阶段只给 degraded） | **是** |
| D-30-04 | 投影独立入口 + writer 门禁 + 部分列 | 无 | `project-units.js`、`db.js` | 缺 writer 抛错；省略键不覆盖 | 门禁与部分列生效 | 退回（C 阶段挂起） | **是** |
| D-30-05 | 生成侧停写三键 + 换 3414 | D-30-09 就绪 | `tools.js` | 整章生成不重渲 | 无全量重渲 | 退回（与 D-30-10 一起挂） | **是** |
| D-30-07 | `ShotParams` 唯一写 B 组 | D-30-04 | `unit-params.js` | 5 列白名单 + 1 条 update | 参数可写且可审计 | 退回（插入分镜不可用） | **是** |
| D-30-08 | `shot_videos.input_hash` + manifest | D-30-09 | DDL、manifest | `PRAGMA` + manifest 校验 | 列存在且被登记 | 退回（D 阶段挂起） | **是** |
| D-30-09 | `seg-2` + HashProjection | D-31-01/02 | `input-hash.js` | 键集冻结 + 固定向量 | 17 项 CFG 测试绿 | 退回（判定退回字符串比较） | **是** |
| D-30-10 | 4 处判定 + 1 处统计 | D-30-08/09 | 4 个出口 | 过期/未知两类断言 | 过期不可导出 | 退回（不建议单独拒） | **是** |
| D-30-11 | 删段行保候选 | D-30-04 | `project-units.js` | 删除用例 + 静态断言 | 候选行留存、不可见 | 退回（C 阶段不能宣称完成） | **是** |
| D-30-13 | 并发协议 + 跨项目顺序 | 无 | `db.js` | TST-LOCK-01~13（含 PG） | 无撞号、无死锁、无残留 | 退回（全部写入链挂起） | **是** |
| D-31-01 | 单次读取即定指纹 | 无 | `backend.js`/`engine-runner.js`/`workflow-runner.js` | 两个反例 | 冻结字节被执行 | 退回（指纹不可信） | **是** |
| D-31-02 | 内容寻址命名 | 无 | `refs.js`/`comfyui.js` | 名字正则 + 并发覆盖用例 | 同名必同字节 | 退回（跨任务覆盖仍在） | **是** |
| D-31-03 | Agent `story_shot_id` | D-30-01 | `tools.js` | 三个错误码 + 单事务 | 单镜可改、旧链路不变 | 退回（单镜改稿不可用） | **是** |

### 8.3 L2 执行层 P1~P7

| # | Gate | 前置条件 | 负责文件/模块 | 验证命令或操作 | 预期结果 | 失败处理 | 阻断编码 |
|---:|---|---|---|---|---|---|---|
| **P1** | 19 项决策有批准记录 | §8.2 全部有结论 | 审批包 + 批准记录 | 人工核对 19 行 | 19 项状态非「待审批」 | 不得进入冻结评审 | **是** |
| **P2** | PG 锁测试真实跑通 | PG 可连（P7） | `tests/tst-lock-*.test.mjs` | `db.provider=postgres` 下跑 TST-LOCK-01~13 | 13 条全绿，日志含真实 `pg_advisory_xact_lock` | 保持未满足，停止 B 阶段之后的工作 | **是** |
| **P3** | 14 项决策单独批准 | P1 子集 | 审批包 | 逐项勾 | 14 项均为「批准」 | 未批项对应阶段挂起 | **是** |
| **P4** | `shot_videos` 并入 manifest | A-03 完成 | `gen-manifest.mjs`、`verify-manifest.mjs` | 重新生成 + 校验 | 校验通过，`shot_videos` 列集被登记 | 不得改 `shot_videos` | **是** |
| **P5** | 25 处 `tx()` 锁定审计清单 | 无 | `lib`/`app` 全部调用点 | 逐处标注 + 理由 | 清单 25 行，每行有结论 | 不得开始 B 阶段 | **是** |
| **P6** | IMP-01~04 顺序与回归清单 | D-31-01/02 批准 | 四个文件 | 排期表 + TST-CA-01~06 计划 | 顺序明确、测试可执行 | D 阶段不得开工 | **是** |
| **P7** | PG 可连 | 有 PG 实例 | `config.json`/`db-driver` | `SELECT 1` | 返回 1 | P2 无法满足 ⇒ 整体停滞 | **是** |

### 8.4 未满足时的 fail-closed 行为

| 未满足 | 系统行为 | 允许的动作 |
|---|---|---|
| P1/P3 | 不得合入对应实现 | 文档、测试设计、隔离库试验 |
| P2/P7 | 锁相关代码可写但**不得宣称可用**；PG 路径保持未验证标记 | 用 SQLite 跑非并发用例 |
| P4 | 不得给 `shot_videos` 加列 | 先改 manifest 生成脚本 |
| P5 | 不得改任何 `tx()` 调用点 | 先出清单 |
| P6 | 不得改四个签名 | 先出排期 |

**一条硬纪律**：PG 未就绪时，**不得**用 SQLite 结果替代 PG 并发验收；报告里只能写「未实跑」。

### 8.5 环境验证未完成项（U-32-1~6）与 Gate 的关系

| 编号 | 内容 | 关联 | 是否阻断编码 |
|---|---|---|---|
| U-32-1 | `/view?type=input` 可读回性 | 严格模式（默认关） | 否 |
| U-32-2 | `hashtextextended` 可用性 | PG 锁 | 否（可降级 `hashtext` 并登记碰撞） |
| U-32-3 | 换 `apiKey` 是否改产物 | 指纹排除项 | 否 |
| U-32-4 | `input/` 清理策略 | 磁盘 | 否 |
| U-32-5 | 差集日志上界实测 | V5 | 否 |
| U-32-6 | 外部篡改可发现性 | 内容寻址边界 | 否 |

**本轮新增登记（非决策）**：`U-36-1` —— `recordChange` 对「未登记实体」是否从「静默返回 null」升级为抛错。在用户确认前只做 `console.warn` + 计数；该事项不阻断编码，但**阻断「Stage 3 审计已完成」这一结论**。

---

## 九、V1~V8 验收

### 9.1 总表

| # | 验收目标 | 具体测试 | 数据与环境 | 通过标准 | 失败标准 | 证据产物 |
|---:|---|---|---|---|---|---|
| **V1** | 内容寻址：对象身份 = (摘要, 规范化扩展名) | TST-CA-01~06 | 隔离库 + 临时 `input/` 目录 | 6 条全绿；名字匹配 `ic-<64hex>.<ext>` | 任一用例红；名字含 pid/role/时间戳 | 测试日志 + 目录清单 + 名字样本 |
| **V2** | 快照一致性：指纹描述的字节就是执行的字节 | 三个反例（媒体/工作流/跨任务）+ 回归用例 | 隔离库 + stub `runWorkflow` | 三个反例结构性不可达；候选 `input_hash` 永不等于「渲染后现算」 | 任一反例可达 | 反例测试代码 + 断言输出 |
| **V3** | 指纹覆盖：字段集与白名单正确 | TST-CFG-01~17 | 隔离库（纯函数为主） | 17 条全绿，含键集冻结、秘密零接触、模板不渲染 | 任一字段变化未引起 Hash 变化；或投影读到 `apiKey` | 键集快照 + 固定向量 + 日志扫描结果 |
| **V4** | 锁协议：顺序、嵌套、释放 | TST-LOCK-01~13 | **PG 真库**（11~13 强制）+ SQLite | 13 条全绿；已持锁后调 `txProjects` 必抛 `TX_NESTED_MULTI_PROJECT`；SQLite 无升级 BUSY | 任一红；或用 SQLite 结果替代 11~13 | PG 执行日志 + 取锁序列 spy + 错误码断言 |
| **V5** | 审计完整性 | V5-A~G + TST-AUD-01~15 | 隔离库 | A3 按 D02-34 §3.3；条数 ≤ 实际变化；相同替换 0 条；A6/A8 增量为 0；失败回滚 | 任何「不适用」对象被要求用例、或日志条数超上界 | 日志条数矩阵 + before/after 样本 |
| **V6** | B-30-8 行为替换 | 整章生成用例 | 隔离库 | 指纹判定取代启发式，字段比较仅作短路；整章不重渲 | 停写后仍全量重渲 | 生成次数计数 + 日志 |
| **V7** | B-30-9 fail-closed | 历史候选用例 | 隔离库含 `input_hash=''` 行 | 不可导出、不可选为当前成片，错误可读 | 任一出口放过 | 导出响应 + UI 文案截图 |
| **V8** | 基线不回退 | 全量 | 隔离库 | `950 / 922 / 17 / 11`；17 条同名同因 | 新增失败；或 17 条中任一转绿未说明 | 全量日志 + sort 后 diff |

### 9.2 V4 最终定义（引用 D02-34 §4.1，不得改写）

① TST-LOCK-01~05（同项目并发交错）在 PG 真库通过；② TST-LOCK-06~13（顺序、嵌套拒绝、释放）通过，其中 11/12/13 **必须在 PG 真库**；③ 断言「一个事务内的项目锁集合不可扩展」；④ SQLite 侧不再出现「deferred 事务升级写锁」导致的 `SQLITE_BUSY`。

### 9.3 V5 最终定义（引用 D02-34 §4.2，不得改写）

① V5-A~F 全绿；② A3 按 D02-34 §3.3 判定（`order_no`/`variant_of` 均记 update、同变仍 1 条）；③ TST-AUD-08~15 全绿；④ 日志条数 ≤ 实际变化行数；⑤ 完全相同的整组替换 0 条日志；⑥ V5-G（A2/A4/A5）按落地进度补齐，未落地标「待实现」。

### 9.4 证据产物规范

| 验收 | 必须提交的证据 |
|---|---|
| V1 | 断言日志 + `input/` 目录 `ls` 输出 + 3 个名字样本 |
| V2 | 三个反例的测试代码 + 失败截图（若能构造）或「结构性不可达」的代码依据 |
| V3 | 键集冻结快照（`Object.keys` 输出）+ 一条固定输入的 hash 值 |
| V4 | PG 版本号 + `SELECT 1` 输出 + 13 条用例日志 + 取锁顺序 |
| V5 | 日志条数矩阵（对象 × 操作 × 条数） |
| V6 | 整章生成的提交次数前后对比 |
| V7 | 4 处出口的响应体 + UI 文案 |
| V8 | 全量日志 + `not ok` 行 sort 后与基线的 diff |

### 9.5 四种验证不得混淆

| 类型 | 例子 | 不能替代 |
|---|---|---|
| 静态检查 | 键集断言、`Shots.remove` 计数为 0 | 不能替代运行期行为验证 |
| 单元测试（SQLite） | 审计、指纹、判定 | 不能替代 PG 并发 |
| PG 并发测试 | TST-LOCK-11~13 | 不能替代真实生产链验证 |
| 真实链验证 | 首结构化项目全流程 | 不能由前三者推出 |

---

## 十、回归与遗留失败

### 10.1 基线（历史值，本轮未复跑）

`950 tests / 922 pass / 17 fail / 11 skipped`。该数字来自 D02-32 的实跑；本轮无代码变更，**不代表本轮重新执行**。

### 10.2 17 条历史失败（逐条对比，不得删减）

| # | 用例 | 类别 |
|---:|---|---|
| 1 | `freeComfy: POST /free 携带 unload_models + free_memory` | `freeComfy` |
| 2 | `narration：内置 Agent 与外部写入 API 同口径，可写旁白` | legacy `shots` 读路径 |
| 3 | `set_storyboard：clear 只清本次写入的章节，别的章节（含已出片镜头）必须保留` | 旧 `set_storyboard` |
| 4 | `set_storyboard：duration 必须当场校验成数字（NaN 落库会让这条分镜永远出不了片）` | 旧 `set_storyboard` |
| 5 | `set_storyboard：同批「自动号在前、显式号在后」不再撞号吞内容` | 旧 `set_storyboard` |
| 6 | `set_storyboard：同批重复 (chapter, idx) 只落一条，镜号归一为 ≥1 整数` | 旧 `set_storyboard` |
| 7 | `set_storyboard：对不上的资产名不再静默丢弃（随结果回报）` | 旧 `set_storyboard` |
| 8 | `set_storyboard：未声明字段当场拒绝（字段拼错不再被静默丢弃）` | 旧 `set_storyboard` |
| 9 | `set_storyboard：章节必须存在（标题与 id 都认），不得写出孤儿分镜` | 旧 `set_storyboard` |
| 10 | `update_shot：时长归一化后才落库（越界裁剪、非数字拒绝）` | legacy `shots` |
| 11 | `依赖调度：引用资产未完成的镜头被暂缓，已就绪的镜头照常提交` | legacy `shots` |
| 12 | `停止：当前分镜复位为待生成，不再留在「失败」` | legacy `shots` |
| 13 | `停止：换装/年龄兜底循环不再逐镜继续出图（每个事件都是一次真提交）` | 换装兜底 |
| 14 | `分镜业务校验：台词速度按「真正落库的时长」算，说话人超 2 个拒绝` | legacy `shots` |
| 15 | `台词速度校验：两条写入路径共用同一份默认时长（历史 duration=0 的行不许两套上限）` | legacy `shots` |
| 16 | `换装兜底：LLM 阶段（renderDisabled）不渲染，推迟到「资产图」阶段执行` | 换装兜底 |
| 17 | `自动换装：同章第二次换装事件不被首次结果误判为「已显式引用」` | 换装兜底 |

### 10.3 判定规则（写死）

| 情况 | 判定 |
|---|---|
| 17 条仍失败、同名同因 | **合格**（基线保持） |
| 任一条转绿 | 必须在报告中说明「为何转绿、是否本轮引入行为变化」，不得静默 |
| 新增失败 | **阻断**，不得合并 |
| 失败数变化但名单相同 | 视为异常，必须查清 |
| 只比数量不比名单 | **不接受**（必须 `sort` 后 `diff`） |

### 10.4 报告格式

每份实施报告必须含：全量 `tests/pass/fail/skip` 四个数；`not ok` 行 sort 后与基线的 diff（必须为空或逐条解释）；新增/转绿条数与原因。

---

## 十一、工程执行约定

### 11.1 提交与报告

- 每个工作项一个提交，提交信息以工作项 ID 开头（如 `C-01：投影入口`）。
- 报告写代码 SHA；代码提交后再提交报告；报告自身 SHA 由下一次提交回填（报告不能自指）。
- 报告必须逐项对照本任务书的「验收证据」列，缺证据即视为未完成。

### 11.2 测试入口（唯一）

```
IC_DATA_DIR=<临时绝对目录> node scripts/test-runner.mjs
```

- 未设 `IC_DATA_DIR` 即拒绝运行（测试唯一入口要求）。
- 禁止把测试指向 `data/ic.db`。
- 断言日志按 `not ok <用例名>` 过滤。

### 11.3 真库保护

- 任何阶段不得写 `data/ic.db`；需要读真实数据时**复制三件套到临时目录读副本**（`ic.db`/`-wal`/`-shm`）。
- 每轮结束记录三文件 SHA 与 `-shm` 的 mtime，与上一轮比对。

### 11.4 回滚方案（通用要求）

| 变更类型 | 回滚方式 |
|---|---|
| 加列 | 保留列（SQLite 删列需重建表，代价高）；功能开关降级 |
| 加索引 | `DROP INDEX` |
| 新增模块 | 删除模块 + 恢复调用点（要求每个新增模块都有「未被调用时可直接删除」的性质） |
| 门禁收紧（S5） | 只能由 `structured_spec` 降级脚本回退，且必须在空表前置下 |
| 命名变更（内容寻址） | 保留旧名字的对象，回退时切回旧命名函数 |

### 11.5 停工条件（遇到即停，不得「先做着看」）

1. 发现某项决策的实现在语义上不可行（须回到审批包）；
2. 发现需要新增决策编号（本轮纪律：编号只由审批包管理）；
3. PG 环境不可用却要继续做锁相关声明；
4. 真实库出现非预期写入；
5. 新增失败用例。

### 11.6 「每阶段十项」的自检含义

本任务书每个工作项都在 §三 的两张表里给出十项：**文件 / 修改目标 / 接口 / DB 变化 / 上游依赖 / 下游调用方 / 测试文件 / 测试命令 / 验收证据 / 回滚方案**。实施报告中每个工作项必须把这十项各写一行结论，缺项视为未完成。

---

## 十二、Draft 自检与结论

### 12.1 自检七问

| # | 问题 | 答案 |
|---:|---|---|
| 1 | 19 项决策是否完整覆盖 | **是**。§三 每个阶段的工作项均标注对应决策；19 项全部有落点 |
| 2 | 决策之间是否存在矛盾 | **无实质矛盾**。两处强耦合（D-30-05+D-30-10、D-31-01+D-31-02）已写成「必须同批」 |
| 3 | 是否存在未被任务书覆盖的已批准架构要求 | **无**。未覆盖项全部是「未批准决策」或「U-32-1~6 未验证」 |
| 4 | 14 项 Gate 是否完整 | **是**。§8.2 逐项，与 §8.3 的 P1~P7 是两层、不可相加 |
| 5 | V1~V8 是否完整 | **是**。§9.1 六列齐全（目标/测试/数据与环境/通过/失败/证据），V4/V5 引用 D02-34 原文 |
| 6 | 当前是否具备冻结条件 | **不具备**。缺 P1/P3 批准、P2/P7 环境、P4 manifest、P5 清单、P6 排期 |
| 7 | 当前是否允许开始编码 | **不允许**。14 项 Gate 决策未批；IMP-01~04 未落地；55 项测试全部未执行/未实跑 |

### 12.2 三问分答（本 Draft 的唯一结论）

| 问题 | 答案 | 依据 |
|---|---|---|
| 19 项架构决策是否可以提交用户审批 | **可以** | D02-35 已呈报，定义/版本/四态唯一 |
| P10-A 正式实施任务书是否可以**冻结** | **不可以** | 本文件为 Draft；冻结需 §12.3 的五个动作全部完成 |
| P10-A 编码是否可以启动 | **不可以** | 见 §12.1 第 7 问 |

### 12.3 从 Draft 到冻结的五个动作（按顺序）

| # | 动作 | 产出 |
|---:|---|---|
| 1 | 用户对 19 项给出批准记录（P1/P3） | 审批包 §六 的记录表填好 |
| 2 | 准备 PG 实例并跑通 P7 + P2（TST-LOCK-01~13，11~13 必须真库） | PG 版本号 + 13 条用例日志 |
| 3 | 完成 P4：把 `shot_videos` 与 `continuity_runs` 并入 manifest 并校验通过 | manifest diff + 校验输出 |
| 4 | 完成 P5：25 处 `tx()` 逐处判定清单 | 25 行清单表 |
| 5 | 完成 P6：IMP-01~04 顺序与 TST-CA-01~06 排期 | 排期表 |

五个动作全部完成后，本 Draft 才能把「Draft」改为「已冻结」，并开始阶段 A。

---

## 附录 A · 阶段与上线顺序 S1~S5 的映射

| S 序 | 内容 | 对应阶段 | 对应工作项 |
|---|---|---|---|
| S1 | Stage 3 写入链可用 | A、B | A-01/02/05/06、B-01~B-06 |
| S2 | 投影 + 参数入口 | C | C-01~C-07 |
| S3 | `input_hash` + `seg-2` + 候选落库 | A、D | A-03/07/08、D-01~D-05 |
| S4 | 有效性判定升级 | D | D-06、D-07 |
| S5 | `Shots.*` 门禁收紧 | C（最后一步） | C-03、C-04 |

> 注意：C-03（writer 门禁）在阶段 C 内**最后**执行；阶段 C 的其余工作项可在 S5 之前完成。

## 附录 B · 文件清单（按模块）

| 模块 | 文件 | 涉及工作项 |
|---|---|---|
| Schema | `lib/core/schema/tables.js`、`lib/core/schema-manifest.json` | A-01~A-04 |
| 迁移 | `lib/core/db.js`（迁移段） | A-01~A-03 |
| 事务 | `lib/core/db.js`（`tx` 段） | A-05 |
| 审计 | `lib/core/changelog.js` | A-06、B-01~B-05、C-02 |
| 场次 | `lib/core/scene-state.js` | B-01 |
| 镜 | `lib/core/render/global-no.js` | B-02 |
| 资产引用 | `lib/core/render/shot-assets.js` | B-03 |
| 站位/动作 | `lib/core/render/shot-blockings.js`、`shot-actions.js`（新增） | B-04、B-05 |
| 投影 | `lib/core/render/project-units.js`（新增） | C-01、C-07 |
| 参数 | `lib/core/render/unit-params.js`（新增） | C-02 |
| 服务层 | `lib/core/db.js`（`Shots`/`ShotVideos`） | C-03、C-04 |
| Agent | `lib/agent/tools.js` | B-06、C-05、D-05、D-06 |
| HTTP | `app/api/projects/[id]/shots/route.js`、`[sid]/route.js` | C-06 |
| 指纹 | `lib/core/render/input-hash.js`（新增） | A-07、D-05 |
| 媒体 | `lib/core/refs.js`、`lib/core/comfyui.js`、`lib/core/backend.js` | A-08、D-01、D-04 |
| 引擎 | `lib/core/engine-runner.js` | D-02 |
| 工作流 | `lib/core/workflow-runner.js` | D-03 |
| 求解 | `lib/core/continuity/*`、`lib/core/continuity/solve-hash.js` | E-01~E-04 |
| 启动 | `lib/core/db.js`（启动段） | E-05 |
| 脚本 | `scripts/schema/gen-manifest.mjs`、`scripts/set-structured-spec.mjs`（新增） | A-04、F-02 |

## 附录 C · 编号与术语

| 术语 | 含义 |
|---|---|
| 段（unit） | `shots` 一行，一次生成任务的容器 |
| 镜（shot） | `story_shots` 一行，创作单位 |
| 投影 | Stage 3 → `shots` 的 A 组 17 列写入 |
| 冻结快照 | `prepareShotForRender` 产出的 `inputSnapshot`（payload + hash） |
| 过期 | `selected.input_hash !== segmentInputHash(段当前输入)` |
| 来源未知 | `input_hash=''`，按过期处理且不可导出 |
| 不可见留存 | 段行删除后候选行仍在库，但无查询/选择/导出路径 |

## 附录 D · 本轮变更声明

| 项 | 状态 |
|---|---|
| 业务代码 / DDL / `schema-manifest.json` / 正式规范 / 真实库 | **零改动、零写入** |
| 新增文件 | 本任务书 Draft + D02-35 审批包 |
| 决策编号 | 零新增；19 项不变 |
| 测试 | 未新增、未执行；基线沿用 `950 / 922 / 17 / 11`（本轮未复跑） |
| Gate | 14 项决策 Gate 未批；P1~P7 中 P2/P4/P5/P6/P7 未满足 |
