#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
run_finalcheck_tests.py — h3_finalcheck.py 的基线测试（正反例对照）

每次改完 h3_finalcheck.py 或 physics-realism.md 后跑一遍：
    python scripts/tests/run_finalcheck_tests.py

判据：
  case30 合规稿 → 退出码 0，无 FAIL
  case31 事故稿 → 退出码 1，且必须命中 F01/F02/F04/F05/F06/F07/F08/F09 与 L03

退出码：全部符合期望 = 0；任一不符 = 1。
"""

import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
SCRIPT = HERE.parent / "h3_finalcheck.py"
FIXTURES = HERE / "finalcheck"

# (文件, 期望退出码, 必须命中的条目)
CASES = [
    ("case30_finalcheck_ok.md", 0, []),
    ("case31_finalcheck_bad.md", 1,
     ["F01", "F02", "F04", "F05", "F06", "F07", "F08", "F09", "F12", "L03"]),
    # 全介质现实性（G 组）：悬空 / 隔衣听诊 / 输液袋低于病人 / CPR 无位置 / 烟向下 / 人群僵死 / 单人抬人 / 车载人无反应
    ("case32_medium_bad.md", 1,
     ["G01", "G02", "G03", "G05", "G06", "G07"]),
]


def main():
    bad = 0
    print(f"{'用例':34}{'期望':>6}{'实际':>6}  结果")
    print("-" * 76)
    for name, want, must in CASES:
        path = FIXTURES / name
        if not path.exists():
            print(f"{name:34}  [缺文件]")
            bad += 1
            continue
        proc = subprocess.run(
            [sys.executable, str(SCRIPT), str(path)],
            capture_output=True, text=True, encoding="utf-8", errors="replace")
        out = proc.stdout + proc.stderr
        ok = proc.returncode == want
        missing = [c for c in must if c not in out]
        if missing:
            ok = False
        mark = "✓" if ok else "✗"
        print(f"{name:34}{want:>6}{proc.returncode:>6}  {mark}")
        if not ok:
            bad += 1
            if proc.returncode != want:
                print(f"    退出码不符（期望 {want}）")
            if missing:
                print(f"    漏报条目：{missing}")
            for line in out.splitlines():
                if line.startswith(("[FAIL]", "[WARN]")):
                    print("    ", line[:150])
    print("-" * 76)

    # 模式库自检
    st = subprocess.run([sys.executable, str(SCRIPT), "--selftest"],
                        capture_output=True, text=True, encoding="utf-8", errors="replace")
    st_ok = st.returncode == 0
    print(f"模式库自检：{'✓ 全部命中正常' if st_ok else '✗ 有正则失效'}")
    if not st_ok:
        bad += 1
        print(st.stdout)

    if bad:
        print(f"失败：{bad} 项与基线不符。")
        return 1
    print(f"全部 {len(CASES)} 个用例 + 模式库自检 通过。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
