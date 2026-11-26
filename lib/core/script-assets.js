// 从剧本文本抽取「场景 / 角色 / 道具」并建资产。
//
// 为什么需要这个：分镜表里没人会写道具列，场景列也常常没有；但投喂阶段【场景资产】栏必须有
// 东西可引用。资产本该在**读原文时**就建好（原文的场次头就写着地点、人物行写着谁在场），
// 而不是等导入分镜表时靠画面文字去猜——猜出来的名字还未必和资产库对得上。
//
// 抽取依据（都是剧本里本来就有的结构，不需要作者多写一个字）：
//   场次头：`1-1 日景 外 赛车场 / 赛道`  /  `【第3场｜夜｜内｜客厅】`  /  `场次：2-1 夜 内 卧室`
//   人物行：`人物: 斯洛恩（Sloane Ashford）、怀亚特（Wyatt）、现场媒体与观众`
//   道具：量词短语（一顶头盔 / 一份公文包）+ 常用道具词表
import { Assets } from './db.js';

// 群称/泛称不是角色（出现在「人物:」行里但不需要参考图）
const CROWD_WORDS = ['媒体', '观众', '记者群', '人群', '众人', '路人', '工作人员', '群众', '围观', '其他', '等'];

// 影视常见道具（用来兜量词漏掉的），命中即建；不含过于日常、几乎每场都有的物件
const COMMON_PROPS = ['婚纱', '头纱', '奖杯', '话筒', '麦克风', '手机', '行李箱', '收纳箱', '公文包', '头盔',
  '矿泉水', '毛巾', '图纸', '马克笔', '平板电脑', '方向盘', '笔记本', '戒指', '钥匙', '酒杯', '文件袋',
  '手包', '雨伞', '钢笔', '照片', '信件', '匕首', '长剑', '药瓶', '相机', '耳环', '项链', '腕表'];

const TIME_WORDS = '日景|夜景|清晨|黄昏|傍晚|深夜|白天|夜晚|日|夜';
const IN_OUT = '内|外|内外';

// 从剧本里抽出场景清单（含该场的在场人物）
export function extractScenesFromScript(script) {
  const text = String(script || '');
  const out = [];
  const lines = text.split(/\r?\n/);
  // 三套常见场次头，任选其一
  const RES = [
    /^\s*[【\[]?\s*(\d+[-－_]\d+)\s*[｜|]?\s*([^\s｜|】\]]*)\s*(日景|夜景|清晨|黄昏|傍晚|深夜|白天|夜晚|日|夜)?\s*(内|外|内外)?\s*[｜|]?\s*([^【】｜|\n]+)[】\]]?\s*$/,
    /^\s*[【\[]\s*第\s*(\d+)\s*场\s*[｜|]\s*([^｜|\]]*)\s*[｜|]\s*(内|外|内外)\s*[｜|]\s*([^】\]]+)[】\]]\s*$/,
  ];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    let hit = null;
    // 形式一：1-1 日景 外 赛车场 / 赛道
    const m1 = l.match(/^\s*(\d+[-－_]\d+)\s+(?:(?:\S+)\s+)?(内|外|内外)\s+(.+?)\s*$/);
    if (m1) hit = { no: m1[1], place: m1[3] };
    // 形式二：【第3场｜夜｜内｜客厅】
    if (!hit) {
      const m2 = l.match(/^\s*[【\[]\s*第\s*(\d+)\s*场\s*[｜|]\s*([^｜|\]]*)\s*[｜|]\s*(内|外|内外)\s*[｜|]\s*([^】\]]+)[】\]]\s*$/);
      if (m2) hit = { no: m2[1], place: m2[4] };
    }
    // 形式三：场次：2-1 夜 内 卧室
    if (!hit) {
      const m3 = l.match(/^\s*场\s*次\s*[：:]\s*(\d+[-－_]\d+)\s+(.+)$/);
      if (m3) {
        const rest = m3[2].replace(new RegExp('^(?:' + TIME_WORDS + ')\\s*', ''), '').replace(new RegExp('^(?:' + IN_OUT + ')\\s*'), '');
        hit = { no: m3[1], place: rest };
      }
    }
    if (!hit) continue;
    const place = String(hit.place).replace(/[／/]/g, '').replace(/\s+/g, '').replace(/[，,。；;]+$/, '').trim();
    if (place.length < 2) continue;
    // 该场次下的「人物:」行（最多往下看 6 行）
    const people = [];
    for (let j = i + 1; j < Math.min(i + 7, lines.length); j++) {
      const pm = lines[j].match(/^\s*(?:人物|出场人物|角色)\s*[：:]\s*(.+)$/);
      if (pm) { people.push(...splitPeople(pm[1])); break; }
      if (/^\s*\d+[-－_]\d+\s+/.test(lines[j])) break;
    }
    out.push({ no: hit.no, place, characters: people });
  }
  // 同名场景合并（同一地点出现多场）
  const merged = new Map();
  for (const s of out) {
    const k = s.place;
    if (!merged.has(k)) merged.set(k, { ...s, nos: [s.no] });
    else merged.get(k).nos.push(s.no);
  }
  return [...merged.values()];
}

