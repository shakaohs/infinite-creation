# D02-25 · Stage 3 生产创作链与双轨资产引用收敛实施方案

> 任务性质：生产架构审计 + 数据流设计 + 实施拆分。**本轮不修改任何业务代码、DDL、Schema Manifest，不启动 P10。**
> 证据标记：**【源码】**＝当前仓库代码可复核；**【文档】**＝正式文档有描述但代码未必如此；**【推断】**＝由源码推出、有前提；**【未验证】**＝本轮无法验证；**【建议】**＝尚未存在、需授权后新增。
> 全部行号取自本轮读取时的 HEAD（`4a04eed`）。

---

## 一、执行摘要（先回答任务书 §十三 的十个问题）

### 1.1 十问十答

| # | 问题 | 结论 | 一句话证据 |
|---:|---|---|---|
| 1 | 当前用户实际操作的创作链是 legacy 还是 Stage 3？ | **legacy**（近乎全部） | 项目/章节/剧本/分镜/生成全部落在 `projects` `chapters` `shots` `shot_videos`；Stage 3 只有 `scene_states` 一张表被生产写入 |
| 2 | `story_shots` 是否已是正式生产镜头权威？ | **否** | `INSERT INTO story_shots` 只出现在 `lib/core/render/global-no.js:220`，其两个导出（`insertStoryShot` :198、`appendStoryShots` :379）**无任何 app/lib 调用方**，只有 tests |
| 3 | `shot_assets` 是否已是正式生产资产绑定权威？ | **否** | 唯一写入口 `writeShotAssets()`（`render/shot-assets.js:224`）**无生产调用方**；生产绑定在 `shots.character_ids` 等 7 列（`db.js:950/984`→`:891`） |
| 4 | 资产选择/站位/动作/导演数据如何进入 Stage 3？ | **都不进**（一处例外） | `shot_blockings`／`shot_actions` 的 `INSERT` 命中数 **0**；`story_shots` 的 20 个导演列（`shot_size`/`cam_pos`/…）零写入；唯一例外是 `scene_states` 经 Agent 工具 `set_scene_state` 写入 |
| 5 | 两条赛道是否真正共享同一套创作数据？ | **否（这条链还不存在）** | `render_adaptations`/`render_units`/`render_unit_shots`/`prompt_packages`/`render_tasks`/`render_attempts` 的 `INSERT` 全为 **0**；生产是"每镜直接生成"，无编译单元、无版本冻结 |
| 6 | 哪些 P8/P9 能力由真实生产入口触发？ | **只有 1 项** | 全仓 `runSceneQuality()` 仅被 `app/api/projects/[id]/continuity/run/route.js:44` 调用，且该路由**无任何 UI 调用方**；`planInvalidation()` 零生产调用 |
| 7 | 距完整自动化生产链还缺哪些关键环节？ | **8 个**（见 §16.1） | 缺 stage-3 镜表写入口、资产引用写入口、站位动作写入口、改镜触发、失效计划消费、UI 入口、双赛道编译、legacy 迁移 |
| 8 | 应按什么顺序实施？ | **B1→A→B2→C→D→E**（§14） | 先把"实体读取"接上（零依赖、零 DDL、可单测），再接管镜头，再接管引用，再自动化，最后双赛道 |
| 9 | 哪些架构决策需你批准？ | **D-25-1~8**（§17） | 镜头权威、场次键映射、资产引用收敛、删除保护、自动化边界、编译赛道命名、迁移路径、PF-1 补表 |
| 10 | 什么条件下才能宣布 Stage 3 正式接管生产？ | **8 条验收门槛**（§18.3） | 核心一条：**用户从界面完成一次"建项目→写剧本→出分镜"后，`story_shots` 有行且 `shots` 不再新增** |

### 1.2 三句话总结

1. **Stage 3 目前是"建成但未接入"的模块群**：P5~P9 的规则、求解、持久化、QC、门禁都是可运行的真代码（有 950 条测试），但它们的输入表（`story_shots`/`shot_assets`/`shot_blockings`/`shot_actions`）在生产环境**没有任何写入方**，因此能力无法被真实创作触发。
2. **唯一的真实桥接是 `scene_states`**：Agent 工具 `set_scene_state`（`lib/agent/tools.js:635`）在 `structured_spec=1` 的项目里写场次基线，且 `scene_states.scene_id` 必须是本项目 `category='scene'` 的资产（`scene-state.js:56~66`）。这是目前"Stage 3 与 `assets` 实体表"唯一的正式连接点。
3. **"双赛道共用创作数据"是阶段4 的目标，不是现状**：`render_units.track` 的语义在 D01-05 里写明"`seedance / h3 / legacy`"（D01-05 §4.7 注释），但编译层六张表零写入；现在生产的三条执行通道（本地 ComfyUI／RunningHub／外接 HTTP 引擎）共用的是 `runWorkflow()` 这个渲染收口，**不是**共同创作版本。

---

## 二、当前生产架构事实（只写可复核的）

### 2.1 表清单与"是否被生产写入"

隔离库实测共 **33 张表**（`sqlite_master`）。按"是否有 app/lib 生产写入"分类：

| 分类 | 表 | 生产写入方 |
|---|---|---|
| **legacy 创作数据** | `projects` `chapters` `shots` `shot_videos` `assets` `reference_images` `messages` `jobs` `change_logs` | 全部有（`db.js` 的各 CRUD + 对应 API/Agent） |
| **Stage 3 新建** | `scene_states` | **有**：`upsertSceneStates()` ← Agent `set_scene_state`（`tools.js:635`） |
| | `story_shots` | **无**（仅 tests） |
| | `shot_assets` | **无**（仅 tests） |
| | `shot_blockings` | **无**（`INSERT` 命中 0，含 tests 也是手写 SQL） |
| | `shot_actions` | **无**（同上） |
| | `shot_states` / `qc_reports` | **有，但入口无 UI**：`POST /continuity/run` → `runSceneQuality()` |
| **阶段4 编译层** | `render_adaptations` `render_units` `render_unit_shots` `prompt_packages` `render_tasks` `render_attempts` `render_selections` `render_task_jobs` `adaptation_locks` | **0**（模块 `lib/core/render/*.js` 只被 `index.js` 再导出，无调用方） |
| **迁移/归档** | `migration_batches` `migration_items` `migration_edges` `legacy_artifacts` `timelines` | `legacy_artifacts` 有写入函数（`task-jobs.js:136`）但**该模块无调用方**，实际 0 |
| **其他** | `queue_items` `skills` `workflows` | 有（队列与配置） |

> 这张表是本报告最重要的一张：**"DDL 存在"与"生产在用"必须分开看**。

### 2.2 三条执行通道（不是"两条赛道"）

**【源码】** `runWorkflow()`（`lib/core/workflow-runner.js:261`）是全仓渲染的**唯一收口**，其内按序分流：

| 通道 | 判定 | 代码 |
|---|---|---|
| ① 外接 HTTP 引擎（Seedance/即梦/万相/可灵 等） | `config.engines[]` 中 `enabled=true` 且 `kind` 匹配 | `engine-runner.js:39 pickEngine()` → `runEngineTask()` |
| ② 本地 ComfyUI | `cfg.comfyui.provider === 'native'`（默认） | `backend.js` 原路 → `comfyui.js` |
| ③ RunningHub 云端 | `cfg.comfyui.provider === 'runninghub'` | `backend.js:14/23/32` → `runninghub.js` |

三条通道**共用**同一份 `spec`（工作流规格，`workflow-specs.js`，如 `minimax_h3_r2v`）与同一份 `params`（提示词/时长/分辨率/参考图）。
所以它们是**同一创作链的执行端切换**，与任务书说的"两条视频生成赛道，最后分别编译"不是同一层概念。

**【文档】** 任务书的双赛道＝`render_units.track`（D01-05 §4.7 注释：`seedance / h3 / legacy`），属**阶段4 编译层**：
D02-06 第 448 行原文"Seedance / H3 双编译器、提示词编译 → 阶段 4"。
**【结论】** 当前不存在"双赛道编译"，只有"多执行端"。这条链要在阶段4 才成立（§8）。

---

## 三、真实生产调用链（项目 → 剧本 → 场次 → 分镜）

### 3.1 项目创建

| 步骤 | 实现 | 写表 | 生产调用 |
|---|---|---|---|
| `POST /api/projects` | `app/api/projects/route.js:51` → `createUserProject()` | `projects`（+`chapters` 若传章节） | **是** |
| `createUserProject()` | `lib/core/project-create.js:19`，默认 `structured_spec=true` | — | **是**（用户建项目的唯一入口） |
| `Projects.create()` | `db.js:596+`，低层原语 | `projects` | 被上面调用；tests 直接用 |

