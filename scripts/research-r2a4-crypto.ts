import { task, delivery } from "./lib/research-r2a4";
import { join } from "node:path";
import { writeFile } from "node:fs/promises";
import { backfillPublicData } from "../src/server/data-sources/binance/public-data-store";
const root = join(task, "data", "market-data", "binance-public-data");
const result = await backfillPublicData({
  root,
  now: Date.parse("2026-11-14T00:00:00Z"),
  progress(done, total, phase) {
    if (done % 25 === 0)
      console.log(
        JSON.stringify({ done, total, phase, at: new Date().toISOString() }),
      );
  },
});
await writeFile(
  join(task, "crypto-coverage.json"),
  JSON.stringify(result, null, 2) + "\n",
);
await delivery({
  cryptoStore: {
    status: "archives-captured",
    root,
    coverage: ".test-data/r2a4/crypto-coverage.json",
    checksum:
      "Every accepted ZIP verified against adjacent official SHA256 CHECKSUM",
    bytes: result.series.reduce((n, s) => n + s.bytes, 0),
    series: result.series.map(({ files, ...s }) => ({
      ...s,
      files: files.length,
      quarantined: files.reduce((n, f) => n + f.quarantined.length, 0),
    })),
  },
});
console.log(
  JSON.stringify({
    complete: true,
    bytes: result.series.reduce((n, s) => n + s.bytes, 0),
  }),
);
process.exit(0);
