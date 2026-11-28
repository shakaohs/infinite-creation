# D02-44 · P10-A 阶段 B：Stage 3 创作写入链实施报告

> **状态**：实施完成，**提交阶段 B 验收申请**（判定权在独立复核方与用户，不在本报告）。
> **施工依据**：`D02-40-P10-A正式实施任务书冻结版.md` §3.2 B-01～B-06。**未修改 D02-40 一字**，未新增架构决策编号。
> **基线**：`2c9b3df`（D02-43 收尾）。**本轮提交**：`369bf08`（代码 + 测试 + 证据同批提交；本报告随后单独提交）。
> 报告不能自指，故不写「本报告自己的 SHA」——它在仓库历史里紧邻代码提交之后可见。
> **零 DDL、零 manifest 变更、零生产库写入**：`data/ic.db` SHA 仍为 `b2ebdb5435fcf573a95a48fc444e0733d0fd7af41333b39c8a7ea34f7336d757`（自 D02-15 起从未变）。

---

## 0. 一句话结论

六个工作项全部落地：结构化项目的创作写入现在真实落在 Stage 3（`scene_states` / `story_shots` / `shot_assets` / `shot_blockings` / `shot_actions`），五个 A 类必需审计实体全部接通且 fail-closed，全部写入路径都在 `txProject` 内并先断言项目锁。

**结构化项目此刻仍然不可出片**：`shots` 里没有对应生成段，界面分镜列表看不到这些镜头，走不了渲染。这是阶段 B 的**已知中间状态**，不是缺陷，也不是可以用临时建行掩盖的东西（见 §九）。

---

## 一、B-01～B-06 实施结果

| 工作项 | 落点文件 | 关键改动 | 事务边界 | 锁断言 | A 类审计 | 专项测试 | 结果 |
|---|---|---|---|---|---|---|---|
| **B-01** 场次基线 | `lib/core/scene-state.js` | `upsertSceneStates(projectId, rows, {origin})` 新签名；定位优先 `scene_uid`（身份）再 `scene_key`（别名）；改名不改身份；`scene_uid` 不存在/跨项目一律拒 | `txProject`（`:151`） | `:152` | A1 `scene_state` create(`:204`)/update(`:242`) | `tests/d02-36-b01.test.mjs` 8 条 | 通过 |
| **B-02** 镜头写入 | `lib/core/render/global-no.js` | `insertStoryShot` 允许列加 `segment_id`/`scene_uid`/`cam_note`；**不给 `global_no` 时在锁内按 `MAX+1` 取号**；新增 `updateStoryShot`/`deleteStoryShot`；段 ID 与镜 ID 混用拒绝 | `txProject`（`:233` `:273` `:307` `:487`） | `:234` `:274` `:308` `:488` | A2 `story_shot` create/update/delete(`:257` `:294` `:311`) | `tests/d02-36-b02.test.mjs` 8 条 | 通过 |
| **B-03** 资产引用 | `lib/core/render/shot-assets.js` | 新增 `diffShotAssets`（差集键 = `(role, asset_id)`）；物理写入仍是整组 DELETE+INSERT，但**先算差集再逐条记审计**；`voice_ids` 回填单列 update | `txProject`（`:262` `:324`） | `:263` `:325` | A3 `shot_asset` delete/create/update(`:288` `:291` `:294`) | `tests/tst-aud-08-15.test.mjs` 12 条 | 通过 |
| **B-04** 站位 | `lib/core/render/shot-blockings.js`（新增 138 行） | `writeShotBlockings(shotId, rows)`；差集键 = `(shot_id, character_id)`；**没给的列不进 INSERT**，让 DDL 默认值（`in_frame=1`、`occlusion='none'`）生效；锁内复核镜头仍在 | `txProject`（`:87`） | `:88` | A4 `shot_blocking` delete/create/update(`:114` `:117` `:120`) | `tests/d02-36-b04.test.mjs` 11 条 | 通过 |
| **B-05** 动作 | `lib/core/render/shot-actions.js`（新增 130 行） | `writeShotActions(shotId, rows)`；**行级** upsert + delete（不做整组重建）；带 `id` = 改该行，不带 = 新增，本次未出现的既有行 = 删；锁内复核镜头仍在 | `txProject`（`:67`） | `:68` | A5 `shot_action` update/create/delete(`:100` `:111` `:119`) | `tests/d02-36-b05.test.mjs` 11 条 | 通过 |
| **B-06** Agent 分支 | `lib/agent/tools.js` | `hSetStoryboard` 在**旧链路之前**分流：`structured_spec=1` → `writeStructuredStoryboard`，只写 `story_shots`；开关只经 `isStructuredSpec()`；项目行读不到即拒 | `txProject`（`:2356`） | `:2357` | 经 B-01/B-02 的同一批 `recordChange`（无自有埋点） | `tests/set-storyboard-structured.test.mjs` 9 条 | 通过 |

**合计新增测试 59 条**（8+8+12+11+11+9），全绿。

---

## 二、每个修改文件的改动性质与关键函数