**【源码】** 新项目默认 `structured_spec=1`，所以"结构化创作"这个开关在生产是**默认开**的；但开关只控制"能否写 `scene_states`"（`tools.js:626`），**不控制**镜头写到哪张表。

### 3.2 剧本保存与场次结构化

| 步骤 | 实现 | 写表 | 生产调用 |
|---|---|---|---|
| 剧本正文存 `chapters.script` / `projects.novel` | `Chapters.create/update`（`db.js:1072/1087`）、`POST /projects` 的 `chapters` 分支 | `chapters` | **是** |
| 小说导入并建角色资产 | `POST /projects/:id/novel/import`（`route.js:20/54`） | `projects` `chapters` `assets` | **是** |
| 场次基线（结构化） | Agent 工具 `set_scene_state` → `upsertSceneStates()`（`scene-state.js:104`） | `scene_states`（14 列） | **是**（要求 `structured_spec=1`） |
| 场次场景抽取 | `ensureScriptAssets()`（`script-assets.js:163`）从场次头/人物行/道具词建 `assets` | `assets` | **是**（被分镜导入调用，`storyboard-import.js:909`） |

**场次身份（本轮最关键的建模缺口）**：`scene_states.scene_key` 是**用户/模型给的字符串键**（如 `S01_病房`），
而 legacy `shots.scene_name` 是**自由文本**（如"病房"），两者**没有映射表、没有生成规则、也没有校验**。
`story_shots` 同时有 `scene_key` 与 `scene_id`（后者指场景资产），但两张表之间只有 `scene_id ↔ assets.id` 这一条被校验过（`scene-state.js:126`）。

### 3.3 分镜生成与镜号

| 步骤 | 实现 | 写表 | 生产调用 |
|---|---|---|---|
| Agent 批量写分镜 | 工具 `set_storyboard` → `hSetStoryboard()`（`tools.js:2040`）→ `Shots.create/update`（`:2256/2260`） | `shots` | **是** |
| 界面新建/编辑单镜 | `POST/PATCH /projects/:id/shots[/:sid]` → `Shots.create/insertAt/update` | `shots` | **是** |
| 分镜表（xlsx）导入 | `storyboard-import.js`（`Assets.create` 补资产 + `Shots.create` 写镜） | `assets` `shots` | **是** |
| 镜号 | legacy：`shots.idx`（**章内**连续，`db.js:950~958`） | `shots.idx` | **是** |
| Stage 3 镜号 | `story_shots.global_no`（项目级唯一，`global-no.js` 两阶段重编号） | `story_shots` | **无** |

**两套镜号的关系**：`shots.idx` 是"章内镜号"，`story_shots.global_no` 是"项目级镜号 + `shot_no` 章内号"。
两者**没有转换代码**（全仓无 `idx → global_no` 映射函数）。

### 3.4 镜头复制/拆分/合并/删除/移场

| 操作 | legacy 实现 | Stage 3 对应 | 结论 |
|---|---|---|---|
| 复制/新增 | `Shots.create` / `insertAt`（`db.js:950/973`） | `insertStoryShot` / `appendStoryShots` | 仅 legacy 可用 |
| 拆分/合并 | 无独立 API；界面靠"改 `sub_shots` + 手动加镜" | 无 | 两套都无正式能力 |
| 删除 | `DELETE /projects/:id/shots/:sid`（`route.js:38`）→ `Shots.remove()`（`db.js:1004`：清 `shot_videos` + `shots`；本章有运行中任务时 409） | **无** | 仅 legacy；投影后需补"删 legacy 镜 → 级联删 `story_shots` 及其从表" |
| 移场（改章节） | `Shots.update({chapter})` | 无 | 仅 legacy |

> 说明：`story_shots.scene_key` 变更 = `applyTargetOrder`/`renumberTwoPhase` 支持的是**顺序**，不是**归属**；
> 移场（换 `chapter_id`）在 Stage 3 没有任何入口。

### 3.5 结论：`story_shots` 的真实地位

| 提问 | 答案 |
|---|---|
| 是否有正式生产写入入口？ | **没有**。`insertStoryShot`/`appendStoryShots` 仅导出 + tests |
| 哪些模块调用？ | tests（`stage3-p1/p3/p8/p9*`）+ `shot-assets.js`（而它本身也无生产调用方） |
| 是否有"剧本→分镜→story_shots"完整路径？ | **没有**，路径在 `shots` 处终止 |
| legacy `shots` 是否仍是用户实际操作源？ | **是**（界面、API、Agent、导入、生成全部围绕它） |
| 两套数据是否可能不一致？ | **已经不一致**：`story_shots` 在生产恒为空，谈不上"不一致"，而是"根本不存在" |
| 是否有同步/映射/迁移机制？ | **没有**。`legacy_artifacts` 是阶段4 的归档表，写入函数无调用方 |

---

## 四、legacy 与 Stage 3 数据模型对照

| 业务概念 | legacy 落点 | Stage 3 落点 | 生产用哪个 | 能否机械映射 |
|---|---|---|---|---|
| 项目 | `projects`（22 列） | 同表 | legacy | 同一表 |
| 章节 | `chapters`（title/seq/novel/script） | 同表 + `story_shots.chapter_id` | legacy | 需 `title ↔ id` 映射 |
| 剧本 | `chapters.script` / `projects.novel` | 同表（无第二份） | legacy | 同表 |
| 场次 | `shots.scene_name`（自由文本） | `scene_states.scene_key` + `scene_id` | **两套并存，无映射** | **否**（需建映射规则） |
| 镜头 | `shots`（35 列） | `story_shots`（48 列） | legacy | **部分**：见下 |
| 镜号 | `shots.idx`（章内） | `global_no`＋`shot_no` | legacy | 需生成规则 |
| 视觉/构图/摄影机 | `shots.camera`／`visual`（自由文本） | `shot_size`／`cam_direction`／`cam_pos`／`lens_mm` 等 20 个结构化列 | legacy | **否**（需 LLM 或人工结构化） |
| 台词/旁白/音效 | `shots.dialogue/narration` | `dialogue`／`narration`／`sfx`／`music_cue` | legacy | 可（文本直传） |
| 时长/时间片 | `shots.duration`／`sub_shots`（JSON） | `story_duration`／`time_slices`（JSON） | legacy | 可（`sub_shots` 结构需对齐，`validateSubShots`） |
| 资产实体 | `assets` | 同表 | **legacy 与 Stage 3 共用** | 同一表 |
| 镜头资产绑定 | `shots.character_ids/scene_ids/prop_ids/costume_ids/age_ids/audio_ids/refs` | `shot_assets`（role＋order_no＋variant_of） | legacy | **可**（见 §5.3） |
| 站位 | `shots.blocking`（**模板化字符串**，D01-04 §4.5） | `shot_blockings`（逐人 14 列 + 场次基线） | legacy | **需解析**（字符串→行） |
| 动作 | `shots.sub_shots`（镜头级时间片） | `shot_actions`（actor/tier/init_state/trigger…） | legacy | **不可直映**（粒度不同） |
| 场次基线 | 无 | `scene_states`（14 列） | **Stage 3** | 反向：Stage 3 领先 |
| 连续性状态 | 无 | `shot_states`（8 列） | Stage 3（仅 P9 入口） | — |
| QC | 无 | `qc_reports`（8 列） | Stage 3（仅 P9 入口） | — |
| 生成产物 | `shot_videos`（多候选 + selected）／`shots.video_path` | 无（`render_*` 未用） | legacy | 阶段4 再谈 |

**结论**：两套模型不是"字段名不同"，而是**抽象层级不同**——legacy 是"文本 + JSON 列"，Stage 3 是"关系化 + 可校验"。
能机械映射的只有台词/时长/资产绑定；镜头语言（构图、机位、站位、动作）需要**结构化转换**，这是迁移的真正成本所在。

---

## 五、`assets` 与 `shot_assets` 的真实引用链

### 5.1 实体侧（结论 A，已在 D02-24 确认）

| 项 | 事实 |
|---|---|
| 实体表 | `assets`（`db.js:130~157`，26 列） |
| 主键 | `id`（uuid v4，`db.js:753`） |
| 归属 | `project_id` NOT NULL；`Assets.create/update` + AS-2 强制同项目 |
| C.4 四字段 | `id`／`name`／`category`／`parent_id` 齐备 |
| 唯一性 | 仅 PK；`(project_id, category, name)` **无唯一约束**（实测同名可建两条） |
| 文件 | `image_path`／`audio_path`／`video_path`（项目内相对路径）＋`versions` |

### 5.2 引用侧（结论：无生产写入）

