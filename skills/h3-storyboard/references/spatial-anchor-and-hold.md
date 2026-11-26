# 空间锚点 · 维持句 · 动作预算 · 门窗与分身防崩（H3 空间层唯一权威）

> 来源：MiniMax Hailuo 官方 prompt 模板（`[HOLD]` 维持逻辑、40–70 词上限）、官方多人动效指南（`one featured action, small everything else`）、以及 2026-10-21《门后》4 段成片（`p6_段01_规矩` ~ `p6_段04_门开了`）与《凶宅试睡员》6 段真机逐帧复盘。

## 一、为什么站位、门窗和人数会崩（机制，不是运气）

H3 **每段独立生成、零记忆**，且**按词根触发视觉图层**。它的四大底层习性决定了空间层的写法：

1. **零记忆自造家具**：参考图里没有、正文也没写的东西，它会自己造（沙发、吊灯、茶具）。
2. **跨镜预演与词根激活**：如果 Shot 4 写了开门/出门，或者前镜出现了 `gap / doorway / knock`，后面切机位如果不显式锁死 `the door stays shut`，它就会提前把门打开（段01 Shot 3 末尾提前压门把手、段03 Shot 3 反打背景门大敞四开）。
3. **段内坐标冲突 = 分身复制**：如果同一角色在 Shot 1 绑定在右侧电表箱旁，Shot 4 没写走位却写他在左侧鞋柜旁，H3 不会让他“瞬移”，而是**在右边保留一个旧的他，同时在左边鞋柜旁再画一个新的他**（段01 Shot 4 左右两个林昭夹住老周）！
4. **画外动作词根张冠李戴**：如果门外有人敲门，你在门内单人镜头的画面正文里写 `three knocks landing on the far side`，H3 看到动词 `knocks` 就会让**屋里的主角自己转过身去举拳敲自己家的门**（段02 Shot 1 真机实证）！

---

## 二、第一件必做：全片一张「空间锚点卡」（区分全程闭合段 vs 状态变化段）

开写前先钉死全片空间锚点卡，在每段 `detailed_description` 开头复述：

### 2.1 全程无门窗开闭变化的段落（如《门后》段02、段03）

**必须显式写死 `closed`（闭合态）**，不能只写 `one dark green steel door`：

```text
The entrance hall holds one closed dark green steel door with its latch chained facing the viewer,
one low wooden shoe cabinet at the left of the door, one grey meter box on the right wall
and one bare warm bulb overhead; these pieces stay in place for every shot.
```

### 2.2 段内发生开门/关门状态变化的段落（如《门后》段01、段04）

> **★ 2026-10-21《门后》段04 真机血泪教训（防“双扇门/门中门”分裂）**：
> 段04 在 `retention_analysis` 把门厅图 `<Subject 3>` 标为 `fully_preserved`，又在段首写死 `one dark green steel door facing the viewer... stay in place for every shot`，结果到了 Shot 4 写 `the steel leaf swings toward the viewer on its own` 时，H3 为了同时满足“参考图里正中带猫眼的关着的门不动”和“门扇向内打开露出走廊”，把单扇门硬生生分裂成了**左扇关闭（带猫眼）+ 右扇打开**的诡异双扇门！

**正确规程（H31 机检兜底）**：
1. **`retention_analysis` 改标 `partially_preserved`**：
   `<Subject 3> (image): partially_preserved — hall walls, shoe cabinet, meter box and bulb retained; the dark green steel door stays closed in Shots 1 to 3 and swings open in Shot 4.`
2. **段首锚点句只锁死不动的固定物，门标明“初始闭合”**：
   `The entrance hall holds one low wooden shoe cabinet at the left wall, one grey meter box on the right wall and one bare warm bulb overhead staying in place throughout; the dark green steel door at the centre starts closed and latched.`
3. **开门前的所有镜头（Shots 1–3）末尾维持句显式写 `the dark green steel door stays shut`**，严禁在 Shot 3 末尾提前抢跑压门把手；直到 Shot 4 才写门扇开启。

---

