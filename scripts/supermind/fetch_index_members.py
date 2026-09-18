"""S5 fetch B: point-in-time index membership.

Runs on the SuperMind research kernel. Takes no parameters, so running it twice
is literally the same request.

`get_index_stocks(code, date=D)` returns the constituent list recorded for D.
Verified against the platform before freezing: the 2015 and 2025 CSI 300 lists
differ by 332 names, and an index returns nothing at all before its inception
date (932000.CSI -> 0 rows in 2015, 2000 rows in 2025), so the platform is not
back-filling membership. That second property is the one that matters: it means
a pre-inception query yields an honest empty result rather than a
look-ahead list, and the local side can therefore treat "0 rows before
inception" as a fact about the index rather than an error.

中证A500 is `000510.CSI` and its inception is 2024-09-23, which is the reason
this script also records a pre-inception date: the empty result is evidence, not
a gap to be papered over.
"""

import json

from mindgo_api import get_index_stocks, get_security_info, write_file

PROBES = [
    ("000300.SH", "2010-01-04"),
    ("000300.SH", "2015-01-05"),
    ("000300.SH", "2025-01-02"),
    ("000510.CSI", "2020-01-02"),
    ("000510.CSI", "2024-09-30"),
    ("000510.CSI", "2025-01-02"),
]
OUTPUT_PATH = "mcp/nextjs-quant/s5-index-members.json"


def main():
    rows = []
    empty = []
    for index_code, date in PROBES:
        symbols = get_index_stocks(index_code, date=date)
        symbols = [str(item) for item in (symbols or [])]
        print("%s %s n=%d" % (index_code, date, len(symbols)))
        if not symbols:
            empty.append({"indexCode": index_code, "snapshotDate": date})
            continue
        rows.append(
            {
                "indexCode": index_code,
                "snapshotDate": date,
                "symbols": sorted(symbols),
            }
        )
    info = get_security_info("000510.CSI")
    print("000510.CSI display_name=%s start_date=%s" % (info.display_name, info.start_date))
    for row in rows:
        print("  %s %s head=%s" % (row["indexCode"], row["snapshotDate"], row["symbols"][:5]))
    print("empty (pre-inception or unknown) probes: %s" % (empty,))
    payload = json.dumps(rows, ensure_ascii=False, sort_keys=True)
    print("wrote %s bytes=%d" % (OUTPUT_PATH, write_file(OUTPUT_PATH, payload)))


if __name__ == "__main__":
    main()