| 项 | 事实 |
|---|---|
| 写入口 | `writeShotAssets()`（`shot-assets.js:224`）：先 `DELETE FROM shot_assets WHERE shot_id=?` 再逐行 INSERT（整组替换） |
| 调用方 | **0**（`lib/core/index.js:70` 再导出 + tests） |
| 读入口 | `load-scene.js:177`（QC 用）；`deriveVoiceIds()`（`shot-assets.js:213`，供 `voice_ids` 派生） |
| 校验 | 存在性 `ASSET_NOT_FOUND`／同项目 `ASSET_NOT_IN_PROJECT`／`category==role` `ASSET_ROLE_MISMATCH`／重名 `ASSET_NAME_AMBIGUOUS`／变体父 `ASSET_VARIANT_ORPHAN`／场景一致 `SCENE_ASSET_MISMATCH` |
| `variant_of` | `assets.parent_id` 的快照（`resolveVariantOf` :171~181），仅 costume/age 有值 |

### 5.3 legacy 绑定能否准确映射到 Stage 3

**【源码 + 推断】** 可以，但有三个必须显式处理的差异：

| 差异 | legacy | Stage 3 | 映射规则（建议） |
|---|---|---|---|
| `role` | 由**列名**隐含（`character_ids` → character） | 显式列 `role` | 列名→role 一一对应（`db.js:873` 的 `SHOT_REF_FIELD_CATEGORIES` 就是这张表） |
| `order_no` | 无（数组顺序即顺序） | 同 role 内 1..n 连续 | 数组下标 + 1 |
| `variant_of` | 无（`costume_ids` 里直接放变体 id） | 需 `assets.parent_id` | 查 `assets.parent_id` 回填 |
| `audio_ids` | 可含 voice/music/sfx | `role='voice'` 上限 3；music/sfx 不入 `shot_assets`（AS-4） | **不可全映射**：music/sfx 必须留在别处（见 D-25-3） |

**最后一行是硬冲突**：legacy `audio_ids` 允许 music/sfx，`shot_assets` 的 `role` 值域只有 6 项且 AS-4 明令
"music/sfx/video/other 不许进 `shot_assets`"。所以"`audio_ids` 全量搬进 `shot_assets`"在契约上就是错的。

### 5.4 删除与引用完整性（必须如实说）

| 行为 | 现状 | 后果 |
|---|---|---|
| 删资产 | `Assets.remove()`（`db.js:837`）级联删子变体（`parent_id`），**不清理 `shot_assets`** | 阶段3 会留下悬空 `asset_id`；依赖层用 `__missing__` 兜底，V-03 fail-closed，不静默放行 |
| 删资产 | 同上，**不清理 legacy `shots.*_ids`** | 悬空 id 永久留在数组里（`normalizeShotRefs` 只在"下次写这一镜"时丢弃） |
| 删除前提示 | `Assets.usageOf()`（`db.js:822`） | `children` 正确；`shotIds` **只扫 legacy `shots`**，看不到 `shot_assets` |
| 删项目 | `Projects.remove`（`db.js:697~712`） | 顺序正确（先镜级从表、后 `assets`、最后 `projects`）；无外键，靠顺序 |

**因此：不得声称"Stage 3 的资产删除保护已完整"。** 现状是"fail-closed 兜底"，不是"删除保护"。

### 5.5 资产修改是否触发 QC 失效

| 环节 | 是否就绪 | 证据 |
|---|---|---|
| 资产改动可被捕获 | **是** | 所有写都过 `Assets.create/update`，且写 `change_logs`（`changelog.js:44`） |
| 失效编排支持 | **是** | `planInvalidation({change:{assets:[{asset_id, fields}]}})`（`invalidate.js:404~450`），缺 `shotAssets` 时抛 `INVALIDATION_ASSETS_CONTEXT_MISSING`（fail-closed） |
| 调用方接线 | **否** | `planInvalidation` 全仓**零生产调用**（只有 doc 注释提到） |
| 改完自动重跑 | **否** | 无 watcher／无 hook；`runSceneQuality` 只在手工 HTTP 路由里 |

---

## 六、导演、站位、动作、场次基线的数据链

### 6.1 逐项事实

| 数据 | 生产落在哪 | Stage 3 表 | 生产写入 | 备注 |
|---|---|---|---|---|
| 景别/机位/构图 | `shots.camera`（自由文本）+ `shots.visual` | `shot_size`／`cam_direction`／`cam_height`／`cam_pos`／`lens_mm`／`composition_rule`… 共 20 列 | **0** | 结构化字段无入口 |
| 摄影机运动 | `shots.camera` 文本里描述 | `movement`／`movement_amp`／`cam_path` | **0** | — |
| 站位 | `shots.blocking`：**模板化中文字符串**，如"@斯洛恩（画面左 · 背靠西侧金属护栏 · 正面朝右前方…）"（D01-04 §4.5 有实测 13 条） | `shot_blockings`（逐人：`position_abs`／`norm_x/y/z`／`facing`／`posture`／`anchor_object`…） | **0** | 需"字符串→结构化"解析器；P5 的 69 条规则全部依赖结构化列 |
| 动作 | `shots.sub_shots`（JSON：时间片 + 画面描述） | `shot_actions`（actor／tier／`trigger_json`／`result_json`／`end_state`…） | **0** | 粒度不同：`sub_shots` 是"镜头时间片"，`shot_actions` 是"角色动作单元" |
| 场次基线 | **无** | `scene_states`（`coord_system`／`fixtures`／`axis_lock`／`time_of_day`…） | **有**（Agent `set_scene_state`） | Stage 3 在此领先 legacy |
| 台词/旁白 | `shots.dialogue`／`narration` | `dialogue`／`speakers`（JSON）／`narration` | **0** | 可直传 |
| 时长 | `shots.duration` + `sub_shots` | `story_duration` + `time_slices` | **0** | 需与 `validateSubShots` 对齐 |

### 6.2 数据类型边界（任务书 §3.4 要求区分）

| 类型 | 例子 | 是否持久化 |
|---|---|---|
| 正式生产数据 | `shots.blocking` 文本、`shots.camera`、`scene_states.*` | 是 |
| 临时请求数据 | `POST /continuity/run` 的 `annotations`（人工标注）、`POST /continuity/solve` 的 `plan` | **否**（只活在请求里，P8-A 已记录：持久化需 DDL） |
| 测试夹具 | tests 里手写的 `insertStoryShot` + 直接 `INSERT INTO shot_blockings` | 否（隔离库） |
| 求解器计算结果 | `shot_states.state_in/out/meta/conflicts` | 是（但仅 P9 入口） |
| 人工标注输入 | `annotations`（`source: manual`） | **否**（同上） |

> **不得**把 `annotations` 这类"请求字段"描述成"已持久化的生产能力"——它每次调用都得重传，且 P8 明确禁止把 `shot_states.meta` 回搬成人工输入。

### 6.3 导演"决策"数据在哪

**【源码】** 没有独立的"导演决策"实体。相关数据分散在：
- `projects.style`（风格）、`projects.video_*`（分辨率/比例/模型）、`projects.context`（bible/风格指南等，`CONTEXT_KEYS`）；
- `chapters.script`（剧本）；
- `shots.camera`／`visual`／`sub_shots`／`blocking`（逐镜导演意图，文本）；
- `scene_states`（空间基线，结构化）。

`story_shots` 的 48 列本来是为"结构化导演数据"设计的（20 列镜头语言 + 说话人 + 时间片 + 版本/来源），但**没有写入方**。

---

## 七、P8/P9 的真实生产调用情况

| 能力 | 入口 | 生产可达性 | 备注 |
|---|---|---|---|
| `loadSceneInput()` | `run-scene.js:137` | 仅经 `POST /continuity/run` | 读 `story_shots`（生产为空 ⇒ `SCENE_INPUT_EMPTY`） |
| `assembleSolverShots()` | `solve-scene.js` 内部 | 同上 | P8 来源隔离在此，未破坏 |
| `solveContinuity()` / `solveLoaded()` | `solve-scene.js` | 同上 | 纯函数，无 I/O 之外的副作用 |
| `runSceneQuality()` | `run-scene.js:126` | **仅** `app/api/projects/[id]/continuity/run/route.js:44` | 无 UI 调用；无定时/事件触发 |
| `loadShotAssetEntities()` | `run-scene.js:105` | 同上 | 恒 `[]`（D02-24 结论 A：有源未接） |
| `persistSceneStates()` | `run-scene.js:162` | 同上（同一事务） | 内容 Hash 幂等 |
| `buildShotReport()` / `saveReport()` | `run-scene.js:179/206` | 同上 | 规则级 carried + 六字段 |
| `planInvalidation()` | — | **零调用** | 只有注释引用 |
| `gateOf()` | `run-scene.js:226` | 同上 | 产出 `pause`／`pass`，但**无消费方**（不阻断任何生成） |

### 7.1 七个"是否自动"的直接回答