## 三、第二件必做：每镜一句维持句（HOLD · 落地在镜行末尾）

> **口径澄清**：`[HOLD]` 是 Hailuo Web 模板的概念，H3 Ref2VA 六段式没有独立 `[HOLD]` 字段，因此**一律写成每镜正文末尾的最后一句话**（机检 H24）。

| 治什么 | 正向维持句模板（挑 1–2 项，禁写否定词） |
|---|---|
| **门提前自开（段03 反打穿帮）** | `the dark green steel door and its iron chain stay shut behind him` |
| **站位/座位漂移** | `the two stools stay at the two ends of the table` |
| **家具乱造** | `the low wooden shoe cabinet and the grey meter box stay unchanged` |
| **服装/道具变形** | `the square white photograph stays flat in his left hand` |

---

## 四、第三件必做：动作预算与同框硬锁（一镜一主角动作 · H23/H30）

官方多人指南原话：
> `one featured action, small everything else`
> `five people doing five things reads as chaos and melts the weakest face first`

1. **单镜正文 ≤85 词**（>85 词 WARN，>100 词 FAIL——超 100 词必先丢机位再丢后半动作）。
2. **一镜最多两个人物 `<Subject>`，且只给其中一个人写动作**：
   - 同框第二人**只能写纯静态维持**（`<Subject 1> stands still by the right wall with both hands in his pockets`）；
   - **严禁给第二人写旁观动态词**（如 `watches him go` / `looks on` / `waits and watches`）——实测段01 Shot 4 写 `watches him go` 直接诱发 H3 把第二人再画一遍凑数（机检 H30）。

---

## 五、形变专治清单

| 病灶 | 原因 | 处方 |
|---|---|---|
| 递接物件时手穿模 | 手对手接触 | 改**放置式**：`she sets the cup down on the table` |
| 纸张/账本文字乱码 | 要求可读多字文本 | 写 `ink strokes standing in rows`（若需单字特写如`"允"`，须挂道具参考图或锁死单字微距） |
| 两人特征互换/融合 | 描述对称 | 服装/年龄/发型硬差异化，各自绑定固定方位 |

---

## 六、真机复盘一 · 《凶宅试睡员》6 段空间层规程（H28）

1. **空间描述过载 → 空间尺度膨胀（机检 H28）**：
   - 锚点写 `a wall of framed sepia photographs`，成片把一面木格栅铺成几百张照片的祠堂展厅，房间纵深翻倍。
   - **铁律**：家具/装饰一律**单数 + 限定位置**（`one tall framed photograph on the left panel`），严禁 `wall of / rows of / dozens of / hundreds of / grid of`。
2. **一段一景**：一段只允许一块空间；本段不用的空间图照样原槽位挂着（保图槽顺序），但正文不引用。
3. **特写镜带 1–2 个资产可识别特征**（`the iron chain on the steel latch`），防材质漂移；中景补可视裁切锚（`cut at the waist`）。

---

## 七、真机复盘二 · 《门后》4 段成片逐帧取证与五大硬伤根治（2026-10-21 · H29–H33）

对上传的 4 段成片（`p6_段01_规矩.mp4`、`p6_段02_敲门.mp4`、`p6_段03_背面_r1.mp4`、`p6_段04_门开了.mp4`）逐秒抽帧拉片后，定位出以下五大模型级病根及根治铁律：

### 7.1 病根一：人物穿过门洞/开口 → 半透明 alpha 融化蒸发（段01 末镜 · 机检 H29）

- **成片现象**：`p6_段01_规矩.mp4` 第 13.3s–15.0s，老周（`<Subject 2>`）往门外走时，身体越过门框线立刻变成半透明鬼影逐渐溶解消失。
- **文本病灶**：Shot 4 写了 `he steps out through the dark green steel door`。H3 把“穿过有框开口（`through the door / doorway / opening`）”当成图层透明度淡出（alpha transition）。
- **根治铁律（H29）**：**人绝不穿过门洞、窗洞、门帘、栅栏或任何有框开口。**
  - 安全替代 A（停在出门前）：`he turns toward the dark green steel door and rests his right hand on the latch`
  - 安全替代 B（只拍门合上，人已不在画内）：`the dark green steel door swings shut into its frame and the latch clicks into place`