| 文件 | 性质 | 关键函数 | 净变化 |
|---|---|---|---|
| `lib/core/scene-state.js` | 改 | `upsertSceneStates`（新签名 + uid 定位 + A1 审计 + `txProject`） | +89 −23 |
| `lib/core/render/global-no.js` | 改 | `insertStoryShot`（锁内取号 + 白名单扩展 + A2 create）、新增 `updateStoryShot`、`deleteStoryShot`、`appendStoryShots` 改用 `txProject` | +112 −16 |
| `lib/core/render/shot-assets.js` | 改 | 新增 `diffShotAssets`；`writeShotAssets`（差集审计 + `txProject`）；`writeStoryShotWithAssets`（`txProject`） | +78 −5 |
| `lib/agent/tools.js` | 改 | `hSetStoryboard`（前置项目校验 + 结构化分流位置前移）、新增 `writeStructuredStoryboard` | +138 −1 |
| `lib/core/index.js` | 改 | 仅新增导出（`updateStoryShot`/`deleteStoryShot`/`diffShotAssets`/`shotBlockingError`/`diffShotBlockings`/`writeShotBlockings`/`listShotBlockings`/`shotActionError`/`writeShotActions`/`listShotActions`） | +7 −1 |
| `lib/core/render/shot-blockings.js` | 新增 | `writeShotBlockings`、`diffShotBlockings`、`listShotBlockings` | 138 |
| `lib/core/render/shot-actions.js` | 新增 | `writeShotActions`、`listShotActions` | 130 |

**未改动**（逐条核对）：`lib/core/changelog.js`（A-06 已完成的实体元数据直接复用）、`lib/core/db.js`（四个冻结锁接口零改动）、`lib/core/schema/*`、`scripts/schema/*`、`lib/core/schema-manifest.json`、`lib/core/render/input-hash.js`（A-07）、`lib/core/refs.js`（A-08）、`lib/core/render/shot-videos*`。

---

## 三、每个写入入口的事务边界与锁断言

| 入口 | 事务 | 锁断言 | 备注 |
|---|---|---|---|
| `upsertSceneStates` | `txProject(projectId)` | `assertProjectLocked` | 纯校验全在事务内、写库之前完成，任一条不合法整批不落盘 |
| `insertStoryShot` | `txProject(projectId)` | `assertProjectLocked` | 外层已持同项目锁时复用（同项目嵌套合法，D02-40 §3.1.1） |
| `updateStoryShot` | `txProject(projectId)` | `assertProjectLocked` | 取锁后**重读**一次行，避免用锁外读到的旧值算差 |
| `deleteStoryShot` | `txProject(projectId)` | `assertProjectLocked` | 删前先取 `before` 快照，否则审计无法复原"删了什么" |
| `appendStoryShots` | `txProject(projectId)` | `assertProjectLocked` | 取号与写入在同一事务内 |
| `writeShotAssets` | `txProject(projectId)` | `assertProjectLocked` | 差集必须在 DELETE **之前**算，否则读不到 before |
| `writeStoryShotWithAssets` | `txProject(projectId)` | `assertProjectLocked` | 插镜 + 写资产同事务，失败不留半个镜 |
| `writeShotBlockings` | `txProject(projectId)` | `assertProjectLocked` + 锁内复核镜头 | 项目 id 只能经 `story_shots` 反查，所以镜头行在**取锁前**读；锁内再核一次，避免"给已删的镜挂站位" |
| `writeShotActions` | `txProject(projectId)` | 同上 | 同上 |
| `writeStructuredStoryboard` | `txProject(projectId)` | `assertProjectLocked` | 整批一个事务；内部对 B-01/B-02 入口的嵌套调用全部同项目 |

**没有第二套事务管理器**：全部走 `lib/core/db.js` 的 `txProject`。**四个冻结接口签名零改动**（`txProject` arity 2 / `txProjects` arity 2 / `lockedProjects` arity 0 / `assertProjectLocked` arity 1，与 D02-42 实测一致）。

### 3.1 关于「读在锁外、写在锁内」这一窗口

`writeShotBlockings` / `writeShotActions` 签名是 `(shotId, rows)`，项目 id 只能**经 `story_shots` 反查**——而不先拿到 projectId 就打不开 `txProject`。这形成一个结构性的读-写窗口（与 D02-32 记的 `runSceneQuality`「先 load 再开写事务」同型）。

处理方式不是"假装没有窗口"，而是**在锁内复核**：

- 镜行已消失 → `SHOT_NOT_FOUND`（错误指向真实原因，而不是等审计反查失败才暴露）
- 镜行换了项目 → `SHOT_NOT_IN_PROJECT`

这与 `updateStoryShot` 取锁后重读的做法一致。**残余风险如实登记**：复核与写入之间没有第二个检查点，但两者之间不再有可被外部插入的读操作，窗口从"整段业务逻辑"缩到"一条 SELECT 与紧随的 DELETE"。

---

## 四、A1～A5 审计实体的实际接线证据

五个 A 类实体在 `changelog.js` 的 `ENTITY_META` 里已登记（A-06 完成），本轮把它们从"能记"变成"真的在记"。

