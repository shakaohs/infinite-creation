---
name: h3-storyboard
description: "独立 H3 分镜 Skill（无人值守·从 forest-laoli-h3 拆出「③ 分镜」阶段）。把剧本/分集原文转成 MiniMax H3 可直投的分镜稿 + 三字段/六段式投喂稿。锁参数由调用方传入（不询问，缺失用默认值）。核心：八档四轴镜头档位、镜行三要素（景别/机位/运镜+画面事实）、越轴正向不变式、站位四要素、空间锚点、物理真实、氛围六件套、H3 官方硬规格（单段 4-15s、正文英文、<d>台词、图≤9）。机检 H1-H38 + 收尾复检。触发词：H3 分镜、海螺分镜、H3 镜头、H3 镜行、H3 shot、H3 投喂、Ref2VA 分镜、T2VA 分镜、H3 运镜、H3 越轴、H3 站位、八档四轴、H3 六段式、H3 三字段。"
version: "1.0.0"
---

# H3 分镜 Skill（h3-storyboard）

把**剧本/分集原文**转成可直投 MiniMax H3 的分镜稿，再编译成**三字段 / 六段式**投喂稿。**只做分镜这一环**——剧本由上游提供，资产图由上游（`z-image-prompt-writing` 或资产层）提供，本 Skill 不写剧本、不锁定资产、不出图。

## 一、无人值守接口（锁参数由调用方传入，不询问）

本 Skill 面向**无人值守流水线**：锁的值由调用方在请求里传入，**不询问用户、不弹卡**。缺失时按默认值兜底，必传项缺失则直接报缺（返回明确提示，让流水线补传），不阻塞等待。

| 参数 | 键 | 默认值 | 说明 |
|---|---|---|---|
| 模式 | `mode` | `Ref2VA` | `T2VA`（零图·三字段）/ `I2VA`（首帧）/ `L2VA`（尾帧）/ `FL2VA`（首尾帧）/ `Ref2VA`（多模态参考·六段式） |
| 时长档 | `duration` | 按节拍 8–15s | 4 / 5 / 8 / 10 / 12 / 15 秒，按情绪节拍定 |
| 画风基底 | `base` | **必传** | `BASE_LIVE` 真人 / `BASE_ANIME` 3D·半写实 / `BASE_2D` 手绘 / `BASE_INK` 水墨——决定脸部特写机位规则 |
| 资产形态 | `asset` | `M1` | `M1` 文字档（图号+接线单）/ `M2` 已锁参考图 |
| 段缝 | `seam` | 按节拍 | 尾帧锚定 / 换机位硬切 / 空镜过渡（情绪顶点用尾帧锚，文戏慢段用空镜） |
| 画幅 | `aspect` | `9:16` | `9:16` 竖屏（短剧主流）/ `16:9` 横屏；全片唯一，禁 `auto` |
| 空间锚点 | `anchor` | **必传** | 全片一张锚点卡：家具清单 + 座位/站位表 + 三个方位词 + 门窗初始开闭态 |

- **两条必传**：`base`（画风基底）与 `anchor`（空间锚点）——前者决定机位规则（3D 禁「特写×平视正面」），后者是站位的唯一依据。无人值守下缺失即报缺，不猜测。
- **画幅纪律**：全片一个画幅；画幅只写载荷 `aspect_ratio`，**不进正文**。
- **★ 锁必须先落盘再动笔（G0 硬门禁）**：六项锁 + 情绪节拍曲线 + 拆段表通过 `set_storyboard_plan` 写入本章锁档（`references/pipeline.md §一 / §五`）。没有锁档时 `set_storyboard` 直接拒绝，结构机检还会核对时长档、连续同机位、节拍归属、镜数密度。节拍曲线是运镜速度/留白/段缝的唯一依据——跳过就只能凭感觉，运镜必然平。

## 二、能力边界

| 做 | 不做 |
|---|---|
| 剧本原文 → H3 镜行表（分镜稿） | 写剧本 / 改台词 |
| 分镜稿 → 三字段 / 六段式投喂稿 | 资产锁定、生成图片/视频 |
| 机检 H1–H38 + 收尾复检 | 剧本层、诊断、交付打包 |

## 三、工作流（五步）

