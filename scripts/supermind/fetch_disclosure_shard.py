"""S5 batch-2 shard fetch: statement disclosure dates AND statement metrics.

Runs on the SuperMind research kernel. The shard point (`__TABLE__`,
`__START__`, `__END__`) is substituted locally before the source is sent, so one
file serves all 20 shards.

One trading day in the R3 window = one `get_fundamentals(..., date=D)` call. The
grid must be every trading day, not period ends: a `(symbol, 报告期)` row is
visible only between its own announcement and the next one, so a sparser grid
silently drops periods and pollutes the past with the wrong report period.

De-duplication happens HERE, on the platform side. A row is observed on every
trading day between two announcements (~60 observations for a quarterly), and
shipping all of them would move ~10.5 GB for a ~0.5 GB fact set. The dedup key
is the fact itself, so the file is independent of which shard or grid produced
it; the local freeze step then collapses across shards by the same identity.

Asserted here so the local step does not have to guess: every returned row has
`report_date <= D`. The script aborts if the platform ever returns a statement
announced after the snapshot date.
"""

import gzip
import json
from decimal import Decimal

from mindgo_api import (
    balance,
    cashflow,
    get_fundamentals,
    get_trade_days,
    income,
    query,
    write_file,
)

TABLE = "__TABLE__"
START = "__START__"
END = "__END__"
# Written gzipped because the platform imposes a daily DOWNLOAD byte quota
# (measured: ~50 MiB/day, see .codex-runs/s5-delivery.md 9.9). This is a
# transport-only change: the local side gunzips and the frozen payload bytes are
# unchanged, which is verified by re-deriving the SAME payloadHash from a
# gzipped transfer. `gzip` is not in the skill's forbidden-module list.
OUTPUT_PATH = "mcp/nextjs-quant/s5-shard-__TABLE__-__START__.json.gz"

INCOME_COLS = [
    income.symbol, income.date, income.report_date, income.stat_date,
    income.change_id, income.reporttypecode,
    income.overall_income, income.operating_income, income.overall_costs,
    income.operations_costs, income.operating_expenses,
    income.profit_from_operations, income.non_operating_profit,
    income.non_operating_expenses, income.profit_before_tax,
    income.minus_income_tax_expenses, income.net_profit, income.np_atsopc,
    income.minority_interest_income, income.basic_eps, income.diluted_eps,
    income.total_comprehensive_income, income.income_from_main_business,
    income.cost_of_main_business, income.profit_of_main_business,
    income.investment_income, income.fv_chg_income, income.sales_fee,
    income.manage_fee, income.financial_expenses,
    income.operations_taxes_and_surcharges, income.impairment_loss_on_assets,
]
INCOME_NAMES = [
    "symbol", "date", "report_date", "stat_date", "change_id", "reporttypecode",
    "overall_income", "operating_income", "overall_costs", "operations_costs",
    "operating_expenses", "profit_from_operations", "non_operating_profit",
    "non_operating_expenses", "profit_before_tax", "minus_income_tax_expenses",
    "net_profit", "np_atsopc", "minority_interest_income", "basic_eps",
    "diluted_eps", "total_comprehensive_income", "income_from_main_business",
    "cost_of_main_business", "profit_of_main_business", "investment_income",
    "fv_chg_income", "sales_fee", "manage_fee", "financial_expenses",
    "operations_taxes_and_surcharges", "impairment_loss_on_assets",
]

BALANCE_COLS = [
    balance.symbol, balance.date, balance.report_date, balance.stat_date,
    balance.change_id, balance.reporttypecode,
    balance.total_assets, balance.total_current_assets,
    balance.total_non_current_assets, balance.cash, balance.accounts_receivable,
    balance.notes_receivable, balance.inventory, balance.fixed_asset,
    balance.cip_project, balance.intangible_assets, balance.goodwill,
    balance.total_liabilities, balance.current_liabilities,
    balance.non_current_liabilities, balance.short_term_loan,
    balance.long_term_loan, balance.total_equity, balance.total_quity_atsopc,
    balance.minority_equity, balance.undistributed_profits,
    balance.total_share_capital,
]
BALANCE_NAMES = [
    "symbol", "date", "report_date", "stat_date", "change_id", "reporttypecode",
    "total_assets", "total_current_assets", "total_non_current_assets", "cash",
    "accounts_receivable", "notes_receivable", "inventory", "fixed_asset",
    "cip_project", "intangible_assets", "goodwill", "total_liabilities",
    "current_liabilities", "non_current_liabilities", "short_term_loan",
    "long_term_loan", "total_equity", "total_quity_atsopc", "minority_equity",
    "undistributed_profits", "total_share_capital",
]