| 实体 | 表 | 主键形状 | 归属解析 | 接线点（行号） | 触发方式 |
|---|---|---|---|---|---|
| **A1** `scene_state` | `scene_states` | `id` | 行自身 `project_id` | `scene-state.js:204`（create）、`:242`（update） | 每次 upsert 一条 |
| **A2** `story_shot` | `story_shots` | `id` | 行自身 `project_id` | `global-no.js:257`（create）、`:294`（update）、`:311`（delete） | 每次插/改/删一条 |
| **A3** `shot_asset` | `shot_assets` | `[shot_id, role, asset_id]` | 经 `story_shots` 反查 | `shot-assets.js:288`（delete）、`:291`（create）、`:294`（update） | **按差集**，物理整组重写不放大日志 |
| **A4** `shot_blocking` | `shot_blockings` | `[shot_id, character_id]` | 经 `story_shots` 反查 | `shot-blockings.js:114`（delete）、`:117`（create）、`:120`（update） | 按差集 |
| **A5** `shot_action` | `shot_actions` | `id` | 经 `story_shots` 反查 | `shot-actions.js:100`（update）、`:111`（create）、`:119`（delete） | **按行** |

**fail-closed 五条的实测覆盖**：

| 条件 | 错误码 | 覆盖用例 |
|---|---|---|
| 1. A 类实体未登记 | `AUDIT_ENTITY_META_MISSING` | B02-06、B04-07、B05-08、AUD-ROLLBACK |
| 2. 项目归属无法解析 | `AUDIT_PROJECT_UNRESOLVED` | B02-05、B04-06、B05-05 |
| 3. 复合主键无法准确定位 | `AUDIT_PK_AMBIGUOUS` | B04-05、AUD-PK、A-06 既有 13 条 |
| 4. before/after 快照无法读取 | `AUDIT_SNAPSHOT_UNREADABLE` | A-06 既有用例（本轮未改该逻辑） |
| 5. 审计日志写入失败 | 随 `change_logs` 约束/异常抛出 | 上述三个 "审计失败 ⇒ 业务写入回滚" 用例 |

**没有一处把 A 类降级成 `console.warn` 加计数**（`AUDIT_OPTIONAL` 仍是既有 6 个实体，未新增成员）。**没有一处靠调用方传 `projectId` 绕过归属解析**：A 类只要有任何一侧行快照，归属就必须由真实行算出（D42-01）；两侧都无快照时仅 `action='rollback'` 可用显式 id（D02-43）。

---

## 五、差集算法与日志条数验证

### 5.1 算法

`shot_assets`：

1. 在**物理 DELETE 之前**读出 `beforeRows`（`SELECT * FROM shot_assets WHERE shot_id = ?`）
2. 用解析后的 `afterRows`（`resolveShotAssets` 的产物）与 `beforeRows` 一起进 `diffShotAssets`
3. 键 = `role` 与 `asset_id` 的二元组（用 `\u0000` 拼接，避免与业务字符冲突）
4. `after` 有 / `before` 无 → `added`；`before` 有 / `after` 无 → `removed`；两边都有但 `order_no` 或 `variant_of` 不同 → `changed`
5. 按 `removed → delete`、`added → create`、`changed → update` 逐条 `recordChange`，快照取**落库后的真实行**（`rawGet` 复合键）

`shot_blockings` 用同一形状，键退化为 `character_id`（`shot_id` 在镜内恒定）；另加一条纪律：**只比调用方显式给出的列**，没给的列不制造假 update（否则 `in_frame` 缺省值会天天报变化）。

`shot_actions` **不做差集**：它按 `id` 行级处理——带 `id` 改该行、不带 `id` 新建、本次未出现的既有行删除。整组重建会让每轮都产生全量假日志，且会丢掉 `id`（下游可能已经引用了这个 id）。

### 5.2 日志条数上界（可机检）

| 用例 | 场景 | 日志条数 | 断言 |
|---|---|---|---|
| TST-AUD-08 | 完全相同的第二次写入 | **0** | 物理整组重写不产生审计 |
| TST-AUD-09 | 加一条引用 | **1**（create） | 不是 3（整组 2 删 + 3 建） |
| TST-AUD-10 | 去一条引用 | **1**（delete） | above |
| TST-AUD-11 | 两条引用**互换顺序** | **2**（update × 2） | 这是本项最关键的一条：互换不是"删两个建两个" |
| TST-AUD-12 | 仅 `variant_of` 变 | **1**（update） | `order_no` 未变，故不是 delete+create |
| TST-AUD-13 | `order_no` 与 `variant_of` 同时变 | **1**（update） | 两个字段的变化**合并**成一条，不拆两条 |
| TST-AUD-14 | `asset_id` 变 | **2**（1 delete + 1 create） | 不是 update |
| TST-AUD-15 | `role` 变 | **1 removed + 1 added**（纯函数层） | 见 §5.3 |
| AUD-上界 | 5 条引用换 1 条 | **2** | 不是 10 |

