# 物理真实律（Physics Realism）· 所有写实类项目强制

> 适用：**BASE_LIVE 真人写实**全类型（都市、年代、悬疑、犯罪、豪门、灾难、动作）。
> 性质：**P0 阻断级**。物理错 = 整镜作废，重写，不许"后期修"。
> 与站位锁、道具锁的关系：**物理在它们之前**。站位对、道具对、表情对，只要物理错，观众第一眼就出戏。

---

## 零、为什么必须先过这一关

H3 没有物理引擎，只有语言先验。

**你不写受力，它就按训练集里出现频率最高的姿态补。**
频率最高的姿态是什么？——**站着**。

所以以下写法全部会退化成"站着"：

| 你写的 | 模型画的 |
|---|---|
| `stands in the water` / `floats upright` | 站在齐胸深的水池里 |
| `is at the foot of the wall` | 直立贴墙，像贴在背景板上 |
| `he is on the horse` | 人马同框但无骑乘关系，人浮在马背上方 |
| `she holds the umbrella` | 伞悬在她手边，没有握持 |

**根本修法只有一条：把"接触的物理结果"写出来。** 不是写"他在水里"，是写"水到锁骨、腿悬空、衣在下坠"。

---

## 一、四问前置（写任何一镜之前，先答这四问）

```
① 谁托着他？    地面 / 水面 / 绳子 / 另一只手 / 车座 / 马鞍
② 谁在拉他？    重力 / 绳索张力 / 人力拖拽 / 水流 / 风力
③ 什么挡着他？  墙 / 船壳 / 桌沿 / 门框 / 另一个人的身体
④ 什么在拽他？  湿衣物 / 血 / 泥沙 / 背包 / 逆风
```

四问里**至少答出两个，并写进正文**。一个都答不出 = 这一镜是飘的。

### 1.1 介质判定表（先判介质，再查细则 —— 不要只盯着水）

不同的介质，翻车方式完全不同。**每一镜先判它属于哪一类，再去查对应小节**：

| 介质/类型 | 判据 | 必查小节 | 机检 |
|---|---|---|---|
| **水** | 海/河/湖/积水/雨中湿身，人可浸入 | 2.1 水体 | F01–F06 |
| **火与热** | 火、烟、爆炸、灼伤、高温 | 2.2 火与热 | G03 |
| **雨雪风** | 降雨、降雪、强风、沙尘 | 2.3 雨雪风 | G04 |
| **土/泥/沙/雪地** | 地面松软、有吸附、有脚印 | 3.3 介质阻力 | — |
| **载具** | 船/车/机/骑/电梯，自身在动 | 2.4 载具 + 2.4b | H37 / G05 |
| **打斗** | 推搡、拳脚、摔倒、被制 | 2.5 打斗 | — |
| **伤害与体液** | 出血、伤口、昏迷、溺水 | 2.6 伤害 | F11 |
| **医疗操作** | 听诊/输液/CPR/注射/清创/搬运 | **2.8 医疗** | G02 / G07 |
| **人群与背景** | 围观、走廊、集市、大远景人流 | **2.9 人群** | G06 |
| **承重与搬运** | 抬人、抬担架、抬重物、拖拽 | **2.10 承重** | G07 |
| **重力与悬空** | 任何"浮起来/悬在空中" | 3.1 / G01 | G01 |

**判定顺序不能跳**：介质错了，后面所有细节都白写。比如把"人在海里"判成"人在甲板上"，水位、受力、腿状态全都无从写起。

---

## 二、分介质规则表

### 2.1 水体（最高频翻车区）

#### ⚠️ 第一铁律：浸没语义压倒一切（2026-11-04 三次真机后定）

**英文 `hang` / `dangle` / `suspend` 的默认语义是「吊起来」。** 只要用这三个词形容人，模型就画出「脚沾水、身体吊在半空抓绳」——**你写多少遍 `the water at his collarbones` 都压不过它**。

三次真机，同一个病根换了三种姿势：

