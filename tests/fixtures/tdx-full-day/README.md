# Synthetic full-package fixtures

Hand-built ZIPs, not vendor data. Each valid day record is little-endian
`<IIIIIfII`: date 20260911, OHLC 1000/1200/900/1100 (price x100), amount
110000, volume 10000, reserved zero. ZIP timestamps are fixed at 2026-09-11.
The malformed archives test traversal, duplicate member names and a 31-byte record.
with-index.zip contains the same synthetic record under sh/lday/sh000001.day.
These fixtures exercise the assumed market/lday layout; a real full vendor ZIP
still requires verification before claiming vendor compatibility.
