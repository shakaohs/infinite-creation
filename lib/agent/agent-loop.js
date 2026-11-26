import { Chapters, ReferenceImages, buildNovelContextBlock, isValidNovelStep } from '../core/index.js';
import { filterReferenceImages, SKILL_PIPELINE_NODES, STYLE_PRESETS, imageSizeFor } from '../shared/index.js';
import { loadSkill, listSkills } from './skill-engine.js';
import { targetChapterIdSet } from './tools.js';

export const REFERENCE_INSTRUCTION = `

【参考图片素材】用户本次上传了参考图片素材。请先用视觉能力逐张分析这些参考图的内容、画面风格、角色/场景/道具等元素，然后用 generate_asset_from_reference（图生图/i2i）以这些参考图为输入派生风格/设定一致的新素材（角色/场景/道具/服装等），而不是一律文生图。这些参考图仅作「生成新素材的参考」，不要把它们直接当成品素材使用，而是据此派生新素材。`;

// 拆分镜阶段不再内联精简铁律——改为强制 Agent 按 skill 自带的「规则库索引」加载完整规范再写。
// 用户要求：「调用 skill 去写、有依照地写、不要只依照一部分」——即 skill() 加载全文 +
// skill_reference() 按索引读对应 references，逐条对照，禁止凭记忆/速查片段落笔。
export function storyboardAuthoringInstruction(videoModel) {
  if (String(videoModel || 'h3').startsWith('seedance')) {
    // 段长按版本分档（这是两套不同的硬规格，不能共用 15s）：
    //   2.5 → API duration=4~30，官方要求默认 25–30 吃满上限、减少段数与段缝，不要拆成 16–24 碎段
    //   2.0 → 单次生成上限 15s
    const is25 = String(videoModel || '') === 'seedance25';
    const segLen = is25
      ? 'durationSec 4–30 整数（**默认 25–30 秒吃满上限**，减少段数与段缝；禁止拆成 16–24 秒的碎段；低于 12 秒只能用于打戏快切或衔接段，并写明理由）'
      : 'durationSec 4–15 整数（2.0 单次生成上限 15 秒）';
    const segRule = is25
      ? '结构机检会核对：单段 4–30s（主体段应为 25–30s）、每镜必须有 characters、连续两镜不许同景别同机位、每镜必须归属某段节拍。'
      : '结构机检会核对：单段 4–15s、每镜必须有 characters、连续两镜不许同景别同机位、每镜必须归属某段节拍。';
    return [
      '【拆分镜 · 按「漫剧老李全流程」（short-drama-director）执行，禁止凭记忆或片段落笔】跳步会被门禁直接拒绝写入，顺序不可调换：',
      '① skill("short-drama-director") 加载老李全流程执行入口（含五道锁取值规则、阶段映射、覆盖声明与必读清单）。',
      '② 文戏先 skill("sd-storyboard-engine")；本镜若涉及打斗/群战，按打戏三档再深入：真人写实克制→sd-real-engine、通用武侠→sd-combat-engine、玄幻仙侠→sd-xuanhuan-engine。',
      '③ 用 skill_reference 逐个读完必读规则（缺一个 set_storyboard 会拒绝）：camera-specs-15rules.md（镜头五要素+景别阶梯）、blocking-direction.md（站位/权力几何/依托物）、spatial-reference-system-V3.md（空间坐标）、segment-splicing.md（段缝衔接）、dialogue-speed-check.md（语速自检）、camera-transitions-6types.md（转场六型）。打戏另必读 skill_reference(name="sd-combat-engine", ref="tier-and-finisher-system.md") 与 ref="combat-iron-laws.md"；群像/光影再补读 short-drama-director 的 crowd-behavior-direction.md / lighting-and-antifake.md。',
      '④ 定锁并调 set_storyboard_plan 落盘：mode（有参考图选 Ref2VA）、aspect（取项目锁卡，全片唯一，禁 auto）、base（按画风基底）、assetMode（固定 M2：框架资产图已在库）、seam（tail_frame / hard_cut / empty_shot，取项目段缝锁）、anchors（positions 站位表必填：每人在本段的位置、朝向与依托物）。',
      '⑤ 画情绪节拍曲线 + 排拆段表（写进 plan.beats）：每段 emotion + type（紧张上升/爆发/留白/凝固）+ intensity 1–10 + ' + segLen + ' + shotRange（如 "1-3"）+ beatFunction（钩子/递进/反转/收束）。shotRange 必须从镜 1 连续覆盖；按情绪节拍拆段、不按字数拆；一段里不许塞两个反转；接缝两侧强制换机位或换景别。',
      '⑥ 按节拍写逐段镜行 camera / visual / sub_shots / dialogue / blocking，再调 set_storyboard。Seedance 线镜行写【中文栏位】：camera = 景别+焦段+机位角度+运镜（五要素写全），visual = 人与物的可见状态与动作，sub_shots = 段内切点时间轴；镜长由剧情倒推、禁等分。' + segRule,
      '⑥-补零 【每段必须写 blocking（段首站位声明）· 不写=站位必然漂】blocking 是这个生成段唯一的方位权威，投喂阶段会原样沿用，所以必须在分镜阶段就写死：一行式，每人一段括号写六要素——位置（画面左/中/右）+ 依托物（场景里的固定物）+ 身后背景物 + 朝向 + 姿态 + 手头事务；收尾写「轴线锁定：A 在左、B 在右，机位恒定在两人连线×侧，全段禁越轴；位移仅限：…（无位移就写「全员原位」）」。三条硬口径：① 一个分镜只写一次，镜行（sub_shots）里**禁止再复述谁在画面左/右**（重复发位会让模型按镜行重新布局，这正是「东一个西一个」的病根）；② 位置优先用依托物锚定（「背靠金属护栏」「长桌西侧」），比裸写「画面左」稳；③ 同场景前后两段必须保持同一套左右关系，换边必须有剧情走位理由并写清路径。',
      '⑥-补 【老李九字段 → 流水线字段 的落位，必须逐项写，不许省】sd-storyboard-engine 的单镜模板是九字段（场景/画面内容/状态/光影/色调/台词/重音/人声/音效），流水线只有 camera/visual/sub_shots/dialogue 四个文本栏，映射固定如下（写错栏=投喂阶段拿不到来源）：camera ← 景别｜焦段｜机位角度｜运镜；visual ← 第一行「画面：{画面内容}」，随后按顺序写「状态：{进镜姿态与持物} → {出镜姿态与持物}（无变化写 —）」「光影：{光位/光比/光向}」「色调：{色调名}，高光#{色值}，阴影#{色值}，色温{数值}K」「重音：{本镜最重的一个字/词}」「人声：{台词之外的表演性人声，无则 —}」「音效：{环境音+动作音，有音桥标音桥入/出}」；sub_shots ← 每个切点一行「起-止s 景别｜机位｜动作」；dialogue ← `人物名：台词` 原文，一字不改。**九字段一个都不能省**（无内容写 —），否则投喂稿的【画幅风格】【音效】栏没有来源，只能让模型自选光色。',
      (is25 ? '⑥-补二 【段与子镜的关系】一个分镜 = 一个生成段（25–30s），段内切点全部写进 sub_shots，**不要把一个子镜单独占一个分镜**——按子镜拆段会让段数翻几倍、段缝风险成倍上升（这正是 2.5 用 30s 上限要解决的问题）。子镜行数按「每镜 2.5–7.5 秒」算：25–30s 段写 4–13 行都合规（把真实分镜表里 5–6 个 4–6s 的镜头合并成一段，就写 5–6 行，不许为了凑数硬切碎），超出才会被判密度不匹配；投喂层 C2 另有「时间轴镜头数 ≤ 段长÷3」的上限（30s→10 镜），镜头多于此值时投喂阶段要合并相邻镜头。' : '') + '',
      '⑦ 写完按老李的判据逐项自查（站位与依托物段内不跳变、台词 ≤3.5 字/秒、单镜 ≤2 人开口、段缝方式全片一致、转场是否有叙事意图）；门禁 FAIL 就按报错改，不要硬提交——分镜结构一旦入库，提示词阶段救不回来。',
    ].join('\n');
  }
  return [
    '【拆分镜 · 按「H3 全流程」（forest-laoli-h3）执行，禁止凭记忆或片段落笔】跳步会被门禁直接拒绝写入，顺序不可调换：',
    '① skill("forest-laoli-h3") 加载 H3 全流程技能全文（G0 锁 → ①剧本 → ②资产 → ③分镜 → ④编译 → ⑤清洗机检 → ⑥交付 → ⑦收尾复检）。',
    '② 紧接着 skill_reference(name="forest-laoli-h3", ref="00-framework-adapter.md")：这是本框架追加的适配层，说明哪几段在流水线内生效、哪些交互门作废、字段怎么映射——必须先读，避免照抄「停下询问用户/跑脚本/剥壳投递」这类本框架不执行的条款。',
    '③ 再用 skill_reference 逐个读完必读规则（缺一个 set_storyboard 会拒绝）：pipeline.md（G0 六项锁 + 拆段实操 + 标准产出顺序）、camera-four-axis-h3.md（八档四轴+回合制切镜+神态双挂+状态账）、h3-shot-grammar.md（运镜/越轴/站位三件套）、spatial-anchor-and-hold.md（空间锚点+维持句+H50-H58）、dialogue-density.md（台词 3.3 字/秒 + 填充率 80–90%）、checklist.md（十组必查）、h3-constraints-qc.md（H1–H38 对照）。写表演/物理/氛围再按索引补读 acting-facs / acting-recipes / acting-listen、physics-realism.md、atmosphere-and-light.md。',
    '④ 定 G0 六项锁并调 set_storyboard_plan 落盘：mode（短剧默认 Ref2VA）、aspect（取项目锁卡，全片唯一，禁 auto）、base（BASE_LIVE/BASE_ANIME/BASE_2D/BASE_INK）、assetMode（固定 M2：框架资产图已在库）、seam（tail_frame / hard_cut / empty_shot）、anchors（furniture 家具清单 + positions 站位表必填 + directions 统一方位词 + doors 门窗初始开闭态）。',
    '⑤ 画情绪节拍曲线 + 排拆段表（写进 plan.beats，这是后面运镜速度/留白/段缝的唯一依据）：每段 emotion + type（紧张上升/爆发/留白/凝固）+ intensity 1–10 + durationSec 4–15 整数 + shotRange + beatFunction（钩子/递进/反转/收束）。一个节拍=一次情绪变化或一次信息揭示；一段里不许塞两个反转。',
    '⑥ 按节拍写逐段镜行 camera / visual / sub_shots / dialogue，再调 set_storyboard。结构机检会核对：单段 4–15s、每镜必须有 characters、连续两镜不许同景别同机位、每镜必须归属某段节拍、镜数与时长密度匹配（4s→1–2 镜、8s→2–4、12s→3–5、15s→4–6）。',
    '⑦ 语言铁律：camera / visual / sub_shots 必须【全英文】——剧本是中文也要翻译成英文画面语言（H3 只吃英文视觉词）；只有 dialogue 台词保留中文。',
    '⑧ 跨镜锁定门禁（逐镜必过）：按 h3-shot-grammar.md §1.16/§四、h3-format.md「跨镜锁定自检清单」与 spatial-anchor-and-hold.md §8 逐镜核对——换人必换机位或景别；人数场景不变的固定站位戏，全员从 [Shot 1] 在场、站位锁死、切镜只切机位/景别/看向谁，换视角把其他人写成无 <Subject> 标签的虚化肩背/后影 + 站位锁死句，严禁为过机检硬写入画/退场动作（只有剧情真有人来/走才写）；时间戳只标切点、单镜 ≤100 词、同框带标签主体 ≤2 人。',
    '⑨ 写完后按 checklist.md 的 P物理 / A锁定 / B图槽 / C格式 / D镜头 / E空间 / F表演 / G声音 / H词根 / I交付 十组逐项自查；门禁 FAIL 就按报错改，不要硬提交。',
  ].join('\n');
}