| 版本 | 当时写法 | 出片 |
|---|---|---|
| v2.1 | `floats upright` + `his chin clear of the water` | 站在齐胸水池里 |
| v2.2 | `hangs off the hawser` + `his weight pulls both arms straight` | 被整体吊到水面以上 |
| v2.3 | `hangs in the sea` + `legs hang free, feet dangling` | **仍吊在半空，脚只沾水** |

**结论：水镜里的人，禁用 `hang` / `dangling` / `suspended`，一个都不许有。**

| 禁写 | 改成 |
|---|---|
| `hangs in the sea` | `bobs half-submerged in the sea` |
| `stays suspended at the hull` | `stays half-submerged at the hull` |
| `hanging / bobbing` 混用 | 只留 `bobbing half-submerged` |
| `his legs hang free` | 见 §2.1b，**不能只换动词**：`his knees drawn up just under the surface` |
| `his feet dangling in open water` | 见 §2.1b：`his feet kicking slowly, water churning at his chest` |

**物件不受限**：绳可以 `the hawser hangs down from the gunwale`，头发可以 `hangs across her cheek`——只有**人和水同框**时才禁。

#### 四件套（缺一件就退化成站姿或吊姿）

| 件 | 写什么 | 句式 |
|---|---|---|
| ① 没入线 | 水到身体哪个部位 | `the water at his collarbones` |
| ② **浸没证据** | 水正在包围他的身体 | `waves washing around his shoulders` / `water breaking across his chest` |
| ③ **腿在干什么** | 姿态 + 动作 + 水面结果（**见 §2.1b**） | `his knees drawn up just under the surface, his feet kicking slowly` |
| ④ 衣物吸水 | 吸水后的重量与形态 | `the soaked jacket drags at his shoulders, its hem floating out` |

**② 是 2026-11-04 新增，也是前几次漏掉的那件。** 只有抽象坐标（锁骨）不够——必须给一个「水正在接触身体」的动作证据。没有它，模型没有「他被水包围」的凭据，就会把身体整个画到水面之上。

```
❌ the water at his collarbones（抽象坐标，模型可以无视）
✅ the water at his collarbones, waves washing around his shoulders（水在包围他，无法无视）
```

判据交给 `h3_finalcheck.py` F04：有腿但无浸没证据（`below the surface` / `beneath the water` / `waves washing around`）→ WARN。

#### 定义行锁一次，胜过镜行写十遍

`<Subject N>` 定义行是**跨镜最高权重**。定义行只写长相、不写「他在水里」，每一镜都要靠局部描写硬撑——撑不住。

```
❌ <Subject 1> is …: short gray-black hair, a square jaw, a dark soaked jacket collar.
✅ <Subject 1> is …: short gray-black hair, a square jaw, a dark soaked jacket collar,
   half-submerged in the grey sea, the sea water washing at his chest and shoulders.
```

**人在水里的段落，定义行必须带 `half-submerged`。**

判据：`h3_finalcheck.py` **F12**——水镜里人物出现 `hang / dangle / suspend` → FAIL（物件自动豁免）。

**水中五禁**

| 禁写 | 为什么错 | 改成 |
|---|---|---|
| `stands in the water` | 直立＝脚踩底＝水深只到胸口 | `his body hangs almost vertical off the rope, tipped back by the drag` |
| `floats upright` | 同上，且"浮"没有姿态信息 | 四件套全写 |
| `his chin clear of the water`（**单独出现**） | 只交代下巴，其余部位下落不明 | 必须与没入线同句 |
| 手抓**岸上/甲板**的栏杆 | 人在水面，栏杆在 2 米以上，臂长不够 | 只抓垂到水面的东西：绳、抛下的救生索、舷窗沿、救生圈、另一只手 |
| `the wave slams down on him` | 浪是**水位升降 + 横向推挤**，不从天上砸 | `the swell lifts him a hand's width and sets him back against the steel` |

**补两条真机经验**

- **浪的方向写"撞击点名 + 爆开结果"，不写高度**。写 `bursting upward around his chest` 成立；写 `a wall of water three metres high` 会被画成海啸。
- **身体出水必须分镜**。抓绳 → 引体 → 脚踏壁 → 翻上沿，一镜只走一步。一镜写完"他爬上来了"必出瞬移。

