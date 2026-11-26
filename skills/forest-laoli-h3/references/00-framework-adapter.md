# 00 · 无限创作流水线适配层（framework adapter）

> **本文件是框架追加的，不属于上游原包。** 上游 `SKILL.md` 与 `references/` 一字未改；本文件只解决一件事：
> 把 H3 全流程的七个阶段映射到「无限创作」的四个流水线阶段与工具上，并把上游的「人机交互门」替换成框架的「项目锁卡 + 后端机检」。
> **判据有疑问 → 回上游原文（`pipeline.md` / `gates.md` / `checklist.md` / `h3-format.md`），不用本文件摘要替代原文。**

## 一、阶段映射

| 上游 | 框架内怎么落 | 工具 | 权威原文 |
|---|---|---|---|
| **G0 锁**（A 模式 / B 时长档 / C 画风基底 / D 资产形态 / E 段缝 / F 空间锚点） | 一次落盘，`set_storyboard` 之前必须完成 | `set_storyboard_plan` | `pipeline.md` §一、§四、§五 |
| **① 剧本** | 写本章剧本（带刺活人话、情绪节拍） | `set_chapter_script` | `script-layer.md` |
| **② 资产** | 登记资产 + 出图提示词（图由框架生成回填） | `create_asset` / `update_asset` / `change_outfit` / `change_age` | `asset-layer.md` |
| **③ 分镜** | 写镜行（英文） | `set_storyboard` | `camera-four-axis-h3.md` / `h3-shot-grammar.md` / `spatial-anchor-and-hold.md` / `dialogue-density.md` |
| **③·补 表演** | 四区肌肉 + 听戏反应，并入 `visual` | 同上 | `acting-facs.md` / `acting-recipes.md` / `acting-listen.md` |
| **④ 编译** | 写视频提示词（六段式 / 三字段） | `write_video_prompts_batch` / `write_shot_video_prompt` | `h3-format.md` |
| **⑤ 清洗机检** | 后端 `checkVideoPrompt` 等价执行 H1–H38 的关键项，FAIL 自动回灌重写 | 后端 | `h3-lexicon-cleanup.md` / `h3-constraints-qc.md` |
| **⑥ 交付** | 入库（`video_prompt` 字段），无剥壳 `.txt`、无投喂包 | — | `delivery.md`（仅参考图槽铁律部分） |
| **⑦ 收尾复检** | 分镜阶段门禁 + 提示词机检两道；**不跑 `python h3_finalcheck.py`** | 后端 | `checklist.md` / `gates.md` |

## 二、覆盖声明（优先级高于上游任何条款）

| 上游条款 | 框架内口径 |
|---|---|
| G0「缺一项就停下来问，不许默认」 | **锁位由项目锁卡给全**（模式/画幅/画风基底/段缝），直接执行，禁止提问 |
| 「画幅未指定默认 9:16 并说明」 | 画幅取 `project.video_aspect_ratio`，全片唯一，禁 auto |
| ①剧本「分集 → 分场 → 平台节奏」 | 框架一章 = 一个生成单元集；平台发行规格（60–90 秒/付费卡点）**不进生成层** |
| ②资产「全片固定 9 图槽表」「图 <=9、全挂不省图」 | 框架参考图上限 **7 张**（`MAX_IMAGE_REFS`），顺序由工具按「人物→场景→道具→音色」真实注入；**不要手写 `<Picture N>` 编号**，编号由 `write_video_prompts_batch` 给出 |
| ⑤「跑 `h3_lint.py` / 62 项清单 / FAIL 清零」 | 不跑脚本；后端机检覆盖字段/顺序/时长/词根/镜行词数/图槽越界等项目，FAIL 回灌 |
| ⑦「跑 `h3_finalcheck.py`」 | 不跑；物理真实与 L0 现实性靠写作时自检（`physics-realism.md` 交付 16 问） |
| ⑥「剥壳 .txt + 清单 JSON + 图槽表」 | 不适用：产物是数据库字段，甲方要改直接改字段 |
| 「单段 4–15s」 | **框架同样硬约束**（`duration` 1–15，H3 侧按 4–15 执行） |
| 「参考图/视频/音频配额」 | 图 ≤7（框架）、音频 ≤3（框架），视频参考框架暂不支持 → 只用图 + 音 |