### 7.2 病根二：段内依托物跳变 + 双人同镜动态 → 左右两个林昭分身（段01 末镜 · 机检 H30 + H32）

- **成片现象**：`p6_段01_规矩.mp4` 第 11.5s–14.0s（Shot 4），画面左右两边**同时站着两个一模一样的深灰连帽衫男主林昭（`<Subject 1>`）**，一左一右夹着中间的老周！
- **文本病灶（双重叠加）**：
  1. **段内坐标自相矛盾（主因 · H32）**：Shot 1 写老周 `<Subject 2>` 站在左侧鞋柜旁（`stands beside the low wooden shoe cabinet`），林昭 `<Subject 1>` 站在两步外的右侧（电表箱下）。到了 Shot 4，中间没有任何走位镜头，却突然写 `<Subject 1> stands beside the low wooden shoe cabinet`（把林昭写到了左边鞋柜旁）！H3 既保留了 Shot 1 右侧插兜的林昭，又按 Shot 4 指令在左侧鞋柜旁新画了一个插兜的林昭，于是出现左右双胞胎分身！
  2. **双人同镜加旁观动词（次因 · H30）**：Shot 4 同时写了老周出门 + 林昭 `and watches him go`。
- **根治铁律（H30 + H32）**：
  - **同一段内若无显式走位（`walks from A to B`），每个角色的依托物与左右位置必须从 Shot 1 到末镜 100% 锁定不变**（林昭在 Shot 1 靠右侧电表箱，Shot 4 就必须写 `stands still below the grey meter box on the right`）；
  - 同框第二人只准写 `stands still`，禁写 `watches him go`。

### 7.3 病根三：画外敲门写进画面正文 → 屋里男主自己转身敲自己家的门（段02 首镜 · 机检 H31a）

- **成片现象**：`p6_段02_敲门.mp4` 第 0.0s–2.5s（Shot 1），剧情是半夜门外女声敲门喊“水管漏了”，屋里只有男主林昭一人；但成片画面却是**林昭背对镜头，自己举起右手握拳在屋里敲自家的绿铁门**！
- **文本病灶**：`case15` Shot 1 在画面正文（分号后）写了：`he stops one step short of the steel door, his head tilted toward it, three knocks landing on the far side`。H3 的视觉渲染器不理解 `on the far side` 的空间阻隔，它只看到当前镜头唯一人物 `<Subject 1>` 和动作词根 `knocks`，于是直接驱动 `<Subject 1>` 举手敲门！
- **根治铁律（H31a）**：**凡隔着门/墙发生的画外声源动作（`knocks / knocking / pounding / footsteps outside`），严禁写进 `detailed_description` 的镜行正文！**
  - **画面正文只写门内可见的受迫物理结果**：`he stops one step short of the closed steel door, his head tilted toward it, the steel door vibrating three times in its frame and the iron chain clinking once on its hook`；
  - **敲门动作词只放进 `overall_soundscape`**：`Three heavy knocks sounding on the outer side of the steel door`。

### 7.4 病根四：跨镜开门抢跑、未开门段背景门自开、开门段分裂“双扇门”（段01/03/04 · 机检 H31b）

- **成片现象**：
  - `p6_段01_规矩.mp4` 第 10.5s（Shot 3 铁链特写末尾）：画面左侧突然伸出一只手把门把手压下（为 Shot 4 出门提前抢跑）；
  - `p6_段03_背面_r1.mp4` 第 7.5s–11.5s（Shot 3 男主正面低机位）：男主蹲在地上看照片，**他身后的绿铁门竟然大敞四开**（而剧情里门根本没开）；
  - `p6_段04_门开了.mp4` 第 11.5s–15.0s（Shot 4 门自己打开）：原本的一扇绿铁门分裂成了**左边一扇关着的带猫眼铁门 + 右边一扇向内打开的铁门**（门中门）。
