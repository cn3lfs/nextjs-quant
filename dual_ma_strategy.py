from mindgo_api import *


def init(context):
    """双均线策略：短均线上穿长均线满仓买入，下穿清仓。"""
    g.symbol = "600519.SH"
    g.short_window = 5
    g.long_window = 20

    set_benchmark("000300.SH")
    set_commission(PerShare(type="stock", cost=0.0003))
    set_slippage(PriceSlippage(0.002))
    log.info("策略初始化完成: symbol=%s, MA%d/MA%d" % (g.symbol, g.short_window, g.long_window))


def handle_bar(context, bar_dict):
    close = history(g.symbol, ["close"], g.long_window + 1, "1d", fq="pre")["close"]
    if len(close) < g.long_window + 1:
        return

    ma_short_prev = close[-(g.short_window + 1):-1].mean()
    ma_long_prev = close[-(g.long_window + 1):-1].mean()
    ma_short = close[-g.short_window:].mean()
    ma_long = close[-g.long_window:].mean()

    positions = context.portfolio.positions
    position = positions[g.symbol].amount if g.symbol in positions.keys() else 0

    if ma_short_prev <= ma_long_prev and ma_short > ma_long and position == 0:
        order_target_percent(g.symbol, 0.95)
        log.info("金叉买入 MA%d=%.2f MA%d=%.2f" % (g.short_window, ma_short, g.long_window, ma_long))
    elif ma_short_prev >= ma_long_prev and ma_short < ma_long and position > 0:
        order_target_percent(g.symbol, 0)
        log.info("死叉清仓 MA%d=%.2f MA%d=%.2f" % (g.short_window, ma_short, g.long_window, ma_long))