上界成立的形式化表述：`日志条数 = added + removed + changed ≤ 真实变化行数`，且对"内容完全相同"恒为 0。

### 5.3 一个必须说清楚的边界：`role` 改变无法端到端构造

`role` 改变在**纯函数层**是 1 removed + 1 added（键含 `role`，所以不可能是 update）。但经 `writeShotAssets` **永远构造不出来**：AS-3 要求 `asset.category === role`，一个资产只有一个 category，换个 role 必然 `ASSET_ROLE_MISMATCH`。

所以 TST-AUD-15 分两段：前半段直接调 `diffShotAssets` 证明差集语义；后半段端到端证明"想换 role 会被拒，且库里零变化、零日志"。

**这不是"测试偷懒"，而是这条契约只能在纯函数层被证明**——把它写成"端到端换 role 成功"反倒是假的。同理，差集键必须含 `role` 的原因也正是：若键只有 `asset_id`，一次真实换类别的差异会被读成"同一行改了内容"，下游看不到"这条引用换了身份类别"。

---

## 六、测试执行记录

全部命令均在本机执行，`IC_DATA_DIR` 指向临时目录（测试唯一入口 `scripts/test-runner.mjs` 无 `IC_DATA_DIR` 即拒绝）。

### 6.1 分层结果

| 层 | 范围 | 命令 | 退出码 | tests | pass | fail | skip |
|---|---|---|---|---|---|---|---|
| 阶段 B 专项 | B-01 | `IC_DATA_DIR=/tmp/ic-x node --test --test-force-exit tests/d02-36-b01.test.mjs` | 0 | 8 | 8 | 0 | 0 |
| 阶段 B 专项 | B-02 | 同上 `d02-36-b02.test.mjs` | 0 | 8 | 8 | 0 | 0 |
| 阶段 B 专项 | B-03 | 同上 `tst-aud-08-15.test.mjs` | 0 | 12 | 12 | 0 | 0 |
| 阶段 B 专项 | B-04 | 同上 `d02-36-b04.test.mjs` | 0 | 11 | 11 | 0 | 0 |
| 阶段 B 专项 | B-05 | 同上 `d02-36-b05.test.mjs` | 0 | 11 | 11 | 0 | 0 |
| 阶段 B 专项 | B-06 | 同上 `set-storyboard-structured.test.mjs` | 0 | 9 | 9 | 0 | 0 |
| A1～A5 审计专项 | A-06 元数据 | 同上 `d02-41-a06-audit-meta.test.mjs` | 0 | 13 | 13 | 0 | 0 |
| A1～A5 审计专项 | D42-01 归属 | 同上 `d02-42-d42-01-audit-owner.test.mjs` | 0 | 10 | 10 | 0 | 0 |
| A1～A5 审计专项 | D43 回滚例外 | 同上 `d02-43-d43-01-rollback-exception.test.mjs` | 0 | 5 | 5 | 0 | 0 |
| 定向回归 | D42-02 观察者 | 同上 `d02-42-d42-02-lock-sink.test.mjs` | 0 | 6 | 6 | 0 | 0 |
| 锁专项（SQLite） | TST-LOCK-01~13 + 5 附加 | 同上 `tst-lock-01-13.test.mjs` | 0 | 18 | 18 | 0 | 0 |
| 既有 Stage 3 回归 | P2 场次 | 同上 `stage3-p2-scene-state.test.mjs` | 0 | 16 | 16 | 0 | 0 |
| 既有 Stage 3 回归 | P3 镜号 | 同上 `stage3-p3-global-no.test.mjs` | 0 | 18 | 18 | 0 | 0 |
| 既有 Stage 3 回归 | P3 资产 | 同上 `stage3-p3-shot-assets.test.mjs` | 0 | 16 | 16 | 0 | 0 |
| **PG 真库锁** | 6 自检 + TST-LOCK-01~13 | `node scripts/verify/tst-lock-pg.mjs` | **0** | 19 | **19** | 0 | 0 |
| **全量** | 全部 | `IC_DATA_DIR=/tmp/ic-full6 node scripts/test-runner.mjs` | 1 | **1092** | **1064** | **17** | **11** |

全量 exit=1 的唯一原因是那 17 条历史失败（见 §七），不是本轮引入。

### 6.2 与阶段 A 基线的数量关系

| 指标 | D02-43（阶段 A 收尾） | D02-44（本轮） | 变化 |
|---|---|---|---|
| tests | 1033 | 1092 | **+59** |
| pass | 1005 | 1064 | **+59** |
| fail | 17 | 17 | 0 |
| skip | 11 | 11 | 0 |
| 用时 | 24s | 30s | +6s（59 条新用例 + PG 无关） |

**新增 59 条 = 通过 59 条**，一一对应；没有任何既有用例因本轮改动转红。

### 6.3 PostgreSQL 真库证据

`docs/D02/evidence/D02-44-p2-pg-lock.txt`（24 行，原始日志未编辑）。六项自检全部通过：服务端在跑、测试库可连、版本 16.x、advisory lock 可执行、**两个独立连接（两个不同 backend pid）**、连的是 `infinite_creation_test`。

