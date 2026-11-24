import {
  closeSync,
  fsyncSync,
  openSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { setImmediate as yieldToReaders } from "node:timers/promises";
import {
  adjustmentFactors,
  GBBQ_RECORD_SIZE,
  isLocalFund,
  isLocalMarketIndex,
  parseGbbqFile,
} from "tstdx/local";
import type { TdxXdxr } from "tstdx/wire";
import {
  chunkBytes,
  chunkSize,
  emptyChunk,
  fileHeader,
  hash,
  missingAtoms,
  panelFlags,
  readAt,
  setBit,
  type PanelChunk,
  type MarketPanelManifest,
  type PanelEvent,
  type MarketPanelSymbol,
} from "./format";
import {
  gpEvidence,
  gbbqFile,
  membership,
  readDaily,
  reportEvents,
  verified,
  type Inventory,
} from "./sources";

// The third GBBQ block encrypted from eight zero bytes with the fixed TDX key.
const gbbqZeroBlock = Buffer.from("7005eeb91deaf33a", "hex");

function rejectedGbbqEventDate(source: Buffer, offset: number, symbol: string) {
  // Keep the first two blocks, which contain the symbol, date and category.
  // Clearing the third block and the plaintext tail makes all numeric fields
  // finite so the shared parser can recover the date. Discard the patched event.
  const record = Buffer.alloc(4 + GBBQ_RECORD_SIZE);
  record.writeUInt32LE(1);
  source.copy(record, 4, offset, offset + 16);
  gbbqZeroBlock.copy(record, 4 + 16);
  return parseGbbqFile(record).events.get(symbol)?.[0]?.date;
}

function fillSymbol(args: {
  input: Inventory;
  symbol: string;
  localIndex: number;
  width: number;
  bands: PanelChunk[];
  dates: string[];
  dayIndex: Map<string, number>;
  through?: string;
  observedFrom: string;
  industryCode: number;
  actions: TdxXdxr[] | null;
  uncertainFactor: boolean;
  events: PanelEvent[];
}) {
  const {
    input,
    symbol,
    localIndex,
    width,
    bands,
    dates,
    dayIndex,
    actions,
    events,
  } = args;
  const bars = readDaily(input, symbol, args.through);
  const etf = isLocalFund(symbol);
  const index = isLocalMarketIndex(symbol);
  const scale = etf ? 1000 : 100;
  const factors =
    actions && !args.uncertainFactor
      ? adjustmentFactors(
          bars.filter((bar) => bar.volume > 0),
          actions,
        )
      : null;
  for (const raw of actions ?? [])
    if (raw.date <= dates.at(-1)!)
      events.push({ kind: "gbbq", availableFrom: raw.date, raw });
  const gp = gpEvidence(input, symbol);
  const gp29 = [...(gp.get(29) ?? [])].sort(([a], [b]) => a.localeCompare(b));
  for (const [date, r] of gp29) {
    if (!r || date > dates.at(-1)!) continue;
    const [suspendedSessions, renameCode] = r.values;
    if (
      !Number.isSafeInteger(suspendedSessions) ||
      suspendedSessions < 0 ||
      !Number.isInteger(renameCode) ||
      renameCode < 0 ||
      renameCode > 5
    )
      throw new Error("GP29 状态非法");
    if (suspendedSessions || renameCode)
      events.push({
        kind: "gp29",
        availableFrom: date,
        suspendedSessions,
        renameCode,
      });
  }
  let j = 0,
    st: boolean | null = null;
  for (let d = 0; d < dates.length; d++) {
    const date = dates[d]!,
      c = bands[d >>> 5]!,
      at = (d % 32) * width + localIndex;
    while (j < gp29.length && gp29[j]![0] <= date) {
      const r = gp29[j++]![1];
      if (!r || r.values[1] === 5) st = null;
      else if (r.values[1] === 2 || r.values[1] === 3) st = true;
      else if (r.values[1] === 4) st = false;
    }
    const evidence = gp.get(29)?.get(date);
    c.statusFlags[at] =
      (etf ? panelFlags.etf : 0) |
      (evidence ? panelFlags.gp29 : 0) |
      (evidence && evidence.values[0] > 0 ? panelFlags.resumed : 0) |
      (st !== null ? panelFlags.stKnown : 0) |
      (st ? panelFlags.st : 0);
    if (date >= args.observedFrom) c.industryCode[at] = args.industryCode;
    const cap = gp.get(16)?.get(date)?.values[0];
    if (
      cap !== undefined &&
      cap > 0 &&
      Number.isFinite(Math.fround(cap * 10000))
    )
      c.marketCap[at] = cap * 10000;
    // GP16-0 is total capitalization in 万元. Its second slot has no
    // documented float-share meaning; turnover stays NaN.
  }
  let prev = missingAtoms;
  let traded = 0;
  for (const b of bars) {
    const d = dayIndex.get(b.date)!;
    const c = bands[d >>> 5]!,
      at = (d % 32) * width + localIndex;
    const atoms = (v: number) => {
      const value = Math.round(v * scale);
      if (value <= 0 || value > 2147483647 || value / scale !== v)
        throw new Error("日线价格不能无损编码");
      return value;
    };
    c.openAtoms[at] = atoms(b.open);
    c.highAtoms[at] = atoms(b.high);
    c.lowAtoms[at] = atoms(b.low);
    c.closeAtoms[at] = atoms(b.close);
    c.volume[at] = b.volume;
    const missingAmount = !index && b.volume > 0 && !(b.amount > 0);
    c.amount[at] = missingAmount ? NaN : b.amount;
    c.prevCloseAtoms[at] = prev;
    let flags = c.statusFlags[at]!;
    // Preserve a reported zero-volume OHLC row for parity but exclude it
    // from the tradable bitmap. Absent sessions carry no manufactured OHLC.
    if (b.volume > 0) {
      if (factors) {
        const factor = Math.fround(factors[traded]!.factor);
        if (!Number.isFinite(factor) || factor <= 0)
          throw new Error("因果复权因子超限");
        c.adjFactor[at] = factor;
      }
      traded++;
      prev = c.closeAtoms[at]!;
      // Keep the observed close in the price history even if amount is missing.
      if (!missingAmount) {
        flags |= panelFlags.valid;
        setBit(c.validBitmap, at);
      }
    } else flags |= panelFlags.zeroVolume;
    if (b.volume > 0 && b.high === b.low) {
      const limit = gp.get(15)?.get(b.date)?.values[0];
      if (limit === 2) flags |= panelFlags.onePriceLimitUp;
      if (limit === -2) flags |= panelFlags.onePriceLimitDown;
    }
    c.statusFlags[at] = flags;
  }
  events.sort((a, b) => a.availableFrom.localeCompare(b.availableFrom));
  return {
    symbol,
    kind: etf ? "etf" : index ? "index" : "stock",
    priceScale: scale,
    industryCode: args.industryCode,
    firstDate: bars[0]!.date,
    lastDate: bars.at(-1)!.date,
  } as const;
}

/** Stage a bounded band of symbols at a time, then transpose to date-major
 * full-market vectors. Only one 32-day market chunk is resident on merge. */
export async function buildFiles(
  dir: string,
  input: Inventory,
  through?: string,
): Promise<MarketPanelManifest> {
  const calendar = new Set<string>();
  const symbols: string[] = [];
  for (const [i, s] of input.symbols.entries()) {
    if (i % 32 === 0) await yieldToReaders();
    const bars = readDaily(input, s, through);
    for (const b of bars) calendar.add(b.date);
    if (bars.length) symbols.push(s);
  }
  const dates = [...calendar].sort();
  if (!dates.length) throw new Error("截至日期没有行情");
  const dayIndex = new Map(dates.map((d, i) => [d, i]));
  const builtAt = new Date().toISOString();
  const observedFrom = new Date(Date.parse(builtAt) + 8 * 3600000)
    .toISOString()
    .slice(0, 10);
  const members = membership(input);
  const { bySymbol: reports, duplicateReportGroups } = await reportEvents(
    input,
    dates,
    symbols,
  );
  const gbbq = input.sources[gbbqFile] ? verified(input, gbbqFile) : null;
  const actions = gbbq ? parseGbbqFile(gbbq) : null;
  const asOf = through ?? dates.at(-1)!;
  const issues =
    gbbq && actions
      ? actions.issues.filter((issue) => {
          if (!issue.symbol) return true;
          const date = rejectedGbbqEventDate(gbbq, issue.offset, issue.symbol);
          return date === undefined || date <= asOf;
        })
      : [];
  const uncertain = new Set(issues.map((issue) => issue.symbol));
  const count = Math.ceil(dates.length / chunkSize);
  const bandWidth = Math.max(
    2,
    Math.min(
      64,
      2 * Math.floor((32 * 1024 * 1024) / (2 * count * chunkBytes(1))),
    ),
  );
  const meta: MarketPanelSymbol[] = [];
  const bandFile = join(dir, "bands.tmp");
  const bandsFd = openSync(bandFile, "wx+");
  const chunks: string[] = [];
  const tileHashes: string[][] = [];
  try {
    const eventsFd = openSync(join(dir, "events.jsonl"), "wx");
    let eventOffset = 0;
    try {
      for (let start = 0; start < symbols.length; start += bandWidth) {
        const batch = symbols.slice(start, start + bandWidth);
        const bands = Array.from({ length: count }, () =>
          emptyChunk(batch.length),
        );
        const views = bands.map((b) => b.c);
        for (const [localIndex, symbol] of batch.entries()) {
          if (localIndex % 8 === 0) await yieldToReaders();
          const events = reports.get(symbol) ?? [];
          const symbolMeta = fillSymbol({
            input,
            symbol,
            localIndex,
            width: batch.length,
            bands: views,
            dates,
            dayIndex,
            through,
            observedFrom,
            industryCode: members.get(symbol) ?? 0,
            actions: actions ? (actions.events.get(symbol) ?? []) : null,
            events,
            uncertainFactor: uncertain.has(undefined) || uncertain.has(symbol),
          });
          const record = Buffer.from(JSON.stringify(events) + "\n");
          writeFileSync(eventsFd, record);
          meta.push({
            ...symbolMeta,
            eventOffset,
            eventBytes: record.length,
            eventHash: hash(record),
          });
          eventOffset += record.length;
          reports.delete(symbol);
        }
        for (const band of bands) writeFileSync(bandsFd, band.body);
      }
      fsyncSync(eventsFd);
    } finally {
      closeSync(eventsFd);
    }
    const fd = openSync(join(dir, "panel.bin"), "wx");
    try {
      writeFileSync(fd, fileHeader(dates.length, symbols.length, bandWidth));
      for (let chunk = 0; chunk < count; chunk++) {
        await yieldToReaders();
        const body = Buffer.allocUnsafeSlow(chunkBytes(symbols.length));
        const checksums: string[] = [];
        for (let start = 0; start < symbols.length; start += bandWidth) {
          const width = Math.min(bandWidth, symbols.length - start);
          const size = chunkBytes(width);
          const tile = readAt(
            bandsFd,
            size,
            start * chunkBytes(1) * count + chunk * size,
          );
          tile.copy(body, chunkBytes(start));
          checksums.push(hash(tile));
        }
        writeFileSync(fd, body);
        chunks.push(hash(body));
        tileHashes.push(checksums);
      }
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } finally {
    closeSync(bandsFd);
    unlinkSync(bandFile);
  }
  const payload = {
    magic: "MKTPAN01",
    formatVersion: 1,
    chunkSize,
    recordBytes: 52,
    builtAt,
    root: input.root,
    calendar: "union-of-accepted-local-day-dates",
    marketCapUnit: "CNY",
    industryBasis: "observed-local-SW-membership",
    financialVintage: "current-local-revision",
    sourceFingerprint: input.fingerprint,
    sources: input.sources,
    dates,
    symbols: meta,
    chunks,
    tileWidth: bandWidth,
    tileHashes,
    gbbqIssues: issues.length,
    duplicateReportGroups,
    industries: input.industries.map(({ code, name }) => ({
      code,
      name,
      observedFrom,
    })),
  } as const;
  const snapshotId = hash(JSON.stringify(payload));
  const manifest = { ...payload, snapshotId };
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest), {
    flag: "wx",
    flush: true,
  });
  return manifest;
}