1. **收参数**：读取 `mode / duration / base / asset / seam / aspect / anchor` 七项锁，缺失按默认值或报缺。
2. **分镜设计**：逐镜按「八档镜头档位表」选档 → 四轴整行取齐（景别/焦段/机位/运镜/景深）→ 落成 H3 shot 头（见 §四）。
3. **镜行成稿**：每镜写成 `[Shot N] 景别, 机位角度, 运镜; 画面事实.`，逐镜过物理→站位→越轴→词根四关。
4. **H3 编译**：镜行表 → 三字段（`integrated_multimodal_description` / `overall_soundscape` / `non_diegetic_music`）或六段式（`subject_definitions` / `summary` / `retention_analysis` / `detailed_description` / `overall_soundscape` / `non_diegetic_music`）。
5. **机检交付**：`h3_lint.py`（H1–H38）清零 FAIL + `h3_finalcheck.py`（L0+F 组）复检，两道都过才交付。

## 四、分镜核心（八档四轴 → H3 shot 头）

**镜行只写三要素**（焦段/景深是设计意图，不进正文）：
```
[Shot N] <景别>, <机位角度>, <运镜>; <画面事实>.
```
例：`[Shot 2] Medium close-up, 45-degree side angle, the camera slides forward 12 cm over three seconds on a rail; she turns her head toward the window, lips pressed thin.`

**八档档位速查**（完整转化表见 `references/camera-four-axis-h3.md` §一）：

| 档 | 用途 | H3 shot 头写法（节选） |
|---|---|---|
| 定场 | 空间交代 | `Wide shot, 45-degree side angle, the camera sliding sideways 10 cm over three seconds on a rail` |
| 常规对话 | 正反打主力 | `Medium shot, 45-degree side angle, static` |
| 过肩关系 | 双人空间 | `Medium shot from behind her left shoulder, 45-degree side angle, static` |
| 情绪逼近 | 情绪推进 | `Medium close-up, ... the camera sliding forward 10 cm over two seconds on a rail` |
| 情绪爆点 | 特写+表演扛 | `Close-up, slightly high angle, static` |
| 权力顶点 | 大角度降级 | `slightly low angle` / `slightly high angle` |
| 动作主体 | 手持 | `Medium shot, side angle, hand-held, the camera jolts once` |
| 极致细节 | 微距 | `Insert close-up, top-down angle, static` |

**三条硬底线**：
1. 推拉必带「距离 + 时长 + 轨道」三件（`sliding forward 12 cm over three seconds on a rail`）。
2. 每镜必写运镜，静止也要写 `the camera holds still`（不写 = H3 自由发挥）。
3. 幅度不超景别上限（特写 10cm / 近景 15cm / 中景 40cm / 全景 80cm）。

**禁用运镜**：升格 / Hit-Stop / 急速变焦 / 滑动变焦 / 摇臂 / Snorricam / 持续手持剧烈晃动。

## 五、越轴（只写正向不变式）

- 每段开头写一次：`The camera stays on the same side of them throughout; she is on the left, he is on the right.`
- **禁写** `line / axis / frame / 轴线锁定 / 禁越轴 / 180度 / 左A右B`——H3 对否定不敏感、对词根敏感，「越轴」会被画成一条轴。
- 三种合法越轴（镜头内过轴 / 中立镜头过渡 / 受击位移重建）见 `references/h3-shot-grammar.md` §二。

## 六、站位（一行式四要素 + 空间锚点）

```
<人物> stands <依托物/位置>, facing <方向>, <姿态>; <位移：从A到B，因X>.
```
- 绝对方位优先（北/南/东/西 + 固定物），不用「画面左/右」。
- 每步有依托物（门口/桌后/窗边），悬空 = 漂移源。
- 位置只声明一次，全段引用；换机位只改画面左右，不改物理位置。
- 每镜点名全部在场者（中景及以上）；近景/中近景优先服从「取景半径上限」（见 §七）。

## 七、景别白名单（最高优先级 · 本项目默认）

**只用三档景别**：`close shot`（近景）/ `medium close shot`（中近景）/ `medium shot`（中景，仅确需交代相邻 2-3 人时）。

**禁写**：`wide shot / full shot / long shot / establishing shot / medium wide / 中远景 / 远景 / 全景 / 大全景`——写了模型必然拉远，远景下人脸崩、站位漂移（机检 H40 硬拦）。

- 取景半径：近景 1 人、中近景 2 人、中景 2–3 人；远处人只作「边缘虚化局部」或画外，不塞进近景。
- 换人（正反打）时至少换机位角度或景别（H41）；人数不变时全员从 Shot 1 全在场、站位锁定（H42）。

## 八、铁律速查（写稿前过一遍）

