import koffi from "koffi";
import {
  readdir,
  stat,
  writeFile,
  readFile,
  open as openFile,
  rename,
  rm,
  lstat,
} from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import { resolve, join } from "node:path";
import { parseArgs } from "node:util";
import { tdxImportTargets } from "./lib/tdx-import-paths";

const { values } = parseArgs({
  options: {
    "tdx-root": { type: "string" },
    out: { type: "string" },
    "remove-zero-prices": { type: "boolean" },
    "source-issues": { type: "string" },
    "price-report": { type: "string" },
  },
});
if (!values["tdx-root"] || !values.out)
  throw new Error("--tdx-root and --out are required");
const { root, targets } = await tdxImportTargets(values["tdx-root"]);
let selected: Set<string> | undefined;
if (values["price-report"]) {
  const report = JSON.parse(await readFile(values["price-report"], "utf8")) as {
    root: string;
    details: { path: string; counts?: number[] }[];
  };
  if (resolve(report.root).toLowerCase() !== root.toLowerCase())
    throw new Error("Audit report target differs");
  selected = new Set(
    report.details
      .filter((d) => d.counts?.[3])
      .map((d) => resolve(d.path).toLowerCase()),
  );
}
if (values["remove-zero-prices"] && !values["source-issues"])
  throw new Error("Removing zero prices requires a WDZ source-issues report");
const allowed = new Map<string, Set<number>>();
if (values["source-issues"]) {
  const lines = createInterface({
    input: createReadStream(values["source-issues"], { encoding: "utf8" }),
    crlfDelay: Infinity,
  });
  for await (const line of lines) {
    if (!line.trim()) continue;
    const row = JSON.parse(line) as {
      symbol?: string;
      skipped?: string;
      records?: number;
      times?: string[];
    };
    if (!row.skipped || !row.records || !row.symbol || !row.times) continue;
    const symbol = row.symbol.toLowerCase(),
      stamps = allowed.get(symbol) ?? new Set<number>();
    for (const time of row.times) {
      const y = Number(time.slice(0, 4)),
        m = Number(time.slice(5, 7)),
        d = Number(time.slice(8, 10));
      const b = Buffer.alloc(4);
      b.writeUInt16LE((((y - 2004) & 31) << 11) + m * 100 + d);
      b.writeUInt16LE(
        Number(time.slice(11, 13)) * 60 + Number(time.slice(14, 16)),
        2,
      );
      stamps.add(b.readUInt32LE());
    }
    allowed.set(symbol, stamps);
  }
}
const os = koffi.load("kernel32.dll");
const open = os.func(
  "void * __stdcall CreateFileW(str16, uint32, uint32, void *, uint32, uint32, void *)",
);
const mapping = os.func(
  "void * __stdcall CreateFileMappingW(void *, void *, uint32, uint32, uint32, str16)",
);
const view = os.func(
  "void * __stdcall MapViewOfFile(void *, uint32, uint32, uint32, size_t)",
);
const unmap = os.func("int __stdcall UnmapViewOfFile(void *)");
const close = os.func("int __stdcall CloseHandle(void *)");
const audit = koffi
  .load(resolve("runtime/tdx-import/audit.dll"))
  .func("void lc5_audit(const void *, uint32, void *, void *, uint32, int)");
const clean = koffi
  .load(resolve("runtime/tdx-import/audit.dll"))
  .func(
    "int lc5_remove_zero_prices(const void *, uint32, void *, const void *, uint32)",
  );
