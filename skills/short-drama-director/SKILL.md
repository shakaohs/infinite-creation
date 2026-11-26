---
name: short-drama-director
description: "漫剧老李全流程 · Seedance 线（无限创作框架内执行版 v7.5.0-FW）。项目视频模型锁定 seedance25 / seedance20 时，剧本→资产→分镜→投喂提示词→质检 一律走本技能：分镜权威=sd-storyboard-engine（文戏）+ sd-combat-engine/sd-real-engine/sd-xuanhuan-engine（打戏三档），投喂权威=references/model-adapters.md 七段式。上游 V7.5.0-SLIM 的全部规则原文保存在本目录 references/ 与 scripts/，原始总控见 SKILL.upstream-v7.5.0.md。触发词：漫剧老李、老李全流程、short-drama-director、短剧导演套装、Seedance 分镜、七段式投喂、打戏分档、段缝衔接、台词语速自检、画面风格锁、镜长倒推。"
agent_created: true
version: "7.5.0-FW"
---

# 漫剧老李 · Seedance 线全流程（无限创作框架内执行版）

## 〇、这份文件是什么

这是 **漫剧老李 V7.5.0-SLIM 套装**在「无限创作」流水线内的**执行入口**，不是另起一套规则。

- **规则本身一字未改**：五道锁、机检 C 系、七段式、打戏三档、站位调度、段缝衔接、台词七维……全部原文都在本目录 `references/` 与 `scripts/`，以及四个子引擎 `sd-storyboard-engine` / `sd-combat-engine` / `sd-real-engine` / `sd-xuanhuan-engine` 里。**判据有疑问一律回原文，不用本文件的摘要替代原文。**
- **本文件只做三件事**：① 说明上游哪几段在框架内生效；② 把上游的「人机交互锁」映射成框架的「项目锁卡 + 工具调用」；③ 给出每个阶段落笔前必读的原文清单。
- 上游原始总控全文：`SKILL.upstream-v7.5.0.md`（137KB，含完整的预算铁律/契约表/看板编译/诊断协议；框架内不需要它也能跑，需要查证时再读）。

## 一、生效范围：框架内跑哪几段

框架的四个阶段（`llm` 文本 → `image` 资产 → `tts` 音色 → `video` 出片）是**唯一编排者**，本技能只负责「怎么写」。映射如下：

| 上游阶段 | 框架内怎么落 | 落地工具 | 权威原文 |
|---|---|---|---|
| P0 立项锁（〇·1 / A / B / C / D / I） | 由**项目锁卡**给出，禁止询问 | 系统提示词「项目锁卡」 | `references/model-adapters.md` 〇节 |
| P1 剧本 | 写本章剧本 | `set_chapter_script` | `sd-script-engine/SKILL.md` + `references/dialogue-doctor-7d.md` |
| P2 资产 | 登记资产 + 写出图提示词（图由框架生成，不需要用户回传） | `create_asset` / `update_asset` / `change_outfit` / `design_ages` | `sd-asset-engine/SKILL.md` + `references/asset-spatial-ledger.md` |
| P3 分镜 | 写镜行（中文栏位） | `set_storyboard_plan` → `set_storyboard` | `sd-storyboard-engine/SKILL.md` + `references/camera-specs-15rules.md` / `blocking-direction.md` / `segment-splicing.md` / `dialogue-speed-check.md` / `spatial-reference-system-V3.md` / `camera-transitions-6types.md` |
| P4 投喂 | 写视频提示词（七段式） | `write_video_prompts_batch` / `write_shot_video_prompt` | `references/model-adapters.md` + `seedance-render-engine.md` + `aspect-ratio-adaptation.md` + `prompt-feeding-checklist.md` |
| P5 质检 | 框架内置机检（等价 C 系） | 后端自动 | `sd-qc-engine` 规则已内化；不放行 = 改稿重写 |

