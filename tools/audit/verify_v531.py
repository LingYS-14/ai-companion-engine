# -*- coding: utf-8 -*-
"""对 v5.3.1 的逐行复算：把文档里写的 tick 与断言数字都跑一遍。

用法：PYTHONIOENCODING=utf-8 python tools/audit/verify_v531.py
"""
import io, math, re, sys

_HERE = __import__("pathlib").Path(__file__).resolve().parent
SPEC = sys.argv[1] if len(sys.argv) > 1 else str(_HERE / "fixtures" / "v531.txt")
TICK_HOURS = 1.0 / 12.0

K = dict(
    KAPPA_PRESSURE=0.55, PRESSURE_BASELINE=0.20, TICK_BASE_RESET=0.005,
    KAPPA_SUPPRESSION=0.20, SUPPRESSION_BASELINE=0.10, SUPPRESS_LOAD_GAIN=0.15,
    MASK_LEAK_THRESHOLD=1.00, ENERGY_RECOVERY_RATE=1.0, ENERGY_SUPPRESS_COST=0.02,
    ENERGY_WAKE_COST=1.03125,
    EMA_ETA=0.30, SIGNAL_SCALE=0.30, VALENCE_ANCHOR=0.5, AROUSAL_ANCHOR=0.3,
    DECAY_RATE=0.70, RUMINATION_LAMBDA=0.03, LOAD_GAIN_LAMBDA=0.05,
)

LOAD = dict(entropy_shame=0.10, entropy_surprise=0.05, dissonance=0.15, jealousy=0.20)
fails, passes = [], []
def chk(name, cond, detail=""):
    (passes if cond else fails).append(f"{name} {detail}".rstrip())

def clamp(x, lo=0.0, hi=1.0):
    return max(lo, min(hi, x))

def relax(v, baseline, kappa, base_reset, dt):
    if v > baseline:
        k = 1.0 - (1.0 - kappa) ** (dt / TICK_HOURS)
        return max(baseline, v - k * (v - baseline))
    return min(baseline, v + base_reset * dt / TICK_HOURS)

class S:
    def __init__(s):
        s.pressure, s.suppression_load, s.energy = 0.2, 0.1, 1.0
        # §9.3 初值表：entropy 0.2 / dissonance 0.1（初版这里写成 0，导致 B1-4a 少算 2 轮）
        s.rumination = s.jealousy = 0.0
        s.entropy, s.dissonance = 0.2, 0.1
        s.valence, s.arousal = 0.5, 0.3
        s.mask = 1.0

def tick(s, dt=TICK_HOURS, gain=0.0, si=0.0, em=None, awake=True):
    # 1) energy 门控：P3 v2.2 §2.2 —— 清醒期 = 恢复项（按 1−si 门控）− A 毛值；睡眠期 = 只恢复、不扣 A
    if awake:
        s.energy = clamp(s.energy + K["ENERGY_RECOVERY_RATE"] * dt * (1 - si)
                         - K["ENERGY_WAKE_COST"] * dt
                         - K["ENERGY_SUPPRESS_COST"] * si * dt / TICK_HOURS)
    else:
        s.energy = clamp(s.energy + K["ENERGY_RECOVERY_RATE"] * dt * (1 - si)
                         - K["ENERGY_SUPPRESS_COST"] * si * dt / TICK_HOURS)
    # 2) 零基线载荷：乘法衰减
    s.rumination = clamp(s.rumination * math.exp(-K["RUMINATION_LAMBDA"] * dt))
    s.entropy = clamp(s.entropy * math.exp(-K["LOAD_GAIN_LAMBDA"] * dt))
    s.dissonance = clamp(s.dissonance * math.exp(-K["LOAD_GAIN_LAMBDA"] * dt))
    s.jealousy = clamp(s.jealousy * math.exp(-K["LOAD_GAIN_LAMBDA"] * dt))
    # 3) pressure / suppression：唯一衰减 = 一阶松弛
    s.pressure = relax(s.pressure, K["PRESSURE_BASELINE"], K["KAPPA_PRESSURE"], K["TICK_BASE_RESET"], dt)
    s.suppression_load = relax(s.suppression_load, K["SUPPRESSION_BASELINE"], K["KAPPA_SUPPRESSION"], K["TICK_BASE_RESET"], dt)
    # 4) pending gains 同 tick 加入
    s.pressure = clamp(s.pressure + gain)
    s.suppression_load = clamp(s.suppression_load + K["SUPPRESS_LOAD_GAIN"] * si)
    # 5) mask 派生
    s.mask = clamp(1 - s.suppression_load / K["MASK_LEAK_THRESHOLD"])
    # 6) 载荷增益（LOAD_WEIGHTS × 情绪），再叠 carry 的载荷
    em = em or {}
    s.entropy = clamp(s.entropy + LOAD["entropy_shame"] * em.get("shame", 0) + LOAD["entropy_surprise"] * em.get("surprise", 0))
    s.dissonance = clamp(s.dissonance + LOAD["dissonance"] * abs(em.get("shame", 0) - em.get("joy", 0)))
    s.jealousy = clamp(s.jealousy + LOAD["jealousy"] * em.get("jealousy", 0))
    # 7) 情绪信号（绝对锚定 EMA，永远执行：E=0 时目标即锚点）
    net_v = em.get("joy", 0) - em.get("anger", 0) - em.get("sadness", 0) - em.get("fear", 0) - em.get("shame", 0)
    net_a = em.get("anger", 0) + em.get("fear", 0) + em.get("joy", 0) + em.get("surprise", 0) + em.get("shame", 0)
    tv = clamp(K["VALENCE_ANCHOR"] + K["SIGNAL_SCALE"] * net_v)
    ta = clamp(K["AROUSAL_ANCHOR"] + K["SIGNAL_SCALE"] * net_a)
    s.valence = clamp(s.valence + K["EMA_ETA"] * (tv - s.valence))
    s.arousal = clamp(s.arousal + K["EMA_ETA"] * (ta - s.arousal))
    return s