13 条 TST-LOCK 全绿，含：

- `LOCK-01` 同项目两事务串行取号 `n=[1,2]`
- `LOCK-03` 不同项目并行不互相阻塞（墙钟 < 串行下界）
- `LOCK-07` 取锁顺序 `order=["pg-p07","pg-q07"]`（`setLockOrderSink` 仍能真实观测）
- `LOCK-11` 后端被 terminate 后锁自动释放
- `LOCK-13` 删掉被锁项目的行后锁仍在

**本轮没有改动锁实现的任何一行**；PG 测试是"确认不退化"，不是"补跑一条"。

---

## 七、17 项历史失败逐条对照

对照方法有两层，缺一层都不算证明：

1. **名单层**：`grep "^not ok" | sed | sort` 后与冻结基线 `/tmp/ic-base/notok.txt` 做 `diff` → **空**（`exit 0`）
2. **原因层**：抽取每条失败的 `error / code / expected / actual` 行，把路径、时间戳、耗时、行号归一后再 `diff` → **17 条原因完全一致，0 条不一致**（`exit 0`）

只比"失败数都是 17"不算证据；本轮两层对照都空。

| # | 失败名称 | 实际原因（归一后） | 归属 |
|---|---|---|---|
| 1 | 分镜业务校验：台词速度按「真正落库的时长」算，说话人超 2 个拒绝 | `ERR_ASSERTION`：期望 `dialogue 超速：50 字 / 10 秒…` 未抛出 | 阶段 B 之前既有 |
| 2 | set_storyboard：章节必须存在（标题与 id 都认） | 分镜规则未加载（缺 8 个 reference） | 既有 |
| 3 | set_storyboard：同批重复 (chapter, idx) 只落一条 | 同上 | 既有 |
| 4 | update_shot：时长归一化后才落库 | 同上 | 既有 |
| 5 | 台词速度校验：两条写入路径共用同一份默认时长 | `ERR_ASSERTION`：`时长真是 8 秒时不该报错` | 既有 |
| 6 | 自动换装：同章第二次换装事件不被误判 | 分镜规则未加载 | 既有 |
| 7 | 停止：当前分镜复位为待生成 | `未找到工作流规格：i2v → custom_yz_h3_终极篇文武双全_本地` | 既有（本机无该工作流） |
| 8 | 依赖调度：引用资产未完成的镜头被暂缓 | 同上 | 既有 |
| 9 | set_storyboard：未声明字段当场拒绝 | 分镜规则未加载 | 既有 |
| 10 | set_storyboard：duration 必须当场校验成数字 | 同上 | 既有 |
| 11 | set_storyboard：clear 只清本次写入的章节 | 同上 | 既有 |
| 12 | set_storyboard：同批自动号在前显式号在后不再撞号 | 同上 | 既有 |
| 13 | narration：内置 Agent 与外部写入 API 同口径 | 同上 | 既有 |
| 14 | set_storyboard：对不上的资产名不再静默丢弃 | 同上 | 既有 |
| 15 | 换装兜底：LLM 阶段不渲染 | 分镜规则未加载 | 既有 |
| 16 | 停止：换装/年龄兜底循环不再逐镜继续出图 | 同上 | 既有 |
| 17 | freeComfy: POST /free 携带 unload_models + free_memory | `res.text is not a function` | 既有（测试替身形状不符） |

**关于第 2/3/4/6/9~16 这 12 条**：它们的共同原因是「`set_storyboard` 的分镜规则门禁要求先加载 8 个必读 reference，而这些老测试夹具没有加载」。这是本轮之前就存在的状态——本轮**没有**为了让它们变绿而放宽门禁，也没有把它们从名单里摘掉。B-06 的新用例是在**如实填满这道门禁**（`ctx.loadedRefs` 写入 8 个 ref）之后才验证写入链走向的，见 §十三 第 3 条。

---

## 八、新增失败清单

**空。** 1092 条中 17 条失败与冻结基线**同名同因**，无一条新增。

本轮实施中途出现过两条新增失败，均已按根因修掉，如实登记：

| 出现的失败 | 根因 | 修法 |
|---|---|---|
| `tst-aud-08-15` 的 TST-AUD-09 报 `Unexpected non-whitespace character after JSON` | **测试自身写错**：把 `asset_id` 当 JSON 串去 `JSON.parse` | 直接 `assert.equal(after.asset_id, prop.id)` |
| `tst-aud-08-15` 的 AUD-上界 期望 2 条实得 1 条 | **测试断言写错**：场景只做了"删一条"没做"加一条"，1 条才是对的 | 改成"删旧道具 + 加新道具"，2 条 |

两次都是测试的期望错，不是实现错——但按纪律仍然登记：**新增失败不得因"是测试写错"而不记录**。

---

## 九、结构化项目当前仍不可出片（必读）

必须把这句话读成结论，不要读成免责声明：