**不做**：离线看板（`build_board_lite.py`）、交付契约表（`audit_contract.py`）、预演故事板独立文件、P4.5 交付物清点——这些是「一次对话交付成品文档」的形态，框架的交付物是数据库里的分镜与提示词。

## 二、覆盖声明（优先级高于任何原文条款）

上游有大量「未指定 = 停下询问用户 / 必须弹卡勾选 / 必须建契约表 / 必须跑脚本」的硬规则。框架是**无人值守流水线**，以下条款一律作废，按右侧口径执行：

| 上游条款 | 框架内口径 |
|---|---|
| 〇·1 / A / B / C / D / I 锁「未指定=停下询问」「必弹卡」 | **锁位已在创建项目时落定**（模型版本、画幅、画风、段缝），直接读取项目锁卡执行，禁止提问、禁止自行改锁 |
| 「C 交付形态三选一」 | 固定「分镜 + 提示词入库」，不问 |
| 「开工必跑 `audit_contract.py --init` 建契约表」「交付前核销契约」 | **不跑任何脚本**（框架 Agent 没有 shell）。契约由后端机检等价承担 |
| 「机检跑 `validate_prompt.py`」 | 后端 `checkVideoPrompt` 已内化七段式语法与时长/语速判据；FAIL 直接回灌给重写 |
| E 锁「默认只出提示词、不直接出图」 | 框架的资产阶段**就是要出图**（ComfyUI/Z-Image）。此条不适用：出图由用户在界面启动，Agent 只写提示词 |
| E.1 素材形态 M0/M1/M2「图不在本包手里」「不索要图」 | 框架内资产图**就在项目里**（`list_assets` / `view_asset` 可看）→ 一律按 **M2 已入库** 执行，直接用真实资产图锁形象，**不再写「图N 占位 + 素材接线单」** |
| 「单段 2.5 吃满 25~30s」 | **按模型分档**：2.5 单段 4–30s，主体段 25–30s 吃满上限（`duration` 字段上限 30）；2.0 与 h3 为 4–15s。段缝按 D 锁处理 |
| 「台词/音效走官方字符（2.5 `{}`/`<>`）」 | 保留：写在七段式【时间轴分镜】与【音效】栏；但台词必须与框架 `dialogue` 字段同源，且 ≤3.5 字/秒（`set_storyboard` 硬门禁） |
| 「交付件数上限 3 件 / 命名全中文」 | 不适用（无文件交付） |
| C31 交付契约（同稿必附角色四格 / 场景母版 / 九宫格 / 素材接线单） | 资产提示词存在项目 `assets` 表、参考图编号由工具注入，投喂稿按设计只放七段式正文。后端机检把「仅 C31/CT-* 的 FAIL」降级为通过并注明豁免；其余任何 FAIL 照拦 |

## 三、锁位取值（逐条，禁止改判）

| 锁 | 取值来源 | 框架内怎么写 |
|---|---|---|
| **〇·1 素材来源** | 项目有小说正文→②改编；只有 idea→①原创 | 不问，按现状判 |
| **A 模型版本** | `project.video_model`：`seedance25` / `seedance20` | **2.5 与 2.0 语法彻底分开，禁混写**；2.0 **全面禁首尾帧**；2.5 参考模式默认①全能参考 |
| **B 画幅** | `project.video_aspect_ratio` | 每条提示词【画幅风格】行与载荷 `aspect_ratio` 都回填此值；**资产板固定 16:9 画布**（`asset-spatial-ledger.md`） |
| **C 交付形态** | 固定入库 | 不问 |
| **D 段缝衔接** | `project.seam`（auto / tail_frame / hard_cut / empty_shot） | auto = 按剧情判：跨组长动作→尾帧锚定；剧情段划分+组内多机位→换机位硬切 |
| **I 画风锁** | `project.style` | 常规稿**不写段8/段9**，只把 ≤30 字美学短语并入【画幅风格】；仅当用户明确点名导演卡才落段8/段9 |

