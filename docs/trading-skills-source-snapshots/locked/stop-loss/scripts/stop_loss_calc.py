#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""止损位与仓位计算器。

用法示例（--equity 默认 100 万，便于按自有资金等比换算）：
  python stop_loss_calc.py --risk-pct 1 --entry 80 --stop 76 --lot 100
  python stop_loss_calc.py --equity 1000000 --risk-pct 1 --entry 80 --atr 2.5 --k 1.5 --target 92
  python stop_loss_calc.py --equity 1000000 --risk-pct 1 --entry 80 --atr 2.5 --swing-low 76.5 --pct 5

止损价来源优先级：显式 --stop > 三方案对照中用户选择。
未给 --stop 时，脚本会列出百分比/ATR/结构位三套方案，并以最保守（距离最大）的一套作为推荐。
"""

import argparse
import math
import sys

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")


def fmt(x, nd=4):
    return f"{x:,.{nd}f}".rstrip("0").rstrip(".") if isinstance(x, float) else f"{x:,}"


def build_candidates(args):
    """返回 [(方法名, 止损价)]，做多为入场下方，做空为上方。"""
    out = []
    sign = -1 if args.side == "long" else 1
    if args.pct is not None:
        out.append((f"百分比 {args.pct}%", args.entry * (1 + sign * args.pct / 100)))
    if args.atr is not None:
        out.append((f"ATR {args.k}x (ATR={fmt(args.atr)})", args.entry + sign * args.k * args.atr))
    if args.swing_low is not None and args.side == "long":
        buf = args.buffer_atr * args.atr if args.atr else args.swing_low * args.buffer_pct / 100
        out.append((f"结构位 前低{fmt(args.swing_low)} - 缓冲{fmt(buf)}", args.swing_low - buf))
    if args.swing_high is not None and args.side == "short":
        buf = args.buffer_atr * args.atr if args.atr else args.swing_high * args.buffer_pct / 100
        out.append((f"结构位 前高{fmt(args.swing_high)} + 缓冲{fmt(buf)}", args.swing_high + buf))
    return out


def size_position(equity, risk_pct, entry, stop, lot, slippage, max_weight):
    risk_cash = equity * risk_pct / 100
    dist = abs(entry - stop)
    if dist <= 0:
        raise ValueError("止损距离为 0，请检查入场价与止损价。")
    raw_qty = risk_cash / dist
    qty = int(math.floor(raw_qty / lot) * lot)

    notes = []
    if max_weight:
        cap_qty = int(math.floor((equity * max_weight / 100) / entry / lot) * lot)
        if cap_qty < qty:
            notes.append(f"受市值上限 {max_weight}% 约束，仓位由 {qty} 降至 {cap_qty} 股")
            qty = cap_qty
    if qty <= 0:
        notes.append("按当前风险预算与止损距离，无法买入一个最小交易单位；应放弃该交易或等待更近的入场点。")

    actual_risk = qty * dist
    risk_with_slip = qty * (dist + slippage) if slippage else actual_risk
    return {
        "risk_cash": risk_cash,
        "dist": dist,
        "dist_pct": dist / entry * 100,
        "raw_qty": raw_qty,
        "qty": qty,
        "notional": qty * entry,
        "weight": (qty * entry / equity * 100) if equity else 0.0,
        "actual_risk": actual_risk,
        "actual_risk_pct": actual_risk / equity * 100 if equity else 0.0,
        "risk_with_slip": risk_with_slip,
        "notes": notes,
    }


def main():
    p = argparse.ArgumentParser(description="止损位与仓位计算器")
    p.add_argument("--equity", type=float, default=1_000_000.0, help="账户权益，默认 100 万")
    p.add_argument("--risk-pct", type=float, default=1.0, help="单笔风险占权益百分比，默认 1")
    p.add_argument("--entry", type=float, required=True, help="入场价")
    p.add_argument("--side", choices=["long", "short"], default="long", help="方向，默认 long")
    p.add_argument("--stop", type=float, help="止损价（给定则直接使用）")
    p.add_argument("--pct", type=float, help="百分比止损方案的百分比，如 5")
    p.add_argument("--atr", type=float, help="ATR 数值")
    p.add_argument("--k", type=float, default=1.5, help="ATR 倍数，默认 1.5")
    p.add_argument("--swing-low", type=float, help="做多的前摆动低点")
    p.add_argument("--swing-high", type=float, help="做空的前摆动高点")
    p.add_argument("--buffer-atr", type=float, default=0.3, help="结构位缓冲的 ATR 倍数，默认 0.3")
    p.add_argument("--buffer-pct", type=float, default=0.5, help="无 ATR 时结构位缓冲百分比，默认 0.5")
    p.add_argument("--lot", type=int, default=100, help="最小交易单位，A股 100，美股 1")
    p.add_argument("--slippage", type=float, default=0.0, help="每股预估滑点")
    p.add_argument("--max-weight", type=float, default=20.0, help="单标的市值占比上限%%，默认 20，设 0 关闭")
    p.add_argument("--target", type=float, help="目标价，用于计算盈亏比")
    args = p.parse_args()

    cands = build_candidates(args)
    stop = args.stop

    print(f"\n=== 输入 ===")
    print(f"账户 {fmt(args.equity,2)} | 单笔风险 {args.risk_pct}% = {fmt(args.equity*args.risk_pct/100,2)}"
          f" | 方向 {args.side} | 入场 {fmt(args.entry)}")

    if cands:
        print("\n=== 止损方案对照 ===")
        for name, s in cands:
            d = abs(args.entry - s)
            print(f"  {name:<34} 止损 {fmt(s):>10}   距离 {fmt(d):>8} ({d/args.entry*100:.2f}%)")

    if stop is None:
        if not cands:
            print("\n错误：需提供 --stop，或提供 --pct / --atr / --swing-low 之一以生成方案。", file=sys.stderr)
            return 1
        # 最保守 = 距离最大
        name, stop = max(cands, key=lambda t: abs(args.entry - t[1]))
        print(f"\n未指定 --stop，采用最保守方案：{name} → {fmt(stop)}")

    r = size_position(args.equity, args.risk_pct, args.entry, stop,
                      args.lot, args.slippage, args.max_weight)

    print(f"\n=== 仓位 ===")
    print(f"止损价      {fmt(stop)}")
    print(f"止损距离    {fmt(r['dist'])} ({r['dist_pct']:.2f}%)")
    print(f"理论股数    {r['raw_qty']:.1f} → 实际 {r['qty']:,} 股（{args.lot} 股为单位）")
    print(f"占用资金    {fmt(r['notional'],2)}  占权益 {r['weight']:.2f}%")
    print(f"实际风险    {fmt(r['actual_risk'],2)}  = 权益的 {r['actual_risk_pct']:.2f}%")
    if args.slippage:
        print(f"计滑点后    {fmt(r['risk_with_slip'],2)}（每股滑点 {fmt(args.slippage)}）")
    for n in r["notes"]:
        print(f"  ! {n}")

    if args.target and r["qty"] > 0:
        reward = abs(args.target - args.entry)
        rr = reward / r["dist"]
        print(f"\n=== 盈亏比 ===")
        print(f"目标 {fmt(args.target)} | 潜在盈利 {fmt(reward*r['qty'],2)} | R:R = 1:{rr:.2f}")
        if rr < 2:
            print("  ! 盈亏比低于 1:2，除非胜率有统计支持，否则建议放弃或等待更好入场点。")

    if r["qty"] > 0:
        print(f"\n=== R 倍数关键位 ===")
        s = 1 if args.side == "long" else -1
        for m in (1, 2, 3):
            print(f"  +{m}R  价格 {fmt(args.entry + s*m*r['dist'])}"
                  f"   盈利 {fmt(m*r['actual_risk'],2)}")
        print(f"  管理建议：+1R 移止损至保本 {fmt(args.entry)}；"
              f"+2R 减半并将止损移至 {fmt(args.entry + s*r['dist'])}；其后按移动止损跟随。")
    print()
    return 0


if __name__ == "__main__":
    sys.exit(main())