// 构造用户任务提示词（内置 Agent 与外部 Agent 共用，保证续跑语义一致）
export function buildTaskPrompt(ctx) {
  let chapters = Chapters.list(ctx.projectId).map((c) => ({ id: c.id, title: c.title, novel: c.novel, hasScript: !!String(c.script || '').trim(), scriptChars: String(c.script || '').length }));
  const target = ctx.chapter || '';
  if (target) chapters = chapters.filter((c) => c.title === target || c.id === target);
  const seed = JSON.stringify({
    project: { name: ctx.project.name, style: ctx.project.style, idea: ctx.project.idea || '' },
    targetChapter: target || null,
    chapters,
    novel: chapters.map((c) => c.novel).join('\n\n').slice(0, 6000),
  });
  // 失败重试纪律：工具内部已有「批量 2 次 → 降级逐镜 2 次」的闭环，但外层（Agent 自己决定再调一次）
  // 没有硬上限。实测过一次空转：Seedance 参考标签缺失时，Agent 连续 3 次原样调
  // write_video_prompts_batch，8 分钟 0 产出、白烧额度。这条纪律要求它撞两次就换策略而不是重试。
  const discipline = '【失败重试纪律 · 直接决定额度消耗】\n'
    + '- 同一工具 + 同一参数连续失败 2 次以上，禁止原样重试：先用 report 说明失败现象与判断，再换策略（改参数 / 补前置条件 / 换工具）。\n'
    + '- 机检 FAIL 会带「必须修复的 FAIL」清单回灌给你：只改清单里的项，不要整段重写碰运气；清单里没有 WARN 就不用管。\n'
    + '- 失败原因若是「缺前置条件」（如参考图未生成、资产未绑定、锁档未写入），先把前置补上再重试，否则重试多少次都一样。\n';
  return (ctx.renderDisabled ? '开始执行：本批只做文本创作，不要调用任何渲染工具。\n' : '开始执行：请把下面的项目完成到成片导出。\n')
    + discipline + seed;
}

// 参考图的文本描述（外部 Agent 通过 view_project_references 查看图片，不内联图片块）
export function buildReferenceDescription(ctx) {
  const refs = filterReferenceImages(ReferenceImages.list(ctx.projectId, { mode: 'reference' }), targetChapterIdSet(ctx));
  const lines = [];
  let idx = 0;
  for (const r of refs) {
    idx += 1;
    const parts = ['参考图' + idx + '（reference_id=' + r.id + '）：' + (r.name || '未命名')];
    if (r.description) parts.push('用途/剧情定位：' + r.description);
    lines.push(parts.join('；'));
  }
  return { refs, descText: lines.join('\n') };
}

// 按「视频模型」锁推导分镜/提示词环节应加载的技能（无人值守路由）：
// h3 → forest-laoli-h3（H3 全流程，用户级唯一权威）；seedance25/seedance20 → short-drama-director（漫剧老李全流程）。
// 两条线各自带完整规则库，不再走项目内的轻量派生技能（h3-storyboard / storyboard-director / combat-storyboard 仅作历史备份保留）。
export function storyboardSkillsFor(videoModel) {
  const m = String(videoModel || 'h3');
  return m.startsWith('seedance') ? ['short-drama-director'] : ['forest-laoli-h3'];
}

// 视频提示词环节的权威技能：与分镜同一条线（老李七段式 / H3 六段式），避免两条线混写。
export function videoPromptSkillsFor(videoModel) {
  return storyboardSkillsFor(videoModel);
}

// 视频提示词格式随视频模型切换：H3 → Ref2VA 六段式（英文）；Seedance → 七段式（中文栏位）。
// 写进系统提示词的「逐镜写提示词」职责句与格式铁律，避免选 seedance 时还被要求写六段式。
export function videoPromptFormatInstruction(videoModel) {
  return String(videoModel || 'h3').startsWith('seedance')
    ? '产出 Seedance 七段式投喂稿（七个【】栏位：【画幅风格】【场景资产】【核心人物】【站位声明】【时间轴分镜】【音效】【强制禁止项】；栏位与语法严格按 write_shot_video_prompt 工具注入的 model-adapters.md 规范）'
    : '产出官方六段式（subject_definitions / summary / retention_analysis / detailed_description / overall_soundscape / non_diegetic_music；禁止 __MINIMAX_H3_REF_N__ 平铺占位符）';
}

// 「视频提示词格式 · 铁律」整段按模型切换。
export function videoPromptIronRule(videoModel) {
  if (String(videoModel || 'h3').startsWith('seedance')) {
    return '【视频提示词格式 · 铁律】当前视频模型是 Seedance：video_prompt 必须是七段式投喂稿，七个【】栏位固定顺序、缺一不可（【画幅风格】→【场景资产】→【核心人物】→【站位声明】→【时间轴分镜】→【音效】→【强制禁止项】），栏位与语法严格按 write_shot_video_prompt 工具注入的 model-adapters.md 规范；版本（2.5/2.0）按项目视频模型锁执行、禁混写；2.0 全面禁用首尾帧。① **严禁用 update_shot 手写 video_prompt**——整章用 write_video_prompts_batch(chapter) 一次批量生成（同场景分批连续产出、批间传状态卡锁站位；工具内部已按模型注入规范、处理参考素材编号与无人值守锁卡），只有单镜重生成/微调才用 write_shot_video_prompt(shot_id)；② 参考素材用「@图片N / @音频N / @视频N（参考图N）」逐条标注用途，不得新造编号；③ 台词的语气位、镜行五要素按七段式规范写全。';
  }
  return '【视频提示词格式 · 铁律】当前工作流是原生 MiniMaxH3ReferenceToVideo，video_prompt 必须是官方 Ref2VA 六段式（subject_definitions / summary / retention_analysis / detailed_description / overall_soundscape / non_diegetic_music），正文全英文、台词 <d>[Chinese]…</d> 保留中文。① **严禁用 update_shot 手写 video_prompt，也严禁写 __MINIMAX_H3_REF_N__ 平铺占位符**——那是旧 Easy 工作流格式，会因参考素材编号错位导致人物漂移、音色错乱；② 整章必须调用 write_video_prompts_batch(chapter) 一次批量生成（工具内部按同场景分批连续产出、批间传滚动状态卡保证站位/手部/机位连续，并按真实参考顺序绑定 <Subject N>/<Picture N>/<Audio N> 与 (Sx) 音色编号），禁止逐条调单镜工具写整章（每镜独立无参照会导致换手/瞬移）；单镜重生成/微调才用 write_shot_video_prompt(shot_id)；③ subject_definitions 必须写清每个主体的可见外貌（发式/肤色/服装/体型），场景用 <Subject N> 锁空间，音色用 <Audio N> 引用并绑定到说话人 (Sx)，禁止写空壳「is the subject shown in <Picture N>」。';
}

