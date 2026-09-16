#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
凯利公式仓位计算器（交易 skill 通用，纯标准库，无第三方依赖）

设计原则（与各交易 skill 的仓位模块一致）：
  1. 固定风险规则按止损定单笔仓位；凯利公式按统计优势定仓位上限；取两者及单只上限的最小值。
  2. 强制分数凯利（默认半凯利），f* ≤ 0 不开仓（没有优势不下注）。
  3. 报告须同时给出：风险仓位、分数凯利仓位、最终建议仓位、以及哪一项在约束。

核心公式：
  f* = (b·p − q) / b = (p(b+1) − 1) / b        # q = 1 − p
  分数凯利仓位 = 账户 × max(f*, 0) × fraction
  风险仓位     = 账户 × 单笔风险% / 止损%
  建议仓位     = MIN(风险仓位, 分数凯利仓位, 账户 × 单只上限%)

用法示例：
  # 直接给胜率与回报倍数 b
  python kelly.py -p 0.50 -b 2 --stop 5 --capital 1000000
  # 按信号质量档位映射胜率（各策略档位见 --profile / --quality）
  python kelly.py --profile swing   --quality 4/5   -b 2   --stop 5
  python kelly.py --profile canslim --quality basic -b 2.5 --stop 8 --risk 1.5 --cap 25
  python kelly.py --profile sepa    --quality basic -b 3   --stop 10 --risk 1.5 --cap 25
  python kelly.py --profile wyckoff --quality single -b 2.5 --stop 6
  # 输出 JSON（供程序解析）
  python kelly.py -p 0.55 -b 2.5 --stop 6 --json
