#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
h3_lint.py — MiniMax H3 提示稿机检（H1~H38 · 支持单段与多段合稿自动切分校验）

用法:
    python h3_lint.py prompt.md --duration 15
    python h3_lint.py multi_segments.md --duration 15          # 自动按段切分 + 跨段图槽一致性 H34
    python h3_lint.py multi_segments.md --duration 15 --whole  # 强制按单段整体解析
    python h3_lint.py prompt.json
    python h3_lint.py prompt.md --duration 12 --json

输入支持:
    1. 纯文本 / Markdown（单段或多段合稿）：用字段名做小标题（## detailed_description 或 detailed_description:）
    2. JSON 载荷：自动取 prompt 字段，duration 从 target.duration_seconds 读

退出码: 0 = 无 FAIL；1 = 有 FAIL；2 = 用法/读取错误
"""

import argparse
import json
import re
import sys
from pathlib import Path

CJK = re.compile(r"[\u4e00-\u9fff]")
FIELDS_SIX = [
    "subject_definitions",
    "summary",
    "retention_analysis",
    "detailed_description",
    "overall_soundscape",
    "non_diegetic_music",
]
FIELDS_THREE = [
    "integrated_multimodal_description",
    "overall_soundscape",
    "non_diegetic_music",
]
RETENTION_VISUAL = {
    "fully_preserved",
    "partially_preserved",
    "attribute_transfer",
    "weak_reference",
}
RETENTION_AUDIO = {
    "fully_copy",
    "partially_copy",
    "reference",
    "weak_reference",
}
NEGATION = [
    "不要", "禁止", "切勿", "避免", "不许", "不准", "不能有",
    "never", "do not", "don't", "avoid", "must not",
]
WORKFLOW_WORDS = [
    "末态继承", "拼接节点", "换机位", "轴线锁定", "180度", "180 度", "左A右B",
    "CAM1", "CAM2", "CAM3", "CAM4", "S0", "S1级", "S4",
]
CAMERA_JARGON = [
    "焦平面死锁", "呼吸式微动", "构图平整", "毫米级", "focal plane lock",
    "breathing micro", "millimeter",
]

# ==== H13 词根清洗 ====
STYLE_WHITELIST = [
    r"shallow depth of field", r"depth of field", r"deep focus", r"soft focus",
    r"film grain", r"grain", r"(?:35|16)mm", r"anamorphic", r"spherical lens",
    r"high contrast", r"low[- ]?key", r"high[- ]?key", r"colou?r temperature",
    r"cinematic realism", r"documentary realism", r"natural light",
]


def mask_style_terms(text: str) -> str:
    """把风格句里的质感术语遮掉，避免误判；否定词、构图词保留以便被抓。"""
    for pat in STYLE_WHITELIST:
        text = re.sub(pat, " ", text, flags=re.I)
    return text


HARD_CN = [
    "轴线", "越轴", "构图", "景别", "机位", "焦平面", "分镜", "镜号", "画幅",
    "声音", "响声", "传来", "回荡", "响起",
    "不要", "禁止", "切勿", "避免", "不许", "不准", "没有", "无人",
]
HARD_EN_PATTERNS = [
    r"\baxis\b", r"\b180[- ]?degree", r"\bfocal plane\b",
    r"\bstoryboard\b", r"\ba sound of\b", r"\bis heard\b",
    r"\bcomposition\b", r"\bframing\b", r"\bdepth of field\b", r"\bshot list\b",
    r"\bnot\b", r"\bnever\b", r"\bwithout\b", r"\bavoid\b", r"\bnothing\b",
    r"\bnobody\b", r"\bno one\b", r"\bdon't\b", r"\bdoesn't\b", r"\bisn't\b",
    r"\baren't\b", r"\bwon't\b", r"\bcannot\b", r"\bcan't\b", r"\black\b", r"\bno\b",
]
SOFT_CN = [
    "电影感", "高级感", "唯美", "氛围", "质感", "张力", "气场", "气势", "压迫感",
    "宿命", "孤独", "压抑", "暧昧", "情绪", "内心", "心理", "回忆", "往事",
    "阴险", "城府", "深沉", "沧桑", "犹豫", "挣扎", "假装", "故作", "试图",
    "仿佛", "宛如", "犹如", "非常", "极其", "十分", "格外", "微微", "略微",
    "突然", "猛地", "渐渐", "众人", "人群", "有人", "某人",
    "光斑", "受光", "亮起", "闪烁", "反光", "映出", "显然",
]
SOFT_EN_PATTERNS = [
    r"\bas if\b", r"\blike a\b", r"\bseems?\b", r"\bappears? to\b",
    r"\bvery\b", r"\bextremely\b", r"\bslightly\b", r"\bsomehow\b",
    r"\bsuddenly\b", r"\bemotion\b", r"\batmosphere\b", r"\btension\b",
    r"\bnervous\b", r"\bangry\b", r"\bsad\b", r"\bhappy\b", r"\bscared\b",
    r"\banxious\b", r"\bfurious\b", r"\bterrified\b", r"\bembarrassed\b",
    r"\bjealous\b", r"\bguilty\b", r"\bconfused\b", r"\bdetermined\b",
    r"\bdesperate\b", r"\bheartbroken\b", r"\buneasy\b", r"\brelieved\b",
    r"\bcoldly\b", r"\bwarmly\b", r"\bbitterly\b", r"\bexpression\b",
    r"\bfeelings?\b", r"\bmood\b",
    r"\baura\b", r"\bvibe\b", r"\bcinematic\b", r"\bmemory\b", r"\binner\b",
    r"\bline\b", r"\bframe\b", r"\bdepth of field\b", r"\bcomposition\b",
]

# 画幅识别：必须同时吃下三种真实写法，否则会静默漏检
#   9:16  半角冒号（标准）
#   9：16 全角冒号（中文输入法默认产出，最常见）
#   16x9  字母 x / × 分隔（口头与表格里常见）
# 时间码 00:06.000 靠前后「非数字/冒号/点」的边界排除，不会被当成画幅。
# x 写法只认官方六档，避免把 "3x3 网格" 之类的描述误当画幅。
ASPECT_RE = re.compile(
    r"(?<![\d:.:A-Za-z×])(\d{1,2})\s*[:：]\s*(\d{1,2})(?![\d:.:A-Za-z×])"
)
ASPECT_X_RE = re.compile(
    r"(?<![\d:.:A-Za-z×])(21|16|9|4|3|1)\s*[x×]\s*(9|16|4|3|1)(?![\d:.:A-Za-z×])",
    re.I,
)
_KNOWN_RATIOS = {"21:9", "16:9", "4:3", "1:1", "3:4", "9:16"}


def find_aspects(text: str):
    """返回稿子里出现的所有画幅（已规范化成半角 a:b，去重保序）。"""
    out = []
    for m in ASPECT_RE.finditer(text):
        a, b = int(m.group(1)), int(m.group(2))
        if 0 < a <= 32 and 0 < b <= 32:
            out.append(f"{a}:{b}")
    for m in ASPECT_X_RE.finditer(text):
        r = f"{int(m.group(1))}:{int(m.group(2))}"
        if r in _KNOWN_RATIOS:
            out.append(r)
    return list(dict.fromkeys(out))


class Report:
    def __init__(self):
        self.items = []  # (level, code, msg)

    def fail(self, code, msg):
        self.items.append(("FAIL", code, msg))

    def warn(self, code, msg):
        self.items.append(("WARN", code, msg))

    def ok(self, code, msg=""):
        self.items.append(("PASS", code, msg))

    @property
    def fails(self):
        return [i for i in self.items if i[0] == "FAIL"]

    @property
    def warns(self):
        return [i for i in self.items if i[0] == "WARN"]


def _aspect_of(obj):
    """从载荷里取画幅（兼容 aspect / aspect_ratio / ratio 三种字段名）。"""
    for k in ("aspect", "aspect_ratio", "ratio"):
        v = obj.get(k)
        if isinstance(v, str) and v.strip():
            return v.strip()
    return None


def _images_of(obj):
    for k in ("images", "image_urls", "media", "refs"):
        v = obj.get(k)
        if isinstance(v, list):
            return v
    return None


def load(path: Path, duration_override):
    """返回 (text, duration, images, aspect)。

    支持三种载荷：
      1. 单个对象 {prompt|content, images, aspect_ratio, target.duration_seconds}
      2. **清单数组**（`delivery.md §四` 的格式）——每段 {name,file,duration,aspect,images}，
         会自动去读同目录下的 `file` 指向的剥壳 .txt，再把多段拼起来喂给切分器。
      3. 纯文本 .md / .txt
    """
    # utf-8-sig：Windows 记事本 / Excel 导出常带 BOM，BOM 会粘在首字段名前面
    # （`\ufeffsubject_definitions`），导致六段式首字段认不出、连锁刷出一串假 FAIL。
    raw = path.read_text(encoding="utf-8-sig", errors="replace")
    if raw.startswith("\ufeff"):
        raw = raw.lstrip("\ufeff")
    duration = duration_override
    images = None
    aspect = None
    if path.suffix.lower() == ".json":
        data = json.loads(raw)

        # ---- 清单数组格式（delivery.md §四）----
        if isinstance(data, list):
            chunks, missing, seg_aspect = [], [], None
            for i, seg in enumerate(data):
                if not isinstance(seg, dict):
                    continue
                txt = seg.get("prompt") or ""
                fname = seg.get("file")
                if not txt and fname:
                    fp = (path.parent / fname)
                    if fp.exists():
                        txt = fp.read_text(encoding="utf-8-sig", errors="replace").lstrip("\ufeff")
                    else:
                        missing.append(fname)
                if txt:
                    chunks.append(txt)
                if images is None:
                    images = _images_of(seg)
                if seg_aspect is None:
                    seg_aspect = _aspect_of(seg)
                if duration is None:
                    duration = seg.get("duration")
            if not chunks:
                raise ValueError(
                    "这份清单里读不到任何稿子正文：请确认每个条目的 `file` "
                    "指向的 .txt 与本清单在**同一目录**，或条目里直接带 `prompt` 字段"
                    + (f"（缺失文件：{missing}）" if missing else "")
                )
            text = "\n\n".join(chunks)
            return text, duration, images, seg_aspect

        if not isinstance(data, dict):
            raise ValueError("JSON 顶层既不是对象也不是数组，无法当载荷读")

        # ---- 单对象格式 ----
        prompt = data.get("prompt") or ""
        if not prompt and isinstance(data.get("content"), list):
            prompt = "\n".join(
                c.get("text", "") for c in data["content"] if isinstance(c, dict)
            )
        if duration is None:
            target = data.get("target") or {}
            duration = target.get("duration_seconds") or data.get("duration")
        return prompt, duration, _images_of(data), _aspect_of(data)
    return raw, duration, images, aspect


def check_picture_overflow(text, images):
    """H36: 载荷图槽越界（正文最大 Picture N > images 数组长度）。

    只对自带 images 数组的载荷生效——这是唯一能自动判定"省图/漏传"的位置。
    剥壳 .txt 与纯文生稿没有 images，返回 None 不打扰。
    """
    if images is None:
        return None
    used = sorted({int(m.group(1)) for m in re.finditer(r"Picture\s+(\d+)", text, re.I)})
    if not used:
        return None                      # 纯 T2VA，不挂参考图
    n = len(images)
    mx = max(used)
    if mx > n:
        return ("fail", f"图槽越界：正文引用到 `Picture {mx}`，images 只有 {n} 张——"
                        f"省图/漏传会让后续槽位整体前移，轻则人景贴反，重则直接卡死")
    empties = [i + 1 for i, v in enumerate(images)
               if v is None or (isinstance(v, str) and not v.strip())]
    if empties:
        return ("fail", f"images 第 {empties} 个槽位是空值——空槽等同省图，后面槽位照样前移")
    if used != list(range(1, mx + 1)):
        missing = [i for i in range(1, mx + 1) if i not in used]
        return ("warn", f"Picture 编号不连续，正文没用到 {missing}——编号可以跳，但全片必须一致，"
                        f"且 images 对应槽位不能删")
    return ("ok", f"图槽未越界（正文引用 1..{mx}，images {n} 张）")


def split_multi_segments(text: str):
    """
    自动识别单文件内是否包含多段投喂稿。

    ⚠ 切分锚点必须只取**一个**字段：`subject_definitions` 与
    `integrated_multimodal_description` 是同一段里的两个不同字段，
    若两者都当起点，**任何单段稿都会被误切成两段**（剥壳后的 .txt 尤其明显，
    因为它就是"字段名纯文本独占一行"）。所以先在两类里选出现次数多的那个当锚，
    两类都不超过 1 次 ⇒ 单段。

    返回 [(seg_label, seg_text), ...]。若只有一段则返回 [(None, text)]。
    """
    def _anchor(field):
        return list(re.finditer(
            r"^[ \t]*(?:#{1,6}[ \t]*)?(?:\*\*|__)?`?" + field + r"`?(?:\*\*|__)?[ \t]*:?[ \t]*$",
            text, re.MULTILINE | re.IGNORECASE,
        ))

    subs = _anchor("subject_definitions")
    imds = _anchor("integrated_multimodal_description")
    # 次数相同优先 subject_definitions（它是每段真正的开头）
    starts = subs if len(subs) >= len(imds) else imds
    if len(starts) <= 1:
        return [(None, text)]
    segments = []
    for idx, m in enumerate(starts):
        s_pos = m.start()
        e_pos = starts[idx + 1].start() if idx + 1 < len(starts) else len(text)
        # 向前查找最近的段落标题（如 ## 段01 / 【段1】）
        prefix = text[max(0, s_pos - 200): s_pos]
        hdr = re.findall(r"(?:^|\n)[ \t]*(?:#{1,4}|\*\*|【)?[ \t]*(段\s*\d+[^\n】*]*)", prefix)
        label = hdr[-1].strip() if hdr else f"段{idx + 1:02d}"
        segments.append((label, text[s_pos:e_pos]))
    return segments


def split_sections(text):
    """按字段名切段。支持 Markdown 标题、粗体、冒号形式。"""
    names = "|".join(re.escape(f) for f in FIELDS_SIX + FIELDS_THREE)
    pattern = re.compile(
        r"^[ \t]*(?:#{1,6}[ \t]*)?(?:\*\*)?(`?" + names + r"`?)(?:\*\*)?[ \t]*:?[ \t]*$",
        re.MULTILINE,
    )
    marks = list(pattern.finditer(text))
    if not marks:
        return {}
    sections = {}
    for i, m in enumerate(marks):
        key = m.group(1).strip("`")
        start = m.end()
        end = marks[i + 1].start() if i + 1 < len(marks) else len(text)
        body = text[start:end].strip()
        body = re.sub(r"^[ \t]*:?[ \t]*", "", body)
        body = body.strip()
        if body.startswith("```"):
            body = re.sub(r"^```[a-zA-Z]*\n?", "", body)
            body = re.sub(r"\n?```$", "", body)
        sections[key] = body.strip()
    return sections


def strip_quoted(text):
    """去掉 <d>…</d> 与引号内内容，用于中文残留检查。"""
    t = re.sub(r"<d>.*?</d>", " ", text, flags=re.S)
    t = re.sub(r'"[^"]*"', " ", t)
    t = re.sub(r"“[^”]*”", " ", t)
    return t


def fmt_sec(sec):
    return re.search(r"(\d{2}):(\d{2})\.(\d{3})", sec)


def check(text, duration, aspect=None, strict_en=False):
    r = Report()
    secs = split_sections(text)
    body = ""

    # ---------- H1 字段集 ----------
    if not secs:
        r.fail("H1", "未识别到任何字段。请用 subject_definitions / detailed_description 等字段名做小标题。")
        return r
    present_six = [f for f in FIELDS_SIX if f in secs]
    present_three = [f for f in FIELDS_THREE if f in secs]
    if len(present_six) >= 5:
        mode = "six"
        missing = [f for f in FIELDS_SIX if f not in secs]
        if missing:
            r.fail("H1", f"六段式缺字段：{', '.join(missing)}")
        else:
            idx = [FIELDS_SIX.index(f) for f in present_six]
            if idx != sorted(idx):
                r.fail("H1", f"六段顺序错误，实测顺序：{' → '.join(present_six)}")
            else:
                r.ok("H1", "六段式字段齐全、顺序正确")
        body = secs.get("detailed_description", "")
    elif "integrated_multimodal_description" in secs:
        mode = "three"
        missing = [f for f in FIELDS_THREE if f not in secs]
        if missing:
            r.fail("H1", f"三字段缺字段：{', '.join(missing)}")
        else:
            r.ok("H1", "三字段齐全")
        body = secs.get("integrated_multimodal_description", "")
    else:
        r.fail("H1", "字段集不完整：既不是六段式也不是三字段。")
        mode = "unknown"
        body = text

    # ---------- H2 时间轴 ----------
    shots = list(re.finditer(r"\[Shot\s+(\d+)\]\s*", body))
    shots = [m for m in shots if not body[max(0, m.start() - 6): m.start()].lower().endswith("from ")]
    if not shots:
        r.fail("H2", "正文没有 [Shot N] 镜行")
    else:
        first = body[shots[0].end(): shots[1].start() if len(shots) > 1 else len(body)]
        if fmt_sec(first):
            r.fail("H2", "[Shot 1] 带了时间戳——首镜必须无时间戳")
        else:
            r.ok("H2", "[Shot 1] 无时间戳")

        nums = [int(m.group(1)) for m in shots]
        if nums != list(range(1, len(nums) + 1)):
            r.warn("H2", f"镜号不连续或未从 1 开始：{nums}")

        last_t = -1.0
        for i, m in enumerate(shots[1:], start=1):
            seg = body[m.end(): shots[i + 1].start() if i + 1 < len(shots) else len(body)]
            mm = re.search(r"At\s+(\d{2}):(\d{2})\.(\d{3})", seg)
            if not mm:
                r.fail("H2", f"[Shot {m.group(1)}] 缺 `At MM:SS.mmm,` 切点")
                continue
            t = int(mm.group(1)) * 60 + int(mm.group(2)) + int(mm.group(3)) / 1000
            if t <= last_t:
                r.fail("H2", f"[Shot {m.group(1)}] 切点 {t:.2f}s 未严格递增（上一镜 {last_t:.2f}s）")
            last_t = t
            if duration and t >= duration:
                r.fail("H2", f"[Shot {m.group(1)}] 切点 {t:.2f}s ≥ 段时长 {duration}s")

        if re.search(r"镜头切至|镜头切到|切换至|转场到", body):
            r.fail("H2", "出现中文切镜动词（镜头切至/切换至）——H3 不被绑定，会做成叠化融脸")
        if re.search(r"cross[- ]dissolve|fade (in|out)|wipe", body, re.I):
            r.warn("H2", "出现 cross-dissolve / fade / wipe——仅当用户明确要求时才可用")
        if re.search(r"升格|慢动作|slow motion|speed ramp", body, re.I):
            r.warn("H2", "出现升格/慢动作——实测破坏节奏，H3 可能渲染成静止")

    # ---------- H3 时长 ----------
    if duration is None:
        r.warn("H3", "未提供段时长，跳过 4–15s 校验（用 --duration 传入）")
    elif not (4 <= float(duration) <= 15):
        r.fail("H3", f"段时长 {duration}s 超出官方 4–15s")
    else:
        r.ok("H3", f"段时长 {duration}s 合规")

    # ---------- H4 正文语言 ----------
    scan = strip_quoted(body)
    cjk = CJK.findall(scan)
    if cjk:
        snippet = "".join(cjk[:20])
        if strict_en:
            r.fail("H4", f"正文出现 {len(cjk)} 个中文字符（<d> 与引号外，strict-en 模式硬拦）：{snippet}…；H3 写实模型只吃英文视觉词，镜行正文必须全英文")
        else:
            r.warn("H4", f"正文出现 {len(cjk)} 个中文字符（<d> 与引号外）：{snippet}…")
    else:
        r.ok("H4", "正文无中文残留")

    for d in re.finditer(r"<d>(.*?)</d>", body, flags=re.S):
        if not re.match(r"\s*\[[A-Za-z]+\]", d.group(1)):
            r.fail("H4", f"<d> 缺语言标签：[{d.group(1)[:20]}…] 应以 <d>[Chinese] 开头")

    # ---------- H5 标签 ----------
    defs_sec = secs.get("subject_definitions", "")
    defined = set(re.findall(r"<(Subject|Picture)\s+(\d+)>", defs_sec))
    used = set(re.findall(r"<(Subject|Picture)\s+(\d+)>", body))

    def tagfmt(tags):
        return ", ".join(f"<{k} {n}>" for k, n in sorted(tags, key=lambda x: (x[0], int(x[1]))))

    undefined = used - defined
    if undefined and defs_sec:
        r.fail("H5", f"正文引用了未定义标签：{tagfmt(undefined)}")
    # 2026-11-23 实测：<Picture N>/<Video N> 是图槽号，只在 subject_definitions 里绑定主体
    #（"<Subject 1> is the young woman in Picture 1"），detailed_description 正文只能用 <Subject N>。
    # 把 <Picture 2> 当主体写 "<Picture 2> stands..." 会让 H3 把参考图当人物画/身份错位 → FAIL。
    body_picture_tags = re.findall(r"<(?:Picture|Video)\s+\d+>", body)
    if body_picture_tags:
        r.fail("H5", f"detailed_description 正文出现图槽标签 {body_picture_tags[:6]}——<Picture N>/<Video N> 只在 subject_definitions 定义主体时用，正文必须写 <Subject N>（图槽号不是主体）")
    unused = defined - used
    if unused:
        r.warn("H5", f"定义了却未被引用（白占 9 图额度）：{tagfmt(unused)}")
    subj_nums = [n for k, n in defined if k == "Subject"]
    if len(subj_nums) > 9:
        r.fail("H5", f"Subject 定义 {len(subj_nums)} 个，超过图像上限 9")
    if defined:
        r.ok("H5", f"标签定义 {len(defined)} 个，正文引用 {len(used & defined)} 个")
    if re.search(r"@[A-Za-z\u4e00-\u9fff]{2,}", body):
        r.fail("H8", "正文出现 @ 锚点（如 @林越）——H3 侧必须全删")

    # ---------- H6 保留度 ----------
    ret = secs.get("retention_analysis", "")
    if ret:
        if re.search(r"\(S\d+\)", ret):
            r.fail("H6", "retention_analysis 里出现 (Sx)——该段不允许写说话人编号")
        marks = re.findall(r"\b([a-z_]{4,})\b", ret)
        bad = [
            m for m in marks
            if ("_" in m) and m not in RETENTION_VISUAL and m not in RETENTION_AUDIO
        ]
        if bad:
            r.fail("H6", f"非法保留度标记：{sorted(set(bad))}（只允许 fully_preserved / partially_preserved / attribute_transfer / weak_reference / fully_copy / partially_copy / reference）")
        elif not any(m in RETENTION_VISUAL or m in RETENTION_AUDIO for m in marks):
            r.warn("H6", "retention_analysis 未见任何保留度标记")
        else:
            r.ok("H6", "保留度标记合法")

    # ---------- H7 说话人编号 ----------
    sx_seq = re.findall(r"\(S(\d+)\)", body)
    if sx_seq:
        nums = [int(x) for x in sx_seq]
        first_seen = []
        for n in nums:
            if n not in first_seen:
                first_seen.append(n)
        if first_seen != sorted(first_seen):
            r.warn("H7", f"(Sx) 首现顺序不是 1,2,3…：{first_seen}")
        elif first_seen[0] != 1:
            r.warn("H7", f"(Sx) 未从 (S1) 开始：{first_seen}")
        else:
            r.ok("H7", f"(Sx) 编号顺序正确：{first_seen}")

    # ---------- H8 泄漏（结构级） ----------
    if "【" in body or "】" in body:
        hit = re.findall(r"【[^】]{1,12}】", body)
        r.fail("H8", f"正文出现七段式栏名：{hit[:5]}")
    wf_body = re.sub(r"\(S\d+\)", " ", body)
    wf = [w for w in WORKFLOW_WORDS if w in wf_body]
    if wf:
        r.warn("H8", f"正文含工程/工作流词：{wf[:5]}")
    jargon = [w for w in CAMERA_JARGON if w in body]
    if jargon:
        r.warn("H8", f"正文含摄影机说明书：{jargon[:3]}")
    if re.search(r"[┌┐└┘│─┬┴┼]", body):
        r.fail("H8", "正文出现 ASCII 框图")
    if re.search(r"\b(?:x|X)\s*[:=]\s*-?\d+(?:\.\d+)?\s*[,，]\s*(?:y|Y)\s*[:=]", body):
        r.fail("H8", "正文出现坐标表")

    # ---------- H13 词根清洗（只在镜行分号之后扫） ----------
    shot_bodies = []
    no_split = []
    for i, m in enumerate(shots):
        seg = body[m.end(): shots[i + 1].start() if i + 1 < len(shots) else len(body)]
        if ";" in seg:
            head, tail = seg.split(";", 1)
            tail = re.sub(r"<d>.*?</d>", " ", tail, flags=re.S)
            shot_bodies.append((int(m.group(1)), head.strip(), tail.strip()))
        else:
            no_split.append(int(m.group(1)))
            shot_bodies.append((int(m.group(1)), "", seg.strip()))
    if no_split:
        r.warn("H13", f"镜行缺分号分区（无法区分镜行头/正文）：Shot {no_split[:6]}")

    joined = "\n".join(b[2] for b in shot_bodies)
    pre = body[: shots[0].start()] if shots else body
    pre_masked = mask_style_terms(pre)
    hard_scan = (pre_masked.strip() + "\n" + joined) if pre_masked.strip() else joined
    soft_scan = joined
    if hard_scan.strip():
        hard_cn = [w for w in HARD_CN if w in hard_scan]
        hard_en = [p for p in HARD_EN_PATTERNS if re.search(p, hard_scan, re.I)]
        if hard_cn or hard_en:
            detail = hard_cn[:6] + [p.strip("\\b") for p in hard_en[:6]]
            hit_shots = [
                n for n, _h, t in shot_bodies
                if (any(w in t for w in hard_cn) or any(re.search(p, t, re.I) for p in hard_en))
            ]
            where = f"（Shot {hit_shots[:8]}）" if hit_shots else "（开场句）"
            r.fail("H13", f"命中硬词根 {detail} → 会被直接画出来{where}")

        soft_cn = [w for w in SOFT_CN if w in soft_scan]
        soft_en = [p for p in SOFT_EN_PATTERNS if re.search(p, soft_scan, re.I)]
        if soft_cn or soft_en:
            detail = soft_cn[:6] + [p.strip("\\b") for p in soft_en[:6]]
            r.warn("H13", f"镜行正文含软词根 {detail} → 建议换成可见事实")

        if not (hard_cn or hard_en or soft_cn or soft_en):
            r.ok("H13", "镜行正文词根干净")

        head_bad = [
            w for n, h, _t in shot_bodies for w in SOFT_CN if w in h
        ]
        if head_bad:
            r.warn("H13", f"镜行头（分号前）混入非镜头语法词：{list(dict.fromkeys(head_bad))[:5]}")

    # ---------- H15 运镜缺位移量 ----------
    MOVE_RE = re.compile(
        r"\b(push(?:es)? in|pull(?:s)? back|doll(?:y|ies)|track(?:s|ing)?|slide(?:s|ing)?|"
        r"moves? (?:forward|back)|camera (?:advances?|retreats?))\b",
        re.I,
    )
    METRIC_RE = re.compile(r"\d+(?:\.\d+)?\s*(?:cm|centimet|毫米|厘米)", re.I)
    DURATION_RE = re.compile(
        r"\b(?:over|for|in|within)\s+(?:\w+\s+){0,2}(?:second|sec|秒|half a second)", re.I
    )
    no_metric, no_dur = [], []
    for n, h, _t in shot_bodies:
        if MOVE_RE.search(h):
            if not METRIC_RE.search(h):
                no_metric.append(n)
            elif not DURATION_RE.search(h):
                no_dur.append(n)
    if no_metric:
        r.warn("H15", f"运镜缺位移量（写厘米级，如 sliding forward 12 cm over three seconds）：Shot {no_metric[:8]}")
    if no_dur:
        r.warn("H15", f"运镜有位移量但缺时长（补 over three seconds，否则 H3 会一秒推完）：Shot {no_dur[:8]}")
    if not no_metric and not no_dur and any(MOVE_RE.search(h) for _n, h, _t in shot_bodies):
        r.ok("H15", "推拉均带位移量与时长")

    # ---------- H16 禁用运镜 ----------
    BANNED_MOVE = {
        "升格": r"升格", "慢动作": r"慢动作|慢镜", "slow motion": r"\bslow[\s-]?mo(?:tion|mo)?\b",
        "Hit-Stop": r"hit[\s-]?stop|顿挫|顿帧", "定格": r"\bfreeze[\s-]?frame\b|定格",
        "急速变焦": r"snap[\s-]?zoom|急速?变焦|甩镜",
        "滑动变焦": r"dolly[\s-]?zoom|滑动变焦|希区柯克变焦",
        "变速": r"speed[\s-]?ramp|time[\s-]?ramp|变速",
        "摇臂": r"\bcrane\b|摇臂",
        "Snorricam": r"snorricam",
    }
    banned_hit = {}
    for label, pat in BANNED_MOVE.items():
        m = re.search(pat, text, re.I)
        if m:
            banned_hit[label] = m.group(0)
    if banned_hit:
        r.fail("H16", f"禁用运镜（H3 做不出来）：{banned_hit} → 见 camera-movement.md §1.4 替代方案")
    else:
        r.ok("H16", "无禁用运镜")

    bare_zoom = [
        m.group(0) for m in re.finditer(r"[^.]{0,28}\bzooms?\b[^.]{0,20}", text, re.I)
        if not re.search(r"lens\s+zooms?|\bzooms?\s+(?:in|out)", m.group(0), re.I)
    ]
    if bare_zoom:
        r.warn("H16", f"裸 zoom 可能被渲染成镜头筒：绑到 lens 上写 `the lens zooms in` → {bare_zoom[:3]}")

    # ---------- H17 运镜 × 景别矛盾 ----------
    CLOSE_RE = re.compile(r"\b(?:extreme close|close)[\s-]?up\b", re.I)
    WIDE_RE = re.compile(r"\b(?:wide|full|long|establishing)\s+shot|extreme wide", re.I)
    PAN_MOVE_RE = re.compile(r"\b(?:slide|slides|track|tracks|drift|drifts|arc|arcs|follow|follows)\b", re.I)
    conflict = []
    for n, h, _t in shot_bodies:
        is_close = bool(CLOSE_RE.search(h)) and not re.search(r"medium close", h, re.I)
        is_wide = bool(WIDE_RE.search(h))
        if is_close and PAN_MOVE_RE.search(h):
            conflict.append((n, "特写配横移/跟拍/环绕（会甩出画）"))
        if is_wide:
            mm = METRIC_RE.search(h)
            if mm and float(mm.group(0).split()[0]) < 20 and MOVE_RE.search(h):
                conflict.append((n, "远景配微推（<20cm 在远景里看不出来）"))
    if conflict:
        detail = "；".join(f"Shot {n}: {why}" for n, why in conflict[:5])
        r.warn("H17", f"运镜×景别矛盾：{detail}")
    else:
        r.ok("H17", "运镜与景别匹配")

    # ---------- H39 近景/中近景塞远处人（2026-11-10 真机 · 必拉远/站位漂移）----------
    # 根因：景别决定取景半径。近景/中近景里写"隔桌/隔厅/远处"的人做可见反应，
    #       模型装不下，只能拉远成中远景，或把人挪位。见 h3-shot-grammar.md §3.5.1
    FAR_PERSON_RE = re.compile(
        r"\b(?:across the (?:round )?table|at the (?:far|opposite) side"
        r"|at the head seat|at the next table|three steps (?:back|from)"
        r"|two steps from|across the room|the far side of the table)\b", re.I)
    far_hit = []
    for n, h, t in shot_bodies:
        full = h + " " + t
        is_tight = bool(re.search(r"\bclose shot\b|\bclose-up\b|medium close", full, re.I))
        if is_tight and FAR_PERSON_RE.search(full):
            far_hit.append(n)
    if far_hit:
        r.fail("H39", f"近景/中近景写远处的人（必拉远或站位漂移）：Shot {far_hit} → 远处人改「边缘虚化局部/画外/拆反应镜」，见 h3-shot-grammar.md §3.5.1")
    else:
        r.ok("H39", "近景/中近景无远处人")

    # ---------- H40 禁中远景/远景/全景（2026-11-10 用户定 · 只允许近景/中近景/中景）----------
    # 用户红线：h3 只出近景和中近景，确保不出现中远、远。
    # 命中任何 wide/full/long/establishing/medium wide/medium long/extreme wide 或中文景别词 → FAIL 硬拦。
    BANNED_SHOT_RE = re.compile(
        r"\b(?:wide|full|long|establishing)\s+shot\b"
        r"|\bextreme\s+wide\b"
        r"|\bmedium\s+(?:wide|long)\s+shot\b"
        r"|\b(?:wide|full|long)\s+shot\b"
        r"|中远景|远景|全景|大全景|中远|远景镜头", re.I)
    # 搜全文，确保"远景/全景"词不管出现在镜行头还是正文都被拦
    banned_matches = [m.group(0) for m in BANNED_SHOT_RE.finditer(text)]
    if banned_matches:
        uniq = list(dict.fromkeys(banned_matches))
        r.fail("H40", f"出现中远景/远景/全景景别（用户红线，只允许 close/medium close/medium）：{uniq[:6]} → 改近景或中近景，多人关系用「边缘虚化局部+画外」交代，见 h3-shot-grammar.md §3.5.1⓪")
    else:
        r.ok("H40", "无中远景/远景/全景景别")

    # ---------- H18 相邻两镜同运镜 / 连续静止 ----------
    def move_family(h: str) -> str:
        hl = h.lower()
        if re.search(r"hold(?:s)? still|static|fixed", hl):
            return "static"
        if re.search(r"slide|track|dolly|drift|follow|arc|pan|tilt|rise|pull|push|zoom", hl):
            return "move"
        return "?"

    fams = [(n, move_family(h)) for n, h, _t in shot_bodies]
    same, static_run, run = [], [], 0
    for i in range(1, len(fams)):
        if fams[i][1] == fams[i - 1][1] and fams[i][1] == "move":
            same.append(fams[i][0])
    for n, f in fams:
        if f == "static":
            run += 1
            if run >= 3:
                static_run.append(n)
        else:
            run = 0
    if same:
        r.warn("H18", f"相邻两镜运镜雷同（换方向或换速度）：Shot {same[:8]}")
    if static_run:
        r.warn("H18", f"连续 ≥3 镜全静止（画面死）：Shot {static_run[:8]}——对话段可豁免，需自行说明")
    if not same and not static_run and fams:
        r.ok("H18", "运镜有变化")

    # ---------- H19 位移 + 变焦同镜 ----------
    zoom_both = []
    for n, h, _t in shot_bodies:
        if MOVE_RE.search(h) and re.search(r"\bzooms?\b", h, re.I):
            zoom_both.append(n)
    if zoom_both:
        r.warn("H19", f"同镜既有位移又有变焦＝无声明滑动变焦（H3 会卡住）：Shot {zoom_both[:8]}")
    else:
        r.ok("H19", "位移与变焦未叠加")

    # ---------- H20 台词密度 ----------
    SPOKEN_CPS = 3.3
    dlines = re.findall(r"<d>\[Chinese\]\s*(.+?)</d>", text, re.S)
    if dlines:
        chars = sum(len(re.sub(r"[，。？！、,.;:!?\s]", "", ln)) for ln in dlines)
        spoken = chars / SPOKEN_CPS
        nshot = len(shot_bodies)
        if duration:
            fill = spoken / float(duration)
            density = len(dlines) / float(duration) * 60
            if fill < 0.65:
                r.warn("H20", f"台词填充率仅 {fill:.0%}（{len(dlines)}句/{chars}字≈{spoken:.1f}s 占 {duration:.0f}s 段）"
                              f"——观众会体感「对话太少」，改成每镜一句压到 80~90%")
            elif fill > 0.98:
                r.warn("H20", f"台词填充率 {fill:.0%} 过满——演员没余量做动作和呼吸，砍 1 句或压字数")
            else:
                r.ok("H20", f"台词 {len(dlines)}句/{chars}字 ≈{spoken:.1f}s，填充 {fill:.0%}，{density:.0f}句/分钟")
            if nshot and len(dlines) < nshot - 1:
                r.warn("H20", f"{nshot} 个镜头只有 {len(dlines)} 句台词——有空镜没人开口，改成每镜一句")
        else:
            r.ok("H20", f"台词 {len(dlines)} 句 / {chars} 字（未给时长，跳过填充率）")
    else:
        r.ok("H20", "无台词段")

    # ---------- H21 回合制切镜 ----------
    spk_sex = []
    for n, h, t in shot_bodies:
        full = h + " " + t
        m = re.search(r"the (man|woman) with [^;]*?voice[^;]*?says", full)
        if m:
            idm = re.search(r"\(S\d+\)", m.group(0))
            key = idm.group(0) if idm else ("sex:" + m.group(1))
            spk_sex.append((n, key))
    consecutive = []
    for i in range(len(spk_sex) - 1):
        if spk_sex[i + 1][0] == spk_sex[i][0] + 1 and spk_sex[i][1] == spk_sex[i + 1][1]:
            consecutive.append(f"Shot {spk_sex[i][0]}→{spk_sex[i + 1][0]}")
    if consecutive:
        r.warn("H21", f"同一说话人连续两镜开口（站桩式对话，切镜点应落在换嘴处）：{consecutive[:6]}")
    elif spk_sex:
        r.ok("H21", "台词镜全部换嘴切镜（回合制）")

    # ---------- H41 换人未换机位/景别（2026-11-10 用户真机 · 同机位原地换人）----------
    # 病：相邻两镜换了说话人/主体，但机位角度 + 景别都没换，H3 把两人当"同一位置两次置换"，
    #     成片同位置凭空来回闪现两个人。见 camera-four-axis-h3.md §三 换人必换机位/景别。
    def shot_sig(h: str):
        hl = h.lower()
        # 景别签名
        if re.search(r"extreme close", hl):
            size = "ECU"
        elif re.search(r"close[- ]up", hl) or re.search(r"\bclose shot\b", hl):
            size = "CU"
        elif re.search(r"medium close", hl):
            size = "MCU"
        elif re.search(r"\bmedium shot\b", hl):
            size = "MS"
        elif re.search(r"\bmedium wide\b|\bwide shot\b|\bfull shot\b|\blong shot\b", hl):
            size = "WIDE"
        else:
            size = "?"
        # 机位角度签名
        if re.search(r"framed from (?:her|his|their) (right|left)", hl):
            ang = "side-" + re.search(r"framed from (?:her|his|their) (right|left)", hl).group(1)
        elif re.search(r"side angle", hl):
            ang = "side"
        elif re.search(r"over (?:her|his|their) shoulder|over the shoulder", hl):
            ang = "ots"
        elif re.search(r"from behind", hl):
            ang = "behind"
        elif re.search(r"high angle|low angle|eye level", hl):
            ang = "level"
        else:
            ang = "?"
        return size, ang

    # 提取每镜的主说话人（Sx 或 the man/the woman）
    def shot_speaker(h, t):
        full = h + " " + t
        m = re.search(r"the (man|woman) with [^;]*?voice[^;]*?says", full)
        if m:
            idm = re.search(r"\(S\d+\)", m.group(0))
            return idm.group(0) if idm else ("sex:" + m.group(1))
        # 无台词镜：用主体标签
        subj = re.findall(r"<Subject\s+(\d+)>", full)
        return ("subj:" + subj[0]) if subj else None

    same_sig_swap = []
    for i in range(len(shot_bodies) - 1):
        n1, h1, t1 = shot_bodies[i]
        n2, h2, t2 = shot_bodies[i + 1]
        s1 = shot_speaker(h1, t1)
        s2 = shot_speaker(h2, t2)
        if s1 is None or s2 is None or s1 == s2:
            continue  # 说话人没换，或有一镜无主体，不判
        if shot_sig(h1) == shot_sig(h2):
            same_sig_swap.append(f"Shot {n1}→{n2}")
    if same_sig_swap:
        r.fail("H41", f"换人但机位+景别都没换（H3 会同机位原地换人，凭空闪现两个人）：{same_sig_swap[:6]} → 换人时至少换机位角度或景别，见 camera-four-axis-h3.md §三")
    else:
        r.ok("H41", "换人时均换了机位或景别")

    # ---------- H42 跨镜换人缺来去交代（2026-11-10 用户真机 · 人凭空出现/消失）----------
    # 病：相邻两镜换了人，但新出现的人没有 steps into frame 入画交代，消失的人没有 leaves/left the frame 退场交代，
    #     H3 零跨镜记忆，第二镜里的人会"凭空出现"，上一镜的人会"凭空消失"。
    #     见 spatial-anchor-and-hold.md §8。
    ENTER_RE = re.compile(r"\bsteps?\s+into\s+frame\b|\benters?\s+frame\b|\bwalks?\s+into\s+frame\b|\bsteps?\s+up\b|\bcomes?\s+into\s+frame\b", re.I)
    LEAVE_RE = re.compile(r"\bleaves?\s+frame\b|\bleft\s+the\s+frame\b|\bsteps?\s+(?:back|away|out)\b|\bexits?\s+frame\b|\bhas\s+left\b", re.I)
    # 固定站位戏的合法豁免（2026-11-23 用户定 · spatial-anchor-and-hold.md §8.2）：
    # 人数不变的戏，切镜时一个角色从「有标签主体」变成「无标签虚化肩背/后影」是合法的，
    # 不是"人走了"。H42 只比 Subject 标签集合会把这种镜头误判为凭空出现/消失，逼模型硬加入退场动作。
    # 认出虚化在场者：a softened shoulder / the out-of-focus back of ... / a blurred figure at the frame edge。
    BLURRED_PRESENCE_RE = re.compile(
        r"(?:out[- ]of[- ]focus|softened|blurred|unfocused|out of focus)\s+"
        r"(?:back|shoulder|figure|silhouette|profile|head|shape|form|mass)\b|"
        r"(?:back|shoulder|figure|silhouette|profile)\b[^.;]{0,60}?\b(?:out[- ]of[- ]focus|softened|blurred|unfocused|out of focus)\b",
        re.I,
    )
    # 段级"人数未变/站位锁死"信号：出现这条就不该再追究标签集合变化。
    LOCKED_BLOCK_RE = re.compile(
        r"keeps?\s+(?:this|the)\s+position|"
        r"every\s+person\s+keeps?|"
        r"(?:all|every)\s+(?:the\s+)?(?:people|persons|characters)\s+(?:stay|remain|keep)\b|"
        r"positions?\s+(?:stay|remain|is)\s+(?:fixed|unchanged|the same)\b",
        re.I,
    )
    def shot_subjects(h, t):
        return set(re.findall(r"<Subject\s+(\d+)>", h + " " + t))
    appear_disappear = []
    for i in range(len(shot_bodies) - 1):
        n1, h1, t1 = shot_bodies[i]
        n2, h2, t2 = shot_bodies[i + 1]
        s1, s2 = shot_subjects(h1, t1), shot_subjects(h2, t2)
        appeared = s2 - s1   # 第二镜新出现的主体
        vanished = s1 - s2   # 第一镜有、第二镜没的主体
        if not appeared and not vanished:
            continue
        body1 = h1 + " " + t1
        body2 = h2 + " " + t2
        # 固定站位戏豁免：本镜有虚化在场者，且段级有站位锁死句 → 视为同一批人换视角，不算来去。
        if BLURRED_PRESENCE_RE.search(body2) and (LOCKED_BLOCK_RE.search(body1) or LOCKED_BLOCK_RE.search(body2)):
            continue
        # 新出现的主体，第二镜里有没有入画交代
        if appeared and not ENTER_RE.search(body2):
            appear_disappear.append(f"Shot {n1}→{n2}: <Subject {','.join(sorted(appeared))}> 凭空出现（缺 steps into frame 入画交代）")
        # 消失的主体，第二镜里有没有退场交代（或第一镜里写了退场）
        if vanished and not LEAVE_RE.search(body1) and not LEAVE_RE.search(body2):
            appear_disappear.append(f"Shot {n1}→{n2}: <Subject {','.join(sorted(vanished))}> 凭空消失（缺 leaves frame 退场交代）")
    if appear_disappear:
        r.fail("H42", f"跨镜主体标签集合变化但缺在场/来去交代（H3 会让人凭空出现/消失）：{appear_disappear[:6]} → 固定站位戏（人数场景不变）：全员从 [Shot 1] 在场、站位锁死，换视角把其他人写成无 <Subject> 标签的虚化肩背/后影 + 段内站位锁死句（Every person keeps this position and facing...），见 spatial-anchor-and-hold.md §8.2/§8.3；只有剧情真有人来/走才写 steps into frame / leaves frame，禁止为过机检硬加动作")
    else:
        r.ok("H42", "跨镜换人均有入画/退场交代（或同框交代）")

    # ---------- H22 道具物理接地 ----------
    PROPS = ("pot", "bowl", "cup", "glass", "plate", "tray", "phone", "laptop",
             "candle", "vase", "bottle", "teapot", "pan", "wok", "kettle", "book", "mirror")
    GROUND_RE = re.compile(
        r"\b(?:seated|standing|rests?|resting|holding|held|clutched|gripped|pressed|pulling|pulls|drops|dropping|lies|lying|laid|set|sets)\b|"
        r"\b(?:on|at)\s+(?:the\s+)?(?:low\s+)?(?:wooden\s+)?(?:table|stove|desk|counter|floor|shelf|tray|plate|rock|slab)\b|"
        r"\b(?:in|on|out of|into)\s+(?:her|his|their)\s+(?:right\s+|left\s+|front\s+)?(?:hand|hands|lap|knee|pocket|chest|thigh)\b|"
        r"\b(?:to|against)\s+(?:his|her|their)\s+(?:right\s+|left\s+)?(?:ear|chest|thigh)\b",
        re.I,
    )
    seen_props = set()
    floaters = []
    for n, h, t in shot_bodies:
        low = (h + " " + t).lower()
        for p in PROPS:
            if p in seen_props or not re.search(r"\b" + p + r"\b", low):
                continue
            seen_props.add(p)
            m = re.search(r"\b" + p + r"\b", low)
            before = low[max(0, m.start() - 60): m.start()]
            after = low[m.end(): m.end() + 110]
            if not GROUND_RE.search(before) and not GROUND_RE.search(after):
                floaters.append(f"Shot {n} 「{p}」")
    if floaters:
        r.warn("H22", f"道具首现未写支撑（H3 会画成悬浮）：{floaters[:6]}"
                      f"——补 seated on the stove / standing on the table / in her hand")
    else:
        r.ok("H22", "道具均有支撑（或未见需支撑道具）")

    # ---------- H23 镜行超长 ----------
    TAG_RE = re.compile(r"</?(?:d|Subject|Picture|scenetrans|cutoff)\b[^>]*>", re.I)

    def wc(s):
        return len(re.findall(r"[A-Za-z][A-Za-z'\-]*", TAG_RE.sub(" ", s)))

    shot_lines = re.findall(r"\[Shot \d+\][^\n]*", body)
    over100, over85 = [], []
    for ln in shot_lines:
        mo = re.match(r"\[Shot (\d+)\]", ln)
        no = mo.group(1) if mo else "?"
        words = wc(ln)
        if words > 100:
            over100.append(f"Shot {no}({words}词)")
        elif words > 85:
            over85.append(f"Shot {no}({words}词)")
    if over100:
        r.fail("H23", f"镜行超 100 词，指令会被丢弃（先丢机位）：{over100[:4]}——拆镜或删同时动作")
    elif over85:
        r.warn("H23", f"镜行 >85 词（目标 ≤85，超 100 才丢指令）：{over85[:4]}——"
                      f"减压只删形容词与运镜冗余，禁删物理四件套/绳几何句/站位锚点/维持句")
    else:
        r.ok("H23", "镜行长度合规（≤85 词）")

    # ---------- H24 维持句 ----------
    HOLD_RE = re.compile(
        r"stay(?:s|ing)? (?:unchanged|fixed|in place|flat|at|shut|closed|latched)\b|"
        r"remain(?:s|ing)? (?:unchanged|fixed|in place|still|shut|closed)\b|"
        r"stay(?:s|ing)? (?:inside|within) the (?:picture|frame)|"
        r"(?:position|placement) stay(?:s)? (?:fixed|unchanged)|"
        r"keeps? (?:its|their) (?:position|place|size|shape)",
        re.I,
    )
    FURNITURE_RE = re.compile(
        r"\b(?:table|stool|sofa|chair|bed|desk|counter|window|door|rug|carpet|"
        r"booklet|certificate|ledger|tray|pot|robe|coat|jacket|cap)\b", re.I)
    no_hold = []
    for n, h, t in shot_bodies:
        if HOLD_RE.search(t):
            continue
        if FURNITURE_RE.search(t):
            no_hold.append(f"Shot {n}")
    if no_hold:
        r.warn("H24", f"关键镜行缺维持句（站位/家具会漂移）：{no_hold[:5]}"
                      f"——补 the two stools stay at the two ends of the table")
    else:
        r.ok("H24", "关键镜行均有维持句")

    # ---------- H25 单镜交代过薄 ----------
    thin = []
    per_shot = []
    for n, h, t in shot_bodies:
        w = wc(h + " " + t)
        per_shot.append(w)
        if w < 35:
            thin.append(f"Shot {n}({w}词)")
    if thin:
        r.warn("H25", f"单镜交代过薄 <35 词（人物/位置/动作会缺项）：{thin[:5]}")
    elif per_shot:
        r.ok("H25", f"单镜词数 {min(per_shot)}–{max(per_shot)}，合计 {sum(per_shot)} 词")

    # ---------- H26 同性别多说话人 ----------
    LOW_RE = re.compile(
        r"\blow\b|\bdark\b|\bdeep\b|\bgravelly\b|\bslow\b|\bcold\b|\bflat\b|"
        r"\bbreathy\b|\bsoft\b|\bquiet\b|\bhusky\b|\bhoarse\b|\bmeasured\b", re.I)
    HIGH_RE = re.compile(
        r"\bhigh\b|\bbright\b|\bloud\b|\bnasal\b|\bsharp\b|\bquick\b|\bfast\b|"
        r"\bclear\b|\bhard\b|\bcarrying\b|\bbrittle\b|\bclipped\b|\breedy\b", re.I)
    spk_desc = {}
    for m in re.finditer(
        r"\bthe\s+((?:[a-z]+\s+){0,3}?(?:man|woman|boy|girl))\b([^:;]{0,110}?)\((S\d+)\)",
        body,
        re.I,
    ):
        desc = m.group(2) or ""
        prev = spk_desc.get(m.group(3))
        if prev is None or len(desc) > len(prev[1]):
            spk_desc[m.group(3)] = (m.group(1).split()[-1].lower(), desc)
    if spk_desc:
        from collections import defaultdict as _dd
        by_sex = _dd(list)
        for sx, (sex, desc) in spk_desc.items():
            by_sex[sex].append((sx, desc))
        conflicts, mitigated = [], []
        for sex, lst in by_sex.items():
            if len(lst) < 2:
                continue
            poles = set()
            for sx, desc in lst:
                lo = len(LOW_RE.findall(desc))
                hi = len(HIGH_RE.findall(desc))
                if lo == 0 and hi == 0:
                    poles.add("none")
                else:
                    poles.add(-1 if lo >= hi else 1)
            tag = f"{sex}×{len(lst)}"
            if "none" in poles or len(poles) < 2:
                conflicts.append(tag)
            else:
                mitigated.append(tag)
        if conflicts:
            r.warn("H26", f"同性别多说话人且音色雷同 {conflicts}（官方 issue #17 必崩，声音会串）"
                          f"——处方：①音高/音质/语速反着写（一低冷慢、一高亮快）②拆段 ③只留一人开口")
        elif mitigated:
            r.ok("H26", f"同性别多说话人 {mitigated} 已做声学对比（一低一高），风险可控")
        else:
            r.ok("H26", f"开口者 {len(spk_desc)} 人，无同性别冲突")

    # ---------- H27 末镜定格 ----------
    FREEZE_RE = re.compile(
        r"freezes?|freezing|hold(?:s|ing)? still|comes? to rest|come to rest|"
        r"movement stops|motionless|stops moving|settles? and stays|everything holds",
        re.I,
    )
    if shot_bodies:
        last_n, last_h, last_t = shot_bodies[-1]
        if not FREEZE_RE.search(last_h + " " + last_t):
            r.warn("H27", f"末镜 Shot {last_n} 无定格句（段缝截不出尾帧会跳）"
                          f"——补 the movement stops and the picture holds still for the last second")
        else:
            r.ok("H27", "末镜有定格句")

    # ---------- H28 空间尺度膨胀 ----------
    SCALE_BLOAT_RE = re.compile(
        r"\b(?:walls?|rows?|dozens|hundreds|grid|shelves?|countless|numerous)\s+(?:of|filled with)\s+"
        r"(?:[a-z-]+\s+){0,3}"
        r"(?:photographs?|frames?|pictures?|portraits?|chairs|tables|lanterns|cabinets?|"
        r"windows|doors|monitors|scrolls|vases|shelves)\b",
        re.I,
    )
    PHOTO_WALL_RE = re.compile(r"\b(?:photo(?:graph)?|picture|frame)\s+walls?\b", re.I)
    bloat_hits = sorted(set(re.sub(r"\s+", " ", m.group(0).lower()) for m in SCALE_BLOAT_RE.finditer(text)))
    bloat_hits += sorted(set(m.group(0).lower() for m in PHOTO_WALL_RE.finditer(text)))
    if bloat_hits:
        r.warn("H28", f"空间描述含复数扩建词 {bloat_hits[:3]}（模型会照着堆一整面/一整排，"
                      f"房间尺度翻倍、与资产图不符）——处方：改单数 + 限定位置，"
                      f"如 `one tall framed photograph on the left panel`")
    else:
        r.ok("H28", "空间描述无复数扩建词")

    # ---------- H29 消除式动作（人穿过门洞/开口 → 半透明融化） ----------
    VANI = re.compile(
        r"\b(?:steps?|walks?|moves?|goes?|passes?|crosses?|heading|heads?)\s+"
        r"(?:out\s+)?(?:through|out\s+of|past|across)\b"
        r"[^.;]{0,40}?\b(?:door|doorway|frame|opening|gate|arch|threshold)\b",
        re.I,
    )
    v_hits = []
    v_text = re.sub(r"<d>.*?</d>", " ", text, flags=re.S)
    for m in VANI.finditer(v_text):
        seg_txt = re.sub(r"\s+", " ", m.group(0).lower()).strip()
        v_hits.append(seg_txt[:60])
    if v_hits:
        r.warn("H29", f"消除式动作 {v_hits[:3]}（穿过门洞的人会变半透明融化）"
                      f"——处方：改出门前动作（turns back / lifts his hand to the steel leaf）"
                      f"或只让门动（the steel leaf swings shut），人不穿过门框线")
    else:
        r.ok("H29", "无穿过门洞的消除式动作")

    # ---------- H30 同框人数上限 / 身形复制 ----------
    bodies = [h + " " + t for _, h, t in shot_bodies] if shot_bodies else []
    SPACE_WORD = re.compile(r"\b(?:room|hall|corridor|kitchen|bedroom|office|street|alley|"
                            r"entrance|stairwell|yard|courtyard|shop|classroom|ward|lobby|study|"
                            r"counter|cashier|store|stall|booth|clinic|hospital|restaurant|cafe|"
                            r"elevator|lift|balcony|rooftop|basement|garage|warehouse|chapel|"
                            r"cliff|cliffside|clifftop|peak|summit|ridge|valley|gorge|canyon|plateau|"
                            r"wilderness|marsh|swamp|meadow|forest|woods|grove|orchard|pavilion|"
                            r"terrace|platform|temple|shrine|pagoda|tower|palace|castle|ruins|"
                            r"cave|cavern|grotto|bridge|dock|pier|harbor|port|beach|shore|"
                            r"riverbank|lakeside|waterfall|pond|lake|river|stream|plaza|square|"
                            r"station|market|bazaar|mountain|mountains|"
                            r"ship|vessel|boat|cruise|ferry|yacht|trawler|tanker|barge|"
                            r"hull|deck|deckhouse|gunwale|cabin|wheelhouse|bridge|quay|jetty)\b", re.I)
    PROP_WORD = re.compile(r"\b(?:handkerchief|photograph|photo|booklet|ledger|pot|cup|phone|sword|blade|letter|key|box|jade|pendant|suitcase|luggage|trunk|bag|briefcase|backpack|umbrella|envelope|contract|document|necklace|bracelet|cigarette|lighter|bottle|glass|knife|scissors|mirror|hawser|rope|mooring|lifebuoy|lifebelt|ring|tether|line)\b", re.I)
    space_tags = set()
    prop_tags = set()
    for m in re.finditer(r"<Subject\s+(\d+)>\s+is[^.\n]{0,140}", text):
        chunk = m.group(0)
        if SPACE_WORD.search(chunk):
            space_tags.add(m.group(1))
        elif PROP_WORD.search(chunk) and not re.search(r"\b(?:man|woman|boy|girl|person|child|landlord|tenant)\b", chunk, re.I):
            prop_tags.add(m.group(1))
    non_person_tags = space_tags | prop_tags
    dup_risk = []      # FAIL 级：必翻车（同框 >2 人 / 同标签引用 ≥3 次 / 旁观动态）
    dup_warn = []      # WARN 级：同标签引用 2 次（站位+眼神指向属合法，仅提醒）
    for (n, h, t), b_full in zip(shot_bodies or [], bodies):
        b = re.sub(r"<d>.*?</d>", " ", b_full, flags=re.S)
        all_refs = set(re.findall(r"<Subject\s+(\d+)>", b))
        people = sorted(all_refs - non_person_tags)
        refs = [x for x in re.findall(r"<Subject\s+(\d+)>", b) if x not in non_person_tags]
        for tid in set(refs):
            cnt = refs.count(tid)
            if cnt >= 3:
                dup_risk.append(f"Shot {n}: <Subject {tid}> 被引用 {cnt} 次（≥3 次，H3 易画两个）")
            elif cnt == 2:
                dup_warn.append(f"Shot {n}: <Subject {tid}> 引用 2 次（站位+指向，通常合法）")
        if len(people) > 2:
            dup_risk.append(f"Shot {n}: 同框 {len(people)} 个人")
        if len(people) >= 2:
            if re.search(r"\b(?:watches?\s+(?:him|her|them)\s+go|looks?\s+on)\b", b, re.I):
                dup_risk.append(f"Shot {n}: 双人同框且第二人带旁观动态词（{people}）")
    if dup_risk:
        r.fail("H30", f"同框人数/标签引用超标（H3 会把同一人画成两个，必翻车）：{dup_risk[:3]}"
                      f"——处方：一镜最多两个人物标签；第二人只写纯静止状态（stays still）；第三人拆下一镜")
    elif dup_warn:
        r.ok("H30", "同框人数合规（同标签引用 2 次属站位+指向，合法）")
    else:
        r.ok("H30", "同框人数与标签引用合规")

    # ---------- H31 门窗状态锁 & 画外声源动作污染 ----------
    # 31a: 画外敲门词写进画面正文（2026-10-21《门后》段02 实证：写 three knocks landing on the far side，
    #      结果门内男主自己转身举拳敲自己家的门！）
    # 31b: 段末开门但段首锚点写死闭合门 stay in place for every shot 且 retention 标 fully_preserved
    #      （2026-10-21《门后》段04 实证：单扇绿铁门分裂成左关右开“双扇门/门中门”！）
    h31_hits = []
    OFFSCREEN_KNOCK_RE = re.compile(
        r"\b(?:three|two|four|heavy|loud|sharp|soft|muffled|urgent)?\s*"
        r"(?:knocks?\s+(?:landing|sounding|falling|hitting)|knocking\s+(?:on|at)\s+the\s+far\s+side)\b",
        re.I,
    )
    for n, h, t in shot_bodies:
        if OFFSCREEN_KNOCK_RE.search(t):
            h31_hits.append(
                f"Shot {n}: 画外敲门动作写进了画面正文（会导致屋里主角自己转身敲门或凭空多出敲门人）"
                f"——处方：画面只写门内受迫反馈（the closed steel door vibrates three times, the chain clinking once），敲门声只放 overall_soundscape"
            )
    DOOR_OPEN_ACT_RE = re.compile(
        r"\b(?:steel\s+leaf|door)\s+swings?\s+(?:open|toward\s+the\s+viewer|inward|outward)|"
        r"\bbeyond\s+the\s+open\s+doorway\b",
        re.I,
    )
    if DOOR_OPEN_ACT_RE.search(body):
        # 检查段首锚点句是否把门死锁为 stay in place for every shot 且 retention 里场景标了 fully_preserved
        if re.search(r"door[\s\S]{0,260}?stay(?:s)?\s+in\s+place\s+for\s+every\s+shot", pre, re.I):
            for sid in space_tags:
                if re.search(rf"<Subject\s+{sid}>[^.\n]*?\bfully_preserved\b", ret, re.I):
                    h31_hits.append(
                        f"开门段锚点冲突：正文有开门动作，但段首将门死锁于 `stay in place for every shot` 且 `<Subject {sid}>` 标为 `fully_preserved`"
                        f"（会导致单扇门分裂成一关一开两扇门）——处方：`<Subject {sid}>` 改标 `partially_preserved`（注明门由关变开），开门前镜头显式写 `the door stays shut`"
                    )
    if h31_hits:
        r.warn("H31", " ； ".join(h31_hits[:2]))
    else:
        r.ok("H31", "门窗开闭状态与画外声源动作隔离合规")

    # ---------- H32 段内角色依托物/方位跳变（防左右双分身） ----------
    # 2026-10-21《门后》段01 实证：Shot 1 老周 (<Subject 2>) 在鞋柜旁（左）、林昭 (<Subject 1>) 在右；
    # Shot 4 未写林昭走位，却写 `<Subject 1> stands beside the low wooden shoe cabinet`，
    # 导致 H3 在右边保留旧林昭、左边鞋柜旁又画一个新林昭，左右两个林昭夹着老周！
    ANCHOR_EXTRACT_RE = re.compile(
        r"(<Subject\s+\d+>|\b(?:he|she)\b)\s+(?:stands?|sits?|waits?|stays?)\s+"
        r"(?:still\s+)?(?:beside|by|at|near|before|behind|on)\s+the\s+([a-z]+(?:\s+[a-z]+){0,3})",
        re.I,
    )
    WALK_RE = re.compile(r"\b(?:walks?|steps?\s+to|moves?\s+to|crosses?|approaches?)\b", re.I)
    subj_anchors = {}  # tid -> (shot_n, anchor_noun)
    anchor_owner = {}  # anchor_noun -> (shot_n, tid)
    h32_hits = []
    for n, h, t in shot_bodies:
        hdr_subj = re.search(r"<Subject\s+(\d+)>", h)
        hdr_tid = hdr_subj.group(1) if hdr_subj else None
        for m in ANCHOR_EXTRACT_RE.finditer(t):
            raw_who = m.group(1)
            if raw_who.lower() in ("he", "she"):
                # 仅当分句在句首且镜行头有唯一 Subject 时映射
                if m.start() < 25 and hdr_tid:
                    tid = hdr_tid
                else:
                    continue
            else:
                tid = re.search(r"\d+", raw_who).group(0)
            if tid in non_person_tags:
                continue
            clause = t[max(0, m.start() - 20): min(len(t), m.end() + 50)]
            has_walk = bool(WALK_RE.search(clause))
            anc = re.sub(r"\s+", " ", m.group(2).lower()).strip()
            if anc in ("left", "right", "centre", "center", "front", "back", "same spot"):
                continue
            if anc in anchor_owner and anchor_owner[anc][1] != tid and not has_walk:
                prev_shot, prev_tid = anchor_owner[anc]
                h32_hits.append(
                    f"Shot {n}: <Subject {tid}> 未经走位直接占用了 Shot {prev_shot} 中 <Subject {prev_tid}> 的依托物 `{anc}`（会导致同一角色在旧位与新位同时画出两个分身）"
                )
            else:
                anchor_owner[anc] = (n, tid)
            subj_anchors[tid] = (n, anc)
    if h32_hits:
        r.warn("H32", " ； ".join(h32_hits[:2]))
    else:
        r.ok("H32", "段内角色位置依托物前后一致")

    # ---------- H33 高危物理死锁动作（全蹲低姿态 + 窄缝穿物过程） ----------
    # 2026-10-21《门后》段03 实证：crouches on his heels + slides through the gap 导致三次卡死 76% 且成片冻帧 1.7s
    FREEZE_RISK_RE = re.compile(
        r"\bcrouches?\s+on\s+(?:his|her|their)\s+heels\b|"
        r"\b(?:slides?|pushes?|slips?|squeezes?)\s+(?:in\s+|out\s+)?(?:through|under)\s+the\s+(?:narrow\s+)?(?:gap|crack|slit|crevice)\b",
        re.I,
    )
    h33_hits = [m.group(0) for m in FREEZE_RISK_RE.finditer(v_text)]
    if h33_hits:
        r.warn("H33", f"高危卡死/冻帧动作 {h33_hits[:3]}（实测易卡 76% 或成片冻帧 1.6s+）"
                      f"——处方：全蹲改半蹲/弯腰（bends from the waist），窄缝穿物改写为地面静置结果态（lies flat on the floor inside the door）")
    else:
        r.ok("H33", "无高危卡死/冻帧物理动作")

    # ---------- H35 氛围层缺失（光位 / 空气介质 / 前景景深） ----------
    # 2026-10-24 定案：参考图给不了光、空气、前景，这三样只能靠文字写。
    # 三类全缺 → 必是平光片（《暖阁》段01 实测：纪律满分、氛围为零）。
    LIGHT_NOUN_RE = re.compile(r"\b(?:light|lamplight|candlelight|moonlight|sunlight|glow|beam|shaft)\b", re.I)
    LIGHT_DIR_RE = re.compile(
        r"\b(?:left|right|window|door|corner|ceiling|floor|above|below|behind|overhead|"
        r"upward|downward|lower|upper|slant|slanted|high window)\b",
        re.I,
    )
    AIR_RE = re.compile(r"\b(?:haze|dust|smoke|mist|fog|steam|incense|motes?|particles|vapou?r)\b", re.I)
    FORE_RE = re.compile(
        r"\bnear foreground\b|\bin the foreground\b|\bblurred\b|\bout of focus\b|"
        r"\bfall(?:s|ing)? soft\b|\bsoft behind\b|\bblurs? into\b|\bshallower\b",
        re.I,
    )
    amb_text = re.sub(r"<d>.*?</d>", " ", text, flags=re.S)
    has_light = False
    for clause in re.split(r"[.;,]", amb_text):
        if LIGHT_NOUN_RE.search(clause) and LIGHT_DIR_RE.search(clause):
            has_light = True
            break
    has_air = bool(AIR_RE.search(amb_text))
    has_fore = bool(FORE_RE.search(amb_text))
    missing_amb = [n for n, v in (("光位(光源+方向)", has_light),
                                  ("空气介质(烟/尘/雾/汽)", has_air),
                                  ("前景遮挡/景深", has_fore)) if not v]
    if len(missing_amb) >= 2:
        r.warn("H35", f"氛围层缺 {len(missing_amb)}/3：{'、'.join(missing_amb)}"
                      f"（参考图给不了光、空气、前景，不写就是平光片）——"
                      f"处方见 references/atmosphere-and-light.md §二六件套，"
                      f"段首补 光位句 + 空气句 + 前景句，不占镜行字数")
    else:
        r.ok("H35", f"氛围层齐（光位={'有' if has_light else '缺'} / "
                    f"空气={'有' if has_air else '缺'} / 前景={'有' if has_fore else '缺'}）")

    # ---------- H14 画幅全片一致（推荐 9:16，16:9 实测可用） ----------
    # v2.0：不再是"恒 9:16"。9:16 是推荐档，16:9 实测跑得通；只禁 auto/adaptive 与段间混用。
    # v2.0.2：吃下 9：16（全角）与 16x9 写法——原来只认半角冒号，中文输入法打出的全角冒号
    #         会被静默忽略，混用检测直接失效（漏报）。此时 raw_ratios 里保留原始写法，便于报错定位。
    ratios = find_aspects(text)
    RECOMMENDED = ("9:16", "16:9")
    canon = (aspect or "").strip().replace("：", ":").replace("x", ":").replace("X", ":")
    if re.fullmatch(r"\d{1,2}:\d{1,2}", canon or ""):
        a, b = canon.split(":")
        canon = f"{int(a)}:{int(b)}"
    else:
        canon = (aspect or "").strip()

    auto_hit = re.search(
        r'(?:aspect_ratio|"aspect"|\bratio\b|画幅)[^\n]{0,24}\b(auto|adaptive)\b', text, re.I
    )
    if canon:
        bad_ratios = [x for x in ratios if x != canon]
        if bad_ratios:
            r.fail("H14", f"画幅必须全片一致为 {canon}，检测到其它比例：{bad_ratios}")
        elif canon in ratios:
            r.ok("H14", f"画幅 {canon}（全片一致）")
        else:
            r.ok("H14", f"画幅 {canon}（外部声明，prompt 内不写比例）")
    elif auto_hit:
        r.fail("H14", f"画幅用了 {auto_hit.group(1)}——它会在段与段之间自己改画幅，段缝必崩；"
                      f"改成固定 9:16（推荐）或 16:9，全片一致")
    elif len(ratios) > 1:
        r.fail("H14", f"画幅混用 {ratios}——段间换画幅必崩段缝；全片只留一个（推荐 9:16，16:9 亦可）")
    elif len(ratios) == 1:
        only = ratios[0]
        if only in RECOMMENDED:
            r.ok("H14", f"画幅 {only}（{'推荐档' if only == '9:16' else '横屏档·实测可用'}）")
        else:
            r.warn("H14", f"画幅 {only} 非本包推荐档（推荐 9:16，16:9 实测可用）"
                          f"——确认这是有意为之，且全片一致")
    else:
        r.warn("H14", "未声明画幅——请在载荷写 aspect_ratio（推荐 \"9:16\"，横屏用 \"16:9\"），"
                      "或用 --aspect 声明；全片必须一致，禁 auto")

    # H14 附：写法不规范（全角冒号 / 字母 x）——已按标准比例识别，但提醒统一写法，
    # 免得下游按字符串精确匹配的脚本（清单校验、渲染端映射）对不上。
    odd = re.findall(r"\d{1,2}\s*[：×]\s*\d{1,2}|\d{1,2}[xX]\d{1,2}", text)
    odd = [x for x in odd if not re.fullmatch(r"\d{1,2}:\d{1,2}", x)]
    if odd:
        r.warn("H14", f"画幅写法不规范 {sorted(set(odd))}——本包已按标准比例识别，"
                      f"但建议统一写成半角冒号（如 9:16），否则下游字符串匹配可能对不上")

    # ---------- H9 画外声 ----------
    if re.search(r"off-screen|voiceover|画外音|OS\)|（OS|\(VO\)", body, re.I):
        if "says in an off-screen voiceover" not in body:
            r.warn("H9", "画外声缺官方固定短语 `says in an off-screen voiceover`")
        OS_PAIR = re.compile(
            r"says in an off-screen voiceover\s*:\s*<d>.*?</d>", re.S
        )
        bad_os = []
        for m in OS_PAIR.finditer(body):
            tail = body[m.end(): m.end() + 90]
            if "lips remain completely closed" not in tail:
                seg = re.sub(r"\s+", " ", m.group(0))[-46:]
                bad_os.append(f"…{seg}")
        if bad_os:
            r.warn("H9", f"画外声 </d> 之后缺闭口证据 `while … lips remain completely closed`：{bad_os[:3]}")
        elif OS_PAIR.search(body):
            r.ok("H9", f"画外声 {len(OS_PAIR.findall(body))} 处均带闭口证据")
    if re.search(r"\{\s*锁口型|\{口型\}", body):
        r.fail("H9", "画外声通道禁用了 {} 锁口型")

    # ---------- H10 声音分层 ----------
    snd = secs.get("overall_soundscape", "")
    bgm = secs.get("non_diegetic_music", "")
    if snd:
        if "<d>" in snd or re.search(r"台词|对白|[他她][说道]|says|saying", snd, re.I):
            r.fail("H10", "overall_soundscape 里出现台词——台词只能留在正文 <d>")
        if re.search(r"\b(music|score|piano|strings|bgm)\b|音乐|配乐", snd, re.I):
            r.warn("H10", "overall_soundscape 出现音乐词——BGM 应只放 non_diegetic_music")
        if not snd.strip():
            r.warn("H10", "overall_soundscape 为空")
    if bgm and re.search(r"<d>|台词", bgm):
        r.fail("H10", "non_diegetic_music 复述了台词")

    # ---------- H11 语气位 ----------
    if sx_seq:
        voice_words = re.compile(
            r"voice|pitch|timbre|tone|pace|rate|accent|whisper|husky|flat|low|high|"
            r"soft|breathy|sharp|steady|quiet|loud",
            re.I,
        )
        seen_sx = set()
        for m in re.finditer(r"\(S\d+\)", body):
            if m.group(0) in seen_sx:
                continue
            seen_sx.add(m.group(0))
            ctx = body[max(0, m.start() - 220): m.start()]
            if not voice_words.search(ctx):
                r.warn("H11", f"{m.group(0)} 首次出现处未见语气/音色/语速描述")
                break

    # ---------- H12 首镜锚定 ----------
    if shots:
        first = body[shots[0].end(): shots[1].start() if len(shots) > 1 else len(body)]
        if not re.search(r"<(Subject|Picture)\s+\d+>", first) and not re.search(
            r"\b(woman|man|girl|boy|lady|gentleman|child|servant|guard|mother|father|"
            r"doctor|nurse|student|teacher|soldier|maid|old man|young man|old woman|young woman)\b",
            first,
            re.I,
        ):
            r.warn("H12", "[Shot 1] 未出现具名主体（<Subject N> 或人物名词）——空镜开场极易被划走")
        if re.search(r"\band\s+(he|she|they)\b|同框|一同入画|与.{0,6}同在画面", first, re.I):
            r.warn("H12", "[Shot 1] 疑似并列主体（X 与 Y 同框）——会把同一人的手和脸渲染成两张脸")
        if re.search(r"\b(this|that)\s+(hand|face|arm|shoulder|head)\b|这只手|那张脸|那只手", body, re.I):
            r.warn("H12", "出现悬空指示代词（这只手/那张脸）——改写成 她的那只手")

    return r


def check_cross_segment_slots(segments):
    """H34: 跨段图槽一致性检查（同一 Picture N 在不同段不能一会儿是人一会儿是场景）。"""
    slot_roles = {}  # pic_num -> (first_seg, role, head_desc)
    conflicts = []
    SPACE_W = re.compile(r"\b(?:room|hall|corridor|kitchen|bedroom|office|street|alley|entrance|stairwell|yard|courtyard|shop|study)\b", re.I)
    PERSON_W = re.compile(r"\b(?:man|woman|boy|girl|child|landlord|tenant|lady|gentleman|servant|doctor)\b", re.I)
    for label, seg_txt in segments:
        secs = split_sections(seg_txt)
        defs = secs.get("subject_definitions", "")
        for m in re.finditer(r"<Subject\s+\d+>\s+is\s+([^.\n]{1,100}?)\s+in\s+(?:<)?Picture\s+(\d+)(?:>)?", defs, re.I):
            desc = m.group(1).strip()
            pnum = m.group(2)
            role = "scene" if SPACE_W.search(desc) else ("person" if PERSON_W.search(desc) else "prop")
            if pnum in slot_roles:
                prev_seg, prev_role, prev_desc = slot_roles[pnum]
                if prev_role != role:
                    conflicts.append(
                        f"Picture {pnum} 跨段槽位错乱：{prev_seg} 为 {prev_role}({prev_desc})，而 {label} 变成了 {role}({desc})"
                    )
            else:
                slot_roles[pnum] = (label, role, desc)
    return conflicts


def check_vessel_motion(text: str):
    """H37 载具运动状态与介质交互（2026-11-04 实测修订 · 船·水交互缺失）

    现象：船呈「停泊态 + 平水」，无船艏浪/尾流/浪花拍舷/船体起伏。
    根因：<Subject N> 只写静态几何（侧倾/甲板/栏杆/舷窗），漏运动状态与环境交互，
         模型按字面渲染 → 静止船 + 死水。
    判据（交通工具类定义行）：
        运动状态 + 介质交互，二者必写其一；只有运动状态 → 海面仍会是死水（WARN）。
    """
    VEHICLE_WATER = re.compile(
        r"\b(?:ship|vessel|boat|cruise|ferry|yacht|trawler|tanker|barge|raft)\b", re.I)
    VEHICLE_LAND = re.compile(
        r"\b(?:car|truck|van|bus|train|plane|aircraft|helicopter|carriage|cart)\b", re.I)
    MOTION = re.compile(
        r"\b(?:under power|underway|under way|making way|dead in the water|adrift|"
        r"drifting|becalmed|listing|heeled|heeling|rolling|pitching|"
        r"under tow|sailing|plowing|steaming|slowing|accelerating|"
        r"at the kerb|at the curb|parked|stopped|idling|pulled over|pulling away)\b", re.I)
    INTERACTION = re.compile(
        r"\b(?:bow wave|wake|white water|whitecaps?|spray|swell|surge|swells|"
        r"slapping|breaking water|foam|splash|churn|ripple|sea state|"
        r"spindrift|backwash)\b", re.I)

    out = []
    water_hit = False
    for ln in text.splitlines():
        if not re.match(r"^\s*<Subject\s*\d+>\s*(?:is|（|:)", ln):
            continue
        is_water = bool(VEHICLE_WATER.search(ln))
        if not (is_water or VEHICLE_LAND.search(ln)):
            continue
        tag = re.match(r"^\s*(<Subject\s*\d+>)", ln)
        name = tag.group(1) if tag else "交通工具"
        m, i = MOTION.search(ln), INTERACTION.search(ln)
        if is_water:
            water_hit = True
            if not i:
                out.append(("warn",
                            f"{name} 是水上载具但定义行无介质交互词——"
                            f"模型会渲染成「停泊态 + 平水」：无船艏浪、无尾流、无浪花拍舷、船体不随浪起伏。"
                            f"补 swell / bow wave / spray / wake 任一处（有运动状态也要补）"))
        else:
            if not m:
                out.append(("warn",
                            f"{name} 是地面载具但定义行未写运动或停靠状态（parked / at the kerb / idling / pulling away）——"
                            f"模型会画成悬空的车"))

    if water_hit and not INTERACTION.search(text):
        out.append(("warn",
                    "全稿无任何海况交互词（swell / bow wave / spray / whitecaps）——"
                    "环境句只有光位没有介质运动，船会浮在镜面死水里"))
    return out


def check_prop_continuity(text: str):
    """H38 道具几何 + 握法的跨镜/跨段衔接（2026-11-04 用户判定 · 根本问题）

    现象：段1 末镜绳子垂直垂在船边、双手在胸前叠握；段2 首镜绳子斜横过头顶、双手高举。
    根因：① 镜行只写 `the hawser stays taut in his two fists`，**不复述走向与握法**
             → 这一镜的绳由模型自创，和相邻镜必然不同；
         ② H3 跨段无记忆，两边各画各的，走向和高低都会漂。

    判据：
        A. 段首/段末镜提到了道具，却没有任何走向词 → FAIL
        B. 上段末镜与下段首镜走向冲突（vertical ↔ diagonal）→ FAIL
        C. 同一段内握法出现两种（高举 ↔ 胸前）→ FAIL（15 秒内不会换握法）
        D. 段首/末镜握法冲突 → FAIL
    """
    # 只认「系泊缆绳」这类有固定走向的绳；救生绳（Subject 6 / rescue rope）被抛出时无固定走向，豁免
    PROP = re.compile(r"\bhawser\b|\b(?:mooring|tow) (?:line|rope)\b|<Subject\s*7>", re.I)
    GEO_VERT = re.compile(
        r"\b(?:straight down|dead vertical|vertical|plumb|straight up|dead straight|"
        r"down the hull|down the steel|down the plating|comes? down|drops? down)\b", re.I)
    GEO_DIAG = re.compile(
        r"\b(?:across|diagonal|overhead|slant\w*|stretched (?:across|between)|"
        r"runs? up and across|angled (?:up|across))\b", re.I)
    # 断缆后的绳：走向由剧本改写（甩回、回弹、松垂），不参与走向一致性判定
    GEO_SNAP = re.compile(
        r"\b(?:snaps?|parts?|parted|swings? back|recoils?|whips? back|goes? slack|"
        r"loops? back|falls? back into the water)\b", re.I)
    # 握法：高举 / 胸前低位
    GRIP_HIGH = re.compile(
        r"(?:fists|hands|arms)[^.;]{0,25}(?:over|above) (?:his|her) head|"
        r"(?:both )?arms (?:up|raised|stretched up)|hands (?:up )?over (?:his|her) head|"
        r"(?:both )?hands raised", re.I)
    GRIP_LOW = re.compile(
        r"(?:fists|hands)[^.;]{0,25}(?:at|below|against|on) (?:his|her) (?:chest|collarbones|chin|sternum)|"
        r"fists stacked|one fist above the other|hands stacked", re.I)

    segs, cur = [], None
    for raw in text.splitlines():
        if re.match(r"^#{2,3}\s*段\s*\d+", raw):
            if cur is not None:
                segs.append(cur)
            cur = {"head": raw.strip(), "shots": []}
        elif cur is not None and re.match(r"^\s*\[Shot\s*\d+\]", raw):
            cur["shots"].append(raw)
    if cur is not None:
        segs.append(cur)

    out, prev_tail = [], None
    for sg in segs:
        if not sg["shots"]:
            continue
        label = re.sub(r"^#+\s*", "", sg["head"]) or "本段"
        n = len(sg["shots"])
        # C. 段内握法唯一
        hi = [i for i, ln in enumerate(sg["shots"]) if PROP.search(ln) and GRIP_HIGH.search(ln)]
        lo = [i for i, ln in enumerate(sg["shots"]) if PROP.search(ln) and GRIP_LOW.search(ln)]
        if hi and lo:
            out.append(("fail",
                        f"{label} 段内握法不统一：第 {hi[0]+1} 镜是「双手高举过头」，"
                        f"第 {lo[0]+1} 镜是「双手胸前叠握」——15 秒内他不会换握法。"
                        f"全段统一为胸前叠握：`his fists stacked at his chest on the hawser`"))

        for i in ((0,) if n == 1 else (0, n - 1)):
            ln = sg["shots"][i]
            if not PROP.search(ln):
                continue
            which = "首镜" if i == 0 else "末镜"
            hv, hd = bool(GEO_VERT.search(ln)), bool(GEO_DIAG.search(ln))
            if GEO_SNAP.search(ln) and not (hv or hd):
                prev_tail = ("snap", None, label) if i == n - 1 else prev_tail
                continue          # 断缆/松脱后走向已按剧本改写，豁免
            # A. 必须写走向
            if not (hv or hd):
                out.append(("fail",
                            f"{label} {which}提到道具却没有走向句——只写 `stays taut` 等于让模型自创姿态，"
                            f"这一镜必然和相邻段对不上。补死方向与握法："
                            f"`the hawser comes straight down the hull, his fists stacked at his chest`"))
                kind = None
            else:
                kind = "vert" if (hv and not hd) else ("diag" if (hd and not hv) else "both")
            grip = "high" if (GRIP_HIGH.search(ln) and not GRIP_LOW.search(ln)) else (
                "low" if (GRIP_LOW.search(ln) and not GRIP_HIGH.search(ln)) else None)
            # B / D. 与上一段末镜比
            if i == 0 and prev_tail:
                pk, pg, pl = prev_tail
                if kind and pk and kind != "both" and pk != "both" and kind != pk:
                    out.append(("fail",
                                f"{label} 首镜道具走向「{kind}」，上一段 {pl} 末镜是「{pk}」——"
                                f"同一根绳跨段换了方向，两段接不上。本片统一为垂直："
                                f"`comes straight down the hull into his fists`"))
                if grip and pg and grip != pg:
                    out.append(("fail",
                                f"{label} 首镜握法是「{'高举过头' if grip=='high' else '胸前叠握'}」，"
                                f"上一段 {pl} 末镜是「{'高举过头' if pg=='high' else '胸前叠握'}」——"
                                f"握法跨段变了。统一为：`his fists stacked one above the other at his chest`"))
            if i == n - 1:
                prev_tail = (kind, grip, label)
    return out


def main():
    ap = argparse.ArgumentParser(description="MiniMax H3 提示稿机检 H1~H38")
    ap.add_argument("path", help="prompt.md / prompt.txt / payload.json")
    ap.add_argument("--duration", type=float, default=None, help="段时长（秒），用于 H2/H3")
    ap.add_argument("--aspect", default=None, help="画幅外部声明（渲染端节点参数决定时用）：9:16（默认推荐）或 16:9（横屏）")
    ap.add_argument("--whole", action="store_true", help="强制按单段整份校验（不自动切分多段合稿）")
    ap.add_argument("--strict-en", action="store_true", help="H4 正文中文由 WARN 升为 FAIL（镜行正文必须全英文；流水线默认启用）")
    ap.add_argument("--json", action="store_true", help="以 JSON 输出结果")
    ap.add_argument("--quiet", action="store_true", help="只显示 FAIL/WARN")
    args = ap.parse_args()

    p = Path(args.path)
    if not p.exists():
        print(f"文件不存在：{p}", file=sys.stderr)
        return 2
    try:
        text, duration, images, json_aspect = load(p, args.duration)
    except Exception as e:
        print(f"读取失败：{e}", file=sys.stderr)
        return 2
    if not text.strip():
        print("稿为空", file=sys.stderr)
        return 2
    # 画幅优先级：命令行 --aspect > 载荷自带 aspect/aspect_ratio > 正文里扫
    if not args.aspect and json_aspect:
        args.aspect = json_aspect

    segments = [(None, text)] if args.whole else split_multi_segments(text)
    if len(segments) == 1:
        rep = check(text, duration, aspect=args.aspect, strict_en=args.strict_en)
    else:
        rep = Report()
        seen_global = set()          # 全片级告警（如"未声明画幅"）只报一次，不按段刷屏
        GLOBAL_CODES = ("H14", "H37")
        for label, seg_txt in segments:
            sub = check(seg_txt, duration, aspect=args.aspect, strict_en=args.strict_en)
            for lvl, code, msg in sub.items:
                if code in GLOBAL_CODES:
                    key = (code, re.sub(r"^\[[^\]]*\]\s*", "", msg or ""))
                    if key in seen_global:
                        continue
                    seen_global.add(key)
                    rep.items.append((lvl, code, f"（全片）{msg}"))
                    continue
                rep.items.append((lvl, code, f"[{label}] {msg}" if msg else f"[{label}]"))
        slot_errs = check_cross_segment_slots(segments)
        if slot_errs:
            for err in slot_errs:
                rep.fail("H34", err)
        else:
            rep.ok("H34", f"跨段图槽一致性通过（共 {len(segments)} 段）")

    # H36 图槽越界（仅载荷带 images 数组时生效，单段/多段都查整份）
    h36 = check_picture_overflow(text, images)
    if h36:
        level, msg = h36
        getattr(rep, level)("H36", msg)

    # H37 载具运动状态与环境交互缺失（2026-11-04 实测修订 · 船·水交互）
    for level, msg in check_vessel_motion(text):
        getattr(rep, level)("H37", msg)

    # H38 道具几何跨镜/跨段衔接（2026-11-04 · 用户判定「根本问题」）
    for level, msg in check_prop_continuity(text):
        getattr(rep, level)("H38", msg)

    if args.json:
        print(json.dumps(
            {
                "file": str(p),
                "duration": duration,
                "segments": len(segments),
                "fail": len(rep.fails),
                "warn": len(rep.warns),
                "items": [{"level": l, "code": c, "msg": m} for l, c, m in rep.items],
            },
            ensure_ascii=False,
            indent=2,
        ))
    else:
        for level, code, msg in rep.items:
            if args.quiet and level == "PASS":
                continue
            tag = {"PASS": "[ OK ]", "WARN": "[WARN]", "FAIL": "[FAIL]"}[level]
            print(f"{tag} {code:4s} {msg}")
        print()
        print(f"—— FAIL {len(rep.fails)} ｜ WARN {len(rep.warns)} ——")
        if rep.fails:
            print("FAIL 必须清零后才能投喂。")

    return 1 if rep.fails else 0


if __name__ == "__main__":
    sys.exit(main())