## 四、P1 剧本（写作）

1. `skill("sd-script-engine")` 加载剧本引擎，按其六阶段编剧链（来源登记→IP与角色→开发圣经→分集规划→正式剧本→圆桌审核）执行；**框架内只做「正式剧本」这一层的产出**，前五层压成剧本里的场次结构，不单独落文件。
2. 剧本格式按框架约定落地：`【第N场｜时间｜地点】` + 出场人物 + 场景/动作 + `人物名：台词` + 必要旁白；用 `set_chapter_script` 写入。
3. 台词质量按 `references/dialogue-doctor-7d.md`（七维诊断）与 `references/dialogue-speed-check.md` 自检：口语化、有称呼、有潜台词、不带书面腔；**每句台词字数 ≤ 时长×3.5**（框架硬门禁，超了写不进去）。
4. 每场必须有冲突目标；台词密度 80~90%，禁纯展示无对白废场。

## 五、P2 资产

1. `skill("sd-asset-engine")` 加载资产引擎，产出三清单（角色外观 / 道具 / 场景）。
2. 框架内**不写「图N 槽位 + 素材接线单」**：每个实体直接用 `create_asset`（人物/场景/道具）登记，提示词写进 `prompt`，框架负责出图并回填 `image_path`。
3. 一致性锚点写进 `bible`（人物圣经）：每个角色唯一外貌/发型/体型/配色/声音；场景写清空间结构（门窗在哪、家具清单、方位词），供分镜的站位与空间锚点直接引用。
4. 换装/年龄变体只在剧情确有事件时生成（`change_outfit` / `change_age`），不为每场都生成。

## 六、P3 分镜（核心阶段）

### 6.1 执行序列（顺序不可调换）

1. `skill("sd-storyboard-engine")`（文戏）／`skill("sd-combat-engine")`（打戏，按 6.4 分档再深入 `sd-real-engine` / `sd-xuanhuan-engine`）。
2. 用 `skill_reference` 读完**必读六件**（缺一个 `set_storyboard` 直接拒绝写入）：
   `camera-specs-15rules.md`（镜头五要素 + 景别阶梯）→ `blocking-direction.md`（站位/权力几何/依托物）→ `spatial-reference-system-V3.md`（空间坐标系）→ `segment-splicing.md`（段缝衔接）→ `dialogue-speed-check.md`（语速自检）→ `camera-transitions-6types.md`（转场六型）。打戏再加 `sd-combat-engine/references/tier-and-finisher-system.md` 与 `combat-iron-laws.md`。
3. `set_storyboard_plan` 落锁档：mode / aspect / base / assetMode（**固定 M2**）/ seam / anchors（positions 站位表必填）+ beats（情绪节拍与拆段表）。
4. 按节拍写逐镜 `camera` / `visual` / `sub_shots` / `dialogue` / `duration` / `characters` / `scenes` / `props`，`set_storyboard` 写入。
5. 结构机检 FAIL 就按报错改，**不要硬提交**——分镜结构一旦入库，投喂阶段救不回来。

### 6.2 镜行的写法（中文栏位）

- `camera`：景别 + 焦段 + 机位角度 + 运镜，按 `camera-specs-15rules.md` 五要素写全（如「中近景｜85mm｜略高于眼位·平视｜固定机位」）。
- `visual`：只写**人和物的可见状态与动作**，按「起 → 过程 → 结果」写清；禁心理结论词（紧张/愤怒），一律落成可见动作。**老李九字段里的「状态 / 光影 / 色调 / 重音 / 人声 / 音效」在框架内没有独立列，全部按固定顺序写在 `visual` 里**：`画面：…` → `状态：进镜→出镜` → `光影：…` → `色调：名，高光#，阴影#，色温NK` → `重音：字` → `人声：…` → `音效：…`（无内容写 `—`，不许整行删）。这六项是投喂阶段【画幅风格】【音效】栏的唯一来源，省了就只能让模型自选光色。
- `sub_shots`：段内切点与时间轴（`0.0-2.5s …`），切镜只改机位不改站位。行数按「每镜 2.5–7.5 秒」核（结构机检区间 = ceil(时长÷7.5) ~ floor(时长÷2.5)+1）：30s 段写 4–13 行都合规，合并原表 5–6 个 4–6s 镜头就写 5–6 行，不要为凑数硬切碎；投喂层 C2 另有「镜头数 ≤ 段长÷3」上限（30s→10 镜），超出部分投喂时合并相邻镜头。
- `dialogue`：`人物名：台词`，每行一个说话人，单镜 ≤2 人开口（框架硬门禁）。
- 中文是允许的：**Seedance 线镜行写中文**，与 H3 线的「英文镜行」不通用，禁止混写。