| 问 | 答 |
|---|---|
| 改一条真实镜头数据后自动触发连续性求解？ | **否**。`Shots.update` 无 hook，无事件总线；求解入口需手工 HTTP |
| 自动执行 QC？ | **否**（同上，QC 与求解绑在同一次 `runSceneQuality` 调用里） |
| 自动保存状态与报告？ | **否**（只在被调用时保存） |
| 自动处理 carried 与失效？ | carried **是**（`buildShotReport` 内部）；失效计划 **否**（`planInvalidation` 零调用，`plan` 必须由调用方手工传） |
| 哪些失败自动重试？ | 求解/QC **无重试**（同步单事务，失败即抛）；渲染侧有队列与重试（`job-runner`／`runRenderSlot`） |
| 哪些关键失败暂停？ | `gateOf()` 会返回 `pause` + `blocking[]`，但**没有代码消费它去停止任务**——它是"结论"，不是"闸门动作" |
| 是否有人必须手动调的内部接口？ | 是：`POST /continuity/run`（唯一能产出状态与报告的口子），且无 UI 入口 |
| 是否有"只有测试能触发"的能力？ | 是，且很多：`story_shots` 写入、`shot_assets` 写入、`shot_blockings`/`shot_actions` 写入、`planInvalidation`、`render_*` 全层 |

> 这一节是对"P8/P9 测试全绿 ⇒ 生产已闭环"的直接否定。**测试通过证明的是模块正确性，不是接线完整性。**

> **同名干扰项提醒**：项目上下文里也有一个 `continuity`（`CONTEXT_KEYS` 之一，落盘为 `continuity.json`，见 `app/api/projects/[id]/context/route.js:43~45`），那是"连续性备忘文本"，供 LLM 参考，与 `POST /continuity/solve|run` 这套求解接口**没有代码关系**。检索时不要混为一谈。

---

## 八、两条赛道当前的编译链

### 8.1 正式定义（文档）

| 文档 | 原文 | 含义 |
|---|---|---|
| D01-05 §4.7（`render_units` 注释） | `track TEXT NOT NULL, -- 冗余自 adaptation；seedance / h3 / legacy` | 赛道 = `seedance`／`h3`（+过渡态 `legacy`） |
| D02-06 第 448 行 | "Seedance / H3 双编译器、提示词编译 → 阶段 4" | 双编译器属阶段4 |

### 8.2 代码现状

| 层 | 表/模块 | 写入 | 说明 |
|---|---|---|---|
| 适配方案 | `render_adaptations`（18 列）／`adaptation-locks.js` | **0** | 版本、profile、切分策略、锁，全空 |
| 编译单元 | `render_units`／`render_unit_shots` | **0** | 单元与镜序映射，全空 |
| 编译产物 | `prompt_packages`（`body`/`ref_pack`/`compiled_hash`/`compiler_ver`） | **0** | 提示词包，全空 |
| 生成任务 | `render_tasks`／`render_attempts`／`render_task_jobs`／`render_selections` | **0** | 任务与尝试，全空 |
| 当前实际生成 | `tools.js:2549 generateShotVideo()` → `runWorkflow()` → `ShotVideos.create`（`tools.js:2519`）＋`Shots.update(video_path)` | **有** | 逐镜、直接、无编译单元 |

### 8.3 七问七答（任务书 §4.2）

| 问 | 答 |
|---|---|
| 两条赛道都能从同一套 Stage 3 镜头数据读输入？ | **不成立**：Stage 3 镜头数据在生产为空；编译层也无读取实现 |
| 是否有赛道仍直接读 legacy `shots`？ | **三条执行通道都读 legacy `shots`**（不是"其中一条") |
| 两条赛道使用相同资产实体与镜头绑定？ | 资产实体**是同一张表**；镜头绑定**都没有**（`shot_assets` 空） |
| 编译过程会修改共同创作数据？ | 目前无编译过程；现有生成只写 `shot_videos`／`shots.video_path`（产物，不动创作字段） |
| 各赛道参数/适配/提示词/结果存哪？ | 设计上：`render_adaptations`／`prompt_packages`／`render_tasks`／`render_attempts`；**现状：都没写**，提示词临时存 `shots.video_prompt` |
| 某赛道失败是否影响另一赛道？ | **无赛道层，故无赛道级隔离**；现有隔离粒度是"镜"（`shot_videos` 多候选、`shots.status`）与"任务"（`jobs`） |
| 如何确保两赛道同一创作版本？ | 无机制。`source_spec_hash`／`shot_scope_hash` 列存在但无写入方 |

**结论**：双赛道共享创作数据是**阶段4 的设计目标**，当前连"创作数据"本身都还没进 Stage 3，
所以"两赛道读同一版本"现在无从谈起。任何声称"双轨已共用一套数据"的说法都不成立。

---

## 九、目标架构图（区分已存在 / 缺失）

```text
                        【现状】                          【目标】
项目入口  POST /api/projects  ────────────── 已有 ──────────────  不变（structured_spec=1）
   |
剧本与场次结构化
   ├─ chapters.script（已有）                       保留为"原文"，不承担结构化职责
   ├─ set_scene_state → scene_states（已有）        保留 + 补齐 scene_key↔章节 映射
   └─ scene_key ↔ shots.scene_name 映射             ✗ 缺失  →  【建议新增】映射规则/表
   |
共同创作数据层
   ├─ story_shots            ✗ 无生产写入            →  P10-A 接管（唯一镜头权威）
   ├─ assets                 ✓ 已是实体权威          →  不变（D02-24 结论 A）
   ├─ shot_assets            ✗ 无生产写入            →  P10-B 接管（唯一引用权威）
   ├─ shot_blockings         ✗ 无生产写入            →  P10-C（blocking 文本 → 结构化行）
   ├─ shot_actions           ✗ 无生产写入            →  P10-C（sub_shots → 动作单元）
   └─ scene_states           ✓ 已有                  →  不变
   |
连续性求解  loadSceneInput → solveLoaded            ✓ 代码就绪，✗ 输入为空 → P10-A/B/C 喂数据
   |
QC 与自动门禁  runSceneQuality → gateOf              ✓ 代码就绪，✗ 无 UI/事件入口 → P10-D
   |
共同创作版本冻结（version freeze）                    ✗ 不存在  →  P10-E 前置（复用 render_adaptations 的 hash 列）
   |
   ├─────────────── track='h3' ───────┐   ┌──── track='seedance' ────┐
   │  编译：prompt_packages            │   │  编译：prompt_packages     │   ✗ 阶段4
   │  任务：render_tasks/attempts      │   │  任务：render_tasks/...    │   ✗ 阶段4
   └───────────────┬───────────────────┘   └──────────┬───────────────┘
                   v                                  v
              赛道 A 结果                        赛道 B 结果
```

**读图要点**：图的中间竖线以上是"创作数据"，以下才是"两条赛道"。当前**只有 `assets` 与 `scene_states` 是绿的**，
其余创作表与整条编译层都是红的。目标不是重画架构，而是把红线逐个点亮，且**不新建第二套创作表**。

---

## 十、数据权威性决策矩阵

| 数据 | 建议唯一权威 | 过渡期谁写 | 谁读 | 冲突处理 | 状态 |
|---|---|---|---|---|---|
| 项目 | `projects` | 不变 | 全链路 | — | 已有 |
| 剧本原文 | `chapters.script`／`projects.novel` | 不变 | 结构化抽取、提示词 | 以 `chapters.script` 为准（多章时） | 已有 |
| 场次 | **`scene_states`（结构化）+ `scene_key` 为键** | Agent 写；legacy `shots.scene_name` 只读 | QC、求解、编译 | `scene_key` 缺失即拒写（已有 fail-closed 风格），禁止猜 | 需补映射（D-25-2） |
| 镜头 | **`story_shots`**（P10-A 后） | 过渡期 `shots` 写、单向投影到 `story_shots` | QC/求解/编译 | 冲突**禁止静默覆盖**：投影失败即拒写并回报 | 待接管 |
| 镜号 | `story_shots.global_no`＋`shot_no` | `shots.idx` 单向映射（章内序号 → `shot_no`） | 全部 | 两阶段重编号已有；跨章冲突抛 | 待接管 |
| 资产实体 | `assets` | 不变 | 全链路 | 同名允许（现状），绑定按 id | 已有 |
| 镜头资产引用 | **`shot_assets`**（P10-B 后） | 过渡期 `shots.*_ids` 写、单向投影 | QC、refs（改为读它） | `role` 值域与 `audio_ids` 的 music/sfx 冲突 → 分流（D-25-3） | 待接管 |
| 站位 | **`shot_blockings`** | 过渡期 `shots.blocking` 文本写，解析为行 | QC/求解 | 解析失败必须报错，不得默认空站位 | 待接管 |
| 动作 | **`shot_actions`** | 过渡期 `shots.sub_shots` 写 | QC/求解 | 粒度不对等，需显式转换规则 | 待接管 |
| 场次基线 | `scene_states` | 不变 | 求解/QC | — | 已有 |
| 连续性结果 | `shot_states` | P9 准入 | QC/门禁 | 只读给 QC，**禁止回搬**为人工输入（P8 冻结） | 已有（入口待接） |
| QC | `qc_reports`（每镜一份，规则级 carried） | P9 | 门禁/UI | 只与最新一份比；A→B→A 新增 | 已有（入口待接） |
| 编译输入 | **创作版本快照**（`source_spec_hash` + `shot_scope_hash` 已有列位） | 阶段4 | 两条赛道 | 冻结后不可改，改则生成新版本 | 待建 |