const totals = {
  files: 0,
  records: 0,
  badDates: 0,
  badOrder: 0,
  badPrices: 0,
  badAmounts: 0,
  zeroVolumeWithAmount: 0,
  errors: 0,
  removedZeroPrices: 0,
};
const details = [];
const started = performance.now();
for (const directory of Object.values(targets)) {
  for (const name of (await readdir(directory)).filter((s) =>
    /\.lc5$/i.test(s),
  )) {
    const path = join(directory, name);
    if (selected && !selected.has(resolve(path).toLowerCase())) continue;
    let file: bigint | null = null,
      map: bigint | null = null,
      ptr: bigint | null = null;
    totals.files++;
    try {
      const size = (await stat(path)).size;
      if ((await lstat(path)).isSymbolicLink())
        throw new Error("LC5 symbolic link not supported");
      if (size % 32 || size / 32 > 0xffffffff)
        throw new Error("LC5 record length invalid");
      if (!size) continue;
      file = open(path, 0x80000000, 7, null, 3, 128, null) as bigint | null;
      if (!file || BigInt.asIntN(64, file) === -1n)
        throw new Error("open failed");
      map = mapping(file, null, 2, 0, 0, null) as bigint | null;
      if (!map) throw new Error("mapping failed");
      ptr = view(map, 4, 0, 0, 0) as bigint | null;
      if (!ptr) throw new Error("view failed");
      const stats = Buffer.alloc(28),
        examples = Buffer.alloc(32 * 8);
      audit(ptr, size / 32, stats, examples, 32, new Date().getFullYear());
      const counts = Array.from({ length: 7 }, (_, i) =>
        stats.readUInt32LE(i * 4),
      );
      totals.records += counts[0]!;
      totals.badDates += counts[1]!;
      totals.badOrder += counts[2]!;
      totals.badPrices += counts[3]!;
      totals.badAmounts += counts[4]!;
      totals.zeroVolumeWithAmount += counts[5]!;
      if (counts.slice(1, 6).some(Boolean))
        details.push({
          path,
          counts,
          examples: Array.from({ length: counts[6]! }, (_, i) => ({
            record: examples.readUInt32LE(i * 8),
            flags: examples.readUInt32LE(i * 8 + 4),
          })),
        });
      const stamps = allowed.get(name.replace(/\.lc5$/i, "").toLowerCase());
      if (values["remove-zero-prices"] && counts[3] && stamps?.size) {
        // Close this view before replacing the file; execute without other writers.
        unmap(ptr);
        ptr = null;
        close(map);
        map = null;
        close(file);
        file = null;
        const data = await readFile(path),
          output = Buffer.allocUnsafe(data.length);
        if (data.length !== size) throw new Error("LC5 changed during audit");
        const sorted = [...stamps].sort((a, b) => a - b),
          keys = Buffer.alloc(sorted.length * 4);
        sorted.forEach((stamp, i) => keys.writeUInt32LE(stamp, i * 4));
        const kept = clean(
          data,
          data.length / 32,
          output,
          keys,
          sorted.length,
        ) as number;
        const removed = data.length / 32 - kept;
        if (kept < 0 || kept > data.length / 32)
          throw new Error("LC5 cleanup result invalid");
        if (removed) {
          const temporary = `${path}.quant-${randomUUID()}.tmp`;
          try {
            const handle = await openFile(temporary, "wx");
            try {
              await handle.writeFile(output.subarray(0, kept * 32));
            } finally {
              await handle.close();
            }
            await rename(temporary, path);
          } finally {
            await rm(temporary, { force: true });
          }
          totals.removedZeroPrices += removed;
          totals.badPrices -= removed;
          totals.records -= removed;
          details.push({ path, removedZeroPrices: removed });
        }
      }
    } catch (error) {
      totals.errors++;
      details.push({ path, error: String(error) });
    } finally {
      if (ptr) unmap(ptr);
      if (map) close(map);
      if (file && BigInt.asIntN(64, file) !== -1n) close(file);
    }
    if (totals.files % 1000 === 0)
      console.log(
        JSON.stringify({
          ...totals,
          seconds: (performance.now() - started) / 1000,
        }),
      );
  }
}
const result = {
  root,
  scope: selected ? "price-anomalies-from-report" : "all-lc5",
  auditedAt: new Date().toISOString(),
  countsOrder: [
    "records",
    "badDates",
    "badOrder",
    "badPrices",
    "badAmounts",
    "zeroVolumeWithAmount",
    "examples",
  ],
  ...totals,
  seconds: (performance.now() - started) / 1000,
  details,
};
await writeFile(resolve(values.out), JSON.stringify(result, null, 2));
console.log(
  JSON.stringify({
    ...totals,
    seconds: result.seconds,
    report: resolve(values.out),
  }),
);
if (totals.errors) process.exitCode = 1;