1. **`shots` 里没有对应行**。`set_storyboard` 的结构化分支只写 `story_shots`，`segment_id` 一律空串。生成段要等阶段 C 的投影按目标序分配。
2. **界面分镜列表看不到这些镜头**。列表读的是 legacy `shots`。这是**预期行为**。
3. **渲染入口用不上它们**。`projectRenderUnits` 未接线（任务书明令禁止），没有 unit 就没有包、没有任务、没有候选。
4. **资产引用没有落库**。`writeShotAssets` 是独立入口（B-03），`set_storyboard` 的结构化分支**不越权调用它**；返回值里显式写了"资产引用也未写入"，不让调用方误以为已经存好。
5. **站位与动作同样没有接线到 `set_storyboard`**。B-04/B-05 交付的是**写入器**（可被调用），不是"分镜一写就自动落站位"。谁调用、什么时候调用属于阶段 C/D 的编排问题。

**不允许的三种"掩盖"**（本轮一条都没做）：

| 掩盖手法 | 为什么不允许 | 本轮状态 |
|---|---|---|
| 临时插 `shots` 行让列表能显示 | 会造出没有场的段，投影阶段按 id 对不上，且回滚时两边账都不平 | 未做 |
| 复用 legacy 写入兜底 | 等于"结构化开关打开但走老路"，开关失去意义 | 未做 |
| 提前调用投影 | 就是提前实现阶段 C | 未做，`render_units` / `render_adaptations` / `render_unit_shots` 实测零行（B06-09） |

---

## 十、未完成项、阻断项与回滚方式

### 10.1 未完成（属于后续阶段，不是欠账）

| 项 | 归属 | 说明 |
|---|---|---|
| `shot_assets` 差集算法接入 `set_storyboard` | 阶段 C/D 编排 | B-03 已交付可调用的写入器，但 `set_storyboard` 不调用它 |
| 站位/动作接入 `set_storyboard` | 阶段 C/D 编排 | B-04/B-05 同上 |
| 生成段投影（`projectRenderUnits`） | **阶段 C** | 明令禁止本轮实现 |
| `segmentInputHash` 接线 | **阶段 D** | A-07 只交付骨架，`input-hash.js` 本轮未动 |
| `objectNameOf` 接线 | 后续 | A-08 只交付命名函数，本轮未动 |
| 结构化项目的出片能力 | 阶段 C 之后 | 见 §九 |

### 10.2 一个必须点明的实情：两个新写入器零生产调用方

`writeShotBlockings` / `writeShotActions` 目前**只有导出，没有任何生产调用点**（`grep` 只在 `lib/core/index.js` 的 export 列表与自身定义处命中）。它们的唯一"调用方"是测试。

这意味着两件事，必须同时说：

1. **它们不是"已接线的能力"**，而是"可被调用的能力"。本报告§一写"通过"指的是"写入器按契约实现并通过测试"，不是"分镜一写就自动落站位/动作"。
2. **它们没有回归保护**（这是 D02-38 记过的同一个坑："零生产调用方 = 没有回归保护"）。将来谁在阶段 C 接线，必须同时补一条"从 `set_storyboard` 到 `shot_blockings`/`shot_actions` 真的落库"的端到端用例——现在的 22 条用例只能证明"给定正确入参，写入器行为正确"，证明不了"接线时参数传对了"。

`shot_assets` 的情况不同：`writeShotAssets` 有真实调用方（`writeStoryShotWithAssets`，以及既有 Stage 3 路径），所以它的差集审计在真实链路里被执行到。

### 10.3 阻断项

**无。** 本轮未遇到任何"必须停下等裁定"的契约冲突。三处与任务书文本不完全一致的地方已按实施纪律登记在 §十三，性质都是"任务书未预见的实现细节"，且都朝更严格的方向收。

### 10.4 回滚方式

| 层次 | 操作 | 影响 |
|---|---|---|
| 全部回滚 | `git revert <本轮代码提交>` | 回到 `2c9b3df` 状态。**零 DDL、零 manifest 变更、零生产库写入**，所以不需要动库 |
| 只关结构化分支 | `setStructuredSpec(projectId, false)` | 该项目立刻回到 legacy 写入链；**已写入的 `story_shots` 行不删**（D02-03 §12.5.1：关开关只影响行为，不删数据） |
| 只退某个写入器 | 删除对应 import 与调用点 | 三个写入器互不依赖，可单独摘除 |

**注意**：`git revert` 不会删除已经写进 `story_shots` 的业务数据（本轮测试全在临时库，真实库零写入）。若某个真实项目在阶段 B 之后被写入了结构化镜行，回滚代码不会让这些行消失——它们会变成"没有代码能维护的行"。这是本阶段中间态的固有代价，已如实登记。

---

## 十一、禁止事项逐条自查