**三条贯穿原则**（与任务书 §5.1 对齐）：

1. **单向投影，不做双向同步**：过渡期 legacy 是"写入端"，Stage 3 是"投影端"；同一字段只允许一处写。
2. **映射失败即失败**：不做"映射不上就跳过"（那会让 Stage 3 数据看起来完整、实则缺行）。
3. **不改 P8 隔离**：投影只写 `story_shots`/`shot_assets` 等原始输入表，绝不写 `shot_states.meta`。

---

## 十一、legacy 过渡与迁移方案（三方案比较，给唯一推荐）

### 方案 A：Stage 3 逐步接管（推荐）

| 阶段 | 做法 |
|---|---|
| A1 影子期 | legacy 仍是唯一写端；每次写 `shots` 后，同事务投影一份到 `story_shots`/`shot_assets`（投影失败 → 整笔回滚并报错） |
| A2 双读期 | QC/求解只读 Stage 3；界面仍读 legacy；两套数量对账（每日/每操作） |
| A3 切换写端 | 界面与 Agent 改为写 Stage 3；legacy 只读，供旧导出与合成使用 |
| A4 退场 | `shots` 停止写入，保留只读 + 导出；`shot_videos` 等产物表继续用 |

| 优点 | 缺点 |
|---|---|
| 数据只有一条写路径，不会有"两边都能改"的冲突 | 过渡期每次写要付一次投影成本（同事务，可接受） |
| 每步可回滚（关掉投影开关回到 A0） | 结构化转换（blocking→行、sub_shots→动作）是主要工作量 |
| 与 P8 隔离原则兼容（投影只写原始输入表） | 需要 `scene_key`、`shot_no` 的确定性生成规则 |

### 方案 B：长期双轨并行

| 优点 | 缺点 |
|---|---|
| 改动最小，legacy 完全不动 | **长期一致性成本不可控**：两个写端 + 一个转换层，必然出现"改了 A 没改 B" |
| 阶段3 能力可独立演进 | 冲突处理无从下手（谁是权威？任务书 §5.1 第 2 条已禁止"两系统同时写"） |
| — | QC 结论会长期建立在"投影可能过期"的数据上 |

**否决**。它违反任务书 §5.1-2（不允许两系统长期双向同步且同时拥有写权），且成本随规模上升。

### 方案 C：以 legacy 为唯一权威，Stage 3 只做"计算视图"

即：`story_shots` 不落成品行，改为**查询时从 `shots` 动态组装**（视图或内存映射），Stage 3 只保留 `shot_states`/`qc_reports`。

| 优点 | 缺点 |
|---|---|
| 零双写、零迁移 | `story_shots` 的 48 列结构化数据无处存放（legacy 只有文本列），QC 规则读的结构化字段（`cam_pos`、`shot_size`…）永远缺失 |
| 不会出现数据不一致 | 无法承载 `shot_no`/`global_no` 稳定性、版本与来源（`spec_source`/`fill_confidence`） |
| — | D01-04/D02-06 的镜号与结构化契约事实上无法落地 |

**否决**：它把"结构化"这件事抹掉了，而 69 条 QC 规则里大量依赖结构化字段（P5 已实现）。

### 推荐：**方案 A**，并给出明确的"投影闸门"

```
写 legacy（Shots.create/update）
   └─ 同一事务 → projectShotToStage3()   ← 【建议新增】唯一投影函数
         ├─ 解析 blocking 文本 → shot_blockings 行（失败 → 抛，整笔回滚）
         ├─ 解析 sub_shots    → shot_actions 行（失败 → 抛）
         ├─ shots.*_ids       → shot_assets 行（music/sfx 分流，见 D-25-3）
         └─ 写 story_shots（global_no 用两阶段重编号；scene_key 缺失 → 抛）
```

投影函数是**唯一**允许同时写两套模型的地方；它必须满足：
同事务、幂等（同输入重复写不产生新行）、可回滚、失败即整笔失败、可开关（灰度）。

---

## 十二、资产 QC 正式接线设计

### 12.1 读取（实体侧，改动极小）

```js
// 【建议】lib/core/continuity/run-scene.js
export function loadShotAssetEntities({ projectId, shotAssets = [] }) {
  const ids = [...new Set(shotAssets.map((r) => String(r?.asset_id ?? '')).filter(Boolean))].sort(cmpStr);
  if (!ids.length) return [];                    // 本镜无引用 ⇒ []（≠ undefined，QH-16）
  return getDb().prepare(
    `SELECT id, name, category, parent_id FROM assets WHERE project_id = ? AND id IN (${ids.map(() => '?').join(',')})`,
  ).all(String(projectId), ...ids);
}
```

| 约束 | 落地方式 |
|---|---|
| 只取本镜子集 | 入参就是本镜 `shotAssets`；依赖层再按 `shotAssets` 过滤（`deps/index.js:117~133`） |
| 只四字段 | SELECT 列表固定 4 列（AR-5） |
| 项目边界 | `WHERE project_id = ?`，越界行自然查不到 |
| 缺失实体 | 查不到 → 依赖层填 `__missing__`（AR-3），V-03 fail-closed |
| 不改 Hash 契约 | 四字段本就是 `qcdep-2` 的纳入范围，不改算法 |

**查询次数优化（D-25-…）**：每场一次 `IN`（并集）后在 JS 里按镜切分，可把 N 次查询降到 1 次，
语义仍是"只给本镜子集"。建议采用后者。

### 12.2 引用写入（真正的接线）

| 环节 | 建议 |
|---|---|
| 写入入口 | 复用 `writeShotAssets()`（已有全部校验），由 **P10-A 的投影函数**或界面绑定入口调用 |
| 更新入口 | 同一函数（整组替换），不做增量 patch |
| 删除入口 | 传 `input:{}` → 清空（现有行为：`DELETE` + 无 INSERT）；**不提供"删单个 role"的隐式语义** |
| 唯一性/排序 | DB 已保证 `(shot_id,role,asset_id)` 唯一、`(shot_id,role,order_no)` 唯一；`order_no` 1..n 连续 |
| 变体 | `variant_of` 由 `assets.parent_id` 回填；父缺失抛 `ASSET_VARIANT_ORPHAN` |
| 归属 | `project_id` 由镜推得；AS-2 校验 |
| 事务边界 | 与 `story_shots` 写入同事务（`writeStoryShotWithAssets` 已是此形态） |
| 并发冲突 | 现有实现是"整组替换"（先删后插）→ 两个并发写同一镜会互相覆盖。**建议**加乐观锁（`story_shots.state_rev` 或 `updated_at` 比对），不满足则拒写（详见 D-25-4） |
| 引用完整性 | 资产删除时**阻断**（§12.4） |
| 失败恢复 | 事务回滚；失败原因必须含 `shot_id`／`asset_id`／`role`（现有错误已带） |

### 12.3 资产变更 → 失效（哪些进 Hash、触发谁）

| 变更 | 进 `qc_dependency_hash` | 受影响规则（按 `rule-deps.js`） | 需重跑 |
|---|---|---|---|
| `name` | 是 | V-26（音色名解析）、AS-8 相关 | 是 |
| `category` | 是 | V-03（`category==role`）、A-07、S-02 | 是 |
| `parent_id` | 是 | V-03／S-02（变体归属）、`variant_of` | 是 |
| 变体（增删子资产） | 间接（引用行变化） | 换装相关（S-13 等） | 是 |
| 资产文件替换（`image_path`） | **否**（AR-5：文件路径不纳入） | 无 QC 失效；出片需人工重生成 | 否（但需提示用户） |
| 资产删除 | 是（引用悬空 → `__missing__`） | V-03 等 → fail-closed | 是（且应阻断删除，见 12.4） |
| 绑定增加/删除 | 是（`shotAssets` 变化） | 按 role 决定（character/prop 进求解，其余只进 QC） | 是 |
| 绑定顺序调整 | 是（`order_no` 进 Hash） | V-23/V-25（顺序相关） | 是 |

**契约边界**：以上全部落在现有 `qcdep-2` 与 `rule-deps.js` 的冻结映射内，**不改任何规则与 Hash 字段**。
如发现某条变更无处归属，只登记为决策（§17），不自行补丁。