// 由 skillPipeline 配置生成「技能→任务映射」文案。这是提示词里唯一的技能路由来源：
// 原先硬编码在提示词与 skill 工具描述里的映射已删除，避免与用户在「流水线编排」里的配置打架。
// available = 本机实际存在的技能名集合；传入后缺项会被点名（fallback=false 时明确禁止替换）。
// nodes 缺项/坏值时回退到节点默认；fallback 为 false 时只有指定技能可用。
// videoModel = 项目锁卡里的视频模型，分镜环节据此动态选 skill（其余环节仍走 config 编排）。
export function renderPipelineSkillMap(pipelineCfg, available, videoModel) {
  const nodes = (pipelineCfg && pipelineCfg.nodes) || {};
  const have = available instanceof Set ? available : null;
  const lines = [];
  for (const meta of SKILL_PIPELINE_NODES) {
    // 「生成小说」是无限・卷轴专属环节，不属于视频流水线，不写进视频 Agent 的技能映射
    if (meta.id === 'novel') continue;
    const node = nodes[meta.id] || {};
    // 分镜 / 视频提示词两个环节按视频模型锁动态路由（config 里的同名节点不再直接生效，避免与模型线冲突）：
    // 两条线各自带着完整规则库（H3 六段式 / 老李七段式），混用会让镜行语言与投喂格式互相打架。
    const skills = meta.id === 'storyboard'
      ? storyboardSkillsFor(videoModel)
      : meta.id === 'video_prompt'
        ? videoPromptSkillsFor(videoModel)
        : (Array.isArray(node.skills) ? node.skills.map((s) => String(s).trim()).filter(Boolean) : []);
    const fallback = node.fallback !== false;
    const missing = have ? skills.filter((s) => !have.has(s)) : [];
    const missNote = missing.length
      ? '（本机缺失：' + missing.join('、') + (fallback ? '，将自动匹配替代技能' : '，本环节应 report 说明并跳过，禁止自行替换') + '）'
      : '';
    if (!skills.length) {
      lines.push(meta.label + '（' + meta.desc + '）→' + (fallback ? '按技能目录自动匹配' : '本环节未指定技能，禁止自行加载其它技能'));
      continue;
    }
    const refs = skills.map((s) => 'skill(' + s + ')').join('、');
    lines.push(
      meta.label + '（' + meta.desc + '）→'
      + (fallback
        ? '优先 ' + refs + '（这些都不存在或不适用时才可自动匹配其它技能）'
        : '必须使用 ' + refs + '，禁止改用其它技能')
      + missNote,
    );
  }
  return '技能→任务映射（来自「流水线编排」配置，优先级高于技能目录摘要；执行对应任务前必须先调用对应 skill 加载全文）：'
    + lines.join('；') + '。';
}

// 「总流水线」环节的第一个可用技能 = 本次会话的主工作模式技能。
// 原先这里硬编码 'novel-to-video'，导致该环节的配置完全不生效；缺失时退回 novel-to-video。
export function pipelinePrimarySkill(cfg) {
  const skills = ((cfg?.skillPipeline?.nodes?.pipeline?.skills) || []).map((s) => String(s).trim()).filter(Boolean);
  for (const s of skills) if (loadSkill(s)) return s;
  return 'novel-to-video';
}

// 当前流水线实际引用的技能名集合。catalogMode=mapped 时，系统提示词只给这些技能写摘要；
// 其余已安装技能只保留名字，避免每次任务把整个技能库的描述全量注入。
export function pipelineSkillNameSet(cfg) {
  const nodes = (cfg?.skillPipeline && cfg.skillPipeline.nodes) || {};
  const names = new Set();
  for (const node of Object.values(nodes)) {
    for (const s of (Array.isArray(node?.skills) ? node.skills : [])) {
      const name = String(s).trim();
      if (name) names.add(name);
    }
  }
  const primary = pipelinePrimarySkill(cfg);
  if (primary) names.add(primary);
  // 分镜/提示词环节按视频模型动态路由，config 里可能只列了其中一条线：
  // 两条全流程技能都要进「当前流水线技能」摘要，否则 catalogMode=mapped 会把它隐藏成"缺失"。
  for (const s of [...storyboardSkillsFor('h3'), ...storyboardSkillsFor('seedance25')]) names.add(s);
  return names;
}

// —— 项目锁卡（2026-11-21）——
// 创建项目时落定的参数（项目名/画风/画幅/分辨率/开关）是唯一事实源。
// 目的：让流水线内的技能不再「停下询问用户」，而是照项目记录执行。
const STYLE_PRESET_FLAT = (() => {
  try {
    return STYLE_PRESETS.flat(2).filter((s) => typeof s === 'string');
  } catch {
    return [];
  }
})();

// 画风锚点：命中预设 → 给出基底；用户自定义 → 原样使用，不归类、不改写。
export function resolveStyleAnchor(style) {
  const raw = String(style || '').trim();
  if (!raw) return { raw: '', base: 'BASE_LIVE', custom: false, note: '未指定风格，按真人写实执行' };
  if (!STYLE_PRESET_FLAT.includes(raw)) {
    return { raw, base: null, custom: true, note: '用户自定义风格' };
  }
  // 先排除「看着像真人、其实不是」的组合，再判基底
  let base = 'BASE_LIVE';
  if (/插画|厚涂|手绘|水彩|国画|素描/.test(raw)) base = 'BASE_2D';
  else if (/2\.5D|3D|CG|次世代|渲染|仿真人/.test(raw)) base = 'BASE_ANIME';
  else if (/水墨|禅意|敦煌|国潮/.test(raw)) base = 'BASE_INK';
  else if (/漫|二次元|Q版|卡通|吉卜力|新海诚|赛博|废土|哥特|像素|粘土/.test(raw)) base = 'BASE_2D';
  return { raw, base, custom: false, note: '' };
}

function fmtAssetSize(ratio, resolution) {
  try {
    const [w, h] = imageSizeFor(ratio, resolution);
    return w + '×' + h;
  } catch {
    return '';
  }
}

