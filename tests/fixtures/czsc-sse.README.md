# CZSC SSE fixture

Extracted without modifying values from `D:/github/czsc-tdx/tests/SseIndexDaily.h`,
source HEAD `b67f3c642a8542ab9abd30c920ebf88f2cfdb7f8`.
2038 daily bars, 2018-01-26 through 2026-06-26; source header labels the series
as forward-adjusted SSE index data. JSON preserves high, low, close, volume and date.
No open-price substitute is fabricated; the native ABI consumes H/L/C/V only.

Golden expectations come exclusively from `tests/CzscCoreTests.cpp`:
`TestRealSseDiagnosticCounts`, `TestRealSseGoldenCentersPresent`, and
`TestRealSseGoldenSegmentCentersPresent`. The manual notes are not authoritative.
The source repository identifies its code license as GPL v3 (Martin Tang, 2016).

`czsc-sse-structures.txt` preserves the first full-history L001–L015,
BZ00–BZ17 and SZ00–SZ01 lines verbatim from `tests/czsc_sse_result.txt` at
the same source commit. Its center prices use the generator's `%.0f` format;
the separate C++ anchor assertions retain float32 precision and <0.0001 tolerance.
