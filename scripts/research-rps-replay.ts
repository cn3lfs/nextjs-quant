/** Offline verification of the R2a-2 full-market RPS snapshot.
 * Set an absolute isolated QUANT_DATA_DIR, then pass the manifest SHA256.
 * Checks every input/output file and recomputes every frozen cross-section.
 * Ranking replay is separate from strategy/funds validation.
 */
import { readFile, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { isAbsolute, join, resolve, sep } from "node:path";
import { z } from "zod";
import { calculateRps, type RpsSecurity } from "quant-rps";
import { strategyBuildHash } from "trading-strategies";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const periods = z.tuple([z.literal(20), z.literal(50), z.literal(120)]);
const directory = process.env.QUANT_DATA_DIR;
if (
  !directory ||
  !isAbsolute(directory) ||
  !resolve(directory).startsWith(resolve(".test-data") + sep)
)
  throw new Error("Set an absolute isolated QUANT_DATA_DIR inside .test-data");
if (process.argv.length !== 3)
  throw new Error("Pass exactly one manifest hash");
const root = join(directory, "research-validation");
async function artifact(hash: string): Promise<unknown> {
  digest.parse(hash);
  const path = join(root, `report-${hash}.json`);
  if ((await stat(path)).size > 256 * 1024 ** 2)
    throw new Error("RPS artifact exceeds existing 256MiB budget");
  const body = await readFile(path, "utf8");
  if (createHash("sha256").update(body).digest("hex") !== hash)
    throw new Error(`RPS artifact hash mismatch: ${hash}`);
  return JSON.parse(body) as unknown;
}
const manifest = z
  .object({
    version: z.literal("full-market-rps-manifest-1"),
    strategyBuildHash: digest,
    inputChunks: z.array(digest).max(100),
    rankChunks: z.array(digest).max(100),
    calendar: z.array(date).max(20000),
    dates: z.array(date).min(1).max(20000),
    periods,
    requestedStocks: z.number().int(),
    loadedStocks: z.number().int(),
    executionEligible: z.number().int(),
    universe: z.object({
      members: z
        .array(
          z.object({
            symbol: z.string(),
            listingDate: date.nullable(),
            delistingDate: date.nullable(),
          }),
        )
        .max(10000),
    }),
  })
  .parse(await artifact(process.argv[2]!));
if (manifest.strategyBuildHash !== strategyBuildHash)
  throw new Error("RPS build changed; refuse silent reinterpretation");
if (manifest.inputChunks.length + manifest.rankChunks.length + 1 > 100)
  throw new Error("RPS manifest exceeds existing 100-file budget");
const sourceChunk = z.object({
  version: z.literal("full-market-rps-input-1"),
  stocks: z
    .array(
      z.object({
        symbol: z.string(),
        name: z.string(),
        firstDate: date,
        unsupportedDates: z.array(date),
        closes: z
          .array(
            z.tuple([
              date,
              z.number().finite().positive(),
              z.number().finite().nonnegative(),
            ]),
          )
          .max(20000),
      }),
    )
    .max(80),
});
const stocks: RpsSecurity[] = [];
for (const hash of manifest.inputChunks) {
  const chunk = sourceChunk.parse(await artifact(hash));
  for (const stock of chunk.stocks) {
    if (
      stock.closes.some((row, i) => i > 0 && row[0] <= stock.closes[i - 1]![0])
    )
      throw new Error("Unordered/duplicate frozen RPS dates");
    stocks.push({
      ...stock,
      closes: new Map(
        stock.closes.map(([d, close, volume]) => [d, { close, volume }]),
      ),
    });
  }
}
if (
  stocks.length !== manifest.loadedStocks ||
  new Set(stocks.map((s) => s.symbol)).size !== stocks.length
)
  throw new Error("RPS source count/identity mismatch");
const members = new Map(manifest.universe.members.map((m) => [m.symbol, m]));
const ranked = z.object({
  version: z.literal("full-market-rps-ranks-1"),
  dates: z.array(date),
  periods,
  columns: z.tuple([z.literal("return"), z.literal("rank"), z.literal("rps")]),
  rows: z
    .array(
      z.object({
        symbol: z.string(),
        values: z.array(z.number().finite().nullable()),
      }),
    )
    .max(80),
});
const symbols = new Set<string>();
const expected = new Map<string, Float64Array>();
for (const hash of manifest.rankChunks) {
  const chunk = ranked.parse(await artifact(hash));
  if (
    JSON.stringify(chunk.dates) !== JSON.stringify(manifest.dates) ||
    JSON.stringify(chunk.periods) !== JSON.stringify(manifest.periods)
  )
    throw new Error("RPS output axes differ from manifest");
  for (const row of chunk.rows) {
    if (
      symbols.has(row.symbol) ||
      row.values.length !== manifest.dates.length * 9
    )
      throw new Error("Duplicate rank symbol / invalid rank dimensions");
    symbols.add(row.symbol);
    expected.set(row.symbol, new Float64Array(row.values.length).fill(NaN));
  }
}
if (symbols.size !== manifest.executionEligible)
  throw new Error("Rank symbol count mismatch");
// Keep only numeric vectors for retained symbols, not thousands of full-market
// row maps. This permits a full replay within the same file and heap budgets.
for (const [index, d] of manifest.dates.entries()) {
  const rankedDay = calculateRps(
    stocks.filter((stock) => {
      const member = members.get(stock.symbol);
      return (
        (!member?.listingDate || member.listingDate <= d) &&
        (!member?.delistingDate || member.delistingDate > d)
      );
    }),
    manifest.calendar,
    d,
    manifest.periods,
  );
  for (const row of rankedDay.rows) {
    const vector = expected.get(row.symbol);
    if (!vector) continue;
    row.values.forEach((point, p) => {
      if (!point) return;
      vector[index * 9 + p * 3] = point.return;
      vector[index * 9 + p * 3 + 1] = point.rank;
      vector[index * 9 + p * 3 + 2] = point.rps;
    });
  }
  if (index % 500 === 0)
    console.error(`RPS offline replay: ${index}/${manifest.dates.length}`);
}
let checkedCells = 0;
for (const hash of manifest.rankChunks) {
  const chunk = ranked.parse(await artifact(hash));
  for (const row of chunk.rows) {
    const vector = expected.get(row.symbol)!;
    for (let i = 0; i < row.values.length; i++) {
      const value = row.values[i];
      if (value === null ? !Number.isNaN(vector[i]) : value !== vector[i])
        throw new Error(
          `RPS numeric mismatch: ${row.symbol}/${manifest.dates[Math.floor(i / 9)]}/${i % 9}`,
        );
      checkedCells++;
    }
  }
}
console.log(
  JSON.stringify({
    status: "verified",
    manifest: process.argv[2],
    sourceFiles: manifest.inputChunks.length,
    rankFiles: manifest.rankChunks.length,
    stocks: stocks.length,
    rankedSymbols: symbols.size,
    checkedDates: manifest.dates.length,
    firstDate: manifest.dates[0],
    lastDate: manifest.dates.at(-1),
    checkedCells,
    boundary:
      "Every file hash and frozen rank cell checked; no network or strategy qualification writes",
  }),
);