// 生成注入系统提示词的项目锁卡（值全部来自项目记录，不写死）
export function buildProjectLockCard(project) {
  const p = project || {};
  const anchor = resolveStyleAnchor(p.style);
  const ratio = String(p.video_aspect_ratio || '16:9');
  const vres = String(p.video_resolution || '480P');
  const ires = String(p.image_resolution || '1K');
  const autoScript = p.auto_script !== false && p.auto_script !== 0;
  const bgm = p.enable_bgm === undefined ? true : !!p.enable_bgm;
  const subs = p.enable_subtitles === undefined ? false : !!p.enable_subtitles;
  const dur = Number(p.target_duration) > 0 ? Number(p.target_duration) + 's' : '按剧本节拍推算（项目未设）';
  const vmodel = String(p.video_model || 'h3');
  const seam = String(p.seam || 'auto');

  const styleLine = anchor.custom
    ? '画风锚点 = 「' + anchor.raw + '」（用户自定义，不是预设项：直接按这段文字执行画风，禁止自行归类成真人/动漫/水墨，也禁止改写用户的描述）'
    : '画风锚点 = ' + anchor.raw + '（预设项）｜画风基底 = ' + anchor.base;

  return [
    '【项目锁卡 · 创建项目时已落定，流水线内禁止询问、禁止改判】',
    '画幅 = ' + ratio + '（创建项目时由用户从下拉选定：1:1 / 2:3 / 3:2 / 3:4 / 4:3 / 9:16 / 16:9 / 21:9；本值即当前项目选择，全片唯一）',
    '—— 画幅是可变项：禁止把 16:9 当默认、禁止自行改成 9:16 或任何其它比例，禁止 auto/adaptive；该值只进生成载荷（width/height），不写进提示词正文；分镜里若出现旧比例，一律以本锁卡为准。',
    '视频分辨率 = ' + vres,
    '图片素材分辨率 = ' + ires + '（资产图与视频画幅解耦，固定横版：人物/场景 16:9 → ' + fmtAssetSize('16:9', ires) + '，道具 1:1 → ' + fmtAssetSize('1:1', ires) + '）',
    '人物资产底色 = 纯白（#FFFFFF）无缝，无灰底、无灰缝、无渐变、无纹理、无投影；四格之间只靠人物轮廓区分。灰底会把环境色带进 H3 成片。',
    '人物颜值 = 要精致吸睛（这是漫剧，脸不抓人没人看）：五官立体、轮廓分明、妆面干净、好看有辨识度、有高级气质，但不刻意像任何明星或网红模板。皮肤必须写英文强压 flawless, smooth, even, clear, radiant skin, absolutely no freckles, no blemishes, no spots——男女都必须无斑，中文"无斑点"压不住写实模型的雀斑先验（实测中文正向仍出斑点，纯英文才压得住）。Z-Image 用 20 步补细节。',
    '人物气质基线 = 男角色帅气、女角色漂亮，且都要「大气」（有主角气场、有辨识度、神态从容自信，不是小家子气的路人脸）。LLM 写人物外观时，漂亮/帅气/大气是硬底线，不能写成憔悴、普通、路人、苦相；素颜/朴素可以是剧情设定，但脸必须好看。',
    '场景基线 = 大气、明亮、有电影感：构图开阔有层次（前景遮挡+中景主体+远景纵深）、光线通透不灰暗、色调干净不脏乱；除非剧情明确要压抑/昏暗/悬疑氛围，否则默认明亮通透。写场景提示词时把「大气明亮」落成具体光位、色温、空间层次，不写"灰蒙蒙/昏暗/脏乱"。',
    '台词速率 = dialogue.length ÷ duration ≤ 3.5（统计含「人物名：」前缀、标点与换行；中文口播实测 3.2–3.5 字/秒）；超限 set_storyboard 会整批拒绝——先延长时长（单段上限见 video_model 分档：h3/2.0 为 15s，2.5 为 30s）或拆镜，禁止删台词、禁止改剧情。',
    styleLine,
    '剧本 = ' + (autoScript ? '自动生成（auto_script 开：novel/idea → 剧本 → 分镜）' : '不自动生成（用户已有剧本，只拆分镜，禁止重写剧本）'),
    '背景音乐 = ' + (bgm ? '开（视频阶段生成并合成）' : '关（不生成配乐）') + '｜字幕 = ' + (subs ? '开' : '关') + (subs ? '（按设置烧入成片）' : '（视频提示词不写任何与字幕有关的句子）'),
    '目标时长 = ' + dur,
    '',
    '【自治执行声明 · 优先级高于任何技能正文】',
    '本流水线无人值守，没有人在旁边回答。技能里任何「停下询问用户 / 等待用户确认 / 弹卡让用户勾选 / 未指定则任务不开始 / 必须先向用户展示菜单 / 不得默认跳过」的要求，一律以本锁卡与项目记录为准自动落定，禁止中断等待。缺项按下述默认执行，并在 report 中注明所用假设：',
    '- 赛道与素材来源：按项目 type 与 novel/idea 现状判定，不询问；',
    '- 画风基底：按上方「画风锚点」——预设项用给定基底，用户自定义文本则原样执行；',
    '- 视频模型 = ' + vmodel + '（h3=MiniMax H3 走本地/云端 ComfyUI 出片；seedance25=Seedance 2.5；seedance20=Seedance 2.0，后期外接视频生成接口）',
    '- 分镜引擎 = ' + storyboardSkillsFor(vmodel).map((s) => 'skill(' + s + ')').join(' + ') + '（按视频模型锁落定：拆分镜前先加载这些 skill 全文，禁止询问、禁止改用其它分镜技能）',
    '- 交付形态：分镜 + 视频提示词 + 成片；',
    '- 段缝衔接 = ' + seam + '（auto=按情绪节拍判断 / tail_frame=尾帧锚定 / hard_cut=换机位硬切 / empty_shot=空镜过渡）',
    '以上缺项均不得以「用户未指定」为由中止任务。',
  ].join('\n');
}