function splitPeople(line) {
  return String(line || '')
    .split(/[、，,／/]+/)
    .map((x) => x.replace(/[（(][^）)]*[）)]/g, '').trim())
    .filter((x) => x.length >= 2 && x.length <= 8)
    .filter((x) => !CROWD_WORDS.some((w) => x.includes(w)));
}

// 一个场次头下往往有多个景（剧本按「场」分，不按「景」分）：EP1 的 1-1 里其实有
// 赛道、发布会、走廊、客厅、维修区、领奖台、车内七个地方。只建场次头会漏掉大半，
// 所以再扫一遍正文，用地名后缀词把「切到XX」里的地点捞出来。
const PLACE_SUFFIX = ['发布会现场', '发布现场', '颁奖现场', '现场', '大厅', '客厅', '卧室', '厨房', '书房',
  '办公室', '会议室', '走廊', '楼道', '电梯', '车库', '车间', '维修区', '赛道', '看台', '领奖台',
  '车内', '车里', '门口', '玄关', '阳台', '天台', '教室', '病房', '酒吧', '餐厅', '酒店', '机场',
  '码头', '街道', '庭院', '花园', '仓库', '直播间', '录音棚', '病房', '手术室'];

export function extractPlaceMentions(script) {
  const text = String(script || '');
  const found = new Set();
  // 按行清洗动词前缀再匹配后缀。不先清洗就会捞出「头切到走廊」「夜的汽车内」这种
  // 带动作碎片的假场景名（实测），建出来的资产名对不上任何画面描述。
  // 循环清洗：实际文本常是「▲ 镜头切到闪回画面：深夜的汽车内」，一层 replace 只吃一个前缀，
  // 剩下的「闪回画面：」「深夜的」会连进地名，建出「夜的汽车内」这种对不上任何画面的假场景。
  const cleanHead = (rawLine) => {
    let l = String(rawLine).replace(/^[\s▲△▍▼●\-*·]+/, '');
    for (let i = 0; i < 6; i++) {
      const before = l;
      l = l
        .replace(/^(?:镜头)?(?:切到|切回|切至|切换到|切|闪回|画面|回到|转到|转向|此时|同时|随后|接着|再)[：:]?/, '')
        .replace(/^(?:现实|室内|室外|白天|日景|夜景|深夜|夜晚|清晨|傍晚|黄昏|夜)(?:的)?/, '')
        // 动作前缀：「站在看台」「蹲在壁炉前」「坐在记者席」
        .replace(/^(?:站|坐|走|跑|靠|停|来|到|进|出|推|拉|抬|转|抱|蹲|躺|趴|望|看)(?:在|到|进|出|着|上|下|于)?/, '')
        .replace(/^[的了着在从向把将被让和与跟对到：:，,]+/, '')
        .trim();
      if (l === before) break;
    }
    return l;
  };
  for (const raw of text.split(/\r?\n/)) {
    // 场次头行跳过后缀扫描：它已经由 extractScenesFromScript 处理过，
    // 再扫一遍会把「1-1 日景 外 赛车场 / 赛道」的「赛道」单独建出来，和「赛车场赛道」重复。
    if (/^\s*\d+[-－_]\d+\s/.test(raw) || /^\s*[【\[]\s*第\s*\d+\s*场/.test(raw)) continue;
    let line = cleanHead(raw);
    if (!line) continue;
    for (const suf of PLACE_SUFFIX) {
      const at = line.indexOf(suf);
      if (at < 0) continue;
      // 前缀只取紧邻的 1–3 个名词字（「发布会」+现场、「赛车」+维修区）
      let pre = '';
      for (let k = 1; k <= 3; k++) {
        const ch = line[at - k];
        if (!ch || !/[\u4e00-\u9fa5A-Za-z0-9]/.test(ch)) break;
        pre = ch + pre;
      }
      pre = pre.replace(/^[的了着在从向把将被让和与跟对到]+/, '');
      // 前缀里还残留动作字（「站在看台」「蹲在壁炉前」）就整个丢掉前缀，只留后缀词。
      // 否则会建出「站在看台」这种名词——画面描述永远不会这么写，等于死资产。
      if (/[站坐走跑靠停来到进出推拉抬转抱蹲躺趴望看]/.test(pre)) pre = '';
      const name = (pre + suf).replace(/\s+/g, '');
      if (name.length >= 2 && name.length <= 10) found.add(name);
      break; // 一行只取最靠前的一处地名
    }
  }
  // 去重：短名被长名包含时只留长的（「赛道」⊂「赛车场赛道」、「现场」⊂「发布会现场」）。
  // 留着会让导入侧的包含匹配变成「命中两个」，反而不绑——建资产建出噪声比不建更糟。
  // 2 字场景名是合法的（走廊 / 客厅 / 车库），不能因为「是后缀词本身」就丢掉；
  // 泛称由下面的包含去重处理（「现场」⊂「发布会现场」、「赛道」⊂「赛车场赛道」）。
  const list = [...found].filter((n) => n.length >= 2);
  const kept = list.filter((n) => !list.some((m) => m !== n && m.length > n.length && m.includes(n)));
  return [...new Set(kept)];
}

// 从剧本里抽道具：量词短语优先，再用常用词表兜
export function extractPropsFromScript(script) {
  const text = String(script || '');
  const found = new Set();
  const re = /(?:一|两|三|几)(?:顶|瓶|件|个|把|条|只|台|部|张|份|串|副|支|根)([^\s，。、；：！？""''（）()]{2,6})/g;
  for (const m of text.matchAll(re)) {
    const w = m[1].replace(/^(?:新的|旧的|白色的|黑色的|红色的|一个|一只)/, '').trim();
    // 「一个闪亮的冠军奖杯」按量词切会得到「闪亮的冠军奖」（截断+带修饰），是噪声；
    // 这类交给下面的常用词表兜（词表里有「奖杯」，原文含「冠军奖杯」就能命中）。
    if (w.length >= 2 && w.length <= 5 && !w.includes('的') && !w.includes('了')) found.add(w);
  }
  for (const w of COMMON_PROPS) if (text.includes(w)) found.add(w);
  return [...found].slice(0, 24);
}

// 幂等建资产：已有同名（或唯一包含）就跳过，绝不重复建
export function ensureScriptAssets(projectId, script) {
  const created = [];
  const scenes = extractScenesFromScript(script);
  // 场次头 + 正文地名合并（场次头的名字优先，正文补充同场次内的其它景）
  for (const place of extractPlaceMentions(script)) {
    if (scenes.some((x) => x.place === place)) continue;
    scenes.push({ no: '', place, characters: [], nos: [] });
  }
  // 合并之后再去一次重：extractPlaceMentions 的内部去重看不到场次头建的名字，
  // 「赛道」就是这么漏出来的 —— 它只在正文里出现过，而同义的「赛车场赛道」来自场次头。
  {
    const kept = scenes.filter((x) => !scenes.some((o) => o !== x && o.place.length > x.place.length && o.place.includes(x.place)));
    scenes.length = 0;
    scenes.push(...kept);
  }
  const props = extractPropsFromScript(script);
  const chars = [...new Set(scenes.flatMap((s) => s.characters))];
  const pool = () => Assets.list(projectId);
  const exists = (name, category) => {
    const all = pool().filter((a) => a.category === category);
    const key = String(name).replace(/[^\u4e00-\u9fa5A-Za-z0-9]/g, '');
    if (!key) return null;
    const exact = all.find((a) => String(a.name).replace(/[^\u4e00-\u9fa5A-Za-z0-9]/g, '') === key);
    if (exact) return exact;
    const loose = all.filter((a) => {
      const an = String(a.name).replace(/[^\u4e00-\u9fa5A-Za-z0-9]/g, '');
      return an && (an.includes(key) || key.includes(an));
    });
    return loose.length === 1 ? loose[0] : null;
  };

  for (const s of scenes) {
    if (exists(s.place, 'scene')) continue;
    try {
      Assets.create(projectId, {
        category: 'scene',
        name: s.place,
        description: '剧本场景' + (s.nos && s.nos.length ? '（场次 ' + s.nos.join('/') + '）' : '') + '｜地点：' + s.place + (s.characters && s.characters.length ? '｜在场：' + s.characters.join('、') : ''),
      });
      created.push({ category: 'scene', name: s.place });
    } catch { /* 重名等异常忽略，不阻断 */ }
  }
  for (const n of chars) {
    if (exists(n, 'character')) continue;
    try {
      Assets.create(projectId, { category: 'character', name: n, description: '剧本人物（' + n + '）' });
      created.push({ category: 'character', name: n });
    } catch { /* ignore */ }
  }
  for (const n of props) {
    if (exists(n, 'prop')) continue;
    try {
      Assets.create(projectId, { category: 'prop', name: n, description: '剧本道具：' + n });
      created.push({ category: 'prop', name: n });
    } catch { /* ignore */ }
  }
  return { created, scenes, characters: chars, props };
}
