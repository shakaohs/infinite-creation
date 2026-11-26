#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
h3_finalcheck.py —— 收尾复检闸门（两层：L0 大方向现实性 → F 组细则）

h3_lint.py 管「格式合不合规」，本脚本管「这么写，现实中成不成立、画出来会不会翻车」。

检查顺序不可颠倒：
    L0 · 大方向 —— 这一镜在现实中能不能发生（人靠什么待着、动作有没有中间态、
         同一个人在段内会不会瞬移、结果有没有来路）
    F  · 细则   —— 已经踩过的真机事故模式（F01~F13）

用法：
    python h3_finalcheck.py prompt.md                 # 两层全跑
    python h3_finalcheck.py prompt.md --logic         # 只跑 L0 大方向
    python h3_finalcheck.py prompt.md --strict        # WARN 也当 FAIL
    python h3_finalcheck.py prompt.md --allow F07     # 豁免条目
    python h3_finalcheck.py --list                    # 打印模式库
    python h3_finalcheck.py --selftest                # 自检正则

退出码：0 = 无 FAIL（可交付）；1 = 有 FAIL（阻断）；2 = 用法/读取错误
"""

import argparse
import re
import sys
from pathlib import Path

# ═══════════════════════════════════════════════════════════
# 词表
# ═══════════════════════════════════════════════════════════

LEVEL_RE = re.compile(
    r"water\s+(?:at|cutting across|across|around|up to|over|reaching)\s+"
    r"(?:his|her|their)\s+(?:collarbones?|chest|waist|armpits?|chin|shoulders?|throat|neck|ribs|knees|thighs)"
    r"|(?:his|her|their)\s+(?:collarbones?|chest|waist)\s+(?:above|below|clear of|at)\s+(?:the\s+)?(?:surface|water|sea)"
    r"|sunk to the (?:chest|waist|neck|shoulders?)"
    r"|water breaking across (?:his|her|their) (?:chest|waist|shoulders?)"
    r"|only (?:his|her|their) (?:forehead|head|face) and both fists above the surface"
    r"|half drown",
    re.I,
)

IN_WATER_RE = re.compile(
    r"\bin the (?:sea|water|surf|green water)\b|at the waterline|under the surface|"
    r"\bslips under|goes under|submerged|\bbobs?\b|\bbobbing\b|half-submerged|"
    r"drifts? in the (?:sea|water)",
    re.I,
)

LIFT_RE = re.compile(
    r"hangs?\s+off|hanging\s+off|hangs?\s+from|hanging\s+from|"
    r"weight pulls (?:both )?(?:his|her) arms straight|pulls (?:both )?(?:his|her) arms straight|"
    r"hauled clear|lifted clear|pulled clear of the water|hoisted",
    re.I,
)

STAND_BAN_RE = re.compile(
    r"stands? in the (?:water|sea|surf)|standing in the (?:water|sea|surf)|"
    r"floats?\s+upright|at the foot of the (?:hull|boat|ship|vessel)",
    re.I,
)

LEG_RE = re.compile(
    r"tread|treading|kick|kicking|scull|sculling|churn|churning|legs?\s+hang|legs?\s+trail|legs?\s+drift|"
    r"legs?\s+dangle|knees? (?:bent|drawn|fold)|feet churn|thighs working|feet\s+working|"
    r"trailing below the surface|just under the surface|under the surface|below the surface|beneath the water|"
    r"dangling in open water|deep water beneath|deep water below",
    re.I,
)

# 水下腿的动作证据（2026-11-04 四次真机后定 R5.2e）：
# `trail` / `drift` 是被动位移，只说「腿在那儿」，模型就补最省力姿态 = 双腿垂直下垂。
# 必须有屈膝 + 蹬水，否则既不是踩水也不像被拖。
KNEE_ACT_RE = re.compile(
    r"knees? (?:drawn|bent|fold\w*|up)|tread\w*|kicking|sculling|churning|"
    r"shins? (?:angled|kicking|sculling)|thighs? (?:forward|up|working)",
    re.I,
)
# 深度暗示词：用在腿上＝把腿往深处送（脚掉到 2 米下）。腿句里出现即判错。
DEPTH_HINT_RE = re.compile(
    r"legs?[^.;]{0,40}(?:below the surface|beneath the water|beneath the surface|"
    r"into the deep|in open water)|"
    r"feet[^.;]{0,25}(?:drifting|sinking)[^.;]{0,20}(?:beneath|below)",
    re.I,
)

# 浸没证据（2026-11-04 改口径）：英文 hang/dangle/suspend 默认语义是「吊起来」，
# 会压过水位描写 → 模型画出「吊在半空抓绳」。合格写法必须是「水面在哪 + 水包围身体」。
# 禁用：hang / dangling / suspended（人物，水镜内）
SUBMERGE_RE = re.compile(
    r"just under the surface|below the surface|beneath the water|beneath the surface|half-submerged|"
    r"waterline cutting across|water (?:washing|breaking|churning|slapping) (?:at|around|across|beside)|"
    r"waves (?:washing|breaking) (?:around|over|across)|drifting beneath|deep and dark|bottom out of sight",
    re.I,
)
# 深水豁免（2026-11-04 用户判定）：水位到锁骨/下巴时，膝盖在水面下半米，
# 水浊 + 折射，腿本来就看不见。此时不写腿是**正确**的；硬写反而被补成「双腿垂直垂到底」。
# 合法写法：承认看不见 —— `the water is deep and dark beneath him`。
DEEP_RE = re.compile(
    r"deep and dark|deep,? (?:and )?black|bottom out of sight|no bottom|deep water (?:beneath|below)|"
    r"the sea is deep", re.I)
# 悬垂语义（人物水镜内一律拦截；绳/头发/布幡等物件除外）
HANG_RE = re.compile(
    r"\b(?:hang|hangs|hanging|hung|dangle|dangles|dangling|suspend|suspends|suspended)\b", re.I)
HANG_OBJ_RE = re.compile(
    r"hawser|rope|line|cable|wire|hair|curtain|cloth|smoke|mist|fog|banner|lantern|"
    r"sleeve|hem|jacket|coat|flag", re.I)

HIGH_GRIP_RE = re.compile(
    r"(?:hooked|hooking|gripping|grips|clutching)\s+(?:over|onto|on)\s+(?:a\s+|the\s+)?"
    r"(?:lower\s+)?(?:rail|railing|gunwale rail|deck rail)",
    re.I,
)

WAVE_FROM_ABOVE_RE = re.compile(
    r"(?:beyond|over|above)\s+the\s+(?:rail|railing|gunwale|deck)\b|"
    r"from the deck above|slams? down|pours? down|drops? down from",
    re.I,
)
WAVE_RE = re.compile(r"\bwave\b|\bswell\b|\bsurge\b|breaker|wall of water", re.I)

CLOSEUP_RE = re.compile(r"close[- ]?up|tight close|extreme close", re.I)
# 下沉/没顶的镜：人正在离场，不适用「水位 + 腿」四件套
SINK_RE = re.compile(
    r"slips? under|goes under|sinks? below|the sea closes|surface closes|"
    r"the water closes over|head under the surface", re.I)
ENV_ANCHOR_RE = re.compile(
    r"behind|blurred|out of focus|soft focus|deck|hull|railing|bulkhead|wall|brick|"
    r"doorframe|door frame|doorway|door edge|door panel|car door|doorway|boards|planking|steel|window|bed|curtain|shelf|table|"
    r"car\b|roof|gate|courtyard|stairs?|floor|ground|frame edge",
    re.I,
)

SUBJ_RE = re.compile(r"<Subject\s*(\d+)>")

VO_RE = re.compile(r"voiceover|off-screen voice", re.I)
MOUTH_RE = re.compile(r"mouth opens|mouth working|lips part|lips move|speaks aloud", re.I)

DECK_RE = re.compile(r"on the (?:side )?deck|at the railing|on the sloping deck|on the wet deck|on board", re.I)
CLIMB_RE = re.compile(
    r"climbs?|climbing|hauls? himself|pulls? himself|leg over|foot on the|scrambles?|"
    r"drags? himself up|boosts? him|comes? up over|knee on the|one knee on|"
    r"(?:gets?|hauls?|pulls?|drags?|climbs?|swings?) (?:up )?over the (?:gunwale|rail|railing)", re.I)

SHIP_WORDS = re.compile(r"\bhull\b|\bboat\b|\bvessel\b|\bship\b|\bhawser\b|\brope\b|\bline\b|\bdeck\b|\brailing\b|\bporthole", re.I)
HUMAN_WORDS = re.compile(r"\bman\b|\bwoman\b|\bboy\b|\bgirl\b|\bhe\b|\bshe\b|\bhis\b|\bher\b|\bface\b|\bcoat\b|\bhair\b|\bjacket\b", re.I)

SEG_HDR = re.compile(r"^#{1,4}\s*段\s*(\d+)|^\s*段\s*(\d+)\s*[｜|·:：]")

# ── G 组：全介质现实性（不止水）
G01_AIR = re.compile(
    r"floats? (?:in|into|through) the air|hovers?|rises? into the air|"
    r"lifted off (?:his|her|the) feet|levitat|suspended in mid-?air", re.I)

# 医疗：本剧核心（外科 / 卫生院 / 急救）
G02_STETH = re.compile(r"stethoscope|listening to (?:his|her) chest|the bell of the", re.I)
G02_CLOTHED = re.compile(r"over (?:his|her) (?:shirt|coat|jacket|sweater|tunic|uniform)|through (?:his|her) (?:shirt|clothes)", re.I)
G02_IV = re.compile(r"\bIV\b|intravenous|drip stand|infusion|saline bag", re.I)
G02_IVLOW = re.compile(r"bag (?:hangs?|sits?|stands?|rests?)? ?(?:below|lower than|under) (?:his|her|the patient)", re.I)
G02_CPR = re.compile(r"chest compressions?|CPR|presses? down on (?:his|her) chest|resuscitat", re.I)
G02_CPRPOS = re.compile(r"centre of (?:his|her) chest|center of (?:his|her) chest|on the sternum|"
                        r"both hands (?:stacked|locked|on)|heel of one hand|arms straight", re.I)
G02_SITUP = re.compile(r"(?:sits?|sitting) (?:straight )?up|bolts? upright|jerks? upright", re.I)
G02_SEVERE = re.compile(r"badly (?:hurt|injured|wounded)|critical|dying|bleeding out|unconscious|"
                        r"head wound|stabbed|crushed", re.I)
G02_PROP = re.compile(r"props? (?:himself|herself)|on (?:his|her) elbows?|pushes? (?:himself|herself) up|"
                      r"with (?:his|her) hands|someone (?:lifts|helps)|supported by", re.I)

# 火与烟
G03_SMOKEDOWN = re.compile(r"smoke (?:sinks?|pours? down|drops?|settles? downward|rolls? down)|"
                           r"smoke (?:hangs?|drifts?) down", re.I)
G03_BURN = re.compile(r"burned? (?:black|to charcoal) instantly|charred? (?:black )?(?:at once|immediately|instantly)", re.I)

# 雨雪
G04_WET = re.compile(r"\brain\b|\braining\b|\brains\b|downpour|\bsnow(?:ing|fall|y)?\b|sleet|drizzle", re.I)
G04_WETRESULT = re.compile(r"soaked|drenched|dripping|wet through|rain running|water running off|"
                           r"snow (?:caught|settled|on)|crusted with|frost in", re.I)

# 载具惯性
G05_VEHICLE = re.compile(
    r"\b(?:car|truck|van|bus|train|ship|boat|ferry|yacht|lift|elevator|escalator)\b|"
    r"\bkerb\b|\bcurb\b|steering|the wheel|behind the wheel|driver's seat|traffic|the lane|the driver", re.I)
G05_MOVE = re.compile(r"pulls? away|brakes?|takes? a corner|turns? the corner|accelerat|starts? (?:off|forward|up)|"
                      r"lurches?|hits? a pothole|bumps? over", re.I)
G05_BODYREACT = re.compile(r"weight (?:sinks|shifts|rocks|goes)|rocks? against|braces?|stumbles?|"
                           r"leans? (?:into|against)|shoulder (?:hits|rocks)|sways?|grabs? the", re.I)

# 人群僵死
G06_FROZEN = re.compile(
    r"(?:crowd|group|everyone|all of them|the people|the onlookers)[^.;]{0,40}?"
    r"(?:stands?|stays?|remains?|waits?)[^.;]{0,20}(?:completely |perfectly )?(?:still|motionless|frozen)|"
    r"everyone (?:is )?frozen|like (?:statues?|wax figures?)|frozen in place", re.I)

# 承重
G07_LIFT = re.compile(r"(?:lifts?|carries?|picks? up|scoops? up) (?:him|her|the man|the woman|the body|the patient|the boy|the girl)", re.I)
G07_NATURE = re.compile(r"swell|wave|surge|\bsea\b|current|\bwind\b|tide|backwash|flood|"
                          r"the water (?:lifts|takes|carries)", re.I)
G07_HELP = re.compile(r"both arms|two (?:men|people|orderlies)|with help|helped by|on a stretcher|"
                      r"over (?:his|her) shoulder|fireman|piggyback|with (?:his|her) shoulder under", re.I)


REGRESS = [
    (re.compile(r"\bsoaked\b|\bdrenched\b|\bsoaking\b|\bwet through", re.I),
     re.compile(r"\bdry (?:jacket|shirt|coat|clothes|sleeve)\b|\bdries\b", re.I),
     "衣物由湿回干"),
    (re.compile(r"\bparted\b|\bparting\b|\bsnapped\b|\btorn\b|\bgave way\b", re.I),
     re.compile(r"\bstays? intact\b|\bwhole again\b|\bunbroken\b|\bstill sound\b", re.I),
     "绳索断后恢复完好"),
    (re.compile(r"\bkneels?\b|\bkneeling\b|\bgoes down on\b", re.I),
     re.compile(r"\bgets? (?:back )?to (?:his|her) feet\b|\bstands? up again\b", re.I),
     "倒地后无起身过程直接站起"),
]

RESULTS_NO_SOURCE = re.compile(
    r"\balready (?:on|standing on|seated on) the (?:deck|side deck)\b|"
    r"\bnow on the (?:side )?deck\b|\bhas climbed\b|\bhaving climbed\b|\bback on the deck\b",
    re.I,
)

ANCHOR_RE = re.compile(
    r"hull|deck|railing|gunwale|waterline|porthole|surface|the sea|the water|"
    r"car\b|door|doorway|gate|courtyard|yard|house|room|street|road|gravel|threshold|"
    r"wall|window|stair|floor|ground|table|bed|"
    r"same (?:place|spot|position)|still at|stays? at|beside|behind|in front of|"
    r"two steps|one step|frame left|frame right",
    re.I,
)

LOCATIVE_RE = re.compile(
    r"in the (?:sea|water|surf|green water)|on the (?:side |sloping |wet )?deck|"
    r"at the (?:railing|waterline)|over the railing|on board|"
    r"half-submerged|\bbobs?\b|\bbobbing\b|below the surface|beneath the water",
    re.I,
)


def nearest_medium(line, tag):
    """按主体就近原则判这个人在水里还是在甲板上，避免整句一刀切。"""
    locs = []
    GAZE_RE = re.compile(r"eyes?\s+(?:on|to|at)|gaz\w+\s+(?:on|at|toward)|"
                         r"look(?:s|ing)?\s+(?:at|up at|down at|toward|towards)|star\w+\s+at", re.I)
    for m in LOCATIVE_RE.finditer(line):
        # 视线落点不是站位：`his eyes on the deck` 不等于他在甲板上
        if GAZE_RE.search(line[max(0, m.start() - 18):m.start()]):
            continue
        g = m.group(0).lower()
        is_water = bool(re.search(r"sea|water|submerged|\bbob|surface|beneath", g))
        locs.append((m.start(), "water" if is_water else "deck"))
    if not locs:
        return None
    best, bd = None, 10 ** 9
    for m in re.finditer(rf"<Subject\s*{tag}>", line):
        for pos, med in locs:
            d = abs(m.start() - pos)
            if d < bd:
                bd, best = d, med
    return best if bd <= 90 else None



def clip(s, n=100):
    s = re.sub(r"\s+", " ", s).strip()
    return s if len(s) <= n else s[:n] + "…"


def sentences(line):
    return [s for s in re.split(r"[;.]\s+", line) if s.strip()]


def load(path: Path):
    return path.read_text(encoding="utf-8-sig", errors="replace").splitlines()


def subject_roles(lines):
    """从 subject_definitions 判每个人是人物还是物件。"""
    roles, cur = {}, None
    for ln in lines:
        m = re.match(r"^\s*<Subject\s*(\d+)>\s*(?:is|（|:)", ln)
        if m:
            cur = m.group(1)
            roles[cur] = "human" if (HUMAN_WORDS.search(ln) and not SHIP_WORDS.search(ln[:60])) else "object"
    return roles


def numbered(lines):
    out, cur = [], 1
    for i, ln in enumerate(lines, 1):
        m = SEG_HDR.search(ln)
        if m:
            cur = int(m.group(1) or m.group(2))
        out.append((i, cur, ln))
    return out


def scan(path: Path):
    lines = load(path)
    roles = subject_roles(lines)
    objects = {k for k, v in roles.items() if v == "object"}

    def is_human(tag):
        return tag not in objects
    rows = numbered(lines)
    hits, logic = [], []

    def add(sev, code, rule, line_no, seg, ev, hint):
        hits.append(dict(code=code, sev=sev, rule=rule, line=line_no, seg=seg, ev=clip(ev), hint=hint))

    # 段级累积：某人在某段出现过哪些介质
    seg_medium = {}

    for line_no, seg, ln in rows:
        s = ln.strip()
        if not s.startswith(("[Shot", "[reference")):
            continue
        is_shot = s.startswith("[Shot")
        tags = list(dict.fromkeys(SUBJ_RE.findall(ln)))

        def human_tags():
            return [t for t in tags if is_human(t)]

        hts = human_tags()

        # 逐句判定「这一句里，某个真人真的在水里吗」
        water_sents = []
        for st in sentences(ln):
            st_tags = [t for t in SUBJ_RE.findall(st) if is_human(t)]
            if st_tags and (IN_WATER_RE.search(st) or LEVEL_RE.search(st)):
                water_sents.append((st, st_tags))

        in_water = bool(water_sents)
        has_level = bool(LEVEL_RE.search(ln))

        # 段级介质登记（按主体就近归属）—— 只登记镜行。
        # 摘要行是整段概括，常在同一句里同时出现「甲板上一人 + 水里一人」，
        # 按句归属会把两人混成同一介质，产生 L03 假阳性。
        if is_shot:
            for t in hts:
                med = nearest_medium(ln, t)
                if med:
                    seg_medium.setdefault((seg, t), set()).add(med)

        # ── L01 结果无来路（大方向：动作链断了）
        if is_shot and RESULTS_NO_SOURCE.search(ln) and not CLIMB_RE.search(ln):
            add("FAIL", "L01", "L0 动作链", line_no, seg, ln,
                "直接写出「人已经在甲板上」的结果，却没有攀爬/被拽的动作步。补中间态，或拆镜")

        # ── L02 切镜后一个空间线索都没有（大方向：空间不连续）
        if is_shot and hts and not ANCHOR_RE.search(ln):
            add("WARN", "L02", "R1.2", line_no, seg, ln,
                "这一镜有人物但通篇没有一处空间线索（船体/甲板/水/位置词）。"
                "补 `in the sea at the hull` 或 `at the same railing, the wet deck boards behind her`")

        # ── F01 悬挂与水互斥（最致命）
        if has_level and LIFT_RE.search(ln):
            add("FAIL", "F01", "R5.2b", line_no, seg, ln,
                "同镜既写「人被吊起」又写水位，物理互斥，模型会把整个人提出水面。"
                "改 `hangs in the sea ... both hands up on the hawser`，绳只保住下巴")

        # ── F02 水中站姿禁词（任何位置都不许有）
        m = STAND_BAN_RE.search(ln)
        if m:
            add("FAIL", "F02", "R5.2", line_no, seg, ln,
                f"禁词「{m.group(0)}」= 一定被画成站在水里。改 `bobs half-submerged ... the water at his collarbones`")

        # ── F12 悬垂语义压过浸没语义（2026-11-04 真机事故 · 最高频）
        # 英文 hang / dangle / suspend 默认语义是「吊起来」，权重压过任何水位描写。
        # 只查人物水镜；绳、头发、布幡、烟等物件不算。
        if is_shot and in_water:
            for hm in HANG_RE.finditer(ln):
                ctx = ln[max(0, hm.start() - 45):hm.end() + 45]
                if HANG_OBJ_RE.search(ctx):
                    continue
                add("FAIL", "F12", "R5.2d", line_no, seg, ln,
                    f"水中人物用了悬垂词「{hm.group(0)}」——英文默认语义是「吊」，会压过水位描写，"
                    f"画出「脚沾水、身体吊在半空抓绳」。改 `bobs half-submerged` / `stays half-submerged`，深水补 "
                    f"`the sea deep and black beneath him`，浅水补 `his knees drawn up just under the surface`")
                break

        # ── F03 / F04 只有真的在水里才查
        if is_shot and in_water and not SINK_RE.search(ln):
            if not has_level:
                add("FAIL", "F03", "R5.1①", line_no, seg, ln,
                    "人在水里但没写水到身体哪个部位，模型自定水位。补 `the water at his collarbones`")
            if not LEG_RE.search(ln):
                if not DEEP_RE.search(ln):
                    add("FAIL", "F04", "R5.1③", line_no, seg, ln,
                        "没写腿 = 模型补站姿。深水（水位到锁骨）请写 `the water is deep and dark beneath him`；"
                        "浅水请写 `his knees drawn up just under the surface, his feet kicking`（禁 hang/dangling/trailing）")
            elif not SUBMERGE_RE.search(ln):
                add("WARN", "F04", "R5.1③", line_no, seg, ln,
                    "写了腿但缺「浸没证据」——水位只是抽象坐标，模型没有「水包围身体」的凭据就会画成吊着。"
                    "补 `water churning at his chest` / `waves washing around his shoulders` / `deep and dark beneath him`（禁 hang/dangling）")

            # ── F13 深水里的腿：看不见就别写（2026-11-04 用户判定 · R5.2e）
            # 水位到锁骨时膝盖在水面下半米，水浊 + 折射，腿本来不可见。
            # 硬写「腿在水下」会被补成「双腿垂直垂到画面底部」——第五次真机就是这么翻的。
            if DEPTH_HINT_RE.search(ln):
                add("FAIL", "F13", "R5.2e", line_no, seg, ln,
                    "给腿指定了深度（`legs trailing below the surface` / `feet drifting beneath`）——"
                    "模型会把腿画到 2 米深处垂直下垂。深水改 `the water is deep and dark beneath him`；"
                    "浅水改 `his knees drawn up just under the surface, his feet kicking`")
            elif LEG_RE.search(ln) and not KNEE_ACT_RE.search(ln):
                add("WARN", "F13", "R5.2e", line_no, seg, ln,
                    "腿只有位置没有动作 —— 被动位移会被补成静止垂直下垂。补屈膝 + 蹬水："
                    "`his knees drawn up just under the surface, his feet kicking`")
            if HIGH_GRIP_RE.search(ln):
                add("FAIL", "F05", "R5.3", line_no, seg, ln,
                    "甲板栏杆在水面以上，臂长够不到。改抓舷窗沿 / 垂下的绳 / 救生圈")

        # ── F06 浪只能水平撞
        if WAVE_RE.search(ln) and WAVE_FROM_ABOVE_RE.search(ln):
            add("FAIL", "F06", "R5.2", line_no, seg, ln,
                "浪从船舷/甲板翻下来逻辑不成立。改 `drives into the hull at the waterline, bursting upward`")

        # ── F07 人物特写无背景归属
        if is_shot and CLOSEUP_RE.search(ln) and hts and not ENV_ANCHOR_RE.search(ln):
            add("WARN", "F07", "R5.3b", line_no, seg, ln,
                "特写只写脸、没写背后三米是什么，会像抠图贴在背景板上。补一句背景实体"
                "（船上：`the wet deck boards behind her shoulder`；陆上：`the pale door frame behind him`）")

        # ── F08 画外音与口型冲突
        if VO_RE.search(ln) and MOUTH_RE.search(ln):
            add("FAIL", "F08", "R5.6b", line_no, seg, ln, "画外音镜不许写嘴在动。改 `his lips stay closed`")

        # ── F09 两个真人在同框却没相对位置
        if is_shot and len(hts) >= 2 and not re.search(
            r"frame left|frame right|left of|right of|uphill|downhill|ahead of|"
            r"on the left|on the right|to his left|to her right|to his right|to her left|"
            r"behind (?:him|her|them)|above (?:him|her|them)|below (?:him|her|them)|"
            r"one step|two steps|beside", ln, re.I):
            add("WARN", "F09", "R1.5", line_no, seg, ln,
                "两人同框没分左右前后，模型易画成同一张脸贴中间。补 `frame left / frame right` + 间距")

        # ── F11 状态回退
        for pre_re, post_re, why in REGRESS:
            if pre_re.search(ln) and post_re.search(ln):
                add("FAIL", "F11", "R5.7", line_no, seg, ln, why + "：同一镜内单向倒流")

    # ── L03 同一人在同段水里/甲板两处出现，却无过渡动作
    seg_rows = {}
    for line_no, seg, ln in rows:
        seg_rows.setdefault(seg, []).append((line_no, ln))
    for (seg, subj), med in seg_medium.items():
        if {"water", "deck"} <= med:
            seg_text = " ".join(l for _, l in seg_rows.get(seg, []))
            if not CLIMB_RE.search(seg_text):
                ln_no = next((n for n, l in seg_rows[seg] if f"<Subject {subj}>" in l), 0)
                add("FAIL", "L03", "L0 空间连续", ln_no, seg,
                    f"<Subject {subj}> 在同段既在水里又在甲板上，且无攀爬/被拽动作",
                    "一个人在段内从水里到甲板必须有中间步（抓绳→引体→踏壁→翻上），"
                    "否则成片就是他瞬移到甲板")

    # ── F10 段内提到道具却无几何句
    for seg, items in seg_rows.items():
        txt = " ".join(l for _, l in items)
        if re.search(r"hawser|mooring rope", txt, re.I) and not re.search(
                r"bitt|cleat|gunwale|porthole|into the water|below him|over the", txt, re.I):
            add("WARN", "F10", "R2.1", items[0][0], seg,
                "本段有缆绳但没有五环几何句", "补 `made fast round a bitt → over the gunwale → down the hull → through his fists → on into the water`")

    # ═══════════════════════════════════════════════════════════
    # G 组 · 全介质现实性（2026-11-04 增补：不止水里，别的介质同样会翻车）
    # ═══════════════════════════════════════════════════════════

    # ── G01 悬空：人/物凭空离地
    for m in G01_AIR.finditer(text_all := " ".join(l for _, _, l in rows)):
        seg_no = next((s for n, s, l in rows if m.group(0) in l), 1)
        add("FAIL", "G01", "R5 重力", 0, seg_no, m.group(0),
            "写「浮/悬/升空」但没有任何托举者——模型会把人画成飘着。"
            "补托举者，或改成有支撑的动词（stands / sits / lies / hangs from）")

    # ── G02 医疗操作失真（本剧核心：外科医生 / 卫生院 / 急救）
    for line_no, seg, ln in rows:
        if not ln.strip().startswith(("[Shot", "[reference")):
            continue
        # 隔衣听诊
        if G02_STETH.search(ln) and G02_CLOTHED.search(ln):
            add("WARN", "G02", "R5 医疗", line_no, seg, ln,
                "隔着衣服听诊——听诊器必须贴皮肤。补 `skin bared, the bell on his bare chest`")
        # 输液袋低于病人
        if G02_IV.search(ln) and G02_IVLOW.search(ln):
            add("FAIL", "G02", "R5 医疗", line_no, seg, ln,
                "输液袋低于病人——液体不会往上流。输液瓶必须高于穿刺点")
        # 心肺复苏没有按压位置
        if G02_CPR.search(ln) and not G02_CPRPOS.search(ln):
            add("WARN", "G02", "R5 医疗", line_no, seg, ln,
                "写了按压但没写手的位置。补 `both hands stacked on the centre of his chest, arms straight`")
        # 重伤者无支撑坐起
        if G02_SITUP.search(ln) and G02_SEVERE.search(ln) and not G02_PROP.search(ln):
            add("WARN", "G02", "R5 医疗", line_no, seg, ln,
                "重伤状态下直接坐起——真人做不到，必须经过撑肘/扶肩。补 `he props himself on one elbow`")

    # ── G03 火与烟方向
    for line_no, seg, ln in rows:
        if not ln.strip().startswith(("[Shot", "[reference")):
            continue
        m = G03_SMOKEDOWN.search(ln)
        if m:
            add("FAIL", "G03", "R5 火", line_no, seg, ln,
                f"烟「{m.group(0)}」——热烟只向上或横向铺开，不会向下沉。改 `smoke climbs` / `hangs in a low bank`")
        m2 = G03_BURN.search(ln)
        if m2:
            add("WARN", "G03", "R5 火", line_no, seg, ln,
                f"烧伤「{m2.group(0)}」——灼伤先红、起泡、后焦，不会瞬间炭化。改 `the skin reddening and blistering`")

    # ── G04 雨雪不作用于人
    for line_no, seg, ln in rows:
        if not ln.strip().startswith(("[Shot", "[reference")):
            continue
        if G04_WET.search(ln) and SUBJ_RE.search(ln) and not G04_WETRESULT.search(ln):
            add("WARN", "G04", "R5 雨雪", line_no, seg, ln,
                "写了雨/雪但人身上没有湿/积雪的结果——模型会画成雨落在玻璃外面。补 `rain running off his jaw` / `snow caught on her shoulders`")

    # ── G05 载具惯性没传到人
    for line_no, seg, ln in rows:
        if not ln.strip().startswith(("[Shot", "[reference")):
            continue
        if G05_VEHICLE.findall(ln) and G05_MOVE.search(ln) and SUBJ_RE.search(ln) and not G05_BODYREACT.search(ln):
            add("WARN", "G05", "R5 载具", line_no, seg, ln,
                "载具在起步/刹车/转弯，人却没有重心反应——会像贴在车厢里的贴纸。"
                "补 `his weight sinks a beat / rocks against the door`")

    # ── G06 人群僵死（蜡像感）
    for line_no, seg, ln in rows:
        m = G06_FROZEN.search(ln)
        if m and ln.strip().startswith(("[Shot", "[reference")):
            add("WARN", "G06", "R3 活人感", line_no, seg, ln,
                f"「{m.group(0)}」——全体静止＝蜡像。至少给背景人物一个具体小动作"
                "（`a woman in the crowd turns her head`）")

    # ── G07 承重不足
    for line_no, seg, ln in rows:
        if not ln.strip().startswith(("[Shot", "[reference")):
            continue
        m = G07_LIFT.search(ln)
        if m and not G07_HELP.search(ln) and not G07_NATURE.search(ln):
            add("WARN", "G07", "R5 承重", line_no, seg, ln,
                f"「{m.group(0)}」一个人抬成年人——现实中抬不动或会失衡。"
                "补第二个人 / 担架 / `with both arms under` 的抱法")

    hits.sort(key=lambda h: (h["seg"], h["line"], h["code"]))
    return hits, rows, roles


def logic_sheet(path, rows, roles):
    """L0 人眼复核表：每段列出 谁 / 在哪 / 靠什么待着 / 动作几步。"""
    segs = {}
    for line_no, seg, ln in rows:
        if ln.strip().startswith(("[Shot", "[reference")):
            segs.setdefault(seg, []).append(ln)
    print("L0 · 大方向现实性复核表（先看这张表，再看细则）")
    print("=" * 78)
    for seg in sorted(segs):
        shots = [l for l in segs[seg] if l.strip().startswith("[Shot")]
        txt = " ".join(segs[seg])
        who = sorted({t for t in SUBJ_RE.findall(txt)})
        where = []
        if IN_WATER_RE.search(txt): where.append("水")
        if DECK_RE.search(txt): where.append("甲板")
        if re.search(r"in the (?:1978|1988)|the courtyard|the gate", txt, re.I): where.append("陆上")
        support = []
        if re.search(r"hawser|rope|line\b", txt, re.I): support.append("绳")
        if re.search(r"railing|porthole|gunwale", txt, re.I): support.append("船体")
        if re.search(r"sits?|kneels?|stands? on|lies?|leans?", txt, re.I): support.append("自身支撑")
        steps = len(re.findall(r"\b(climbs?|hauls?|pulls? himself|kicks?|reaches?|grips?|locks?|drags?|turns?|lifts?)\b", txt, re.I))
        flag = ""
        if "水" in where and "绳" not in support and "船体" not in support:
            flag = "  ← 水里却无受力物：人凭什么不沉？"
        print(f"  段{seg:<2} 镜{len(shots):<2} 人物:<{','.join(who)}>  所在:{'/'.join(where) or '未写明'}"
              f"  受力:{'/'.join(support) or '无'}  动作步:{steps}{flag}")
    print("=" * 78)
    print("复核问法（每段一句，答不出就是方向错）：")
    print("  ① 这个人此刻靠什么待在那儿？（沉不下去/站得住/没被甩出去）")
    print("  ② 这个动作，真人身体做得出来吗？（力量、臂长、关节角度、时间）")
    print("  ③ 从这个状态到下一个状态，中间那一步在哪？")
    print()


def report(path, hits, allow, strict):
    hard = [h for h in hits if h["code"] not in allow and (h["sev"] == "FAIL" or strict)]
    soft = [h for h in hits if h["code"] not in allow and h["sev"] == "WARN" and not strict]
    print(f"收尾复检 · {path.name}")
    print("-" * 78)
    logic_hits = [h for h in hits if h["code"].startswith("L")]
    detail_hits = [h for h in hits if not h["code"].startswith("L")]
    for title, group in (("L0 大方向", logic_hits), ("F 组细则", detail_hits)):
        if not group:
            print(f"【{title}】通过")
            continue
        print(f"【{title}】")
        for h in group:
            tag = "SKIP" if h["code"] in allow else h["sev"]
            print(f"  [{tag}] {h['code']} 段{h['seg']} L{h['line']} ({h['rule']})")
            print(f"        证据：{h['ev']}")
            print(f"        改法：{h['hint']}")
    print("-" * 78)
    print(f"结果：FAIL {len(hard)} ｜ WARN {len(soft)}" + (f" ｜ 豁免 {len(allow)}" if allow else ""))
    if hard:
        print("判定：BLOCK。收尾复检未通过，不许投喂。")
        return 1
    print("判定：PASS。可投喂。")
    return 0


BANK = [
    ("L01", "FAIL", "L0", "结果无来路", "写出「人已在甲板」却没有攀爬动作步"),
    ("L02", "WARN", "L0", "切镜无位置锚", "有人物但没写他站哪、靠哪"),
    ("L03", "FAIL", "L0", "同段介质瞬移", "同一人同段既在水里又在甲板，无过渡动作"),
    ("F01", "FAIL", "R5.2b", "悬挂与水互斥", "hangs off + 水位同镜 → 人被提出水面，脚只沾水"),
    ("F02", "FAIL", "R5.2", "水中站姿禁词", "stands in the water / floats upright / foot of the hull"),
    ("F03", "FAIL", "R5.1①", "水镜缺没入线", "人在水里却没写水到哪"),
    ("F04", "FAIL", "R5.1③", "水镜缺腿状态", "没写腿 → 默认站姿（最致命）"),
    ("F05", "FAIL", "R5.3", "抓臂长之外", "水里手抓甲板栏杆"),
    ("F06", "FAIL", "R5.2", "浪从上方来", "浪从船舷翻下，逻辑不成立"),
    ("F07", "WARN", "R5.3b", "特写无背景归属", "特写只写脸 → 像抠图"),
    ("F08", "FAIL", "R5.6b", "画外音与口型冲突", "voiceover 镜写嘴在动"),
    ("F09", "WARN", "R1.5", "同框未分左右", "两真人同框无相对位置"),
    ("F10", "WARN", "R2.1", "道具无几何句", "有缆绳却无五环"),
    ("F11", "FAIL", "R5.7", "状态回退", "湿→干 / 断→完好 / 倒→起 / 血从有到无"),
    ("F12", "FAIL", "R5.2d", "悬垂语义压过浸没语义", "水镜里人物用 hang / dangle / suspend → 画成吊在半空抓绳"),
    ("F13", "FAIL", "R5.2e", "深水里给腿指定深度", "深水写 `legs trailing below the surface` → 腿垂到 2 米下；浅水写 `knees drawn up`"),
    ("G01", "FAIL", "R5 重力", "凭空悬空", "floats in the air / hovers / lifted off his feet，无托举者"),
    ("G02", "WARN", "R5 医疗", "医疗操作失真", "隔衣听诊 / 输液袋低于病人 / CPR 无按压位置 / 重伤者直接坐起"),
    ("G03", "FAIL", "R5 火", "火烟方向错", "烟向下沉 / 灼伤瞬间炭化"),
    ("G04", "WARN", "R5 雨雪", "雨雪不作用于人", "写了雨雪但身上不湿、不积雪"),
    ("G05", "WARN", "R5 载具", "惯性没传到人", "车起步/刹车/转弯，人无重心反应"),
    ("G06", "WARN", "R3 活人感", "人群僵死", "crowd stands completely still / like statues"),
    ("G07", "WARN", "R5 承重", "承重不足", "一个人抬成年人，无第二人/担架/抱法"),
]


def main():
    ap = argparse.ArgumentParser(add_help=True)
    ap.add_argument("file", nargs="?")
    ap.add_argument("--logic", action="store_true", help="只跑 L0 大方向复核表")
    ap.add_argument("--strict", action="store_true")
    ap.add_argument("--allow", default="")
    ap.add_argument("--list", action="store_true")
    ap.add_argument("--selftest", action="store_true")
    a = ap.parse_args()

    if a.list:
        print("收尾复检模式库（L0 大方向 → F01~F13 细则 → G 全介质）")
        print("-" * 78)
        for code, sev, rule, name, why in BANK:
            print(f"{code:4} [{sev:4}] {rule:8} {name}：{why}")
        return 0

    if a.selftest:
        probes = [
            # (编号, 样句, 判定函数, 期望是否命中)
            ("L01", "he is already on the deck", lambda s: bool(RESULTS_NO_SOURCE.search(s) and not CLIMB_RE.search(s)), True),
            ("L01", "he pulls himself up, leg over the rail", lambda s: bool(RESULTS_NO_SOURCE.search(s) and not CLIMB_RE.search(s)), False),
            ("F01", "he hangs off the hawser, the water at his collarbones", lambda s: bool(LEVEL_RE.search(s) and LIFT_RE.search(s)), True),
            ("F01", "he hangs in the sea, the water at his collarbones", lambda s: bool(LEVEL_RE.search(s) and LIFT_RE.search(s)), False),
            ("F02", "he floats upright against the hull", lambda s: bool(STAND_BAN_RE.search(s)), True),
            ("F03", "he hangs in the sea, both hands on the rope", lambda s: bool(IN_WATER_RE.search(s) and not LEVEL_RE.search(s)), True),
            ("F04", "in the sea at the hull, the water at his collarbones, the sea deep and black beneath him", lambda s: bool(IN_WATER_RE.search(s) and not LEG_RE.search(s) and not DEEP_RE.search(s)), False),
            ("F13", "his legs trailing below the surface, his feet drifting", lambda s: bool(DEPTH_HINT_RE.search(s)), True),
            ("F13", "the water at his chest, his knees drawn up just under the surface, his feet kicking", lambda s: bool(DEPTH_HINT_RE.search(s)), False),
            ("F05", "in the water, one hand hooked over a lower rail", lambda s: bool(HIGH_GRIP_RE.search(s)), True),
            ("F06", "a wave slams down over the rail", lambda s: bool(WAVE_RE.search(s) and WAVE_FROM_ABOVE_RE.search(s)), True),
            ("F06", "a wave drives into the hull at the waterline", lambda s: bool(WAVE_RE.search(s) and WAVE_FROM_ABOVE_RE.search(s)), False),
            ("F08", "in an off-screen voiceover, his mouth opens", lambda s: bool(VO_RE.search(s) and MOUTH_RE.search(s)), True),
            ("NEAR", "on the deck of <Subject 5>, <Subject 4> waves while <Subject 1> hangs off the hawser in the sea", lambda s: True, True),
        ]
        ok = True
        for code, txt, fn, need in probes:
            got = fn(txt)
            good = got == need
            ok = ok and good
            print(f"  {code:5}{'✓' if good else '✗'}  ({'应命中' if need else '不应命中'}) {txt[:56]}")
        # 就近归属：甲板句里提到的水里人，不能被算成在甲板
        m4 = nearest_medium("on the deck of <Subject 5>, <Subject 4> waves while <Subject 1> hangs off the hawser in the sea", "4")
        m1 = nearest_medium("on the deck of <Subject 5>, <Subject 4> waves while <Subject 1> hangs off the hawser in the sea", "1")
        near_ok = (m4 == "deck" and m1 == "water")
        print(f"  NEAR {'✓' if near_ok else '✗'}  同句两个人分属甲板/水里 → 4={m4} 1={m1}")
        ok = ok and near_ok
        print("自检：" + ("模式库全部正常。" if ok else "有正则或就近归属失效！"))
        return 0 if ok else 1

    if not a.file:
        ap.print_help()
        return 2
    p = Path(a.file)
    if not p.exists():
        print(f"读取失败：{p}")
        return 2
    hits, rows, roles = scan(p)
    if a.logic:
        logic_sheet(p, rows, roles)
        return 0
    logic_sheet(p, rows, roles)
    allow = {x.strip().upper() for x in a.allow.split(",") if x.strip()}
    return report(p, hits, allow, a.strict)


if __name__ == "__main__":
    sys.exit(main())