### 12.4 删除保护（补强设计，非本轮实施）

现状缺口：`Assets.usageOf()`（`db.js:822`）只扫 legacy `shots` 的 7 个数组列，**不扫 `shot_assets`**。

| 建议 | 内容 |
|---|---|
| `usageOf()` 增补 | 加一段：`SELECT shot_id, role FROM shot_assets WHERE asset_id = ?`（以及 `story_shots` 侧归属，用 JOIN） |
| 删除策略 | 有正式引用 → **阻断**，返回 `{ shotIds, roles }` 与项目；不默认级联删绑定 |
| 解绑与删除分离 | "从镜头解绑"是 `writeShotAssets` 的职责；"删资产"只在无引用时允许 |
| 子变体 | 保持现有级联（`parent_id`），但级联前也要检查每个子变体是否被引用 |
| 孤儿清理 | 提供显式"清理悬空引用"工具（列出 + 二次确认），不自动删 |

---

## 十三、生产自动化与故障隔离设计

### 13.1 触发模型（当前 vs 建议）

| 事件 | 当前 | 建议 |
|---|---|---|
| 保存镜头（`Shots.update`） | 无动作 | 同事务投影到 Stage 3 → 标记场次 `dirty`（不阻塞保存） |
| 场次 `dirty` | 无概念 | 异步任务：`planInvalidation` → `runSceneQuality`（合并 300ms 内多次改动） |
| 保存资产（`Assets.update`） | 无动作 | 广播"资产变更"→ 找出引用镜 → 标记对应场次 `dirty`（增量 `plan`） |
| 绑定变更 | 无动作 | 同镜头保存流程 |
| 手工"重新检查" | 无入口 | 界面按钮 → 同一条 `runSceneQuality` |

**关键约束**：投影必须**同步同事务**（否则出现"镜存了、Stage 3 没有"）；求解/QC 必须**异步**
（它是纯计算 + 写 `shot_states`/`qc_reports`，不能让用户保存时卡住）。

### 13.2 异常分类与行为（任务书 §七 的表，逐行给落点）

| 异常类型 | 应有行为 | 落点（现有/建议） |
|---|---|---|
| 输入格式错误 | 拒绝，不进求解 | 已有：`ASSERT_*`／`SCENE_INPUT_INVALID_*`／`SCENE_INPUT_EMPTY` |
| 资产引用缺失 | fail-closed，暂停该场次 | 已有：`ASSET_NOT_FOUND`（写入侧）、`__missing__`+V-03 fail（QC 侧） |
| 连续性求解失败 | 明确失败，可重试 | 已有：`CONTINUITY_SOLVER_FAILED` + `reason`；重试需**幂等**（内容 Hash 判定），建议最多 2 次 |
| QC fail | 暂停该镜/场次 | 已有：`gateOf()` 返回 `pause` + `blocking[]`；**缺"执行暂停"** |
| QC warn/info | 自动放行 | 已有：`gateOf` 判 `pass`（warn 不阻断），并有测试 |
| 状态持久化失败 | 事务回滚 | 已有：状态与报告同一 `tx()` |
| 编译失败 | 只停失败赛道 | 阶段4；现有无编译层，故"逐镜生成失败"隔离在镜级 |
| 赛道 A 失败 | 不影响 B | 阶段4（同上） |
| 赛道 B 失败 | 不影响 A | 阶段4（同上） |
| 资产被并发修改 | 重校验依赖 | **建议**：`shot_states.meta.__solver.hash` 与最新资产状态比对；不一致即重跑 |

### 13.3 八个必答项

| 问 | 答 |
|---|---|
| 哪些步骤自动执行 | ① 保存镜头→投影 ② 场次 dirty→失效计划 ③ 求解 ④ QC ⑤ 状态/报告落库 ⑥ 门禁判定（建议） |
| 哪些允许重试 | ③④（幂等，输入 Hash 未变则复用）；①②⑥ 不重试（要么成功要么失败） |
| 重试是否幂等 | 状态：内容 Hash 幂等（已有）；报告：只与最新一份比（已有）；**投影：需自建幂等**（同输入不新增行） |
| 哪些失败需要暂停 | QC fail、资产缺失、求解失败（超过重试）、投影失败（它已回滚保存） |
| 从哪恢复 | 暂停只作用于"场次/镜头"，不锁项目；用户改数据或点"重试"即可 |
| 恢复时是否要重算 | 是：`planInvalidation` 按改动字段给出增量 `plan`，只重跑受影响规则（carried 承接其余） |
| 如何防重复生成任务 | 现有：`dedupeKey`（`tools.js:2513` 的 `shot:<id>:cand:<idx>`）；建议再加"版本 hash 进 dedupeKey" |
| 如何保证共同创作版本不被赛道污染 | 编译只读；`prompt_packages`/`render_*` 与创作表物理分离；冻结后创作表禁写（用 `adaptation_locks`，阶段4） |

---

## 十四、P10 子阶段拆分（按真实依赖排序）

> 排序原则：**先做零依赖、零 DDL、可单测的事**；再动写入口；自动化最后。
> 任务书列的是 A→B→C→D→E，但按依赖，**B 的实体读取部分应提前到 A 之前**（它不改任何写路径）。

### P10-B1：资产实体读取接线（0.5 天级）

| 项 | 内容 |
|---|---|
| 前置 | 无（`assets` 已存在） |
| 修改 | `lib/core/continuity/run-scene.js`（`loadShotAssetEntities` 换实现 + 调用点传参） |
| 接口 | 函数签名变化（内部，不对外） |
| DB | 0 |
| 测试 | 新增：有引用→真值；无引用→`[]`；缺失→`__missing__`；跨项目不可见；Hash 随 `category` 变 |
| 回滚 | 改回 `return []` |
| 验收 | 引用镜的 V-03／A-07／S-02 由"哨兵"变"真值"，且无引用镜的 Hash 一位不变 |
| 依赖 | 与 P10-A 无关，可先做 |

### P10-A：Stage 3 镜头接管（核心）

| 项 | 内容 |
|---|---|
| 前置 | 场次键规则（D-25-2）已定 |
| 修改 | `lib/core/db.js`（`Shots.create/update` 尾部挂钩）、新增 `lib/core/project-shot.js`（投影函数）、`lib/core/render/global-no.js`（复用） |
| 接口 | `projectShotToStage3({ projectId, shotId, tx })`；开关 `IC_STAGE3_PROJECT=1` |
| DB | 0（`story_shots` 已存在）；可能需 `shots → story_shots` 映射表（D-25-2 决定） |
| 测试 | 投影幂等、`global_no` 唯一、`scene_key` 缺失即拒、数量对账、回滚 |
| 回滚 | 关开关（停投影） |
| 验收 | 建项目→写剧本→Agent 出分镜后，`story_shots` 行数与 `shots` 一致，且 `shots.idx ↔ shot_no` 可核 |
| 依赖 | 无它则 B2/C/D 全部空转 |

### P10-B2：资产引用接管

| 项 | 内容 |
|---|---|
| 前置 | P10-A（需要 `story_shots.id`） |
| 修改 | 投影函数内调 `writeShotAssets()`；`refs.js` 改读（或双读对账） |
| 接口 | 复用现有；新增"music/sfx 分流"规则（D-25-3） |
| DB | 0 |
| 测试 | 绑定幂等、`role` 校验、变体父、`audio_ids` 分流、跨项目隔离、删除保护 |
| 回滚 | 停投影，`shot_assets` 保留（只读） |
| 验收 | 界面绑定资产后 `shot_assets` 有行；`refs.js` 与它结果一致（对账零差异） |
| 依赖 | A |

### P10-C：站位/动作/场次接管

| 项 | 内容 |
|---|---|
| 前置 | A（镜头行）、B2（资产行） |
| 修改 | 新增 `lib/core/parse-blocking.js`（文本→行）、`lib/core/parse-subshots.js`（JSON→动作），投影函数调用 |
| 接口 | 两个纯函数 + 投影扩展 |
| DB | 0 |
| 测试 | 13 条实测 blocking 文本逐条解析、解析失败即拒、动作时间片与 `story_duration` 一致 |
| 回滚 | 停投影 |
| 验收 | P5 的 69 条规则在真实项目上"适用率"从个位数升到主要规则可判（不再大面积 not_applicable） |
| 依赖 | A、B2；工作量最大 |

### P10-D：自动化闭环