CASHFLOW_COLS = [
    cashflow.symbol, cashflow.date, cashflow.report_date, cashflow.stat_date,
    cashflow.change_id, cashflow.reporttypecode,
    cashflow.net_cashflows_from_operating_act,
    cashflow.net_cashflows_from_investing_act, cashflow.ncf_from_fa,
    cashflow.cash_received_from_sales,
    cashflow.goods_buy_and_service_cash_pay, cashflow.employees_cash_payments,
    cashflow.payments_of_taxes, cashflow.cash_paid_for_assets,
    cashflow.invest_paid_cash, cashflow.net_profit, cashflow.depreciation_etc,
    cashflow.cash_and_cash_equivalents_at_end, cashflow.net_increase_in_cce,
    cashflow.initial_cce_balance,
]
CASHFLOW_NAMES = [
    "symbol", "date", "report_date", "stat_date", "change_id", "reporttypecode",
    "net_cashflows_from_operating_act", "net_cashflows_from_investing_act",
    "ncf_from_fa", "cash_received_from_sales",
    "goods_buy_and_service_cash_pay", "employees_cash_payments",
    "payments_of_taxes", "cash_paid_for_assets", "invest_paid_cash",
    "net_profit", "depreciation_etc", "cash_and_cash_equivalents_at_end",
    "net_increase_in_cce", "initial_cce_balance",
]

SHARDS = {
    "income": (INCOME_COLS, INCOME_NAMES),
    "balance": (BALANCE_COLS, BALANCE_NAMES),
    "cashflow": (CASHFLOW_COLS, CASHFLOW_NAMES),
}

# `valuation` is deliberately NOT sharded. Its metrics (PE / PB / PS / market
# cap) move with the share price every day while 报告期 and 公布日 stay fixed, so
# the "one row per period, keep the first observation" model that is correct for
# the three statement tables would silently freeze a multiple at the first day
# it became visible. Measured: 40 of 40 sampled valuation keys carried more than
# one metric value inside a 7-day window, versus 0 for income/balance/cashflow.
# Manager ruling 2026-09-19: quotes stay local and PE/PB are derivable from
# local price + the frozen statements + local GBBQ shares, so the cloud copy is
# dropped for this batch rather than fetched under a wrong key.
IDENTITY = ("symbol", "date", "report_date", "stat_date", "change_id",
            "reporttypecode")


def decimal_text(value):
    """Exact decimal text, or None. Never a binary float in the frozen file."""
    if value is None:
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    if number != number or number == float("inf") or number == float("-inf"):
        return None
    return format(Decimal(repr(number)), "f")


def main():
    columns, names = SHARDS[TABLE]
    days = [str(d)[:10] for d in get_trade_days(start_date=START, end_date=END)]
    print("shard table=%s %s..%s trading_days=%d columns=%d"
          % (TABLE, START, END, len(days), len(columns)))

    seen = {}
    rows_seen = 0
    violations = []
    for index, date in enumerate(days):
        frame = get_fundamentals(query(*columns), date=date)
        rows_seen += len(frame)
        if not len(frame):
            continue
        for _, item in frame.iterrows():
            report_date = str(item["%s_report_date" % TABLE])[:10]
            symbol = str(item["%s_symbol" % TABLE])
            if report_date > date:
                violations.append((date, symbol, report_date))
                continue
            stat_date = str(item["%s_stat_date" % TABLE])[:10]
            raw_change = item.get("%s_change_id" % TABLE)
            change_id = None if raw_change is None else int(raw_change)
            metrics = {}
            for name in names:
                if name in IDENTITY:
                    continue
                text = decimal_text(item["%s_%s" % (TABLE, name)])
                if text is not None:
                    metrics[name] = text
            key = (symbol, report_date, stat_date, change_id)
            if key in seen:
                continue
            seen[key] = {
                "table": TABLE,
                "symbol": symbol,
                "snapshotDate": date,
                "reportDate": report_date,
                "statDate": stat_date,
                "changeId": change_id,
                "metrics": metrics,
            }
        if index % 250 == 0:
            print("  ..%s snapshots=%d rows_seen=%d distinct=%d"
                  % (date, index + 1, rows_seen, len(seen)))

    if violations:
        raise AssertionError(
            "快照含晚于快照日的公布日，平台不再是时点数据：%s" % (violations[:5],)
        )
    records = sorted(seen.values(), key=lambda r: (r["symbol"], r["statDate"], r["reportDate"]))
    payload = json.dumps(records, ensure_ascii=False, sort_keys=True).encode("utf-8")
    packed = gzip.compress(payload, 9)
    print("distinct_facts=%d rows_seen=%d calls=%d" % (len(records), rows_seen, len(days)))
    print("payload bytes=%d gzip bytes=%d ratio=%.2fx"
          % (len(payload), len(packed), len(payload) / len(packed)))
    print("wrote %s bytes=%d" % (OUTPUT_PATH, write_file(OUTPUT_PATH, packed)))


if __name__ == "__main__":
    main()