- **根治铁律（H31b）**：
  - 未开门段（段02/03）：段首锚点与每个带门镜头的维持句必须显式写 `the closed dark green steel door stays shut and latched`；
  - 开门段（段04）：`retention_analysis` 场景标 `partially_preserved`（说明门从关变开），段首锚点不把门放进 `stay in place for every shot` 死锁列表，且开门前的 Shot 1–3 显式写 `the steel door stays shut`。

### 7.5 病根五：全蹲低姿态 + 窄缝穿物过程 → 渲染卡 76% 与成片冻帧 1.7s（段03 · 机检 H33）

- **成片现象**：`p6_段03_背面_r1.mp4` 投喂时连续三次卡死在 76%；跑出的成片在 `00:01.6–00:03.3`（Shot 1 全蹲）和 `00:05.8–00:07.4`（Shot 2 照片从门缝塞入）出现长达 1.7 秒的完全静止死机冻帧！
- **文本病灶**：Shot 1 `crouches on his heels`（全蹲折叠肢体 + 低角度）与 Shot 2 `slides through the gap under the door`（薄片穿过极窄门缝的物理过程）超出 H3 物理扩散收敛能力。
- **根治铁律（H33）**：
  - 禁写 `crouches on his heels` 全蹲，改为弯腰或半屈膝：`he bends from the waist with his right hand braced on the low wooden shoe cabinet`；
  - 禁写物品从门缝穿过/塞入的动态过程（`slides through the gap`），直接写**已进入门内的地面静置结果态**：`a white square photograph lies flat on the concrete sill just inside the closed steel door`。

---

## 八、多人同场：人从头到尾在场，切镜头只切机位/景别/看向，不切"谁在场"（★ 2026-11-10 用户真机 · 人凭空出现/消失）

### 8.1 病根：H3 零跨镜记忆，切镜时若没把"仍在场的人"写进新镜，他就会凭空消失

- **成片现象**：第一镜 A、B 两人，C 在旁；切到第二镜拍 A、C，**B 凭空消失**；或第二镜里出现一个第一镜里**根本没站过那个位置的人**（用户标注实锤：顾母站的位置，第一镜是空的，第二镜她"唰"地凭空出现）。
- **文本病灶**：把"切镜头"误当成"换人"。H3 逐镜独立渲染，**每镜画面里谁在、站在哪，完全由这一镜文字决定**，不会继承上一镜。第二镜没写"仍在场的 B"，B 就没了；写了"新站位的 C"却没写她怎么来的，C 就凭空冒出来。

### 8.2 核心铁律（用户原话定版）：人数不变、场景不变 → 人一开始就在，全程站位锁定不变

> **"人数不变、场景不变"的场景，所有人从 [Shot 1] 开始就全在场、站位从头到尾 100% 锁定不变。切镜头只切三样：机位 / 景别 / 看向谁（视线指向说话对象），不切"谁在场"。人只做动作，不出现"入画/退场"。**

**正确写法（用户 2026-11-10 认可 · 四人同框标准式）**：中景，**两个主体居中**（各有 `<Subject N>` 标签 + 动作），**其余在场者作前景/后景虚化**（不占 `<Subject>` 标签，只写无标签的 `a softened shoulder at the frame edge` / `the out-of-focus back of a grey-haired man on the right`）：

```
[Shot 1] Medium shot, fixed position, eye level. <Subject 1> stands center-left ...
<Subject 2> stands center-right behind the table, her right hand flat on the paper stack ...
At the left foreground edge, the softened back of a woman in a white cape, out of focus;
at the right foreground edge, the out-of-focus shoulder and grey hair of an older man.
Every person keeps this position and facing for the whole segment.
```