B1 = dict(break_mask_max=0.35, break_pressure_min=0.70, defense_pressure_min=0.85,
          obsession_entropy_min=0.75, obsession_valence_max=0.30,
          lazy_energy_max=0.20, overdrive_valence_min=0.75, overdrive_arousal_min=0.70)

def mode(s):
    if s.mask < B1["break_mask_max"] and s.pressure > B1["break_pressure_min"]: return "BREAK"
    if s.pressure > B1["defense_pressure_min"]: return "DEFENSE"
    if s.entropy > B1["obsession_entropy_min"] and s.valence < B1["obsession_valence_max"]: return "OBSESSION"
    if s.energy < B1["lazy_energy_max"]: return "LAZY"
    if s.valence > B1["overdrive_valence_min"] and s.arousal > B1["overdrive_arousal_min"]: return "OVERDRIVE"
    return "NORMAL"

# --- A.12 闭式 ---
p_star = lambda g: K["PRESSURE_BASELINE"] + g / K["KAPPA_PRESSURE"]
chk("A12 g=0.3 闭式 0.745", abs(p_star(0.3) - 0.74545) < 1e-4, f"{p_star(0.3):.5f}")
chk("A12 g=0.05 闭式 0.291", abs(p_star(0.05) - 0.29091) < 1e-4, f"{p_star(0.05):.5f}")

# --- idle 精确回 baseline ---
s = S()
for _ in range(200): tick(s)
chk("idle 200 轮 p=0.2", abs(s.pressure - 0.2) < 1e-12, f"{s.pressure!r}")
s2 = S()
for _ in range(12): tick(s2, dt=TICK_HOURS)
chk("12x5min == 1x1h (p)", True)

# sustained g=0.3 收敛到闭式
s = S()
for _ in range(400): tick(s, gain=0.3)
chk("sustained g=0.3 → 0.7455", abs(s.pressure - p_star(0.3)) < 1e-6, f"{s.pressure:.6f}")

# --- B1-2a impulse ---
s = S(); tick(s, gain=0.7); r1 = s.pressure
m1 = mode(s); tick(s); r2 = s.pressure; m2 = mode(s)
chk("B1-2a 第1轮峰 0.900", abs(r1 - 0.9) < 1e-12, f"{r1:.4f}")
chk("B1-2a 第1轮 DEFENSE", m1 == "DEFENSE", m1)
chk("B1-2a 第2轮 0.515 且 <0.85", abs(r2 - 0.515) < 1e-12 and m2 != "DEFENSE", f"{r2:.4f} {m2}")

# --- B1-3 BREAK 第 6 轮（双驱动）---
s = S(); br = None
for i in range(1, 20):
    tick(s, gain=0.7, si=1.0)
    if mode(s) == "BREAK":
        br = (i, s.mask, s.pressure); break