export function buildSystemPrompt({ ctx, skillName, external }) {
  const skill = loadSkill(skillName || pipelinePrimarySkill(ctx.cfg));
  const parts = [];
  parts.push('你是「无限创作」的自主创作 Agent，负责把小说/故事全自动改编为带语音的视频成片。你拥有调用本地 ComfyUI（MiniMax H3 视频 + Qwen-Image/Krea2 文生图/图生图 + Qwen3-TTS 音色）与 ffmpeg 的能力。');
  parts.push('铁律：全程自主决策，不要向用户询问中间确认；遇到失败先重试、再降级、最后记录并继续；操作必须幂等（已完成资产/分镜跳过），以便断点续跑。');
  parts.push('工具边界铁律：你只有下面列出的领域工具（以及用于按名字检索领域工具的 ToolSearch）。除 web_search（查资料/搜图）与 download_reference_image（下载一张图片到项目参考图）这两项联网能力外，你没有任何 shell/命令行/文件读写/子代理工具。技能文档里出现的 python / bash / npm / node / 脚本 等命令，或「运行脚本 / 执行命令 / 读文件」一类步骤，一律不要尝试执行（调用会被直接拒绝，反复尝试只会空转、浪费时间）；凡文档声称「跑脚本才能得到」的产物，改用领域工具（list_*/get_*/generate_*/set_*/update_*/skill_reference 等）本身完成，或直接忽略该脚本步骤。web_search / download_reference_image 会由系统在后台替你执行，你只需按工具参数调用即可。');
parts.push('【不确定就要搜】遇到你不知道或不确凿的事实——品牌名、产品型号、年代物品的真实外观、专业术语、历史/地理/科技细节、真实存在的服饰/道具样式等——必须先调用 web_search(type=web) 查证，再据结果理解上下文或改写描述/提示词，禁止凭空臆造年代/品牌/型号错误。需要某物品/服饰的参考图时，用 web_search(type=image) 搜图，再用 download_reference_image 下载为参考图（这些参考图会在后续「资产图」阶段用图生图自动派生为新素材）。若 web_search 返回 disabled，说明设置里关闭了联网搜索，此时改用你的既有知识继续、不要重试。');
  parts.push('【安全铁律】你没有任何删除/破坏类能力，也不得尝试越权：\n1. 禁止删除项目、清空素材库、批量删除分镜/资产/章节（没有对应工具，也不要试图用其他工具绕）。\n2. 禁止任何 shell/脚本/命令执行（rm、dd、mkfs、chmod、sudo、curl|sh、git force 等一律不做）；技能文档里出现「运行脚本/执行命令/读写文件」类步骤一律忽略，用领域工具本身完成。\n3. 禁止路径越权：所有路径参数（voice_ref / reference_image_path 等）只能指向项目目录内的相对路径，不得包含 ../ 或绝对路径。\n4. 若某次调用返回「已拦截 / 安全拦截」，说明该操作被系统判定为危险，不要再重试同类操作，改用安全方式继续。');
  if (external) {
    parts.push('【外部 Agent 运行时】你的领域工具由本项目的本地 MCP 服务 ic 提供，工具名可能带 mcp__ic__ / ic__ / mcp_ic_ 等前缀，按同名工具调用即可。开始执行前先调用 get_project 验证 MCP 连通性。禁止使用你自身的 shell / 文件读写 / 联网 / 子代理工具；本任务的一切写入与生成都必须通过领域工具完成。');
  }
  if (skill) {
    parts.push('【当前工作模式技能：' + skill.name + '】\n' + skill.body);
  }
  const catalog = listSkills();
  if (catalog.length) {
    const installedNames = new Set(catalog.map((s) => s.name));
    const catalogMode = String(ctx.cfg?.skillPipeline?.catalogMode || 'full').toLowerCase();
    const mappedNames = pipelineSkillNameSet(ctx.cfg);
    const visibleCatalog = catalogMode === 'mapped' ? catalog.filter((s) => mappedNames.has(s.name)) : catalog;
    const otherCatalog = catalogMode === 'mapped' ? catalog.filter((s) => !mappedNames.has(s.name)) : [];
    const descLimit = catalogMode === 'mapped' ? 120 : 220;
    if (visibleCatalog.length) {
      const lines = visibleCatalog.map((s) => {
        const d = String(s.description || '').replace(/\s+/g, ' ');
        return '- ' + s.name + '：' + (d.length > descLimit ? d.slice(0, descLimit) + '…' : d);
      });
      parts.push((catalogMode === 'mapped'
        ? '当前流水线技能（仅摘要，禁止凭摘要臆测规范；执行映射任务前必须先调用 skill(名字) 加载全文）：'
        : '可用技能目录（仅摘要，禁止凭摘要臆测其规范；命中对应任务前必须先调用 skill(名字) 加载全文再遵循）：')
        + '\n' + lines.join('\n'));
    }
    if (otherCatalog.length) {
      parts.push('其他已安装技能（当前流水线未使用，仅列名字；需要时可 skill(名字) 加载全文，不要凭名字臆测规范）：\n- ' + otherCatalog.map((s) => s.name).join('、'));
    }
    // 技能路由只认「流水线编排」配置；mapped 模式只是压缩展示，未展示技能不能被误判成“本机缺失”。
    parts.push(renderPipelineSkillMap(ctx.cfg?.skillPipeline, installedNames, ctx.project?.video_model));
    parts.push('技能选择规则：上面「技能→任务映射」是唯一的路由依据——执行某类任务时，先加载该环节列出的技能；环节标注「必须使用」时不得改用其它技能，标注「优先」时仅在该技能不存在或不适用时才可换用，并在 report 里写明原因。不要因为某个技能描述更贴切就跳过映射里指定的技能。');
    parts.push('短剧/漫剧任务同样遵守「技能→任务映射」：需要额外的短剧/漫剧专项技能时，从「当前流水线技能」或「其他已安装技能」名单里按任务挑选并通过 skill(名字) 加载，不要凭记忆臆测技能名。套装里的 python 脚本一律不执行（脚本机检由后端自动完成，不需要你调用）；最终 video_prompt 必须按「视频提示词」环节指定技能的规范落地——H3 走六段式、Seedance 走七段式，以 write_shot_video_prompt 工具实际注入的规范为准。');
  }
  const c = ctx.project.context || {};
  if (c.bible) parts.push('【人物圣经（一致性锚点，后续所有生成必须遵守）】\n' + c.bible);
  if (c.style) parts.push('【风格指南（统一画风/光线/色调）】\n' + c.style);
  if (c.continuity) parts.push('【连续性记录】\n' + c.continuity);
  parts.push('【人物/道具站位一致性铁律】同一场景内所有镜头必须保持人物/道具相对站位与朝向一致：先为每个场景建立「站位表」（空间锚点+各角色默认方位+道具锚点+180度轴线与允许机位）写入人物圣经 bible 的「场景站位表」章节，之后每个镜头的 sub_shots / visual / video_prompt 都要明确复述各角色/道具相对左右方位与朝向，跨镜左右关系不得漂移（除非剧情明确走位/换位，且换位本身要写清路径）。拆分镜前先调用 skill(scene-blocking-consistency) 加载并遵循其规则。写分镜时按 idx 顺序逐条写，并自动判断前后两镜是否转场：比较前后两镜的 scene_name/场景头与时间——同场景且时间连续→必须参考站位（写每条前先回顾上一条 sub_shots 的结尾落幅，起幅=上一镜落幅，角色左右方位/朝向/道具位置/动作方向一致）；发生转场（场景切换/地点变化/时间跳跃/淡入黑场）→不参考上一镜位置，为新场景重建站位表。');
  parts.push(storyboardAuthoringInstruction(ctx.project.video_model));
  parts.push('【人物着装铁律】人物外貌/发型/配色必须与人物圣经一致。先用 generate_assets_batch 生成角色 canonical 图；是否额外生成服装取决于剧情：仅当剧情出现沐浴/洗澡/更衣/换衣/换装/换上一身等「真实换装事件」时，才用 change_outfit 或 design_outfits 为该角色生成对应的那套服装（category=costume，parent_id 指向角色，每套给短名+外观描述）。不同场景、不同镜头、不同机位、换场地拍摄都不算换装——没有换装事件的角色一律直接用 canonical 图，禁止为每个角色默认生成多套服装（避免素材冗余）。同一个角色在一个分镜里只引用一件服装，不要同时引用角色原图和服装图。写分镜时按剧情在 set_storyboard 的 costumes 字段引用该镜对应那套服装：换装事件之后的镜头引用新一套、之前的镜头不引用或用旧一套。');
  parts.push('【人物年龄/时期铁律】只有当剧情出现明确的时间跳跃或年龄变化（回忆/闪回、小时候/童年/幼年、多年前、年轻时、步入中年、老年/变老、多年后/长大等）时，才用 change_age 或 design_ages 为该角色生成对应时期的年龄变体（category=age，parent_id 指向角色，保持脸/五官/发型/画风一致、只改年龄）。「年轻」「少年」这类普通外貌描写不算时间跳跃，禁止凭此生成年龄变体；剧情没有涉及人物不同年龄段的，禁止生成年龄变体，直接用 canonical 图。同一个角色在同一时期只需要一个年龄变体，不要为同一角色生成多个年龄段；同一个角色在一个分镜里只引用一个年龄变体（且不要同时引用角色原图）。写分镜时在时间跳跃之后的镜头用 set_storyboard 的 ages 字段引用对应时期、之前的镜头不引用。');
  parts.push(buildProjectLockCard(ctx.project));
  parts.push('当前 LLM 支持图片输入：' + (ctx.cfg.llm?.vision ? '是' : '否') + (ctx.cfg.llm?.vision ? '。写视频提示词前，先用 list_assets 拿到全部资产，再用 view_asset 一次性查看每个唯一角色/场景/道具的参考图（每个资产只看一次并记住、后续所有镜头复用，禁止对同一张图反复查看）；仅当某镜头引用了尚未查看过的资产时才用 view_shot_references(shot_id) 补看。只给 list_shots 中 has_prompt=false 的镜头写视频提示词（has_prompt=true 的跳过，用于断点续跑）。基于真实参考图写提示词，避免逐镜重复查看造成上下文膨胀。' : '。不要尝试查看图片，仅用文本描述写提示词。'));
  parts.push('【参考生成新素材（图生图）】若存在用户上传的参考图片素材（mode=reference）：分析其内容/画风/元素后，用 generate_asset_from_reference(reference_id, category, name, ...) 以参考图为图生图(i2i)输入派生新素材，禁止一律用文生图重画；只有与参考图无关、纯靠文字描述的新素材才走 generate_assets_batch 文生图。参考图仅作参考、不直接当成品。');
  parts.push('【用户导入素材（优先绑定分镜）】list_assets 中 source=uploaded 且已有 image_path 的资产，是用户上传并「导入素材库」的设定（已由视觉模型自动命名并归类为 character/scene/prop 等，图片已随首条消息附带）。这些是用户指定的角色/场景/道具视觉锚点：先分析每张图的内容，把它绑定到最相关分镜——拆分镜写 set_storyboard 时必须在 characters/scenes/props 里按名字引用它们，禁止忽略或为同一主体重复生成同义资产。对 category=other 的导入素材，可先 view_asset 查看后作为风格/元素参考。');
  parts.push('【音频素材（音色参考）】素材库中 category=voice/music/sfx 且已有 audio_path/voice_ref 的资产是独立音频（旁白音色/背景音乐/音效），会作为 H3 音色参考输入。拆分镜时：有旁白（narration）的分镜，若素材库存在对应旁白音色（voice 类），用 set_storyboard 的 audios 字段按名字引用；需要背景音乐/音效烘托的分镜，同样用 audios 引用对应音乐/音效资产。audios 引用的是已存在的音频资产名，禁止编造不存在的名字。');
  parts.push('本次生成目标：' + (ctx.chapter ? ('章节「' + ctx.chapter + '」（只生成该章，其它章节不要动）') : '全部章节'));
  parts.push('【剧本流程（先剧本，后分镜）】每章必须先有剧本再拆分镜：\n1) 先用 get_chapter 读取本章 novel 与 script；\n2) script 已有内容：它是本章唯一权威的剧情蓝本，禁止用 novel 重写或覆盖（除非本轮用户明确要求重写剧本，才 set_chapter_script(overwrite=true)；否则不要调用 set_chapter_script）；拆分镜必须严格覆盖剧本中的全部场次/动作/台词/旁白，人物名、场景名、道具名与剧本保持一致；\n3) script 为空且项目「自动生成剧本」开启（当前：' + (ctx.project.auto_script !== false ? '开启' : '关闭') + '）：依据 novel（novel 为空则用项目 idea）写一份完整中文剧本，用 set_chapter_script 保存，再按剧本拆分镜；\n4) script 为空且项目关闭自动生成：不要写剧本、不要拆分镜，用 report 说明「本章缺少剧本且项目未开启自动生成剧本」，跳过该章。\n剧本格式：【第N场｜时间｜地点】+ 出场人物 + 场景/动作描述 + 台词（人物名：台词）+ 必要旁白；台词口语化、可直接配音。');
  parts.push('若目标章节正文（novel）与剧本（script）都为空，则以项目「想法 idea」作为故事前提自行展开完整剧情；不要因为正文为空而拒绝生成。');

  // 只跑 LLM 的阶段（渲染另起一批）：到此为止，不灌「成片导出」那段。
  // 否则 Agent 会为了达成「全部视频 done + 合并导出」而反复调用被 runTool 拦掉的渲染工具。
  if (ctx.renderDisabled) {
    parts.push('【本阶段只做文本创作，禁止一切渲染】本批没有启动 ComfyUI：LLM 与 ComfyUI 同时常驻会爆显存，所以渲染必须另起一批。');
    parts.push('本阶段职责：读入正文 → 写本章剧本（先按「技能→任务映射」的「生成剧本」环节加载技能；已有剧本则直接使用、不要覆盖）→ 写人物圣经与风格 → 为每个资产写图片提示词与音色描述（update_asset 的 prompt / voice_description，图片提示词按「人物素材/道具素材/场景素材/换装/年龄分级」环节加载对应技能，音色按「配音·音色」环节）→ 拆分镜（严格按剧本，set_storyboard，先按「生成分镜脚本」环节加载技能）→ 为整章写视频提示词（**调用一次 write_video_prompts_batch(chapter) 批量生成**，工具内部按同场景每批≤3镜连续产出、批间传滚动状态卡锁站位/手部/机位，自动跳过已有提示词；' + videoPromptFormatInstruction(ctx.project.video_model) + '；仅在单镜微调/重生成时才用 write_shot_video_prompt(shot_id)；禁止逐条调单镜工具写整章、禁止用 update_shot 手写 video_prompt）→ 为每章写背景音乐（set_chapter_music：先按「生成背景音乐」环节加载技能，产出贴合本章剧情的结构化 caption；再用适合本章剧情的语言——华语普通话/粤语/英语等——写 lyrics 歌词；并给合适的 duration 时长）。若项目设置「是否生成背景音乐」为否，则跳过 set_chapter_music。');
    parts.push('以下工具已被禁用，调用只会返回「已跳过」，重试无意义，请不要调用：generate_asset_image、edit_asset_image、change_outfit、design_outfits、change_age、design_ages、generate_assets_batch、design_voice、generate_shot_video、regenerate_shot、generate_chapter_videos、generate_music、assemble_video。');
    parts.push('把所有文本写到数据库后就汇报「文本阶段完成」并结束本轮。不要等待渲染结果，也不要反复尝试被禁用的工具。待办会自动保留，由后续渲染阶段接手。');
    return parts.join('\n\n');
  }

  parts.push('硬性完成要求：分镜必须完整覆盖该章（按「生成分镜脚本」环节技能里的长镜头聚合规则：同一场景连续动作+多句连贯对白合并成一镜，仅场景切换/时空断开才换镜，同一分镜最多 2 个说话人（≥3 人对话拆成多个分镜），禁止一句一镜/碎片化，也禁止压缩/省略/偷工）。**镜头时长必须贴合内容节奏，禁止为凑时长拖长**：时长 ≈ 台词字数÷3.3 + 动作/情绪缓冲 1–3 秒，取整后夹在 2–15 秒之间；一句短台词（约 8–15 字）只给 3–5 秒，绝不为凑 10 秒把短镜头拖长（拖长会产生呆板空镜、打乱节奏）；只有真正的连续动作+多句对白才给长镜头（最长 15 秒）。每镜台词字数 ≤ 时长秒×3.5（中文口播实测 3.2–3.5 字/秒，见 dialogue-density.md），超长台词必须拆镜或压缩台词，否则会被 H3/TTS 压缩成听不清的模糊声。**相邻镜头要衔接自然**：同场景连续镜头写视频提示词时保持人物位置/朝向/动作方向/光线色调连续，并写清本镜起幅与上一镜落幅的衔接关系（动作接续/视线匹配/运动方向连续），避免跳跃感。视频用 generate_chapter_videos(该章) 一次生成全部镜头，直到该章所有镜头 done（remaining=0）。**不因时间长短、镜头多少、失败次数而提前停止**——必须把该章全部分镜视频都生成完才进入导出。');
  parts.push('用工具完成整条流水线：读入大纲 → 写章节剧本（先按「生成剧本」环节加载技能；已有剧本则直接使用）→ 写人物圣经/风格 → 写资产生图/音色提示词并生成（按对应素材环节的技能）→ 写分镜（严格按剧本，先按「生成分镜脚本」环节加载技能）→ 写视频提示词（**调用 write_video_prompts_batch(chapter) 一次批量生成本章**，工具内按同场景分批连续产出、批间传滚动状态卡保证站位连续，自动解析参考素材真实编号并' + videoPromptFormatInstruction(ctx.project.video_model) + '；单镜重生成才用 write_shot_video_prompt）→ generate_chapter_videos 生成该章全部视频 → set_chapter_music 写背景音乐（结构化 caption + 语言合适的 lyrics + duration，先按「生成背景音乐」环节加载技能）→ generate_music 生成该章 BGM → assemble_video(该章) 合并成片（自动垫入 BGM）。若项目设置「是否生成背景音乐」为否，则跳过 set_chapter_music 与 generate_music。每一步用 report 汇报进度。');
  parts.push(videoPromptIronRule(ctx.project.video_model));
  parts.push('【视频与音乐严格顺序隔离 · 铁律】视频和音乐是两种完全不同的模型（H3 视频模型 vs Music3 音乐模型），本地显存有限，两者来回切换会反复换入换出模型导致显存耗尽（OOM）。因此：① 必须先让 generate_chapter_videos 把该章【全部】分镜视频跑完（remaining=0、所有镜头 status=done）之后，才允许调用 set_chapter_music 和 generate_music；② 在视频未全部完成前，【绝对禁止】调用 set_chapter_music / generate_music / assemble_video，哪怕视频中途有镜头失败也禁止提前去写或生成音乐——失败的镜头用 generate_chapter_videos 反复重试直到成功或确认无解，绝不能用「先去生成音乐」来穿插或等待；③ 只有视频全部完成后，才一次性做 音乐→合并，且音乐只做一轮、生成完就立刻合并，不要在视频和音乐之间来回跳。');
  return parts.join('\n\n');
}