**五条硬规则**：
1. **在场者从 [Shot 1] 就全写进画面**，不许"某个镜头才补一个人进来"（补 = 凭空出现）；
2. **站位锁定不变**：每个在场者的位置（left / right / behind the table / at the frame edge）从 Shot 1 到末镜一字不改，切镜只改机位角度和景别，不改人物物理位置；
3. **切镜头只做三件事**：换机位 / 换景别 / 换"谁看向谁"。**看向谁 = 视线锁在说话对象脸上**（`her eyes stay on <Subject 4>`），合谁对话就看向谁；
4. **主体（居中、有 `<Subject N>` 标签、有动作）≤ 2 人**，其余在场者无标签、纯静态、虚化；
5. **段尾维持句锁全员**：`Every person keeps the position and facing set in [Shot 1] for the whole segment`。

### 8.3 什么情况下才允许"人真的来/走"（退场/入场）

只有剧情上确实"这个人走了、那个人来了"（人数变化）时，才允许写来去，且必须显式交代：

- 退场：`<Subject X> steps back from the table and leaves frame right`；
- 入场：`<Subject Y> steps into frame from screen left and stops beside the table`；
- 机检 H42 兜底：跨镜"人数变化"但缺 `steps into frame` / `leaves frame` 交代 → FAIL。
- **H42 对固定站位戏的豁免（2026-11-23 用户定 · 禁硬加动作）**：人数不变的戏里，一个角色从「带 `<Subject N>` 标签的主体」切成「无标签的虚化肩背/后影」是合法换视角，**不算退场**。写法必须同时满足两条：①新镜里写 `the softened back of ...` / `an out-of-focus shoulder at the frame edge` 这类无标签虚化在场者；②段里有站位锁死句（`Every person keeps this position and facing...`）。两条齐了 H42 放行；缺虚化在场者、直接把人从画面抹掉仍 FAIL。**禁止为了让机检过而给固定站位戏硬写 `steps into frame` / `leaves frame`——那是擅自加剧情动作，违反"只优化不创作"。**

**判据一句话**：先问"这个场景人数变不变"？**人数不变 → 全员从第一镜在场、站位锁死、切镜只切机位景别看向（换视角用无标签虚化肩背，不写入退场）**；**人数变 → 才写来去**。两者不许混。

---

## 九、段间尾帧续接 + 动作顺滑 + 朝向锁（★ 2026-11-18 用户新增 · H50–H53）

> 针对「多段连拍」场景：一条片拆成多段连续生成，上一段最后一帧 = 下一段起始帧。H3 零跨段记忆，所以"接住上一段"只能靠**本段文字复述上一段尾帧**，不能靠模型回忆。

### 9.1 动作要顺滑连贯（H50 · 动作链不许跳步）

- **动作必须有起点、过程、终点**，三个都要写。只写结果（`she stands at the cart`）不写过程，模型会瞬移；只写起点不写终点，动作会半途悬空。
- **不许跳过动作过程**：从"手机贴耳"到"推车离开"，中间必须写清「放下手机 → 手落到身侧 → 转身 → 双手握推车把手 → 起步」的完整链条，缺一环模型就自己补错位。
- **不许重复已完成动作**：上一段已经"挂断电话"了，本段开头就**从"放下手机"之后的状态起**，不要再写一次"接电话/挂电话"。
- **单镜动作 1–2 个**，超过就拆镜或拆段；动作用时间点分开写（`At 00:02.000, ...`），不要写"同时做两件事"。

### 9.2 记录前一段段尾站位，作为本段输入（H51）

- 开写每一段前，**先明确写出"上一段段尾站位卡"**（谁、什么姿势、朝向哪、手在哪、道具什么状态），再动笔写本段。
- 本段 `[Shot 1]` 的第一句必须**复述这个尾帧站位**，写法是"从上一段末帧的同一姿势继续"，不是"同上/如前"（H3 看不懂引用）。
- 上一段**无变动 → 沿用**（站位逐字复述一遍）；**有变动 → 同步修改**（写清谁从哪动到哪、怎么动的）。

### 9.3 下一段段首接住上一段段尾（H52 · 容帧续接）