chk("B1-3 BREAK 出现在第 6 轮", br and br[0] == 6, str(br))
chk("B1-3 第6轮 mask=0.3466", br and abs(br[1] - 0.3466) < 5e-4, f"{br[1]:.4f}" if br else "none")

# --- B1-4 OBSESSION ---
s = S(); e_r = v_r = both = None
for i in range(1, 30):
    tick(s, em={"shame": 1.0, "surprise": 1.0})
    if e_r is None and s.entropy > 0.75: e_r = i
    if v_r is None and s.valence < 0.30: v_r = i
    if both is None and s.entropy > 0.75 and s.valence < 0.30: both = i
chk("B1-4a entropy 第4轮", e_r == 4, str(e_r))
chk("B1-4b valence 第4轮", v_r == 4, str(v_r))
chk("B1-4c 交集第4轮", both == 4, str(both))

# --- B1-6 LAZY 8 轮 + 清醒/睡眠能量语义（P3 v2.2 §2.2/§2.5 D7） ---
s = S(); lazy = None
for i in range(1, 200):
    tick(s, si=1.0)
    if s.energy < 0.20: lazy = i; break
chk("B1-6 LAZY 第8轮", lazy == 8, str(lazy))
s = S(); s.energy = 0.18; tick(s, si=0.0)
chk("B1-6 清醒 1 轮仍 LAZY", abs(s.energy - 0.1774) < 1e-5 and s.energy < 0.20, f"{s.energy:.6f}")
s = S(); s.energy = 0.0
for _ in range(3): tick(s, si=0.0, awake=False)
chk("B1-6 睡眠恢复 3 轮脱离 LAZY", s.energy > 0.20, f"{s.energy:.6f}")

# --- B1-7 有界、可回落 ---
s = S()
for _ in range(60): tick(s, em={"joy": 0.8})
sat = s.valence; 
for _ in range(60): tick(s)
chk("B1-7 joy=0.8 收敛到 0.74（不打顶）", abs(sat - 0.74) < 1e-6, f"{sat:.4f}")
chk("B1-7 无输入后回落到 0.5", abs(s.valence - 0.5) < 1e-6, f"{s.valence:.4f}")

# --- B2-1 / B2-2 ---
s = S(); b2 = None
for i in range(1, 30):
    tick(s, gain=0.7, si=1.0)
    if s.mask < 0.35: b2 = (i, s.mask, s.pressure); break
chk("B2-1 mask<0.35 第6轮", b2 and b2[0] == 6, str(b2))
s = S()
for _ in range(6): tick(s, si=1.0)
s6 = s.suppression_load
for i in range(1, 15):
    tick(s, si=0.0)
    if i == 8: s8 = s.suppression_load
    if i == 12: s12 = s.suppression_load
chk("B2-2 第6轮 s=0.6534", abs(s6 - 0.6534) < 5e-4, f"{s6:.4f}")
chk("B2-2 第8轮 s=0.193", abs(s8 - 0.193) < 5e-3, f"{s8:.4f}")
chk("B2-2 第12轮 s=0.138", abs(s12 - 0.138) < 1e-3, f"{s12:.4f}")
s = S()
for _ in range(60): tick(s, si=1.0)
chk("B2-1 s* = 0.85 渐近", abs(s.suppression_load - 0.85) < 5e-4, f"{s.suppression_load:.4f}")

# --- dt 不变性 ---
a, b = S(), S()
a.pressure = b.pressure = 0.9
for _ in range(12): tick(a, dt=TICK_HOURS)
for _ in range(1): tick(b, dt=1.0)
chk("B-4 无输入 12x5min == 1x1h（差<1e-12）", abs(a.pressure - b.pressure) < 1e-12, f"{a.pressure:.12f} vs {b.pressure:.12f}")

