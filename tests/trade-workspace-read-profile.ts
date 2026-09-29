import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve, relative, isAbsolute } from "node:path";
const directory = resolve(process.env.QUANT_DATA_DIR ?? "");
const child = relative(resolve(tmpdir()), directory);
assert.ok(
  !isAbsolute(child) &&
    !child.startsWith("..") &&
    child.startsWith("quant-trade-ledger-"),
);
const originalOpen = fs.open;
let active = 0,
  peak = 0,
  reads = 0;
fs.open = async (...args: Parameters<typeof originalOpen>) => {
  const handle = await originalOpen(...args);
  if (String(args[0]).endsWith(".day")) {
    // Proxy preserves every FileHandle.readFile overload and its receiver.
    handle.readFile = new Proxy(handle.readFile, {
      async apply(read, receiver, options) {
        reads++;
        active++;
        peak = Math.max(active, peak);
        try {
          return await Reflect.apply(read, receiver, options);
        } finally {
          active--;
        }
      },
    });
  }
  return handle;
};
syncBuiltinESMExports();
try {
  const { tradeWorkspacePositions } =
    await import("../src/server/portfolio/trade-workspace-service");
  const start = performance.now();
  const result = await tradeWorkspacePositions({});
  assert.equal(result.summary.trades, 10000);
  assert.equal(result.summary.missingQuotes, 1);
  assert.equal(reads, 199);
  assert.equal(active, 0);
  const evidence = {
    ms: performance.now() - start,
    reads,
    peakOutstandingReadPromises: peak,
    meaning:
      "Node FileHandle.readFile promises, not physical disk parallelism; isolated synthetic day files",
  };
  await fs.writeFile(
    join(tmpdir(), "logs/quant-trade-ledger/read-profile.json"),
    JSON.stringify(evidence, null, 2),
  );
  console.log(evidence);
} finally {
  fs.open = originalOpen;
  syncBuiltinESMExports();
}