- **末帧必须落定**：上一段末镜最后 0.4s 不新起动作、无运动模糊、不甩镜、不让人物出画，落在干净静止帧（`it comes to rest there; the frame holds clean and still...`）。
- **首帧接位**：本段 `[Shot 1]` 写 `Continues from the tail frame of the segment before: the same positions, nobody re-enters, nothing is re-staged.`（H3 无记忆，这句是"别重摆"的指令，不是引用）。
- **机位五要素逐字一致**：连续两段同一机位时，位置 / 高度 / 角度 / 距离 / 构图五要素必须**逐字相同**，写 `the camera holds the exact same position, height, angle, distance and framing as the preceding segment`（H54 见下）。
- **换景别只推机位**：写 `the camera cuts in on the same positions`，禁写 `cut to`（`cut to` 会触发重摆）。
- **末帧预埋钩子**：上一段末 0.5s 让下一段第一要素先进画面（一只靴/一只手/一道脚步声），下一段从"动作的下一半"接着演。

### 9.4 人物朝向要正确（H53 · 朝向 = 空间关系的骨架）

- **朝向是站位的一部分，与位置同等重要，必须逐段重述**：谁面朝左/右、谁看向谁，每个 `<Subject>` 定义和每镜正文都要写。
- **朝向必须成对呼应**：A 面朝右看 B，则 B 的朝向必须反过来朝 A（A 右 B 左），否则两镜拼起来空间关系断裂、像各说各话。
- **禁写"视线在两人之间扫"**：单人镜里人物只看一个方向（`her gaze fixed on one point`），竖屏下尤其不能写"从 A 看到 B"。
- **越轴（反打）全集只允许一次**，且必须显式声明 `this is the one reverse angle in the episode`；不声明，模型会镜像整场、左右全翻。
- **画外的人**：不在画内的人只写"声源方向 / 视线方向"，不写其在画外的具体坐标，避免模型把画外人塞进竖屏。

### 9.5 景别用词逐字一致（H54 · 连续段景别不能跳变）

- **连续两段（容帧续接）的景别必须逐字相同**：上一段写 `a medium close-up`，下一段就必须写 `a medium close-up`，不能一段写 `medium close-up to close-up`、另一段写 `medium close-up`（实测 2026-11-19 用户抓出：第一段特写、第二段变近景，景别跳变）。
- **同一人物同一机位的连续段，禁止换景别**：换景别 = 换机位距离 = 会触发重摆/跳切，除非剧情要求"推近"（且推近要写清起点→终点过程，不写 `cut to`）。
- **景别用词用单一确定值，不用区间/模糊词**：禁 `medium close-up to close-up` / `close-up or medium` 这类"二选一"写法，一个段一个镜一个景别，定死一个词。
- **自检**：写完连续两段，逐字比对 `detailed_description` 开头那一句"风格句 + 景别句"，景别单词必须完全相同。

### 9.6 越轴防线 · 180 度法则（H55 · 空间连续性的铁律）

> 来源：海螺官方《Director's Guide to Shot-Reverse-Shot Spatial Logic》、aifilmindia《The Cinematic Brain》Ch.09、jordangaston/claude-plugins `storyboard-creation`、Bowen《Grammar of the Shot》Ch.5。**AI 视频每一代都是"全新剧组"，看不到上一镜，180 度法则必须靠"写进提示词的书面法律"维持，不能靠记忆。**

**1. 定义（轴线 = 视线连线）**：两名角色对视时，两人视线连线构成"关系轴线"；所有机位必须停在轴线同一侧（180° 半圆内）。越轴 = 双方在剪辑后"看向同一个方向"，观众认知混乱。

**2. 显式锁定视线朝向（唯一根治手段）**：不写"看向对方"，写具体屏幕方向。

- A（左侧）：`profile view facing right, looking toward the right side of the screen`
- B（右侧）：`profile view facing left, looking toward the left side of the screen`
- 更精确（海螺官方）：`character gaze directed at off-screen position, 15 degrees camera-left` / `looking directly camera-right at eye level`

**3. 机位同侧 + 屏幕方向连续**：每镜写 `the camera stays on the same side of the axis` + `never cross the axis`；入场/退场/车辆行驶的左右方向在相邻镜间必须连续（`exits frame right → enters the next shot from frame left`）。