| 禁止项 | 是否违反 | 证据 |
|---|---|---|
| 启动阶段 C～F | **否** | 本轮只做 B-01~B-06；`render_units`/`render_adaptations`/`render_unit_shots` 实测零行（B06-09） |
| 新增 `projectRenderUnits` 或接入生成段投影 | **否** | `git status` 无相关文件；`grep -rn projectRenderUnits lib/` 无新增引用 |
| 修改 `Shots.*` writer 门禁 | **否** | `lib/core/db.js` 零改动；legacy 分支的 `Shots.update/create/remove` 调用未改 |
| 修改生成输入指纹或视频有效性判断 | **否** | `lib/core/render/input-hash.js` 零改动 |
| 修改 `shot_videos` 产物链 | **否** | 无 `shot_videos` 相关改动 |
| 修改 D01/D02 正式架构规范 | **否** | `docs/D01/**` 零改动；`docs/D02/**` 只新增本报告与 evidence |
| 新增 DDL 或修改 manifest | **否** | `lib/core/schema/*`、`scripts/schema/*`、`lib/core/schema-manifest.json` 均零改动 |
| 扩大 Stage 3 架构决策范围 | **否** | 未新增决策编号；未新增实体、未新增表、未新增错误码类别 |
| 将结构化项目宣称为可渲染/可出片 | **否** | §九 明确声明不可出片；`set_storyboard` 返回值也直接写明 |
| 连接或修改生产数据库 | **否** | `data/ic.db` SHA 仍 `b2ebdb54…`；PG 只连 `infinite_creation_test`（自检第 6 项） |

---

## 十二、阶段 B 验收标准对照

| 验收项 | 状态 | 证据位置 |
|---|---|---|
| B-01～B-06 完成 | **达成** | §一 六行全部"通过" |
| A1～A5 五个必需审计实体全部真实接通 | **达成** | §四 十处接线点行号；五个 fail-closed 条件各自有用例 |
| 所有必需写入路径遵守项目锁契约 | **达成** | §三 十行事务/锁断言；arity 4 接口零改动 |
| 审计失败与业务写入同事务回滚 | **达成** | B01-08、B02-06、B04-07、B05-08、AUD-ROLLBACK 五条 |
| `shot_assets` 差集符合 D02-34 §3.3 | **达成** | §五 八项全覆盖 + 上界用例 |
| 结构化 `set_storyboard` 不产生 legacy `shots` 行 | **达成** | B06-01（`legacyShots` 为空数组）、B06-08（clear 也不碰） |
| 专项测试通过 | **达成** | §6.1 前六行，59/59 |
| 全量回归无新增失败，17 项逐条对照无新增差异 | **达成** | §六、§七（名单层 + 原因层双 diff 空） |
| 没有提前实现阶段 C 投影 | **达成** | B06-09 |

---

## 十三、实施中三处偏离任务书文本的地方（如实登记，请复核方裁定）

这三处都不是"自行改契约"，而是任务书没有写到、实现时必须选一个的地方。三处都朝**更严格**的方向收。

### 13.1 结构化分支的位置从"旧链路中间"前移到"旧链路之前"

**任务书原文**：只说"`structured_spec=1` 时写入 `story_shots`，不写 legacy `shots`"。

**实施中发现的冲突**：`hSetStoryboard` 在到达任何"分支点"之前，已经执行了

- `let existing = Shots.list(ctx.projectId)` —— 用来算**章内最大镜号**
- `if (args.clear) { … Shots.remove(...) }` —— 往 legacy `shots` 做**删除写入**

如果把结构化分支放在这两行之后：结构化项目的 legacy 行恒为 0 → 章内最大镜号恒为 0 → **省略 `idx` 的镜头全部从 1 开始，直接覆盖已经写好的第 1 镜**。这不是理论风险，B06-07 就是专门锁它的用例。

**处理**：分支前移到 `lintStoryboardShots` 之后、`Assets.list` 之前；镜号的"章内已有镜"改从 `story_shots` 算（两遍分配，与旧链路同口径）。分值域门禁（锁档、结构机检）**没有放宽**，仍在分支之前执行。

### 13.2 `cam_note` 补进 `insertStoryShot` / `updateStoryShot` 的写白名单

**任务书原文**：B-02 只写"允许列加入 `segment_id`、`scene_uid`"。

**实施中发现的冲突**：B-06 要把 `set_storyboard` 的 `camera` 落到 `story_shots.cam_note`（该列在冻结 DDL 里**本来就有**）。但 `global-no.js` 的两份白名单是**手工维护的**：

- `insertStoryShot` 只挑白名单里的列 → `cam_note` 会被**静默丢弃**（不报错、库里没有）
- `updateStoryShot` 对白名单外的列**抛 `SHOT_FIELD_INVALID`** → 走 update 分支时整批失败

两种结果都不可接受：前者是"D02-31 说的『静默丢失比报错更难发现』"，后者是"同一份数据新增能写、更新不能写"。

**处理**：把 `cam_note` 加进两份白名单。**这不是新字段、不是 DDL 变更**，只是把已有列纳入写许可。B06-02 专门断言 `cam_note` 真的落了库。

### 13.3 B-06 的用例显式填充了"必读 reference"集合

**任务书原文**：没有提这道门禁。

**实施中发现的冲突**：`set_storyboard` 有一道**早于本轮就存在**的硬门禁——必须先用 `skill_reference` 读完 8 个 `forest-laoli-h3` 必读文件，否则拒绝写入。这正是 §七 里 12 条历史失败的原因。

