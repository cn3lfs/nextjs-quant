import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import { setImmediate as yieldToReaders } from "node:timers/promises";
import {
  isAStock,
  isLocalFund,
  isLocalMarketIndex,
  parseBars,
  parseFinancialReport,
  parseFinancialSeries,
  validateLocalSymbol,
} from "tstdx/local";
import { financialAvailableFrom, financialDate } from "tstdx/financial-model";
import { commonIndices } from "~/lib/market/market-indices";
import { parseIndustryMembers } from "../industry-blocks";
import { swIndustries } from "trading-strategies/research/factors/tmt-crowding";
import { isCnEtfSymbol } from "trading-strategy-core/costs";
import { hash, type PanelEvent } from "./format";

export type BuildPanelOptions = {
  symbols?: readonly string[];
  through?: string;
};
export const dayFile = (s: string) => `vipdoc/${s.slice(0, 2)}/lday/${s}.day`;
export const gpFile = (s: string) => `vipdoc/cw/gp${s}.dat`;
export const gbbqFile = "T0002/hq_cache/gbbq";
const industryDir = "Blocks/申万行业";
const defaultIndices = new Set<string>([
  ...commonIndices.map(({ symbol }) => symbol),
  "sh000906",
]);

function entries(path: string) {
  try {
    return readdirSync(path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    return [];
  }
}
function sourceBytes(root: string, file: string) {
  const path = realpathSync.native(join(root, file));
  const rel = relative(root, path);
  if (!rel || rel === ".." || rel.startsWith(".." + sep) || isAbsolute(rel))
    throw new Error("面板来源路径越界");
  const info = statSync(path);
  if (!info.isFile() || info.size > 64 * 1024 * 1024)
    throw new Error("面板来源文件类型或大小非法");
  const body = readFileSync(path);
  if (body.length !== info.size) throw new Error("读取期间面板来源变化");
  return body;
}
export async function discover(root: string, options: BuildPanelOptions) {
  const files = new Set<string>();
  const requested = options.symbols && new Set(options.symbols);
  if (requested) {
    if (!requested.size || requested.size !== options.symbols!.length)
      throw new Error("面板证券池为空或重复");
    for (const s of requested) validateLocalSymbol(s);
  }
  const symbols: string[] = [];
  for (const m of ["sh", "sz", "bj"]) {
    for (const file of entries(join(root, "vipdoc", m, "lday"))) {
      const s = file.toLowerCase().slice(0, -4);
      if (
        !file.toLowerCase().endsWith(".day") ||
        !s.startsWith(m) ||
        (requested && !requested.has(s))
      )
        continue;
      // Fund price precision also covers LOFs and REITs. For the ETF panel
      // use the observed ETF trading-code ranges; names may contain “ETF联接”.
      const etf = isCnEtfSymbol(s);
      const index =
        isLocalMarketIndex(s) && (requested || defaultIndices.has(s));
      if (!isAStock(s) && !etf && !index) continue;
      if (!statSync(join(root, dayFile(s))).size && !requested) continue;
      files.add(dayFile(s));
      symbols.push(s);
    }
  }
  symbols.sort();
  if (
    !symbols.length ||
    (requested && symbols.length !== requested.size) ||
    new Set(symbols).size !== symbols.length
  )
    throw new Error("面板证券缺失、重复或不受支持");
  const pool = new Set(symbols);
  const reports: string[] = [];
  for (const file of entries(join(root, "vipdoc/cw")).sort()) {
    if (/^gpcw\d{8}\.dat$/.test(file)) {
      const path = "vipdoc/cw/" + file;
      reports.push(path);
      files.add(path);
    }
    const s = /^gp((?:sh|sz|bj)\d{6})\.dat$/.exec(file)?.[1];
    if (s && pool.has(s) && !isLocalMarketIndex(s)) files.add(gpFile(s));
  }
  if (statSync(join(root, gbbqFile), { throwIfNoEntry: false }))
    files.add(gbbqFile);
  const industries = entries(join(root, industryDir))
    .filter((f) => f.endsWith(".txt"))
    .sort()
    .map((f) => {
      const file = industryDir + "/" + f;
      const name = f.slice(0, -4);
      const sw = Object.entries(swIndustries).find(
        ([, label]) => label === name,
      )?.[0];
      if (!sw) throw new Error("无法核验申万一级行业 " + name);
      files.add(file);
      // A current membership list supplies no historical admission date. Its
      // conservative lower bound is this build's observation date (Shanghai).
      return { file, name, code: Number(sw) - 800000 };
    });
  if (industries.length > 31) throw new Error("申万一级行业名单数量非法");
  const sources: Record<string, string> = {};
  for (const [i, file] of [...files].sort().entries()) {
    if (i % 32 === 0) await yieldToReaders();
    sources[file] = hash(sourceBytes(root, file));
  }
  // Include the build rules in cache identity so older, valid bytes refresh.
  const fingerprint = hash(
    JSON.stringify([
      "panel-build-v2",
      root,
      options.through ?? null,
      symbols,
      sources,
    ]),
  );
  return { root, symbols, reports, industries, sources, fingerprint };
}
export type Inventory = Awaited<ReturnType<typeof discover>>;
export function verified(input: Inventory, file: string) {
  const body = sourceBytes(input.root, file);
  if (hash(body) !== input.sources[file])
    throw new Error("面板来源在构建期间变化");
  return body;
}
export function readDaily(input: Inventory, symbol: string, through?: string) {
  const bars = parseBars(
    verified(input, dayFile(symbol)),
    "day",
    undefined,
    isLocalFund(symbol) ? 3 : 2,
  );
  if (!bars.length) throw new Error("日线没有有效记录 " + symbol);
  return through ? bars.filter((b) => b.date <= through) : bars;
}
export function membership(input: Inventory) {
  const members = new Map<string, number>();
  for (const def of input.industries)
    for (const s of parseIndustryMembers(verified(input, def.file), def.file)) {
      if (members.has(s)) throw new Error("申万一级归属冲突");
      members.set(s, def.code);
    }
  return members;
}

export async function reportEvents(
  input: Inventory,
  dates: string[],
  symbols: string[],
) {
  const byCode = new Map(symbols.filter(isAStock).map((s) => [s.slice(2), s]));
  const bySymbol = new Map<string, PanelEvent[]>();
  let duplicateReportGroups = 0;
  for (const file of input.reports) {
    await yieldToReaders();
    const report = parseFinancialReport(verified(input, file), file);
    const period = financialDate(report.reportDate);
    if (!period || gpReportFile(period) !== file)
      throw new Error("财报日期与文件名不匹配");
    const counts = new Map<string, number>();
    for (const row of report.records)
      if (byCode.has(row.code))
        counts.set(row.code, (counts.get(row.code) ?? 0) + 1);
    for (const count of counts.values()) if (count > 1) duplicateReportGroups++;
    for (const r of report.records) {
      const symbol = byCode.get(r.code);
      // The six-digit index cannot disambiguate these records. Quarantine
      // only this issuer/period and preserve other issuers' verified reports.
      if (!symbol || counts.get(r.code) !== 1) continue;
      const announcementDate = financialDate(
        r.values[313] ?? 0,
        +period.slice(0, 4),
      );
      if (!announcementDate || announcementDate <= period) continue;
      const availableFrom = financialAvailableFrom(announcementDate, dates);
      if (!availableFrom) continue;
      const events = bySymbol.get(symbol) ?? [];
      events.push({
        kind: "report",
        reportDate: period,
        availableFrom,
        announcementDate,
        sourceFile: file,
        recordOffset: r.dataOffset,
        raw: {
          assets: reportValue(r.values[39]),
          revenue: reportValue(r.values[73]),
          netProfit: reportValue(r.values[94]),
          equity: reportValue(r.values[71]),
        },
      });
      bySymbol.set(symbol, events);
    }
  }
  return { bySymbol, duplicateReportGroups };
}
const gpReportFile = (date: string) =>
  `vipdoc/cw/gpcw${date.replaceAll("-", "")}.dat`;
// TDX uses zero for unreported FN slots as well as for genuine zeroes.
// Preserve unknown unless the source establishes the field independently.
function reportValue(value: number | undefined) {
  return value === undefined || value === 0 ? null : value;
}
type GpRow = ReturnType<typeof parseFinancialSeries>["records"][number];
export function gpEvidence(input: Inventory, symbol: string) {
  const byGroup = new Map<number, Map<string, GpRow | null>>();
  if (input.sources[gpFile(symbol)])
    for (const r of parseFinancialSeries(verified(input, gpFile(symbol)))
      .records) {
      if (![15, 16, 29].includes(r.group)) continue;
      const date = financialDate(r.date ?? 0);
      if (!date) continue;
      let rows = byGroup.get(r.group);
      if (!rows) byGroup.set(r.group, (rows = new Map()));
      rows.set(date, rows.has(date) ? null : r);
    }
  return byGroup;
}