**4. 视线匹配（eyeline match）**：A 朝 screen-right 看，B 的镜头就必须朝 screen-left 看回来——两镜拼起来才算对视。

**5. 群体戏（三人以上）——本片五人码头戏的核心**：
- 三人以上轴线不止一条（A-B、B-C、A-C 三角形）；
- **先给一张 master wide（主全景）锚定所有人位置**；
- 任何时刻**只命名"当前活跃的一对"（active pair）**，这一对享受自己的轴线；
- **活跃配对一换，先回 master wide 重置观众地图，再切紧**。

**6. 四种"合法越轴"（只这四种，且必须显式声明，否则就是穿帮）**：
| 方式 | 写法 |
|---|---|
| 镜头扫过（sweep） | `the camera sweeps across the axis in one unbroken move` |
| 切中性镜（neutral） | 切一个正好在轴线上的镜头（正面/正背面），重置左右 |
| 切回全景（wide reset） | 从新一侧先给全景，再切近 |
| 有意越轴（剧情） | 情绪顶点/权力反转用，但必须配合中性镜或扫镜 |

**7. 与 H53 的衔接**：H53（朝向成对呼应）是 H55 的具体执行；H55 的"显式锁定视线方向"优先于 H53 的"朝向成对"——先写 `looking toward the right side of the screen`，再补朝向成对。

### 9.7 说话切近景 + 身边人局部 + 关键参照物（H56 · 竖屏多人对话的构图解）

> 来源：2026-11-19 用户定版。竖屏 9:16 塞不下五人同框，又不能频繁切镜（越轴/穿帮），解法是"说话人近景 + 身边人局部 + 关键参照物"。

- **说话人**：近景/特写，脸嘴清晰、口型同步。
- **身边人局部**：只露"身边人的局部"（肩 / 半张脸 / 一只手），不占主体、不占 `<Subject>` 标签，写成 `a softened shoulder at the frame edge` / `the out-of-focus back of ...`（与 §8.2 同源）。
- **关键参照物**：用说话人接触的物件锚定空间——推车把手、方向盘、车窗框、车头、桌面等，一句话带出（`one hand still on the luggage cart handle`）。
- **其他人**：不入画，但位置必须在正文写死（延续 §8.2 五条硬规则）。
- **禁止**：为了"全部出镜"而用大全景；为了"切给每个人"而频繁切镜。人不动、镜头动、切镜只切"当前活跃的一对"。

### 9.8 多排座车辆防"人跑后座"（H57 · 座位硬锁 + 本段不做什么）

> 来源：2026-11-19 用户真机——接驳车/观光车有多排座，H3 会把"坐副驾驶"的人自动安排到后座。

- **座位逐字锁死**：每个坐车里的人，写清 `sits in the DRIVER'S seat` / `sits in the FRONT PASSENGER seat`，并写**相对方位**（`on the left side of the shuttle, closest to <Subject X>`）。
- **显式写"后排空"**：`the rear seats are empty; no one sits in or appears in the rear seats`，每段 `detailed_description` 站位句 + 每个坐车镜的维持句都带一句。
- **用"本段不做什么"堵补戏**（§一模板）：每个人物条目结尾写 `and he does NOT move to the rear seats or get out of the shuttle in this segment`——比"他坐哪"更能定人，模型会主动补戏，要提前堵。

### 9.9 每段站位"沿用/同步修改"判据（H58 · 段与段的站位流转）

> 来源：2026-11-19 用户原话定版。写每一段前，先看"上一段结束时的站位"。

- **先列上一段段尾站位卡**（谁、姿势、朝向、手在哪、道具状态），再动笔写本段。
- **上一段无变动 → 沿用**：本段 `[Shot 1]` 把上一段末帧站位**逐字完整重述一遍**（H3 无记忆，禁写"同上/如前"，重述 ≠ 引用）。
- **上一段有变动 → 同步修改**：写清"谁从哪动到哪、怎么动的"（`walks from A to B`），不许凭空出现在新位置。
- **判据一句话**：站位以"上一段结束状态"为输入，逐段追踪——有变更新、没变沿用，绝不靠猜。