#### ⚠️ 这个坑有两层，只修第一层还是翻（2026-11-04 二次 + 三次真机）

**第一层：受力语义互斥。** 写 `hangs off the hawser` + `his weight pulls both arms straight above his fists` + `the water at his collarbones`，三条同时写，模型无法同时满足：

- 「全身重量吊在绳上」→ 物理上是**被提离水面**
- 「水到锁骨」→ 物理上是**浸在水里**

模型选前者：人整条被提到水面以上，脚只沾水。**这一层的修法是「绳只保头，不提人」**：

| 错误（吊离水面） | 正确（绳只保头） |
|---|---|
| `hangs off the hawser` | 见第二层，连 `hangs` 都不能用 |
| `his weight pulls both arms straight above his fists` | `both hands up on the hawser` |
| `the hawser hangs straight down the hull side` | `the hawser comes out of the water above his head into both fists` |
| （无） | `it holds only his chin above the surface` |

**第二层：`hang` 这个词本身就是陷阱。** 修完第一层后写 `hangs in the sea`，出片**仍然吊在半空**——因为 `hang` 在英文里的默认语义就是「吊」，模型先服从动词，再谈你给的水位。**这一层只能靠换词解决**：`bobs half-submerged`。

**口诀两条**：
1. 绳要「从水里出来」，不能「从天上垂下来」（管受力）
2. 人**不 hang、不 dangle、不 suspend**（管语义）—— 两条都做到才不翻

#### 水位锚定法（比身体部位更可靠）

只写 `the water at his collarbones` 是抽象坐标，模型容易偏。**再挂一个场景参照物**，模型就有了可对位画的实体：

```
the water at his collarbones, the lowest portholes half drowned behind him
the water at the second rung of the boarding ladder
the water sitting just under the mooring cleat
the water at her waist, the lifebuoy floating at her elbow
```

参照物必须是**场景里已有的东西**（舷窗、梯级、系缆桩、救生圈），不能临时造一个。

### 2.1b 深水不画腿，浅水才画腿（★ 2026-11-04 五次真机后定 · R5.2e）

**用户判定（原话）**：「要不就看不见腿——水面深就看不见，水面浅就可以站在里面，水浅就可以在里面飘着。基本不会出现坐在深水里面。」

用一句话概括成规则：**腿可不可见，由水位决定，不由你怎么写决定。**

| 水位 | 腿的可信状态 | 写不写 | 写法 |
|---|---|---|---|
| 到锁骨 / 下巴（**深水**） | **看不见**（水浊 + 折射，膝在水面下半米） | **不写** | `the sea deep and black beneath him` |
| 到胸 / 腋下（过渡） | 膝部一团浅影 | 写，但只写膝 | `his knees drawn up just under the surface, his feet kicking` |
| 到腰（**浅水**） | 站得住 | 可写站 | `his feet on the bottom, the water at his waist` |
| 到膝 / 小腿 | 正常站水里 | 照常写 | 无需特殊处理 |

#### 铁律：深水里写「腿在哪」，一定翻车

五个版本，一路踩过来：

| 版本 | 写法 | 出片 |
|---|---|---|
| v2.1 | `floats upright` + `chin clear of the water` | 站齐胸水池 |
| v2.2 | `hangs off` + `weight pulls both arms straight` | 整体吊到水面以上 |
| v2.3 | `hangs in the sea` + `legs hang free, feet dangling` | 仍吊半空 |
| v2.1.5 | `legs trailing below the surface, feet drifting` | **身体入水对了，腿却笔直垂到画面底部，脚在 2 米深** |
| v2.1.6 | 深水镜不写腿，只写 `the sea deep and black beneath him` | 通过 |

**为什么「写清楚」反而更糟**：水到锁骨时，膝盖在水面下约 50 厘米，被水体和折射吃掉，画面里根本不可能有清晰的腿。模型拿到「腿在哪」的指令，只能自己编一个——编出来的默认值就是**双腿垂直下垂**（吊着的人、站在深水里的人，都是这个姿态）。