"""

import argparse
import json
import sys

# 各策略「信号质量 → 经验胜率」映射（样本不足时的保守代理，与各 skill reference 文件一致）
PROFILES = {
    "swing": {   # 双突破信号质量 X/5
        "5/5": 0.55, "4/5": 0.50, "3/5": 0.45,
    },
    "canslim": {  # CANSLIM 综合质量
        "high": 0.55, "strong": 0.55,      # 高分达标 + 强信号
        "basic": 0.48,                      # 基本达标
        "partial": 0.40, "weak": 0.40,      # 部分达标 / 入场信号弱
    },
    "sepa": {     # 两道 Gate + VCP 质量
        "strong": 0.55, "8": 0.55,          # 两 Gate 全过 + VCP≥8 + 放量≥2x
        "basic": 0.48,                       # 两 Gate 全过 + VCP 6-7
        "flawed": 0.40, "weak": 0.40,        # Gate 有瑕疵 / VCP<6
    },
    "wyckoff": {  # 威科夫结构确认度
        "multi": 0.55,                       # Spring+Test+SOS/LPS 多重确认
        "single": 0.48,                      # SOS 或 Spring 单一强信号
        "weak": 0.40, "test": 0.40,          # 仅 Test / 弱信号
    },
}

# 各策略默认单笔风险% 与单只仓位上限%（可用 --risk / --cap 覆盖）
DEFAULTS = {
    "swing":   {"risk": 2.0, "cap": 30.0},
    "canslim": {"risk": 1.5, "cap": 25.0},
    "sepa":    {"risk": 1.5, "cap": 25.0},
    "wyckoff": {"risk": 2.0, "cap": 30.0},
    None:      {"risk": 2.0, "cap": 30.0},
}


def as_ratio(x):
    """把 8 / 0.08 / '8%' 统一成小数比例。>1 视为百分数，≤1 视为比例。"""
    if x is None:
        return None
    if isinstance(x, str):
        x = x.strip().rstrip("%")
        x = float(x)
    return x / 100.0 if x > 1 else x


def resolve_win_rate(args):
    """确定胜率 p：优先 --win-rate；否则用 --profile + --quality 查表。"""
    if args.win_rate is not None:
        return float(args.win_rate), "直接指定"
    if args.quality is not None:
        # --quality 也可直接给数字（如 0.5）
        try:
            v = float(args.quality)
            return v, "直接指定(quality 数值)"
        except ValueError:
            pass
        table = PROFILES.get(args.profile)
        if table is None:
            sys.exit(f"错误：--quality 需要配合已知 --profile，当前 profile={args.profile!r}。"
                     f"可选：{', '.join(k for k in PROFILES)}")
        key = args.quality.strip().lower()
        if key not in table:
            sys.exit(f"错误：profile={args.profile} 下无质量档位 {args.quality!r}。"
                     f"可选：{', '.join(table)}")
        return table[key], f"{args.profile}/{args.quality}"
    sys.exit("错误：必须提供 --win-rate，或 --profile + --quality。")


def kelly(p, b, fraction, capital, stop_pct, risk_pct, cap_pct):
    q = 1.0 - p
    f_star = (b * p - q) / b                      # 全凯利
    f_frac = max(f_star, 0.0) * fraction          # 分数凯利
    ev_R = p * b - q                              # 期望值（单位：R，止损为 1R）

    kelly_pos = capital * f_frac
    risk_pos = (capital * risk_pct) / stop_pct if stop_pct > 0 else float("inf")
    cap_pos = capital * cap_pct

    if f_star <= 0:
        recommended = 0.0
        binding = "无优势(f*≤0)：不开仓"
    else:
        candidates = {"分数凯利仓位": kelly_pos, "风险仓位": risk_pos, "单只上限": cap_pos}
        binding = min(candidates, key=candidates.get)
        recommended = candidates[binding]

    return {
        "win_rate_p": round(p, 4),
        "payoff_b": round(b, 4),
        "expected_value_R": round(ev_R, 4),
        "f_star_full_kelly": round(f_star, 4),
        "fraction": fraction,
        "f_fractional": round(f_frac, 4),
        "capital": round(capital, 2),
        "stop_pct": round(stop_pct, 4),
        "risk_pct": round(risk_pct, 4),
        "cap_pct": round(cap_pct, 4),
        "risk_position": round(risk_pos, 2),
        "kelly_position": round(kelly_pos, 2),
        "cap_position": round(cap_pos, 2),
        "recommended_position": round(recommended, 2),
        "binding_constraint": binding,
    }


def format_cny(x):
    return f"{x/10000:.2f} 万" if x >= 10000 else f"{x:.0f} 元"


def human_report(r, price=None, lot=100):
    lines = []
    lines.append("=" * 44)
    lines.append("  凯利公式仓位计算")
    lines.append("=" * 44)
    lines.append(f"  胜率 p          : {r['win_rate_p']:.2%}")
    lines.append(f"  回报倍数 b       : {r['payoff_b']}  (风险回报比 1:{r['payoff_b']})")
    lines.append(f"  期望值          : {r['expected_value_R']:+.3f} R  "
                 f"({'正期望，可交易' if r['expected_value_R'] > 0 else '非正期望，不交易'})")
    lines.append(f"  全凯利 f*       : {r['f_star_full_kelly']:.2%}")
    lines.append(f"  凯利分数        : ×{r['fraction']}")
    lines.append(f"  分数凯利仓位比  : {r['f_fractional']:.2%}")
    lines.append("-" * 44)
    lines.append(f"  账户资金        : {format_cny(r['capital'])}")
    lines.append(f"  止损幅度        : {r['stop_pct']:.2%}")
    lines.append(f"  单笔风险        : {r['risk_pct']:.2%}")
    lines.append(f"  单只上限        : {r['cap_pct']:.2%}")
    lines.append("-" * 44)
    lines.append(f"  ① 风险仓位      : {format_cny(r['risk_position'])}")
    lines.append(f"  ② 分数凯利仓位  : {format_cny(r['kelly_position'])}")
    lines.append(f"  ③ 单只上限仓位  : {format_cny(r['cap_position'])}")
    lines.append("-" * 44)
    if r["recommended_position"] <= 0:
        lines.append(f"  ★ 建议仓位      : 0（{r['binding_constraint']}）")
    else:
        lines.append(f"  ★ 建议仓位      : {format_cny(r['recommended_position'])}  "
                     f"（受【{r['binding_constraint']}】约束）")
        if price and price > 0:
            raw = r["recommended_position"] / price
            shares = int(raw // lot * lot)
            lines.append(f"    ≈ {shares} 股（价 {price}，取整至 {lot} 股倍数）")
    lines.append("=" * 44)
    lines.append("  提示：样本<30笔/参数不稳/肥尾时，把凯利分数降到 0.25；")
    lines.append("        熊市或派发阶段即使 f*>0 也不做多。")
    return "\n".join(lines)


def main():
    ap = argparse.ArgumentParser(
        description="凯利公式仓位计算器（分数凯利 + 固定风险，取最小值）",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    ap.add_argument("-p", "--win-rate", type=float, help="胜率（0~1），如 0.5")
    ap.add_argument("--profile", choices=list(PROFILES), help="策略档位表：swing/canslim/sepa/wyckoff")
    ap.add_argument("--quality", help="信号质量档位（配合 --profile），如 4/5、basic、single；也可直接给数字")
    ap.add_argument("-b", "--payoff", type=float, required=True, help="回报倍数 b＝平均盈利/平均亏损，即风险回报比 1:b 中的 b")
    ap.add_argument("--fraction", type=float, default=0.5, help="凯利分数，默认 0.5（半凯利）")
    ap.add_argument("-T", "--capital", type=float, default=1_000_000.0, help="账户总资金，默认 100 万")
    ap.add_argument("--stop", required=True, help="止损幅度，如 8 或 0.08")
    ap.add_argument("--risk", help="单笔风险%%，默认按 profile（swing/wyckoff=2, canslim/sepa=1.5）")
    ap.add_argument("--cap", help="单只仓位上限%%，默认按 profile（swing/wyckoff=30, canslim/sepa=25）")
    ap.add_argument("--price", type=float, help="现价（给出则换算股数）")
    ap.add_argument("--lot", type=int, default=100, help="每手股数，默认 100（A股）")
    ap.add_argument("--json", action="store_true", help="输出 JSON")
    args = ap.parse_args()

    p, p_src = resolve_win_rate(args)
    if not (0.0 < p < 1.0):
        sys.exit(f"错误：胜率 p 必须在 (0,1)，当前 {p}")
    b = args.payoff
    if b <= 0:
        sys.exit(f"错误：回报倍数 b 必须 > 0，当前 {b}")

    d = DEFAULTS.get(args.profile, DEFAULTS[None])
    risk_pct = as_ratio(args.risk) if args.risk is not None else d["risk"] / 100.0
    cap_pct = as_ratio(args.cap) if args.cap is not None else d["cap"] / 100.0
    stop_pct = as_ratio(args.stop)
    fraction = args.fraction
    if not (0.0 < fraction <= 1.0):
        sys.exit(f"错误：凯利分数应在 (0,1]，当前 {fraction}（禁止 >1 倍凯利）")

    r = kelly(p, b, fraction, args.capital, stop_pct, risk_pct, cap_pct)
    r["win_rate_source"] = p_src

    if args.json:
        print(json.dumps(r, ensure_ascii=False, indent=2))
    else:
        print(human_report(r, price=args.price, lot=args.lot))


if __name__ == "__main__":
    main()