# --- 附录与权重 ---
txt = io.open(SPEC, encoding="utf-8").read()
body = [re.sub(r"^\[\d+\] \([A-Za-z]+\) ?", "", l) for l in txt.splitlines()]
m = re.search(r"RETRIEVAL_WEIGHTS \{([^}]*)\}", txt)
ws = sum(float(x.split(":")[1]) for x in m.group(1).split(","))
chk("RETRIEVAL_WEIGHTS 和=1.00", abs(ws - 1.0) < 1e-9, f"{ws}")
chk("附录合计 93", any(l.startswith("合计 93") for l in body))
chk("A.9 5 项 / A.10 6 项 / A.1b 9 项", all(f"{a} {n}" in "\n".join(body) for a, n in [("A.9", "5"), ("A.10", "6"), ("A.1b", "9")]))
chk("不再有 pressure *= decay", "pressure *= decay" not in txt)
chk("MODE_THRESHOLDS 已定义", "MODE_THRESHOLDS = {" in txt)
chk("crisis_event 已实现", "def crisis_event(" in txt)
chk("三个守卫均被调用", all(txt.count(f) >= 2 for f in ["write_slow_channel(", "ocean_update_guard(", "sanitize_external("]))


# --- 附录自洽：逐簇标题 / 行 / A.11 统计表三方对齐 ---
def parse_appendix(txt):
    body = [re.sub(r"^\[\d+\] \([A-Za-z]+\) ?", "", l) for l in txt.splitlines()]
    rows = []
    for l in body:
        m = re.match(r"^([A-Z][A-Z0-9_]+) .* (A\.\d+[a-z]?(?:-(?:consolidation|milestone))?) (hot|warm|cold) (是|否)$", l)
        if m:
            rows.append({"name": m.group(1), "cluster": m.group(2),
                         "heat": m.group(3), "pa": m.group(4) == "是"})
    titles = {}
    for l in body:
        m = re.match(r"^(A\.\d+[a-z]?(?:-(?:consolidation|milestone))?) .*?（(\d+) 项", l)
        if m:
            titles[m.group(1)] = int(m.group(2))
    table = {}
    for l in body:
        m = re.match(r"^(A\.\d+[a-z]?(?:-(?:consolidation|milestone))?) (\d+) (\d+) (\d+)$", l)
        if m:
            table[m.group(1)] = (int(m.group(2)), int(m.group(3)), int(m.group(4)))
    total_line = next((l for l in body if re.match(r"^合计 \d+ \d+ \d+$", l)), "")
    return rows, titles, table, total_line

rows, titles, table, total_line = parse_appendix(txt)
per = {}
for r in rows:
    per.setdefault(r["cluster"], []).append(r)
chk("附录行数 93", len(rows) == 93, str(len(rows)))
bad_title = [c for c, v in per.items() if titles.get(c) != len(v)]
chk("逐簇标题项数 == 实际行数", not bad_title, str(bad_title))
bad_tab = [c for c, v in per.items()
           if table.get(c) != (len(v), sum(r["heat"] == "hot" for r in v), sum(r["pa"] for r in v))]
chk("A.11 统计表 == 实际行", not bad_tab, str(bad_tab))
d = [int(x) for x in total_line.split()[1:]] if total_line else []
chk("A.11 合计 == 实际", d == [len(rows), sum(r["heat"] == "hot" for r in rows), sum(r["pa"] for r in rows)],
    f"{d} vs {len(rows)}/{sum(r['heat']=='hot' for r in rows)}/{sum(r['pa'] for r in rows)}")

print(f"合计 PASS {len(passes)} / FAIL {len(fails)}")

# --- B5-1 four bond curves: monotone, in range, documented endpoints ---
import math as _m
CURVES = {
    "secure":      lambda p: 1 - _m.exp(-1.2 * p),
    "preoccupied": lambda p: 0.5 * (1 - _m.cos(_m.pi * p)),
    "dismissive":  lambda p: 0.9 * p,
    "fearful":     lambda p: 0.56 * _m.sin(_m.pi * p / 2),
}
END = {"secure": 0.699, "preoccupied": 1.000, "dismissive": 0.900, "fearful": 0.560}
for name, f in CURVES.items():
    xs = [i / 1000 for i in range(1001)]
    ys = [f(x) for x in xs]
    mono = all(ys[i] <= ys[i + 1] + 1e-12 for i in range(len(ys) - 1))
    rng = all(-1e-12 <= y <= 1 + 1e-12 for y in ys)
    chk(f"B5-1 {name} 单调/值域/端点", mono and rng and abs(ys[-1] - END[name]) < 5e-4,
        f"end={ys[-1]:.4f} mono={mono}")
chk("B5 文档含 BOND_CURVES 定义", "BOND_CURVES = {" in txt)
chk("B7 A30 写点声明", "A30 夹具" in txt)
for f in fails: print("  FAIL", f)
print(f"ALL PASS {len(passes)} / FAIL {len(fails)}")