#### 两条铁律

1. **深水（水位到胸以上）不写腿的具体位置。** 改写成「承认看不见」：`the sea deep and black beneath him`。这一句同时交代了三个信息——水很深、他浮着、脚下没有支撑。
2. **`below the surface` / `beneath the water` 不能用来形容腿。** 这是深度暗示词，用在腿上＝把腿往深处送。要写浅层就写 `just under the surface`。

#### 想要腿有戏，必须先把水位降下来

这是导演层取舍，不是文字层能解决的：

| 想要的画面 | 水位上限 | 备注 |
|---|---|---|
| 踩水（膝抬、脚蹬、水花） | **胸口以下** | 水到锁骨时踩水看不见，写了也没用 |
| 蹬船壳借力上爬 | 胸口 | 膝要能顶到钢板 |
| 被绳拖着走 | 胸口以下 | 身体倾斜 + 脚向后蹬 + 胸前白浪 |
| 力竭下沉 | 锁骨以上 | 这时**不写腿**，只写水面盖过下巴 |

#### 三种场景的直接写法

| 场景 | 句式 |
|---|---|
| 深水抓绳（水位到锁骨） | `bobs half-submerged, the water at his collarbones, the sea deep and black beneath him, water churning at his chest` |
| 浅水踩水（水位到胸） | `the water at his chest, his knees drawn up just under the surface, his feet kicking` |
| 被绳拖着走 | `his body tilted in toward the hull, his feet kicking back against the water`（不给腿定深浅） |

#### 禁写：坐在深水里

深水里没有可坐的东西（没有支撑面），写坐姿模型只能画成悬空坐着。要表现力竭，用**下沉**：`only his forehead and both fists above the surface`。

判据：`h3_finalcheck.py` **F13** —— 腿句里出现 `below the surface`/`beneath the water` → FAIL（深度暗示）；有腿但无屈膝/蹬水 → WARN。深水镜不写腿但写了 `deep and black`/`bottom out of sight` → F04 豁免。

### 2.2 火与热

| 要有 | 写法 |
|---|---|
| 热辐射的距离感 | `he turns his face away and his forearm comes up against the heat` |
| 烟的方向 = 热对流方向 | 室内火：烟贴天花板横铺；室外：烟顺风斜升 |
| 灼伤的即时反应 | 皮肤先红后起泡，**不出现即时焦黑**（那是后期） |
| 灭火后的状态 | 水渍、黑灰、焦味对应的可见残留：`his sleeve black at the cuff, the fabric stiff` |

**禁**：火焰围着人转圈、火不烧衣服只烧背景、烟水平匀速推进（烟一定受热浮力影响）。

### 2.3 雨雪风

| 介质 | 必须写的物理 |
|---|---|
| 雨 | 雨向 = 风向；打在人身上要写**浸透程度**（`his shirt dark across the shoulders`），不是"淋湿了" |
| 雪 | 落在肩头会**积**、落在皮肤上会**化**；呼气成白雾；脚下雪会**响**（`the snow crunches under his shoe`） |
| 风 | 风只对**轻物**有效：头发、衣摆、纸、烟、雨丝。写 `her hair whips across her mouth`，不写"风很大" |

**禁**：雨垂直落但头发横飞（方向矛盾）；雪落在人身上不积不留。

### 2.4 载具（车、船、马、电梯、摩托）

| 载体 | 必写 |
|---|---|
| 行驶中的车 | 车身动作传递到人：`the car takes a corner and his shoulder rocks against the door` |
| 倾斜的船 | 人必须**主动对抗倾斜**：`he braces his foot against the deck edge and his weight goes onto his back leg` |
| 马车/牛车 | 颠簸是**低频大振幅**；人不扶会滑 |
| 马 | 骑乘是**三点接触**（两腿夹 + 一手持缰）；不写接触＝人马分离 |
| 电梯/扶梯 | 启动与停止有**惯性**：`the lift starts and his weight sinks a beat, then comes back` |

