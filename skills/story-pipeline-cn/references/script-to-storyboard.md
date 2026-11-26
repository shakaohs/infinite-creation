# 模式 B · 剧本转分镜（script-to-storyboard）

把一部现成剧本（本技能模式 A 产出的 `script.md`，或用户自带的 `.md`/`.txt` 剧本）拆成**分镜表 + 角色人设卡 + AI 绘图/视频 Prompt**，产出下游生成工具兼容的 `storyboard.json`。

## 触发

用户说「剧本分镜 / 出分镜 / 分镜表 / 剧本拆镜」，或提供剧本文件并意图可视化。若未指定，回退 SKILL.md 菜单。

## 输入

- `script.md` 或现成剧本（`.md`/`.txt`）。
- 若用户未提供画风，先确认 `art_style_prefix`（如 `anime style, cel shading, vibrant colors`）。

## 步骤

### Step 1 · 解析剧本结构

- 按 `【场景 NN】` / `INT.` / `EXT.` / `第X场` 切分场景；无标头按双空行。
- 逐段标注类型：场景头 / 画面描述 / 对白 / 动作指示 / 情绪标注。
- 收集出场角色（对白角色名 + 画面中提及），建立 `姓名 → CHAR_xxx` 映射。

### Step 2 · 分镜表生成

按「连续剧情段」聚合成长镜头（5–15s，最长 15s），同一场景连续动作 + 多句连贯对白合并成一镜（镜内子分镜承载节拍），仅场景切换/时空断开才换镜；**同一分镜最多 2 个说话人，≥3 人轮流对话必须拆成多个分镜（每镜 ≤2 个说话人）**。按 `style-guide.md` 定景别与运镜：

- 环境/全景描写 → `ELS`/`LS`
- 人物进场/全身 → `MLS`/`LS`
- 对白/交流 → `MCU`/`CU`
- 表情/眼神/细节 → `CU`/`ECU`
- 心理/意识 → `ECU`
- 追逐/动作 → `TRACKING`/`HANDHELD`

给每个镜头定：镜号 `S{场}_{n}`、时长（见时长参考）、景别、运镜、画面内容（中文）、角色动作、对白/音效。

**拆镜时，剧本「场景描写」里的信息必须完整分配到各镜，不能丢（铺垫信息四类归属）：**

| 原文场景描写里的信息 | 归属规则 |
|---|---|
| **静态环境元素**（游船横幅、码头全景、背景建筑） | 归本场景第一镜（建立镜）一次性交代；后续镜只在「空间锚点句」里复述，不逐镜重画 |
| **已在场的背景人物**（如「程嘉树、程念念已坐上接驳车」） | 用「身边人局部」带出（肩/半张脸/一只手/窗内侧影），不进主角主体，为后续切到他们做铺垫 |
| **说话人的手持道具**（推车、保温袋、手机、文件） | 逐镜写死，用「关键参照物」锚定空间（如「一手扶推车把手、一手拎保温袋」），不丢失、不替换 |
| **人物站位/朝向/动作**（「程远舟站前方看手机」） | 以原文为准，一字不改，禁止擅自改成「坐车里」或其它站位 |

> 拆镜只优化「动作连贯/视线/口型」，剧情、台词、镜头数、人物、服装、空间元素一律锁死（只优化不创作）。

**长镜头跨段续接规则（长镜头因 H3 单段 4–15s 上限被迫拆段时，必须遵守）：**

- **段尾定格动作**：第一段末尾让动作「定格一下」（`the frame holds clean and still`），给下一段一个干净续接点。
- **段首沿用段尾机位**：第二段开头完全沿用第一段的镜头位置——景别、机位、距离、构图**完全一致**。
- **景别逐字一致**：第一段用 `medium close-up`，第二段也必须逐字用 `medium close-up`，禁止「一段特写、一段近景」的跳变；机位（位置/高度/固定/角度）、距离、构图完全一致。
- **前后连续**：禁止重新接电话、重摆姿势、改站位、改机位、改景别、改朝向、突然切场景、重演已完成动作。

### Step 3 · 角色人设卡

对每个主要角色，按 `templates/character-card-template.md` 产出 `characters/CHAR_xxx.md`：

- 基础信息（年龄/性别/身份/性格关键词）
- 外貌（发型/眼/体型/标志性特征）
- 服装（日常/战斗）
- **可直接使用的英文图像 Prompt**（正面全身立绘 + 表情/动作变体）
- 代表台词

### Step 4 · AI 提示词分工（关键）

对每个镜头拆分两个英文 Prompt（参照 `style-guide.md` 七段结构）：

- `image_prompt`：画风前缀 + 场景/环境 + 主体/角色 + 静态动作/状态 + 镜头语言 + 光线 + 质量标签。**不含运动**，且画面不得出现任何文字/字幕/水印/logo。
- `video_prompt`：**只写镜头运动 + 角色动作**，不重复外貌（视频以首帧图定外貌），且不得出现任何文字/字幕/水印/logo。

示例：
```
image_prompt : "anime style, cel shading — dark factory interior, evening — young male, dark hoodie, flashlight — cautious scanning — tracking shot — dramatic lighting — high quality"
video_prompt : "slowly walking forward, looking around, tracking shot"
```

### Step 5 · 落盘与自检

- 写 `storyboard.md`（人读分镜表 + 角色卡 + 场景卡）。
- 写 `storyboard.json`（机读，结构见 `output-schemas.md`，`art_style_prefix` 已填、`characters` 用 `CHAR_xxx`、`reference_image` 初始 `null`）。
- 自检：`image_prompt`/`video_prompt` 是否英文？是否无任何文字/字幕/水印/logo？角色 ID 是否统一？场景编号是否连续？时长是否在 5–15s（最长 15s）？**铺垫信息是否完整（背景人物/静态环境/手持道具/站位朝向无丢失）？长镜头拆段是否段尾定格、段首沿用、景别逐字一致？**

展示分镜表给用户（门控点：此处调整最省钱，确认后进出图阶段）。

## 产出

- `outputs/<作品名>/storyboard.md`
- `outputs/<作品名>/storyboard.json`（下游生成工具兼容）
- `outputs/<作品名>/characters/CHAR_xxx.md`

## 衔接

`storyboard.json` 可直接交给 **下游图像/视频生成工具** 出图出视频（详见 `references/workflow-chain.md` 桥接说明）。本技能不调 API。