| 项 | 内容 |
|---|---|
| 前置 | A、B2、C（有数据才有意义） |
| 修改 | `Shots.update`/`Assets.update` 尾部发事件；新增 `lib/core/continuity/scheduler.js`（合并抖动 + 串行）；`gateOf` 结果落"暂停表/字段" |
| 接口 | `markSceneDirty(projectId, sceneKey, plan?)`；`runSceneQuality` 增 `trigger:'auto'` |
| DB | **可能需要**：`continuity_runs`／`continuity_tracking`（D02-06 PF-1 要求，当前**不存在**，见 §15） |
| 测试 | 改镜自动重算、carried 承接、失败暂停与恢复、幂等、并发 |
| 回滚 | 关自动触发开关，退回手工 |
| 验收 | 改一条台词后 3s 内该场次报告更新，且只重跑 QIS 内规则 |
| 依赖 | A/B2/C |

### P10-E：双赛道共同数据与独立编译

| 项 | 内容 |
|---|---|
| 前置 | **阶段4 编译器**；P10-D（版本冻结） |
| 修改 | 新增编译服务（`prompt_packages` 写入）、`render_units` 切分、赛道参数 |
| DB | 0（六张表已在）；可能需要 track 枚举约束 |
| 测试 | 同版本双编译、hash 一致、赛道失败隔离 |
| 回滚 | 停用赛道 |
| 验收 | 同一 `adaptation` 下两条 track 各有 `prompt_packages`，`source_spec_hash` 相同 |
| 依赖 | 阶段4（本轮不设计其内部） |

**工作量排序**：B1（极小）＜ A（中）＜ B2（中）＜ D（中大）＜ C（大）＜ E（阶段4）。

---

## 十五、数据库变更建议及必要性分析

**结论：P10-A~D 不需要新增业务表。** 现有 33 张表足以承载；真正缺的是两处**已被正式规范要求、但从未建**的表：

| 建议 | 依据 | 是否必需 | 说明 |
|---|---|---|---|
| `continuity_runs`（八列） | D02-06 §8.2.4／PF-1 | **P10-D 必需** | 当前 `grep` 命中 0：`tables.js`/`db.js`/`manifest` 全无此表。没有它就无法表达"这次求解属于哪一批、是否并发冲突" |
| `continuity_tracking`（三态） | D02-06 §8.2.5／A-05-4 | **P10-D 必需** | 同上，0 命中。`available/degraded/unknown` 三态与 fail-closed 无落点 |
| `shots ↔ story_shots` 映射 | 本报告 §3.3 | **P10-A 视 D-25-2 而定** | 若 `scene_key` 与 `global_no` 能由规则确定性生成，则**不需要**表；否则需一张两列映射表 |
| `assets` 唯一约束 | D02-24 D-24-4 | 非必需 | 存量可能重名，先盘点再定 |
| `shot_assets` 并发版本列 | §12.2 | 非必需 | 可用 `story_shots.updated_at` 做乐观锁，无需新列 |

**明确不做**：不新建资产实体表（D02-24 已否决）、不删 legacy 表、不改 `story_shots` 48 列、不改 `shot_states`/`qc_reports` 结构。

---

## 十六、风险与未决事项

### 16.1 距离完整自动化还缺的 8 个环节

| # | 缺口 | 影响 |
|---|---|---|
| 1 | `story_shots` 生产写入 | QC/求解无输入，P9 链路在真实项目上必然 `SCENE_INPUT_EMPTY` |
| 2 | `shot_assets` 生产写入 | 资产类规则永远"不适用" |
| 3 | `shot_blockings`/`shot_actions` 生产写入 | 69 条规则中大量依赖结构化站位/动作，适用率极低 |
| 4 | 场次键映射（`scene_key ↔ 章节/场次`） | 无法把"用户看到的场次"与"QC 的场次"对上 |
| 5 | 改镜触发（事件/hook） | 求解与 QC 只能手工 HTTP 调 |
| 6 | `planInvalidation` 接线 | 局部重跑与 carried 的价值无法兑现（每次都全量） |
| 7 | 门禁消费方 | `gateOf` 只出结论，不阻断任何任务 |
| 8 | 双赛道编译层 | 阶段4；现在连"共同版本"都不存在 |

### 16.2 风险清单

| 风险 | 等级 | 缓解 |
|---|---|---|
| 投影导致"保存变慢/失败" | 中 | 投影只做必要的行写；失败即回滚并给出可读原因；灰度开关 |
| `blocking` 文本解析不准 | **高** | P5 已有 13 条实测样本可做回归；解析失败必须拒写（不默认空站位） |
| `sub_shots → shot_actions` 粒度错配 | **高** | 先只支持"一镜一动作单元"的最小子集，其余标记 `fill_confidence=low` 并进 QC info |
| `audio_ids` 的 music/sfx 无处安放 | 中 | 分流到独立表/列（D-25-3），不硬塞 `shot_assets` |
| 双写期数据不一致 | 中 | 单向投影 + 数量对账 + 不一致即报警 |
| PF-1 两表缺失导致并发无保护 | **高**（P10-D） | 补表前不做自动并发写；或先用文件锁/单进程串行 |
| 真实库改动风险 | 中 | 全部 DDL 先在隔离库验证 + 提供回滚脚本；本轮 0 改动 |

### 16.3 未验证事项（如实列）

| # | 未验证 | 原因 |
|---|---|---|
| 1 | 真实库中 `shots.blocking` 的结构化程度 | 文档只提到 13 条实测样本，全量覆盖率需查真实库 |
| 2 | 真实库里 `story_shots` 是否曾有过行 | 按任务书禁止操作真实库 |
| 3 | `structured_spec` 在生产项目中的实际开启比例 | 需查真实库 |
| 4 | `blocking` 文本解析的覆盖率 | 需拿真实库样本跑（当前只有 D01-04 提到的 13 条） |
| 5 | 阶段4 编译器的接口形态 | 阶段4 未启动 |

---

## 十七、需要用户批准的架构决策

| # | 决策 | 选项 | 我的建议 | 影响面 |
|---|---|---|---|---|
| **D-25-1** | 镜头权威 | ①`story_shots` 接管（方案 A）②长期双轨 ③Stage 3 只做视图 | **①** | A/B2/C/D 全部依赖它 |
| **D-25-2** | 场次键映射 | ①`scene_key` 由规则生成（`S<章>-<序>_<名>`）②建映射表 ③沿用 `shots.scene_name` 原文当键 | **①**（规则确定、无需表）；若历史数据脏则补② | P10-A |
| **D-25-3** | `audio_ids` 中 music/sfx 的归属 | ①分流到 `shot_audio`（新表）②留在 `shots.audio_ids` 不管 ③塞进 `shot_assets`（违反 AS-4） | **①**，但**推迟到 P10-C**；③明确禁止 | B2/C |
| **D-25-4** | 并发写保护 | ①乐观锁（`updated_at` 比对）②补 PF-1 两表后做③单进程串行 | **②（P10-D 时）**；之前用③ | D |
| **D-25-5** | 删除保护语义 | ①有引用即阻断 ②级联解绑 ③警告后允许 | **①**（解绑与删除分离） | B2 |
| **D-25-6** | 自动化触发边界 | ①保存后同步投影+异步求解 ②全异步 ③仅手工 | **①** | D |
| **D-25-7** | 双赛道命名与编译归属 | ①`track ∈ {h3, seedance}`，阶段4 实现 ②先只做 h3 | **①**（与 D01-05 注释一致） | E |
| **D-25-8** | 是否补建 PF-1 两表 | ①P10-D 前补 ②不补，用文件锁替代 | **①**（否则并发无保护，且 D02-06 已冻结要求） | D |

---

## 十八、最终推荐方案

### 18.1 推荐

**方案 A（Stage 3 逐步接管）+ 单向投影 + 唯一渲染收口不变。**

四句话：

1. **镜头权威归 `story_shots`**，但接管方式是"legacy 写 → 同事务单向投影"，不是"两套都写"。
2. **资产权威本来就唯一**（`assets`），只需把实体读取接上（P10-B1，零 DDL），再把引用投影进 `shot_assets`（P10-B2）。
3. **自动化只做三件事**：投影（同步）、失效计划 + 求解 + QC（异步、幂等）、门禁消费（暂停而非只出结论）。
4. **双赛道留到阶段4**：先把"共同创作版本"（`source_spec_hash`/`shot_scope_hash` 的写入）做实，再谈两 track 编译。

### 18.2 分期与门禁

```text
P10-B1（实体读取，0 DDL）──→ 可独立验收
      │
      ▼
P10-A（镜头投影）──→ P10-B2（引用投影）──→ P10-C（站位/动作）──→ P10-D（自动化）──→ P10-E（阶段4）
                                                                        │
                                                              D-25-8 补 PF-1 两表
```

每一期都必须满足：**新增测试 + 全量回归不掉 + 真实库零写入（用隔离库验证）**。

### 18.3 "Stage 3 正式接管生产"的 8 条验收门槛