## 三、落笔前必读（分镜阶段 · 缺一个 `set_storyboard` 直接拒绝）

按此顺序读完再动笔：

1. `pipeline.md` —— G0 六项锁判据、拆段实操、一集标准产出顺序（第 4–5 步就是情绪节拍与拆段表）
2. `camera-four-axis-h3.md` —— 八档四轴整行取齐、回合制切镜、神态动作双挂、状态账
3. `h3-shot-grammar.md` —— 运镜 / 越轴 / 站位三件套、镜行分两区
4. `spatial-anchor-and-hold.md` —— 空间锚点卡、维持句、门窗分身、段间尾帧续接（H50–H58）
5. `dialogue-density.md` —— 台词连续铺轨、3.3 字/秒标定、声槽全局绑定
6. `checklist.md` —— 十组必查（分镜阶段先过与镜头结构相关的组）
7. `h3-constraints-qc.md` —— H1–H38 对照，知道后端在拦什么

写提示词阶段再补：`h3-format.md`（六段式规格）→ `h3-lexicon-cleanup.md`（词根黑名单）→ `physics-realism.md`（物理真实）→ `acting-*.md`（表演）→ `atmosphere-and-light.md`（氛围六件套）。

## 四、框架字段 ↔ 上游概念的对应

| 框架字段 | 上游概念 | 写法 |
|---|---|---|
| `camera` | 镜行头（分号前） | 景别·机位·运镜，**全英文**（如 `Medium close-up, eye level, fixed camera`） |
| `visual` | 镜行正文（分号后） | 只写人与物的可见状态与动作，**全英文**；禁否定词/抽象词/心理词/镜头术语 |
| `sub_shots` | 段内时间轴与切点 | `0.0-2.4s …`；切镜用官方绑定短语（`the camera cuts to` 等），**全英文** |
| `dialogue` | 台词稿 | `人物名：中文台词`；单镜 ≤2 人开口；≤3.5 字/秒 |
| `duration` | 单段时长 | 4–15 整数秒，与节拍 `durationSec` 一致 |
| `video_prompt` | 六段式投喂稿 | `subject_definitions` / `summary` / `retention_analysis` / `detailed_description` / `overall_soundscape` / `non_diegetic_music` |
| `characters` / `scenes` / `props` / `costumes` / `ages` / `audios` | 图槽与音槽 | 传**资产名**，不要传编号；编号由工具回填 |

## 五、H3 与框架的三处硬差异（最容易写错）

1. **镜行正文全英文**：`camera` / `visual` / `sub_shots` 只要出现中文，`set_storyboard` 直接拒绝。只有 `dialogue` 保留中文。
2. **不要手写 `<Picture N>` / `<Subject N>` / `<Audio N>`**：编号由 `write_video_prompts_batch` 按本镜真实参考顺序注入。正文里只能用 `<Subject N>`，`<Picture N>` 只在 `subject_definitions` 出现一次。
3. **不要写「无字幕/No subtitles」**：字幕关闭的项目，提示词里一个字都不提字幕（否定词根会被画成乱码条）。

## 六、失败处置

- `set_storyboard_plan` 被拒 → 按报错补齐六项锁或节拍（`shotRange` 必须从镜 1 连续覆盖）。
- `set_storyboard` 被拒（结构机检）→ 按报错改：时长档、具名主体、连续同机位、节拍归属、镜数密度。
- 提示词机检 FAIL → 按回灌的 `[FAIL]` 项逐条改，不要整份重写。
- 上游文档里的脚本一律不执行；文档声称「跑脚本才能得到」的产物，用工具本身完成。
