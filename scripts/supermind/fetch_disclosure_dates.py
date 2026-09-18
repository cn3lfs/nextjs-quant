"""S5 fetch A: real disclosure dates (公布日) for a small sample.

Runs on the SuperMind research kernel. The local repo is the editing side; this
file is transmitted to the remote kernel and executed there. It takes no
parameters, so running it twice is literally the same request.

Why `get_fundamentals(query(...), date=D)` and not `run_query`:
`profit_report` is the 业绩快报 table (tens of rows per snapshot) while `income`
carries the real statement calendar (`report_date` 公布日, `stat_date` 报告期,
`change_id` 变更批次) for several thousand symbols per snapshot. Only
`get_fundamentals(..., date=D)` returns rows at all: `run_query` returns none for
these tables, and `statDate=` returns none for any table tried.

What this script asserts about the platform, so the local freeze step does not
have to guess:
  * every returned row has report_date <= D, i.e. the snapshot never contains a
    statement announced after D. The script aborts if that is ever violated.

The JSON it writes is a raw platform response, not a frozen snapshot: field
mapping, the `availableAt` policy and hashing all happen locally in TypeScript.
"""

import json
from decimal import Decimal

from mindgo_api import get_fundamentals, income, query, write_file

SAMPLE_SYMBOLS = [
    "600519.SH",
    "600000.SH",
    "000001.SZ",
    "000002.SZ",
    "601318.SH",
]
SNAPSHOT_DATES = ["2020-04-10", "2021-04-30", "2023-04-28"]

COLUMNS = [
    income.symbol,
    income.date,
    income.report_date,
    income.stat_date,
    income.change_id,
    income.overall_income,
]
OUTPUT_PATH = "mcp/nextjs-quant/s5-disclosure-dates.json"


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
    wanted = set(SAMPLE_SYMBOLS)
    rows = []
    violations = []
    for snapshot in SNAPSHOT_DATES:
        frame = get_fundamentals(query(*COLUMNS), date=snapshot)
        print("snapshot %s rows=%d" % (snapshot, len(frame)))
        if not len(frame):
            continue
        for _, item in frame.iterrows():
            symbol = str(item["income_symbol"])
            if symbol not in wanted:
                continue
            report_date = str(item["income_report_date"])[:10]
            if report_date > snapshot:
                violations.append((snapshot, symbol, report_date))
                continue
            rows.append(
                {
                    "table": "income",
                    "symbol": symbol,
                    "snapshotDate": snapshot,
                    "reportDate": report_date,
                    "statDate": str(item["income_stat_date"])[:10],
                    "changeId": int(item["income_change_id"]),
                    "overallIncome": decimal_text(item["income_overall_income"]),
                }
            )
    if violations:
        raise AssertionError(
            "快照含晚于快照日的公布日，平台不再是时点数据：%s" % (violations[:5],)
        )
    print("collected rows=%d" % len(rows))
    for row in sorted(rows, key=lambda r: (r["snapshotDate"], r["symbol"], r["statDate"])):
        print(
            "  %s %s stat=%s report=%s chg=%s revenue=%s"
            % (
                row["snapshotDate"],
                row["symbol"],
                row["statDate"],
                row["reportDate"],
                row["changeId"],
                row["overallIncome"],
            )
        )
    payload = json.dumps(rows, ensure_ascii=False, sort_keys=True)
    print("wrote %s bytes=%d" % (OUTPUT_PATH, write_file(OUTPUT_PATH, payload)))


if __name__ == "__main__":
    main()