// ================= 「无限・秩影」lemo-opuscar 代码电影模式 =================
// 与上面 ComfyUI 全链路完全独立：本模式脱离 ComfyUI，用 node/ffmpeg/three.js/python 渲染成片。

export function buildOpuscarSystemPrompt({ ctx, external }) {
  const parts = [];
  parts.push('你是「无限・秩影」的自主创作导演，负责用 lemo-opuscar 技能把「所选风格 + 上传素材 + 用户提示词」用代码渲染做成成片视频（node / ffmpeg / three.js / python，脱离 ComfyUI）。');
  parts.push('铁律：全程自主决策，不要向用户询问中间确认；失败先读错误再重试、再降级、最后记录并继续；操作尽量幂等（已产出的文件跳过，便于断点续跑）。');
  parts.push('工具边界：你只有 opuscar_* 系列工具，外加 skill / skill_reference / get_project / list_assets / view_asset / report。禁止调用任何 ComfyUI 领域工具（本会话未注册，调用会被拒绝）；不要用 opuscar 工具去读写项目数据库或碰 ComfyUI。');
  parts.push('安全铁律：opuscar_shell 的 cwd 只能是 lib（库根，默认）或 film（影片工作区）；命令里的绝对路径必须落在 opuscar_init 返回的 lib_root / film_dir 之内；命令里禁止 ".." 路径段与 rm -rf / sudo / curl|sh 等危险命令（会被拦截）。opuscar_read_file / opuscar_write_file 的 path 只能写相对路径，禁止 ../ 与绝对路径。');
  parts.push('工作流（严格按序）：\n1) opuscar_init 获取 lib_root 与 film_dir；\n2) 首次使用时若库内缺少 node_modules 或 .venv，先 opuscar_shell(cwd=lib, command=sh plugin/skills/lemo-opuscar/scripts/setup.sh deps) 装核心依赖（需要语音加 deps voice、配乐加 deps music）；\n3) 读取风格规范：若任务消息给出的是「预设风格 slug」则用 opuscar_read_file 读库内 styles/<slug>/STYLE.md；若给出的是「自定义风格」描述（styleInfo.custom_style），则没有固定 STYLE.md，你要把该描述当作风格不变量自行设计页面（可参考 styles/README.md 选相近风格，或读任意一个 STYLE.md 学习页面契约与写法），其余流程相同；\n4) 在 film_dir 写 TREATMENT.md（三个候选结构 + 你的选择，先于 demo）；\n5) 写影片页面代码 index.html（遵循 core/README.md 的「页面契约」：window.READY=true、window.render(t) 确定性逐帧绘制、window.DUR、可选 window.EV / window.TEXTS(t)），以及依赖的 JS/CSS/资源，全部写在 film_dir，不要改库内 styles/ 与 core/；\n6) 渲染：先 opuscar_shell(cwd=lib, command=node core/render/still.mjs "$LEMO_FILM" 1.5 抽帧自查风格是否符合 STYLE.md（或自定义风格描述），再 node core/render/video.mjs "$LEMO_FILM" --out "$LEMO_FILM/out/video.mp4"）；\n7) 需要语音时 opuscar_write_file 写 lines.json，再 opuscar_shell 跑 core/tts/tts.py 或 tts_zh.py 生成 wav；\n8) 合成：opuscar_shell(cwd=lib, command=sh core/render/mux.sh "$LEMO_FILM/out/video.mp4" "$LEMO_FILM/mix.wav" "$LEMO_FILM/out/final.mp4")（无配乐可跳过 mux，直接交付 video.mp4）；\n9) opuscar_save_film 把成片落为项目视频资产。每一步用 report 汇报进度。');
  parts.push('素材语义：用户上传的素材可以是任意文件类型——图片/音频/视频/数据/扫描/CAD/字体/文档等，都已复制到影片工作区 film_dir/materials/ 下（相对路径见任务消息）。你必须逐一审视这些素材：先用 opuscar_read_file 读可读的文本/数据/JSON/字幕等；图片/视频/音频可被页面代码按相对路径引用（如 "materials/xxx.png"）；「剪辑与纪实 / Evidence Films」类风格（字幕新闻、新闻影片、视觉调查、卫星简报、产品拆解、档案灯台等）把上传素材当真实素材来源组织材料；其余风格把上传素材当参考/风格锚点（角色、场景、配色、构图）。用户提示词是主题与方向。所选风格 slug、用户提示词、素材清单见任务消息。');
  if (external) parts.push('【外部 Agent 运行时】你的领域工具由本地 MCP 服务 ic 提供，工具名可能带 mcp__ic__ / ic__ 等前缀，按同名工具调用即可；开始前先 opuscar_init 验证连通。禁止使用你自身的 shell / 文件读写 / 联网 / 子代理工具。');
  return parts.join('\n\n');
}