**禁**：车在转弯人纹丝不动；船横倾 15 度人还站得笔直。

#### 2.4b 载具本身也要写运动与交互（2026-11-04 真机 · H37）

**只写载具的静态几何 = 模型给你一台停泊的模型船、一辆悬空的车。** 载具作为 `<Subject N>` 时：

| 项 | 必写 | 漏了会怎样 |
|---|---|---|
| 运动状态 | `dead in the water` / `under power` / `adrift` / `parked` / `at the kerb` / `idling` | 船不知道在走还是停，车不知道动不动 |
| 介质交互（**水上强制**） | `a long grey swell running past` / `white water breaking along her waterline` / `bow wave` / `wake` / `spray` | 海面被画成**镜面死水**，船像摆在游泳池里 |
| 人的对抗或跟随 | 船横倾时人找平衡、起步时重心后沉 | 人像贴在载具上 |

```
❌ a white cruise ship heeled fifteen degrees to port, her wet side deck sloping …（只有几何）
✅ a white cruise ship dead in the water and rolling slowly on a long grey swell,
   heeled fifteen degrees to port, white water breaking along her waterline, …
```

判定交给机检 **H37**：水上载具定义行无 `swell / bow wave / white water / spray / wake` → WARN；地面载具无 `parked / at the kerb / idling` → WARN；全稿有船却无海况词 → 追加 WARN。

### 2.5 打斗与暴力

| 项 | 正确物理 |
|---|---|
| 出拳 | 力从脚起、经腰转、肩送；被打者**头先动、身体后跟**，不是整个人平移 |
| 挨打 | 打击点局部凹陷 + 颈部被动甩动；重击后有**短暂失衡**（`his heel catches the step behind him`） |
| 推搡 | 推的人自己也会往前送半步（作用力） |
| 倒地 | 先膝、再髋、再肩，有**缓冲次序**；不许整个人水平落地 |
| 掐脖 | 被掐者下颌被迫上抬、发声受限（只出气音） |

**禁**：拳头到位但人不动；打完后衣服头发整齐；多人围殴时只有主角在动。

### 2.6 伤害与体液

| 项 | 正确物理 |
|---|---|
| 出血 | 顺着重力流，有**路径**（`blood runs from his hairline down past his ear`）；不出现无来源的胸口血斑 |
| 时间 | 血会**凝**（由鲜红转暗、边缘结痂）；不许一镜之内从鲜红跳成干涸 |
| 湿衣 | 湿的地方**颜色深、贴身**；干燥由边缘向内退 |
| 溺水 | 手松开后**身体下沉**，不是原地浮着 |
| 昏迷 | 失去支撑力，**身体先塌**，不是先闭眼 |

### 2.7 时间不可逆律（跨镜一致性）

同一场戏内，以下状态**只许单向演进**：

```
干 → 湿 → 湿透 → 半干（且必须有热源/时间理由）
完好 → 磨损 → 破口 → 断裂
整洁 → 沾污 → 沾血
站 → 跪 → 倒地 → 不起
站起 → 坐起 → 撑肘 → 平躺（反向：平躺 → 撑肘 → 扶物 → 站立）
```

**回退即为穿帮。** 上一镜已断的绳不能再承重；上一镜已湿透的衣不能下一镜变干。

### 2.8 医疗与器械操作（★ 医疗题材核心 · 2026-11-04 增补）

医疗剧的翻车方式和动作戏不同：**动作错了观众不会立刻发现，操作错了懂行的一眼就出戏**。

