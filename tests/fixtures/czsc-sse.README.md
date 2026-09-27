# CZSC SSE fixture

Extracted without modifying values from `D:/github/czsc-tdx/tests/SseIndexDaily.h`,
source HEAD `b67f3c642a8542ab9abd30c920ebf88f2cfdb7f8`.
2038 daily bars, 2018-01-26 through 2026-06-26; source header labels the series
as forward-adjusted SSE index data. JSON preserves high, low, close, volume and date.
No open-price substitute is fabricated; the native ABI consumes H/L/C/V only.

The source repository identifies its code license as GPL v3 (Martin Tang, 2016).

`czsc-sse-golden.txt` is a verbatim copy of czsc-tdx `tests/unit/golden/sse.txt`
at `4af864a`. Structure sections are rendered from H/L only (MACD uses the engine's
(H+L)/2 proxy, so the test feeds exactly that as close); the recursion section uses
the real close/volume. It is the authority for configs 0 and 1100.
