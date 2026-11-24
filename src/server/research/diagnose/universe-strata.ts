import { createHash } from "node:crypto";
import { join } from "node:path";
import {
  isAStock,
  parseBars,
  parseFinancialSeries,
  parseTdxLocalBlocks,
  readStableLocalFile,
  resolveTdxRoot,
} from "tstdx/local";
import {
  CORE_12_SYMBOLS,
  CORE_30_V1_DEFAULTS,
  CORE_30_DISCLOSURE,
} from "./universe-presets";

export type Core30Options = {
  seed?: string;
  developmentStart?: string;
  /** A single common market session at or before developmentStart. */
  gp16Date?: string;
};

const tiers = ["small", "mid", "large", "unknown"] as const;
type Tier = (typeof tiers)[number];
type Stock = {
  symbol: string;
  industryCode: string;
  industry: string;
  firstBarDate: string;
  lateListed: boolean;
  sizeTier: Tier;
  gp16: {
    file: string;
    date: string;
    valueWan: number | null;
    recordOffset: number | null;
    recordSha256: string | null;
    reason: string | null;
  };
};

const hash = (input: Buffer | string) =>
  createHash("sha256").update(input).digest("hex");
async function optionalFile(path: string) {
  try {
    return (await readStableLocalFile(path)).body;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function capOn(
  root: string,
  symbol: string,
  date: string,
): Promise<Stock["gp16"]> {
  const file = `vipdoc/cw/gp${symbol}.dat`;
  const bytes = await optionalFile(join(root, file));
  const dateNumber = Number(date.replaceAll("-", ""));
  const records =
    bytes &&
    parseFinancialSeries(bytes).records.filter(
      (row) => row.group === 16 && row.date === dateNumber,
    );
  const row = records?.length === 1 ? records[0] : undefined;
  const reason = !bytes
    ? "missing-file"
    : !records?.length
      ? "missing-on-date"
      : !row
        ? "duplicate-on-date"
        : row.values[0] <= 0
          ? "nonpositive-cap"
          : null;
  return {
    file,
    date,
    valueWan: !reason && row ? row.values[0] : null,
    recordOffset: row?.offset ?? null,
    recordSha256:
      row && bytes ? hash(bytes.subarray(row.offset, row.offset + 13)) : null,
    reason,
  };
}

/** CLI research only. Current industry membership and local coverage identify
 * survivors. GP16 is the close-date observation in today's file revision.
 * A first local bar is a coverage bound, not a certified IPO date. */
export async function buildStratifiedCore30(
  tdxRoot: string,
  options: Core30Options = {},
) {
  const root = resolveTdxRoot(tdxRoot);
  const seed = options.seed ?? CORE_30_V1_DEFAULTS.seed;
  const developmentStart =
    options.developmentStart ?? CORE_30_V1_DEFAULTS.developmentStart;
  const gp16Date =
    options.gp16Date ??
    (developmentStart === CORE_30_V1_DEFAULTS.developmentStart
      ? CORE_30_V1_DEFAULTS.gp16Date
      : developmentStart);
  for (const date of [developmentStart, gp16Date]) {
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
      !Number.isFinite(Date.parse(date)) ||
      new Date(date).toISOString().slice(0, 10) !== date
    )
      throw new Error("Invalid stratification date");
  }
  if (gp16Date > developmentStart)
    throw new Error("GP16 after development start");
  const cfg = async (name: string) =>
    new TextDecoder("gb18030", { fatal: true }).decode(
      (await readStableLocalFile(join(root, "T0002", "hq_cache", name))).body,
    );
  const industries = parseTdxLocalBlocks({
    "tdxhy.cfg": await cfg("tdxhy.cfg"),
    "tdxzs3.cfg": await cfg("tdxzs3.cfg"),
    "tdxzs.cfg": "",
    "spblock.dat": "",
    "infoharbor_block.dat": "",
  })
    .filter((row) => row.category === "industry" && row.level === 1)
    .sort((a, b) => a.code!.localeCompare(b.code!));
  if (industries.length !== 30)
    throw new Error("Expected 30 local level-1 industries");
  const seen = new Set<string>();
  const members: Stock[] = [];
  const strata = [];
  for (const industry of industries) {
    const stocks: Stock[] = [];
    for (const symbol of industry.members.filter(
      (s) => !s.startsWith("bj") && isAStock(s),
    )) {
      if (seen.has(symbol)) throw new Error(`Conflicting industry: ${symbol}`);
      seen.add(symbol);
      const bytes = await optionalFile(
        join(root, "vipdoc", symbol.slice(0, 2), "lday", symbol + ".day"),
      );
      if (!bytes || bytes.length === 0) continue;
      if (bytes.length % 32) throw new Error(`Truncated .day: ${symbol}`);
      const firstBarDate = parseBars(bytes.subarray(0, 32), "day")[0]?.date;
      if (!firstBarDate) throw new Error(`Invalid first bar: ${symbol}`);
      stocks.push({
        symbol,
        industryCode: industry.code!,
        industry: industry.name,
        firstBarDate,
        lateListed: firstBarDate > developmentStart,
        gp16: await capOn(root, symbol, gp16Date),
        sizeTier: "unknown",
      });
    }
    if (!stocks.length)
      throw new Error(`No local .day coverage: ${industry.name}`);
    const ranked = stocks
      .filter((s) => s.gp16.valueWan !== null)
      .sort(
        (a, b) =>
          a.gp16.valueWan! - b.gp16.valueWan! ||
          a.symbol.localeCompare(b.symbol),
      );
    for (const [i, stock] of ranked.entries())
      stock.sizeTier = tiers[Math.floor((i * 3) / ranked.length)]!;
    // Rotate the desired tier by industry code order. If empty, sample all
    // available tiers by the same hash. Unknown caps retain a sampling slot.
    const targetTier = tiers[members.length % tiers.length]!;
    const target = stocks.filter((s) => s.sizeTier === targetTier);
    const draw = target.length ? target : stocks;
    const [selected] = draw
      .map((stock) => ({
        stock,
        key: hash(`${seed}:${industry.code}:${stock.symbol}`),
      }))
      .sort(
        (a, b) =>
          a.key.localeCompare(b.key) ||
          a.stock.symbol.localeCompare(b.stock.symbol),
      );
    members.push(selected!.stock);
    strata.push({
      industryCode: industry.code!,
      targetTier,
      usedFallback: !target.length,
      eligible: stocks.length,
      lateListedCount: stocks.filter((s) => s.lateListed).length,
      unknownSizeCount: stocks.length - ranked.length,
    });
  }
  const symbols = members.map((m) => m.symbol);
  const overlapSymbols = CORE_12_SYMBOLS.filter((s) => symbols.includes(s));
  return {
    id: "core-30-v1" as const,
    seed,
    developmentStart,
    gp16Date,
    symbols,
    members,
    strata,
    overlapWithCore12: {
      count: overlapSymbols.length,
      symbols: overlapSymbols,
    },
    lateListedSymbols: members.filter((m) => m.lateListed).map((m) => m.symbol),
    survivorBiasDisclosure: CORE_30_DISCLOSURE,
  };
}