| 操作 | 必写（物理正确） | 常见错误 |
|---|---|---|
| 听诊 | **贴皮肤**：解开衣扣、听诊器金属面直接贴上胸壁 | 隔着衬衫/外套听（`over his shirt` 是硬错误） |
| 输液 | 输液袋**必须高于穿刺点**（重力滴注）；管内有液柱 | 袋子挂在床沿、低于手臂（液体不会往上流） |
| 心肺复苏 | 双手交叠压在**胸骨下半段**、双臂伸直、靠上身重量下压；有回弹 | 手按在左胸/腹部；弯着胳膊按 |
| 测血压 | 袖带绑在上臂、与心脏同高、听诊器放在肘窝肱动脉 | 袖带绑在小臂；无袖带直接报数值 |
| 注射 | 有针头、有药液、排气；进针角度可见 | 空手比划、器械消失 |
| 止血 | 直接压迫/加压包扎/止血带在**近心端**；有血迹渗透过程 | 一按就干净；止血带绑在远心端 |
| 搬运伤员 | 疑似脊柱伤用**硬板/平托**；一人抬不起成年人 | 一个人抱起就走（见 2.10） |
| 重伤者体态 | 失血/休克者**平躺、腿略抬**；不会自己利索坐起 | 重伤后直接坐直说话 |
| 无菌 | 手术/清创有手套、器械盘、铺巾 | 徒手伸进伤口 |

**写作公式**：`器械名 + 接触位置 + 接触结果`，三件缺一，模型就自由发挥。

```
❌ he listens to his chest
✅ he bares the chest, sets the cold bell of the stethoscope on the skin below the left nipple, and holds still
```

机检 `G02` 兜底：隔衣听诊 / 输液袋低于病人 → WARN；CPR 无按压位置、重伤者无支撑坐起 → WARN。

### 2.9 人群与背景（活人感 · 不是蜡像）

| 场景 | 必写 |
|---|---|
| 围观/走廊/集市 | 至少一个具体小动作：`a woman at the back turns her head`、`a man steps back to let them through` |
| 大远景人群 | 分**三层**：前景有人走过、中景有人停步、后景人流在动 |
| 死亡/肃穆场面 | 允许静止，但要给一个**微动**（风吹衣角、有人低头） |

**禁**：`the crowd stands completely still` / `like statues` / `everyone frozen` —— 全体静止＝贴图。
机检 `G06`。

### 2.10 承重与搬运（力气要有出处）

| 动作 | 物理约束 |
|---|---|
| 抬成年人 | 至少两人，或一人用消防抱/背负；**单人公主抱成年人走楼梯**现实中做不稳 |
| 抬担架 | 两人前后、步频一致；转弯时外侧的人放慢 |
| 抬重物 | 屈膝用腿，不是弯腰用背；重物贴身 |
| 拖拽 | 有摩擦、有重量、有拖痕；被拖者身体贴地 |

机检 `G07`：单人抬成年人无第二人/担架/抱法 → WARN。

---

## 三、三条通用铁律

### 3.1 支撑面律 —— 手扶的东西必须在臂长内

任何"手扶/手抓/手撑/靠"，先算距离：

```
✅ 岸上：her hand hooked over the white steel rail（栏杆在她身前）
✅ 水中：his fingers hooked into the rim of a round brass porthole（舷窗在胸侧）
❌ 水中：one hand hooked over a lower rail（甲板栏杆在水面上两米）
❌ 车内：he puts his hand on the roof（坐着够不到车顶）
```

**推论**：要让人抓住高处的东西，得先给他**够得着的中继**（绳、垂下的布、台阶、另一个人的手）。

### 3.1b 环境归属律 —— 特写也要写"他背后是什么"

**支撑面律管"脚下/手上"，这条管"背后"。** 特写、近景最容易翻车：只写人物表情和视线，背景交给模型自由填，它会填最近的高频背景——天空、海、纯色。结果人物像**抠图贴在背景板上**。

2026-11-04 真机：甲板上的老太太特写，背景全是海，观感是「她站在船外面／浮在海面上」。

| 错误 | 正确 |
|---|---|
| `she stands at the railing, her eyes on the water below`（背景无交代） | `at the railing, the wet deck boards behind her shoulder, her eyes on the water below` |
| `he looks out`（背景无交代） | `the wet deck boards behind his shoulder` / `the white steel rail crossing the near lower frame` / `the cabin wall behind him` |

**判据一句话：除纯空镜外，任何人物镜都要能回答"他背后三米内是什么"。** 答不出，就补一句实体（甲板、栏杆、门框、墙、车座、树）。