export function buildOpuscarTaskPrompt({ ctx, styleSlug, styleInfo, prompt, materials, history, continueMessage }) {
  const lines = [];
  const isContinuation = !!String(continueMessage || '').trim();
  if (isContinuation) {
    lines.push('这是在同一条影片记录上继续修改：此前已有一版成片，影片工作区 film_dir 里保留了上一版的 TREATMENT.md、index.html 与素材。');
  } else {
    lines.push('请用 lemo-opuscar 的代码渲染制作一支成片视频。');
  }
  if (styleInfo && styleInfo.custom_style) {
    lines.push('所选风格：自定义风格（无预设 STYLE.md）。\n自定义风格描述：' + styleInfo.custom_style);
    lines.push('请把上面的「自定义风格描述」当作本片的风格不变量（画风/配色/动效/镜头语法/声音调性等）自行实现，不要套用任何预设风格。');
  } else {
    const styleLabel = styleInfo ? (styleInfo.cn || styleInfo.en || '') : String(styleSlug || '');
    lines.push('所选风格：' + styleLabel + '（slug=' + styleSlug + '）' + (styleInfo && styleInfo.cat ? '，类别：' + styleInfo.cat : '') + (styleInfo && styleInfo.line_cn ? '；简介：' + styleInfo.line_cn : ''));
  }
  lines.push('用户提示词：' + (String(prompt || '').trim() || '（无）'));
  if (Array.isArray(materials) && materials.length) {
    const ms = materials.map((m, i) => (i + 1) + '. [' + (m.type || 'file') + '] ' + (m.name || m.filename || '') + '（相对路径：' + (m.filename || '') + '）');
    lines.push('已上传素材清单（均在 film_dir/materials/ 下，可读文本用 opuscar_read_file，图片/视频/音频可在页面代码里按相对路径引用）：\n' + ms.join('\n'));
  } else {
    lines.push('已上传素材清单：（无）');
  }
  if (isContinuation) {
    if (Array.isArray(history) && history.length) {
      const hs = history.filter((m) => m && String(m.text || '').trim()).map((m, i) => (i + 1) + '. ' + String(m.text).trim());
      lines.push('此前的修改对话：\n' + hs.join('\n'));
    }
    lines.push('本轮修改要求：' + String(continueMessage).trim());
    lines.push('执行要求：先用 opuscar_read_file 读取 film_dir 里现有的 TREATMENT.md、index.html 及相关代码/素材，理解上一版的实现；只改本轮要求涉及的部分，保留其余内容与风格不变；改完重新渲染并合成，最后 opuscar_save_film 覆盖保存到同一条记录。除非本轮要求涉及画幅或时长，否则保持原有 DUR 与画面比例。');
    return lines.join('\n\n');
  }
  lines.push('请按系统提示词的工作流执行：先读所选风格 STYLE.md，再写 TREATMENT 与页面代码，渲染、合成、opuscar_save_film 落地。');
  return lines.join('\n\n');
}

// ================= 「无限・卷轴」网文大纲规划模式 =================
// 与 opuscar / ComfyUI 全链路完全独立：本模式不做视频，只做小说结构（总纲/卷纲/章纲）+ 角色 + 记忆。

export function buildNovelSystemPrompt({ ctx }) {
  const parts = [];
  // 主技能来自「流水线编排 → 生成小说」环节，第一个为主技能，其余为备用
  const node = (ctx.cfg?.skillPipeline?.nodes || {}).novel || {};
  const skills = (Array.isArray(node.skills) ? node.skills : []).map((s) => String(s).trim()).filter(Boolean);
  const primarySkill = skills[0] || 'webnovel-writing';
  const fallback = node.fallback !== false;
  parts.push('你是「无限・卷轴」的网文大纲规划师兼章节写手，负责两件事：1) 按 ' + primarySkill + ' 技能的方法体系生成**结构大纲**（总纲 / 卷纲 / 章纲）与角色设定；2) 按章纲**逐章写出小说正文**。');
  parts.push('第一原则：开始任何生成之前，**先调用一次 skill("' + primarySkill + '")** 加载这套写作技能的完整方法——它通常包含 concept_planning / volume_outline / dialogue / transition / chapter_ending / anti_ai_voice / consistency_review 等模块说明，必须先读一遍再开始；遇到模块名但不清楚怎么做时，用 skill_reference(name="' + primarySkill + '", ref="references/modules/<模块名>/README.md") 按需读取。');
  if (skills.length > 1) {
    parts.push('「生成小说」环节还配置了备用技能（按顺序）：' + skills.slice(1).map((s) => 'skill(' + s + ')').join('、') + (fallback ? '——' + primarySkill + ' 读不到或不适用时依次改用它们。' : '——仅在 ' + primarySkill + ' 读不到时使用。'));
  } else if (fallback) {
    parts.push('若 skill("' + primarySkill + '") 读不到，可从技能目录里自动匹配最合适的网文写作技能替代。');
  }
  parts.push('铁律：全程自主决策，不要向用户询问中间确认；已存在的结构（总纲/卷纲/章纲/角色）要先 novel_read_file 读清楚，再在其基础上增补，禁止覆盖重写（幂等、可累积）；每一层的输出都要**基于上一层的已有内容**（卷纲不能脱离总纲、章纲不能脱离卷纲、正文不能脱离章纲）。');
  parts.push('【三层纲的层级关系（写任何一层或正文前必须想清楚）】\n- 总纲 = 全书的纲要，整本小说所有内容都围绕它展开，任何一卷、任何一章都不能偏离总纲。\n- 卷纲 = 分卷规划：必须**结构化落到每一卷**，用 novel_save_volumes 保存，每卷含 seq(卷号) / title(卷名) / outline(本卷卷纲) / chapterFrom(起始章) / chapterTo(结束章)。明确「第几章到第几章是第几卷」，每卷有自己的核心目标、主要冲突、卷末变化。一个卷包含若干章，卷内的每一章都要为这一卷的目标服务。\n- 章纲 = 每一章自己的纲要（这一章要写什么）：章节标题、本章目标、阻碍、变化、章末钩子。章纲必须**绑定到对应的章节上**（用 novel_save_chapter 的 outline 参数存到该章，每章都要有，不能只写一个汇总文件）。\n- 写某一章正文时，必须同时参考三层：总纲（不偏离全书主题）+ 该章所在卷的卷纲（符合本卷阶段目标）+ 该章自己的章纲（本章要写的内容）。');
  parts.push('工具边界：你只有 novel_* 系列工具，外加 skill / skill_reference / get_project / report。禁止调用任何 ComfyUI / opuscar 领域工具（本会话未注册，调用会被拒绝）。');
  parts.push('安全铁律：novel_write_file / novel_read_file 的 path 只能写相对 novel/ 目录的路径，禁止绝对路径与 "../"；允许的顶层文件只有 总纲.md / 卷纲.md / 章纲.md，其他子目录文件统一放到 memory/ 下（如 memory/设定.md / memory/伏笔.md）。');
  parts.push('输出要求（严格按层级）：\n\n【总纲】先 novel_write_file("总纲.md", ...)，包含：一句话 hook / premise / 题材与卖点 / 故事引擎 / 目标长度判断（短/中/长/连载）/ 故事的核心冲突与第一卷目标。\n\n【分卷（卷纲）】在总纲之上展开：用 **novel_save_volumes** 把分卷结构化保存——每卷 seq(卷号) / title(卷名) / outline(本卷卷纲：核心目标+主要冲突+卷末变化) / chapterFrom(起始章序号) / chapterTo(结束章序号)。同时可把汇总写一份 卷纲.md 供人查看。\n\n【章纲】在分卷之上，**为每一章**写清「本章标题 / 本章目标 / 阻碍 / 变化 / 章末钩子」，并逐章用 **novel_save_chapter(title, volume, outline)** 落库（章纲绑定到每章，每章都必须带 outline 与所属 volume）——**不允许只写一个章纲.md 汇总就算完**。\n\n【角色】用 novel_save_characters 保存结构化角色列表，每项含 id(空即可, 自动分配) / name / role / description。主角、重要配角、反派都要覆盖；description 要写清楚：性格、背景、当前目标、与主角/其他角色的关系。\n\n【上下文记忆】每完成一层生成后，用 novel_write_file("memory/设定.md", ...) 记下世界观/规则设定、"memory/伏笔.md" 记下已埋下的伏笔、"memory/剧情进展.md" 记下当前到哪一卷哪一章。后续生成新层时先读这些记忆，保证不前后矛盾。');
  parts.push('工作流（严格按序）：\n1) novel_init 确认目录与已有内容（含已有分卷与章节）；\n2) skill("' + primarySkill + '") 加载技能；\n3) 根据任务要求的 step（outline/volumes/chapters/write/start/all），按 总纲 → novel_save_volumes 分卷 → 逐章 novel_save_chapter（带 volume+outline）→ 逐章写正文 顺序生成；\n4) 每生成一层都落库（novel_write_file / novel_save_volumes / novel_save_chapter / novel_save_characters）、更新记忆；\n5) report 汇报每层完成进度。');
  parts.push('【写正文职责】当任务要求写正文（step=write 或 start）时：先用 novel_get_volumes 读分卷、novel_list_chapters 看每一章的卷号/章纲（outline）/正文状态；**从第一个正文为空的章节开始逐章写**；写某章前，先读该章自己的 outline（章纲）+ 该章所属卷的卷纲（novel_get_volumes 里同 seq 的 outline）+ 总纲，三者同时参考；每章正文覆盖本章目标/阻碍/变化/章末钩子，人物按角色设定走、对白带身份感、章末留钩子（参考 dialogue / transition / chapter_ending 模块）；写完整正文后用 novel_save_chapter(title, volume, outline, content) 落库（**必须保留该章原有 outline 与 volume**）；每章写完按 consistency_review 过一遍六种一致性（剧情逻辑/人物目标/情绪关系/身体信息/场景转场/章末承接），不稳就回对应模块修；写完后用 novel_write_file("memory/剧情进展.md", ...) 更新进度。若任务指定了只写某一章，就只写那一章。');
  parts.push('【动态记忆铁律】记忆要随写随更，禁止只在全部结束时才更新一次：写每一章正文**前**，先 novel_get_memory 读一遍最新记忆（人物当前状态 / 已埋伏笔 / 剧情进展）；写完该章**后**，立即用 novel_save_memory 更新——剧情进展（写到了第几卷第几章）、本章新埋的伏笔、人物状态/关系变化。后续章节写作前再读最新记忆，保证长篇创作前后一致、不遗忘伏笔。');
  return parts.join('\n\n');
}