### 6.3 硬约束（框架内同样生效）

- **镜长由剧情倒推，禁等分**（法则 17）：台词字数÷3.3 + 动作缓冲 1~3s；一句 8~15 字台词只给 3~5s。
- 单段时长按模型分档：2.5 为 4–30s（主体段 25–30s），2.0 / h3 为 4–15s；同场景连续动作 + 多句连贯对白合并成长段，禁一句一镜。
- **站位与依托物段内不跳变**：同段无走位时，角色依托物/左右关系必须全程一致（否则投喂阶段必然分身）。
- 段缝两侧强制换机位或换景别；同段缝方式全片一致（按 D 锁）。
- 每镜必须归属某段节拍（`shotRange`），一段内不许塞两个反转。

### 6.4 打戏三档分流（先定档再取库）

| 档 | 戏种 | 去哪取规则 |
|---|---|---|
| R1 真人写实克制 | 现代格斗/警匪/MMA/一打多 | `sd-real-engine` |
| R2 通用武侠 | 冷兵器/江湖/招式对拆 | `sd-combat-engine` |
| R3 玄幻仙侠 | 斗法/法相/万剑归宗/神魔大战 | `sd-xuanhuan-engine` |

## 七、P4 投喂（七段式 · 本线最终交付物）

1. 整章**一次** `write_video_prompts_batch(chapter)`：同场景连续镜一批（≤3 镜）连续产出，批间传滚动状态卡锁站位/手部/机位。
2. 语法权威唯一：`references/model-adapters.md`（**按 A 锁版本取对应章节，2.5 / 2.0 不混**）；画幅回填看 `references/aspect-ratio-adaptation.md`；镜头五要素看 `references/camera-specs-15rules.md`；有对白必过 `references/dialogue-speed-check.md`；有 OS/VO 必过 `references/vo-os-weaving.md`；出稿前过 `references/prompt-feeding-checklist.md`。
3. 七段式栏位固定顺序、缺一不可：
   `【画幅风格】→【场景资产】→【核心人物】→【站位声明】→【时间轴分镜】→【音效】→【强制禁止项】`
4. 参考素材用 `@图片N / @音频N / @视频N（参考图N）` 逐条标注用途（由工具注入的真实编号，不得新造）。
5. 【站位声明】是跨段承接的唯一载体：写清每个人在本段的左右方位、朝向、依托物、手部道具——**不写「承接上段」这类空话**。
6. 段8/段9 只在用户明确点名导演卡时写；否则美学短语 ≤30 字并入【画幅风格】。
7. 禁写：工作流规则词（末态继承/拼接节点/换机位）、内部术语（M1/C27/P0A）、术语裸写（J-cut/甩镜）——投喂稿只写「画面怎么接」。

## 八、机检（框架内置等价项）