### 3.2 力成对律 —— 只写一端就是飘

| 只写一端 | 两端都写 |
|---|---|
| 他把绳拉紧了 | `his two arms pull down on the rope and his shoulders rise with the load` |
| 浪打在他身上 | `the swell drives him back and the hull stops him, his shoulder flattened on the steel` |
| 她推开门 | `she pushes the door and her weight follows it forward` |
| 他扛起麻袋 | `his knees straighten first and his back stays flat, the sack riding up on his shoulder` |

### 3.3 介质阻力律 —— 不同介质不同速度

```
空气：正常速度
水：慢半拍，带拖尾（`his arm comes up through the water slowly, trailing a sheet of water`）
泥/雪/沙：抬脚有吸附感（`the mud pulls at his boot before it comes free`）
烟/雾：只影响可见度，不影响速度
```

**禁**：水中做陆上速度的动作；水下头发不飘。

### 3.4 失温与体液必须有后果

冷 + 湿 + 长时间，身体一定给信号。不给 = 假人。

```
his lips gone grey-blue, his jaw juddering between words
water runs into his mouth and he turns his head to spit it out
salt drying white in the creases of his neck
his fingers stiff and slow to close
```

---

### 3.5 持物一致性律 —— 图片锁外形，文字锁拿法（★ 2026-11-04 用户判定）

参考图能锁住道具的**外形**（材质 / 颜色 / 粗细 / 磨损），**锁不住拿法**（哪只手、手多高、朝哪个方向）。拿法只能靠文字，而且必须全片用同一句。

**四要素**：`哪只手 + 握在哪 + 手的高度 + 道具朝向`

```
✅ his fists stacked at his chest on the hawser, the hawser coming straight down the hull into them
❌ both arms up on the hawser        （→ 手举过头顶、绳斜横，和上一段接不上）
```

**铁律**
1. 同一人物 + 同一道具，**全片只有一种拿法**（15 秒内不会换手，跨段更不会）。
2. **段首镜与段末镜必须复述持物句**——接缝处靠上下文救不回来。
3. **高举过头 ≠ 胸前叠握，不许混用**。水位到锁骨的人双手举过头顶还浮着，本身违反 §2.1b。

判据：`h3_lint.py` **H38**。

## 四、把物理写进镜行的位置

物理句**不进机位区，进画面事实区**（分号之后）：

```
[Shot 3] Low wide shot, 30-degree low angle, the camera holds still;
<Subject 1> bobs half-submerged at the hull, the water at his collarbones;  ← 没入线 + 禁 hang
both hands up on the hawser, its load only holding his chin clear;        ← 受力点（绳只保头，不提人）
his legs trailing below the surface, his feet drifting;                   ← 腿在水下（禁 hang / dangling）
the hawser stays taut.                                                   ← 维持句
```

**词数预算**：物理三句约 25–30 词。单镜上限 **85 词**（>100 才丢指令），机位区压到 20 词内、人物动作压到 20 词内即可。**物理不够，先砍机位修饰，不砍物理。**

---

## 四之二、压词优先级（词数超标时删什么、绝不删什么）

> 2026-11-04 用户实判：**为了压词数去删物理约束，画面崩得比超词更狠。**
> 词数是为了「不丢指令」，不是为了「写得短」。压错地方 = 用格式合规换真机翻车。

### 禁删（删了画面就崩）

| 类别 | 例子 |
|---|---|
| **物理四件套** | 没入线（`the water at his collarbones`）· 受力点（`both hands up on the hawser`）· 腿在水下（`legs trailing below the surface, feet drifting`）· 浸没证据（`waves washing around his shoulders`）· 衣物吸水 |
| **道具几何句** | 系缆桩 → 舷墙 → 垂船侧 → 穿双手 → 入水（五环少一环，绳就悬空） |
| **站位锚点** | 位置词、`in the same place`、同框分左右 |
| **维持句** | `stays fixed / stays taut / stays at`（H24 白名单） |
| **承载与接触部位** | 手指扣舷窗沿、脚踩湿甲板、背靠舱壁 |
| **台词与音色标签** | `<d>[Chinese]…</d>`、`(Sx)` |
| **载具运动 + 介质交互** | `rolling on a long grey swell`、`white water breaking along her waterline`（H37） |