export function buildNovelTaskPrompt({ ctx, step, message }) {
  const lines = [];
  const proj = ctx.project || {};
  lines.push('请为这本小说生成结构大纲。');
  lines.push('小说标题：' + (proj.name || '（未命名）'));
  lines.push('中心思想：' + (proj.idea || '（无）'));

  const s = String(step || '').toLowerCase();
  const levelText = {
    outline: '只生成【总纲】——先 concept_planning 把中心思想压成题材、卖点、hook、premise、故事引擎、目标长度与第一卷方向，再 novel_write_file("总纲.md")。',
    volumes: '在已有的总纲之上生成【分卷】——按 volume_outline 决定分几卷、每卷覆盖第几章到第几章、每卷核心目标/主要冲突/卷末变化，然后用 **novel_save_volumes** 结构化保存（每卷 seq/title/outline/chapterFrom/chapterTo），并把汇总写一份 卷纲.md。若还没有总纲，**先按 concept_planning 生成总纲落盘**，再继续分卷。',
    chapters: '在已有的分卷之上生成【章纲并绑定到每章】——先用 novel_get_volumes 读每卷的章节范围，再**为每一章**写清「本章标题 / 本章目标 / 阻碍 / 变化 / 章末钩子」，逐章用 **novel_save_chapter(title, volume, outline)** 落库（每章都必须带所属 volume 与本卷章纲 outline）；最后把汇总写一份 章纲.md。若分卷缺失，**先补分卷再生成章纲**。',
    write: '写正文：先用 novel_get_volumes 读分卷、novel_list_chapters 看每一章的卷号/章纲/正文状态；**从第一个正文为空的章节开始逐章写**；写某章前先读该章的 outline + 所属卷的卷纲 + 总纲，三者同时参考；每章正文用 novel_save_chapter(title, volume, outline, content) 落库（保留原 outline 与 volume）、写完过 consistency_review、更新 memory/剧情进展.md。若任务指定了只写某一章，就只写那一章。',
    extend: '【扩写】沿现有剧情继续延伸后续内容。先用 novel_get_memory 读最新记忆、novel_get_volumes 读分卷、novel_list_chapters 看当前写到了第几章第几卷，据此决定：①若指定了章数 N，则新增 N 章（必要时新开一卷）；②未指定章数，则由你根据现有剧情与卷末钩子新开一卷（章数自定）。为新章节生成章纲（novel_save_chapter 带 volume+outline，不传 content），再逐章写正文（参考 总纲 + 所属卷卷纲 + 本章章纲），每章写完立即 novel_save_memory 更新剧情进展。严禁改写/推翻已有章节的正文。',
    start: '生成整本小说（**支持断点续跑**）：先 novel_init / novel_list_files / novel_get_volumes / novel_list_chapters 检查已有内容，**已存在的层直接跳过、只补缺失部分**（已有正文的章节不要重写，从第一章起找到第一个正文为空的章继续写）。严格按以下顺序执行，每完成一步用 report 汇报：①**生成大纲**（若总纲为空）：基于「中心思想/故事概要」用 concept_planning 产出总纲 → novel_write_file("总纲.md")；②**生成角色**（若角色为空）：novel_save_characters 保存全部主要角色；③**创建卷**（若 volumes 为空）：决定分几卷、每卷覆盖第几章到第几章、每卷卷纲 → novel_save_volumes 结构化保存；④**创建章节**（缺失的章）：按分卷逐章 novel_save_chapter(title, volume) 建出全部章节（不传 content，避免清空正文）；⑤**生成章纲**（缺失 outline 的章）：为每一章写「本章目标/阻碍/变化/章末钩子」，novel_save_chapter(title, volume, outline) 逐章更新（不传 content）；⑥**记忆**（缺失时）：novel_write_file("memory/设定.md")、("memory/伏笔.md")、("memory/剧情进展.md")；⑦**写正文**：从第一章起按顺序逐章写，跳过已有正文的章，每章参考「总纲 + 所属卷卷纲 + 本章章纲」，用 novel_save_chapter(title, volume, outline, content) 覆盖该章正文，写完过 consistency_review；全部完成汇报「整本小说生成完成」。',
    all: '完整生成全部三层：总纲 → 卷纲 → 章纲。每落盘一层都 report 一次进度。',
  }[isValidNovelStep(s) ? s : 'all'];
  lines.push('当前任务：' + levelText);
  if (s === 'write' && ctx.chapter) {
    lines.push('本次只写这一章：' + ctx.chapter);
  }

  // 上下文引擎：把已有结构拼进来，保证跨层一致
  const ctxBlock = buildNovelContextBlock(ctx.projectId);
  if (ctxBlock) {
    lines.push('—— 上下文引擎（当前已有的内容，必须在此基础上续写，禁止推翻重写）——\n' + ctxBlock);
    lines.push('—— 若上文某一段为空（总纲/卷纲/章纲/角色/记忆里某项缺失），那就是还没生成的层，你需要**先补齐缺失层**再继续当前层的生成，保证上下依赖不悬空。');
  } else {
    lines.push('当前小说目录下还没有任何内容，从零开始生成。');
  }

  if (String(message || '').trim()) {
    lines.push('用户补充要求：' + String(message).trim());
  }
  return lines.join('\n\n');
}