| # | 门槛 | 可检验方式 |
|---|---|---|
| 1 | 用户从界面建项目 → 写剧本 → 出分镜后，`story_shots` 有行 | 真实项目跑一遍，查表计数 |
| 2 | 同一操作**不再**在 `shots` 新增行（或 `shots` 仅为只读投影） | 对账：`story_shots` 数 == 界面镜数；`shots` 停止增长 |
| 3 | `shots.idx ↔ shot_no`、`global_no` 唯一且稳定（重排后不乱） | 重排测试 + 两阶段重编号已有用例 |
| 4 | 界面绑定资产后 `shot_assets` 有行，且 `refs.js` 与它零差异 | 对账脚本 |
| 5 | `shot_blockings`/`shot_actions` 覆盖主要镜头（≥90%），解析失败率可观测 | 统计 `fill_confidence` |
| 6 | 改一条台词 → 自动重算该场次，报告新增且 carried 承接到位 | 端到端测试 |
| 7 | QC fail 会真正暂停（任务不提交生成），warn 自动放行 | 门禁消费方测试 |
| 8 | 双赛道（若已实现）对同一版本产出 `source_spec_hash` 相同的包 | 阶段4 验收 |

**在 1~7 未全部满足前，任何"Stage 3 已接管生产"的表述都不成立。**

---

## 附录 A：测试矩阵（任务书 §十，20 项）

| # | 场景 | 输入 | 预期行为 | 验证层次 |
|---:|---|---|---|---|
| 1 | 新项目 → Stage 3 镜头生成 | 建项目+剧本+Agent 出分镜 | `story_shots` 行数=镜数，`global_no` 连续 | 集成（真实 sqlite） |
| 2 | legacy 剧本导入转换 | xlsx/文本导入 | 资产自动补建 + 镜头投影成功 | 集成 |
| 3 | 镜号唯一稳定 | 插入/删除/重排 | `global_no` 唯一、重排后仍唯一 | 单元+集成 |
| 4 | 一资产多镜引用 | 3 镜引同一角色 | 3 行 `shot_assets`，QC 各自读到真值 | 集成 |
| 5 | 跨项目访问隔离 | 引用他项目 asset_id | `ASSET_NOT_IN_PROJECT` | 单元 |
| 6 | 资产缺失 fail-closed | 删资产后求解 | `__missing__` → V-03 fail → 门禁 pause | 集成 |
| 7 | 资产修改触发正确失效 | 改 `category` | 只有读该字段的规则重跑（carried 其余） | 集成 |
| 8 | 资产删除引用保护 | 删被引用资产 | 阻断 + 返回 shotIds/roles | 集成 |
| 9 | 改镜触发求解 | PATCH 台词 | 3s 内该场次报告更新 | 端到端 |
| 10 | 站位/动作真实写入 | 真实 blocking 文本 | 解析成功率与失败原因可观测 | 集成+样本回归 |
| 11 | QC fail 自动暂停 | 制造 fail | 任务不提交，暂停记录含定位 | 端到端 |
| 12 | warn/info 放行 | 制造 warn | 继续生成 | 端到端 |
| 13 | 状态与报告事务一致 | 注入写失败 | 两者同时回滚 | 集成 |
| 14 | 重复请求幂等 | 同输入连跑 3 次 | 状态不重写、报告复用最新 | 集成 |
| 15 | 共同版本冻结 | 冻结后改创作数据 | 拒绝或生成新版本 | 阶段4 |
| 16 | A/B 同版本 | 同 adaptation 双 track | `source_spec_hash` 相同 | 阶段4 |
| 17 | A/B 失败隔离 | A 抛出 | B 不受影响，创作数据不变 | 阶段4 |
| 18 | 过渡期一致性 | 投影后比对 | 数量/字段零差异，差异即报警 | 集成 |
| 19 | 迁移与回滚 | 开/关投影开关 | 关后行为回到现状，数据保留 | 集成 |
| 20 | 全链路自动恢复 | 求解失败后修复 | 重跑成功后门禁 pass，无重复报告 | 端到端 |

---

## 附录 B：证据索引（关键 file:line）

| 结论 | 证据 |
|---|---|
| `assets` 建表 26 列 | `lib/core/db.js:130~157` |
| `shots` 35 列（含 `character_ids` 等） | `lib/core/db.js:158~`、`:174~176`；`schema-manifest.json` 的 `existing.shots` |
| 项目创建唯一入口 | `app/api/projects/route.js:51` → `lib/core/project-create.js:19` |
| `story_shots` DDL 48 列 | `lib/core/schema/tables.js:87~140` |
| `global_no`/`shot_no` 唯一约束 | `tables.js:385` `uq_ss_gn(project_id, global_no)`、`:386` `uq_ss_sn(chapter_id, shot_no)` |
| `insertStoryShot` / `appendStoryShots` | `lib/core/render/global-no.js:198` / `:379` / INSERT `:220` |
| `writeShotAssets` | `lib/core/render/shot-assets.js:224` |
| `shot_assets` DDL | `lib/core/schema/tables.js:198~208` |
| `loadSceneInput` 读四表 | `lib/core/continuity/load-scene.js:164`（`story_shots`）、`:177`（`shot_assets`） |
| `runSceneQuality` 唯一入口 | `lib/core/continuity/run-scene.js:126`；路由 `app/api/projects/[id]/continuity/run/route.js:44` |
| `loadShotAssetEntities` 恒 `[]` | `lib/core/continuity/run-scene.js:105~110`（调用点 `:186`） |
| `gateOf` 无消费方 | `lib/core/continuity/run-scene.js:226` + 全仓 grep 无其它调用 |
| `planInvalidation` 零调用 | 全仓仅注释引用 |
| `set_scene_state` 生产写场景 | `lib/agent/tools.js:635`；`scene-state.js:104/126/139` |
| `scene_id` 必须是本项目 scene 资产 | `lib/core/scene-state.js:56~66` |
| `set_storyboard` 写 legacy | `lib/agent/tools.js:2040` → `:2256/2260` |
| 分镜表导入写镜 | `lib/core/storyboard-import.js:1052` `Shots.create`（资产补建在 `:664`） |
| 单镜删除 | `app/api/projects/[id]/shots/[sid]/route.js:38` → `Shots.remove`（`db.js:1004`，清 `shot_videos`+`shots`） |
| 单镜生成写 `shot_videos` | `lib/agent/tools.js:2519`；`db.js:1023` |
| 渲染唯一收口 | `lib/core/workflow-runner.js:261`；`backend.js:14/23/32`；`engine-runner.js:39` |
| 编译层六表零写入 | `tables.js:210/231/247/258/276/293` + 全仓无对应 `INSERT` |
| `track` 语义（seedance/h3/legacy） | D01-05 §4.7 注释（`render_units.track`） |
| 双编译器属阶段4 | D02-06 第 448 行 |
| PF-1 两表不存在 | `tables.js`/`db.js`/`schema-manifest.json` 对 `continuity_runs`、`continuity_tracking` 命中均为 0 |
| `usageOf` 只扫 legacy | `lib/core/db.js:822~836` |
| 删资产不清理 `shot_assets` | 全仓 `DELETE FROM shot_assets` 仅 `shot-assets.js:235` |
| 项目删除顺序 | `lib/core/db.js:697~712` |

---

## 附录 C：本轮自检（对照任务书 §十二）

- [x] 完整追踪项目、剧本、场次、分镜生产链（§3）
- [x] 确认 `story_shots` 写入入口与调用方（无生产调用方，§3.5）
- [x] 确认 `shot_assets` 写入入口与调用方（无生产调用方，§5.2）
- [x] 确认 `assets` 实体源与 ID 语义（§5.1，沿用 D02-24 结论 A）
- [x] 确认 legacy 资产绑定与 Stage 3 引用关系（§5.3，含 `audio_ids` 硬冲突）
- [x] 追踪站位/动作/导演/场次基线（§6）
- [x] 追踪 P8/P9 生产执行入口（§7，含 7 个"是否自动"的直接回答）
- [x] 追踪两条赛道当前编译链（§8，六表零写入）
- [x] 明确共同创作数据与独立编译边界（§4、§9）
- [x] 给出唯一权威来源方案（§10）
- [x] 给出 legacy 迁移与兼容方案（§11，三方案比较 + 推荐 A）
- [x] 给出资产 QC 正式接线设计（§12）
- [x] 给出生产自动化与故障恢复方案（§13）
- [x] 给出有依赖关系的 P10 子阶段计划（§14，含依赖重排说明）
- [x] 给出完整测试矩阵（附录 A，20 项）
- [x] 新增 D02-25 文档（本文件）
- [x] **没有任何业务代码、DDL 或 Schema Manifest 变更**（`git status` 仅新增本文件）

**本轮不构成实施授权。** §17 的 D-25-1~8 需你逐条确认后，才按 §14 的顺序进入 P10-B1。