### 优先删（删了不崩）

1. **形容词副词**：`slowly` / `hard` / `completely` / `very` / `a little`
2. **运镜冗余**：重复的 `the camera`、滑轨厘米数（`slides forward 30 cm over two seconds` → `pushes in`）
3. **段首已交代过的信息**：光位、色板、空气介质不必在镜行复述
4. **Subject 定义已承担的静态外观**：船体定义里写了 `row of brass portholes`，镜行就不必再写「舷窗半淹」
5. **次要背景动作**：人群小动作可减到只剩一个（**至少留一个**，否则 G06 人群僵死）

### 判断口诀

**删「怎么好看」，不删「怎么成立」。**

一句话自查：删掉这半句，观众会不会问「他凭什么能在那儿」？会问 → 不许删。

---

## 五、交付前物理 17 问

**先过介质判定（1），再逐介质查（2–8），最后过通用现实性（9–16）。**

1. **这一镜的介质判对了吗？**（水 / 火 / 雨雪 / 泥雪 / 载具 / 打斗 / 伤害 / 医疗 / 人群 / 承重——见 §1.1 表）
2. 水/雨/雪/泥里的人，**没入线**写了吗？
3. 手抓的东西，在他**臂长**范围内吗？
4. 推与反推、拉与被拉，**两端**都写了吗？
5. 这个动作在真人身体上**做得出来**吗（力量、速度、关节角度）？
6. 载具在动时，人体有**对抗或跟随**吗？
7. 湿/脏/伤/破的状态，比上一镜**只往前**走了吗？
8. 温差与浸泡的生理后果写了吗（唇色、颤抖、僵硬）？
9. 介质正确吗（水中慢半拍、烟中不加速、雪上有声）？
10. **水里/空中的人，是不是被写成"吊离水面／悬在地面之上"？**（`hangs off the rope` + `arms pulled straight` = 一定飞起来）
11. **每个人物镜"他背后三米内是什么"写了吗？**（不写背景，人就是抠图贴在海上）
12. **医疗操作对了吗？**（听诊贴皮肤、输液袋高于穿刺点、按压在胸骨、重伤者不直接坐起）
13. **有没有东西凭空悬着？**（`floats in the air` / `hovers` 无托举者）
14. **火与烟的方向对吗？**（烟向上或横向铺开，不下沉；灼伤先红后起泡，不瞬间炭化）
15. **雨雪有没有作用在人身上？**（雨打湿、雪落在肩，不是落在玻璃外面）
16. **承重够吗？人群活吗？**（单人抬不动成年人；围观人群至少一个具体小动作）
17. **关键道具的接触点在这一镜可见吗？**（绳在手里、刀在手上、人扶着栏）——为了"姿势好看"把它写没了，就是 §3.6

十七问全"是"才许提交。任一"否"，回改该镜，不许靠种子多跑几次碰运气。

---

## 六、真机事故档（不许重犯）

| 事故 | 根因 | 条款 |
|---|---|---|
| **人站在海里**（《你说我能扛》段1–8） | 只写 `floats upright against the hull`，无没入线/无腿/无受力 | §2.1 四件套 |
| **水中人抓着甲板栏杆** | 支撑面超出臂长 | §3.1 |
| 浪从船顶翻下来 | 写了高度与 `slams down`，没写撞击点 | §2.1 |
| 道具悬浮半空（锅/杯/手机） | 首现未写支撑面 | §3.1（另见 H22） |
| 人凭空出现（浪过后） | 遮挡前后未写"散去后人还在原地" | 站位锁 R1.4 |
| 一镜之内从鲜红到大面积干血 | 违反时间不可逆 | §2.7 |
| 车转弯人纹丝不动 | 未写惯性传递 | §2.4 |
| 骑乘人马分离 | 未写三点接触 | §2.4 |