B-06 的用例如果不管这道门禁，就一条都跑不起来（会被门禁挡住，测不到写入链走向）。

**处理**：在用例的 runtime 上把 8 个 ref 标成已加载（`mkCtx`），**门禁本身一个字没动**。理由：本文件测的是"写入链路走向（`story_shots` vs `shots`）"，不是技能加载门禁；那道门禁有它自己的用例（未加载时拒绝），本轮不放宽也不重复测。

**如果复核方认为这属于"绕过门禁"**，等价替代方案是把 8 个 reference 真的读一遍（`skill_reference` 工具调用），但那样测的仍然是同一件事、只是慢很多。请复核方裁定。

### 13.4 附带发现的两处"看起来有防护、其实到不了"

不属于偏离，属于**必须说清楚的事实**，避免被读成"已经防住了"：

| 位置 | 现象 | 结论 |
|---|---|---|
| `shot-actions.js` 的 `ACTION_CROSS_SHOT` 分支 | `beforeById` 只含**本镜**的行；带别镜的 `id` 时更早的 `if (!b) throw ACTION_NOT_FOUND` 先命中，`ACTION_CROSS_SHOT` **当前不可达** | 保留作防御，但**不得**据此宣称"跨镜移动有独立防护"。B05-06 断言的实际错误码是 `ACTION_NOT_FOUND`，并在用例里写明了原因 |
| `shot-actions.js` 的 `if (logId) changed += 1` | `VOLATILE.shot_action` 是空集，`recordChange` 对 update 恒返回非 null，所以该 `if` 恒真 | 保留（将来若该实体加 VOLATILE 列，这里会自动正确），但**当前不构成一个分支** |

---

## 十四、阶段 B 验收申请

按 D02-44 任务书 §八，九条验收标准全部达成（§十二）。现提交阶段 B 验收申请：

| 角色 | 承担方 | 需要做的事 |
|---|---|---|
| 执行 | WorkBuddy | 已交付：代码 + 测试 + 证据 + 本报告（§六、§7） |
| 独立复核 | ChatGPT | 复核 §十三 三处偏离、§十三-13.4 两处不可达分支、§五 差集算法、§四 十处接线点 |
| 最终验收 | 用户 | 决定通过或不通过 |

**本报告是申请，不是结论。阶段 B 完成不等于阶段 C 获准；阶段 C 必须等待阶段 B 独立复核通过及用户最终验收。**

---

## 附录 A 新增与修改文件清单

| 文件 | 类型 | 行数 | 说明 |
|---|---|---|---|
| `lib/core/render/shot-blockings.js` | 新增 | 138 | B-04 站位写入器 |
| `lib/core/render/shot-actions.js` | 新增 | 130 | B-05 动作写入器 |
| `tests/d02-36-b01.test.mjs` | 新增 | 141 | B-01 专项 |
| `tests/d02-36-b02.test.mjs` | 新增 | 145 | B-02 专项 |
| `tests/d02-36-b04.test.mjs` | 新增 | 249 | B-04 专项 |
| `tests/d02-36-b05.test.mjs` | 新增 | 246 | B-05 专项 |
| `tests/tst-aud-08-15.test.mjs` | 新增 | 302 | B-03 差集八项 + 四条附加 |
| `tests/set-storyboard-structured.test.mjs` | 新增 | 241 | B-06 专项 |
| `tests/helpers/append-worker.mjs` | 新增 | 24 | B-02 并发取号的子进程夹具 |
| `docs/D02/evidence/D02-44-p2-pg-lock.txt` | 新增 | 24 | PG 真库完整锁测试原始日志 |
| `lib/core/scene-state.js` | 改 | +89 −23 | B-01 |
| `lib/core/render/global-no.js` | 改 | +112 −16 | B-02 |
| `lib/core/render/shot-assets.js` | 改 | +78 −5 | B-03 |
| `lib/agent/tools.js` | 改 | +138 −1 | B-06 |
| `lib/core/index.js` | 改 | +7 −1 | 导出新增的写入器与纯函数 |

## 附录 B 关键坐标速查

| 要找什么 | 去哪看 |
|---|---|
| 结构化分流在哪 | `lib/agent/tools.js:2183`（`isStructuredSpec` 判断）、`:2326`（`writeStructuredStoryboard` 定义） |
| 项目行 fail-closed 在哪 | `lib/agent/tools.js:2049` 的 `if (!ctx.project)` |
| 锁内取号在哪 | `lib/core/render/global-no.js:235`（`nextAppendGlobalNo`） |
| 差集函数在哪 | `lib/core/render/shot-assets.js`（`diffShotAssets`）、`lib/core/render/shot-blockings.js`（`diffShotBlockings`） |
| A 类五实体接线点 | §四 表格的"接线点（行号）"列 |
| 17 条历史失败原始日志 | `/tmp/ic-full6/full.log`（本机临时目录，不入库） |
| PG 锁证据 | `docs/D02/evidence/D02-44-p2-pg-lock.txt` |