| 上游 C 码 | 框架内由谁拦 |
|---|---|
| C1b 单段时长、C13 镜长雷同 | `set_storyboard` 结构机检（时长按模型分档：2.5 为 4–30s、2.0/h3 为 4–15s；连续同机位同景别拒绝） |
| 台词语速 | `dialogue / duration ≤ 3.5 字/秒`（硬拒绝） |
| 单镜说话人数 | ≤2（硬拒绝） |
| 七段式栏位完整 / 版本语法 | `checkVideoPrompt`（写提示词时校验，FAIL 回灌重写） |
| 站位/依托物一致性 | 分镜阶段门禁 + 投喂阶段状态卡（不靠事后机检） |

## 九、子引擎路由

| 子引擎 | 什么时候进 |
|---|---|
| `sd-script-engine` | 写剧本、改编、台词诊断 |
| `sd-asset-engine` | 提资产、写资产提示词、场景空间账本 |
| `sd-storyboard-engine` | 文戏分镜主力 |
| `sd-combat-engine` | 通用武侠/打斗 |
| `sd-real-engine` | 真人写实克制打斗 |
| `sd-xuanhuan-engine` | 玄幻仙侠斗法 |
| `sd-feed-engine` | 投喂封装细则（素材映射/工程语清洗/段间连续性） |

## 十、参考文件索引（全部原文都在本目录 `references/`）

**锁与适配**：`model-adapters.md`（七段式语法·唯一权威）、`aspect-ratio-adaptation.md`、`platform-safety-compliance-guide.md`、`agent-platform-adapters.md`

**分镜与调度**：`camera-specs-15rules.md`、`blocking-direction.md`、`spatial-reference-system-V3.md`、`spatial-topview-camera.md`、`camera-transitions-6types.md`、`creative-transition-library.md`、`segment-splicing.md`、`crowd-behavior-direction.md`、`storyboard-board-lite.md`

**表演与情绪**：`acting-direction.md`、`facs-au-dictionary.md`、`facs-emotion-recipes.md`、`facs-micro-expression.md`、`wenxi-micro-expression.md`、`emotion-beat-curve.md`

**台词与声音**：`dialogue-doctor-7d.md`、`dialogue-speed-check.md`、`vo-os-weaving.md`、`dialect-voice-control-dictionary.md`

**画面质感**：`lighting-and-antifake.md`、`audiovisual-aesthetic-presets.md`、`cinematic-dramaturgy-rules.md`、`style-bible/`（导演卡与风格钳制协议）

**资产与连续性**：`asset-first-pipeline.md`、`asset-delivery-modes.md`、`asset-spatial-ledger.md`、`character-lineage-and-sheets.md`、`production-ledger-handbook.md`

**投喂与质检**：`prompt-feeding-checklist.md`、`seedance-render-engine.md`、`quality-gate-review.md`、`delivery-pitfalls.md`、`blooper-prevention-playbook.md`、`screenplay-gate-engine.md`、`project-bundle-contract.md`

**注意 · `references/h3-adapter.md`**：那是上游「把七段式转成 H3 格式」的历史支线说明。**在本框架里 H3 有自己的全流程（`forest-laoli-h3`）**，本条 Seedance 线**不要**用它做格式转换——视频模型是 h3 的项目根本不会加载本技能。

**脚本（框架内不执行，仅供人工核验）**：`scripts/validate_prompt.py`、`scripts/audit_contract.py`、`scripts/build_board_lite.py`、`scripts/compile_feed.py`、`scripts/slice_context.py`、`scripts/style-lock-ladder.py` 等。

## 十一、常见翻车自查（投喂前逐条过）

1. 镜行把「紧张/压迫」写成结论词 → 改成可见动作与计数。
2. 同段内角色从左边家具换到右边家具但没写走位 → 投喂必出两个分身。
3. 一句台词塞 40 字进 5 秒 → 成片糊成一团（框架会先拒）。
4. 段缝两侧同机位同景别 → 跳切。
5. 2.0 稿里写了首尾帧 → 违反 A 锁硬约束。
6. 【站位声明】写「承接上一段」→ 模型零记忆，等于没写。
7. 投喂稿里出现「末态继承/拼接节点」→ 内部术语泄漏。