- 单段 4–15 秒，与 `duration_seconds` 一致；正文英文，`<d>[Chinese] …</d>` 保原文。
- 首镜无时间戳，后续 `[Shot N] At 00:04.000,` 严格递增；切镜只用官方绑定短语 `the camera cuts to`。
- 词根零容忍：正文禁否定词、禁镜头/摄影术语、禁抽象评价、禁心理动词、禁比喻（见 `h3-lexicon-cleanup.md`）。
- 每句台词必挂「神态 + 动作」双挂（四区肌肉，禁「紧张/愤怒」结论词）。
- 道具首现必写支撑面；同框一镜最多 2 人；动作预算一镜一个主角动作 + ≤70 词。
- 门窗状态显式锁死（`closed / shut` / `partially_preserved`）；画外敲门只写画面内受迫结果，声音放 `overall_soundscape`。
- 物理真实优先：先过受力再谈站位（`physics-realism.md` §1.1 介质判定表）。
- 氛围六件套写在段首（光源/光质/空气介质/色板/前景景深/材质高光），最少写光位+介质+前景。
- **★ 跨镜锁定门禁（写完 `detailed_description` 逐镜必过）**：见 `h3-format.md §3.4「跨镜锁定自检清单」` 与 `spatial-anchor-and-hold.md §8.2/§8.3`——①换人必换机位或景别（H41，否则原地闪现两人）②**人数场景不变的固定站位戏：全员从 [Shot 1] 在场、站位锁死，换视角把其他人写成【无 <Subject> 标签】的虚化肩背/后影 + 段内站位锁死句；严禁为过机检硬写 `steps into frame` / `leaves frame`（＝擅自加剧情动作），只有剧情真有人来/走才写入退场**（H42 已认此豁免）③首镜无时间戳、后续 `At MM:SS.mmm` 递增、一镜一时戳（H2）④单镜 ≤100 词（H23）⑤`<Picture N>` 跨段不换主体（H34）⑥越轴只写正向不变式。**这几条是三段连续实测中模型"读过却没执行"的高频 FAIL，必须逐镜核对，不靠机检重试补救。**

## 九、规则库索引

| 文件 | 内容 | 何时读 |
|---|---|---|
| `references/pipeline.md` | **流程权威**：G0 六项锁判据（A 模式/B 画幅/C 时长档/D 画风基底/E 资产形态/F 段缝）、G1–G5 阶段门、拆段实操、一集标准产出顺序 | **分镜动笔前第一份必读** |
| `references/gates.md` | **三级门禁**：P0 阻断 29 条 / P1 结构 16 条 / P2 审美 7 条 | 分镜与编译后逐条对 |
| `references/checklist.md` | **77 项投喂前必查清单**（P物理/A锁定/B图槽/C格式/D镜头/E空间/F表演/G声音/H词根/I交付） | 写完一稿逐项打勾 |
| `references/camera-four-axis-h3.md` | 八档四轴 → H3 shot 头转化表、回合制切镜、神态双挂、状态账 | 分镜设计前必读 |
| `references/h3-shot-grammar.md` | 运镜·越轴·站位三件套（核心）、幅度上限、取景半径、动作节奏 | 写每个镜行时 |
| `references/camera-movement.md` | 22 种运镜 H3 可执行度、厘米刻度、运镜×景别矩阵 | 写运镜时 |
| `references/spatial-anchor-and-hold.md` | 空间锚点卡、维持句、门窗/分身专治、段间尾帧续接 | 写站位与段缝时 |
| `references/physics-realism.md` | 物理真实律（介质判定表、支撑面律、力成对律） | 写实类每镜先过 |
| `references/acting-facs.md` / `acting-recipes.md` / `acting-listen.md` | 四区肌肉、30 种情绪配方、听戏五步链 | 写表演时 |
| `references/dialogue-density.md` | 台词密度（3.3 字/秒、一镜一句、声槽绑定） | 排台词时 |
| `references/atmosphere-and-light.md` | 氛围六件套、三层分工、国漫 3D 正词表 | 写氛围层时 |
| `references/h3-lexicon-cleanup.md` | 词根黑名单、九条改写公式、五遍清洗 | 编译前清洗时 |
| `references/h3-format.md` | 三字段/六段式规格、时间戳格式 | 编译时 |
| `references/h3-constraints-qc.md` | 硬约束 H1–H38 对照 | 机检判读时 |

## 十、机检命令

```bash
python scripts/h3_lint.py 稿子.md --duration 12          # H1-H38，FAIL 清零
python scripts/h3_lint.py 稿子.md --duration 12 --aspect 16:9   # 横屏显式声明
python scripts/h3_finalcheck.py 稿子.md --logic          # 先看 L0 现实性复核表
python scripts/h3_finalcheck.py 稿子.md                  # L0+F 组复检，退出码非 0 即拦
```

**检查顺序不能倒**：先 L0 大方向（这一镜现实成不成立），再 F 组细则（具体事故模式）。格式合规 ≠ 画得出来。
