import { describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import Database from "better-sqlite3";
import { runPortfolio } from "quant-backtest";
import { strategyObjectSchema, type Csi800Stock } from "trading-strategies";
import { executionCostsSchema } from "trading-strategy-core/costs";
import {
  compileCnPaperContext,
  cnPaperContentHash,
  cnPaperWeeklyDates,
  captureCnPaperSignal,
  type CnPaperSignalOrigin,
  type CnPaperSignalPrefix,
  type CnPaperCapture,
} from "~/server/paper/cn-book-context";
import {
  buildLifecycleRps,
  lifecycleRawPrefixHash,
} from "~/server/research/lifecycle-source";
import {
  buildClassicPanel,
  buildClassicObservation,
  type ClassicFinancialInput,
  type ClassicPriceInput,
} from "../../scripts/lib/csi800-factor-data";
import type { FrozenCandidate, PaperAccount } from "~/server/paper/model";
import frozen from "~/server/data/paper-candidates.json";
import { applyAdjustmentAtAnchor, adjustmentFactors } from "tstdx/local";
import type { TdxXdxr } from "tstdx/wire";
import { migrate } from "~/server/db/migrations";
import { PaperRepository } from "~/server/db/paper-repository";
import { advancePaper } from "~/server/paper/advance";
import { researchCorporateActions } from "~/server/research/corporate-actions";
import { readIndustryBlocks } from "~/server/market/industry-blocks";
import * as settingsService from "~/server/infra/settings";
import * as barService from "~/server/market/bar-store/read-bars";
import * as identityService from "~/server/research/forward-identity";
import * as calendarService from "~/server/market/data-health";
import { settingsSchema } from "~/lib/domain";
import { loadPaperInput } from "~/server/paper/inputs";

function fixture(hour = 8) {
  const calendar = Array.from({ length: 480 }, (_, index) =>
    new Date(Date.UTC(2024, 0, 1 + index)).toISOString().slice(0, 10),
  ).filter((date) => ![0, 6].includes(new Date(date).getUTCDay()));
  const stocks: Csi800Stock[] = ["sh600000", "sh600001"].map(
    (symbol, offset) => {
      const bars = calendar.map((date, index) => {
        const close =
          10 + offset + index * 0.01 + Math.sin(index / 3 + offset) * 0.1;
        return {
          date,
          open: close,
          high: close + 0.2,
          low: close - 0.2,
          close,
          volume: 10000000,
          amount: 100000000,
        };
      });
      return { symbol, bars, signalBars: bars, actions: [] };
    },
  );
  const first = calendar[300]!;
  expect(new Date(first).getUTCDay()).toBe(1);
  const strategy = strategyObjectSchema.parse({
    id: "l3-tiny-cn-weekly",
    version: 1,
    market: "cn-equity",
    period: "day",
    universe: { kind: "pool", id: "declared-synthetic-two-stock-fixture" },
    entry: { kind: "constant", value: true },
    rank: { kind: "rps-composite", periods: [20, 50, 120] },
    exit: {
      stop: { kind: "atr", period: 14, multiple: 3 },
      chandelier: { period: 14, multiple: 3 },
    },
    overlay: {
      volatilityTarget: 0.15,
      industryWeight: 0.3,
      industryBasis: "current-labelled",
      symbolWeight: 0.15,
    },
    rebalance: {
      kind: "ranked-weekly",
      top: 1,
      retentionMultiple: 1.5,
      weighting: "equal",
    },
    sizing: { kind: "weight", weight: 1 },
    sleeve: "swing",
  });
  const hash = cnPaperContentHash(stocks);
  const policy = {
    initial: 1000000,
    sleeves: [{ id: "swing", share: 1, riskPerTrade: 0.02, maxPositions: 1 }],
    costs: executionCostsSchema.parse({
      commissionBps: 0,
      minimumCommission: 0,
      slippageBps: 0,
      sellTaxBps: 0,
    }),
  };
  const candidate: FrozenCandidate = {
    ...(frozen.candidates[0] as unknown as FrozenCandidate),
    strategy,
    executionPolicy: policy,
    sourceContext: {
      inputHash: hash,
      resultHash: hash,
      buildHash: hash,
      configHash: hash,
      manifestPath: "declared-synthetic-fixture",
      sourceKey: "cn-day",
      universeSymbols: stocks.map((stock) => stock.symbol),
      rawUniverse: {
        symbols: stocks.map((stock) => stock.symbol),
        source: "declared-synthetic-raw",
        hash,
      },
    },
  };
  const account: PaperAccount = {
    id: "paper:synthetic-cn-context",
    market: "cn-equity",
    currency: "CNY",
    sleeve: "swing",
    initial: policy.initial,
    candidates: [candidate],
    startedAt: Date.parse(
      `${first}T${String(hour).padStart(2, "0")}:00:00+08:00`,
    ),
    revision: 0,
    lastBar: null,
    lastRun: null,
    error: null,
    summary: null,
    mirror: { venue: "off" },
    mirrorRevision: "synthetic",
  };
  const capture: CnPaperCapture = {
    stocks,
    baselineStocks: stocks,
    benchmark: stocks[0]!.bars,
    calendar,
    classicWeeks: [],
    firstSignal: calendar[200]!,
    industries: stocks.map((stock) => ({
      symbol: stock.symbol,
      date: calendar[0]!,
      availableAt: calendar[0]!,
      groups: ["shared-parent", stock.symbol],
      basis: "current",
      source: hash,
    })),
    sourceHashes: { frozen: hash },
    observationSourceHashes: { actual: hash },
    sourceIdentity: { version: "declared-synthetic" },
    buildHash: hash,
  };
  return { account, capture, first, ready: calendar.slice(300, 303) };
}

describe("production CN book context assembly", () => {
  it("the default local reader consumes immutable origin files and produces executable CN context", async () => {
    const { account, capture, first } = fixture();
    const root = await mkdtemp(
      join(process.env.QUANT_DATA_DIR!, "cn-provider-"),
    );
    try {
      const sha = (bytes: string | Uint8Array) =>
        createHash("sha256").update(bytes).digest("hex");
      const freeze = async (
        name: string,
        value: unknown,
        compressed = false,
      ) => {
        const plain = JSON.stringify(value),
          bytes = compressed ? gzipSync(plain) : Buffer.from(plain);
        const path = join(root, name);
        await writeFile(path, bytes);
        return { path, hash: sha(bytes), decodedContentHash: sha(plain) };
      };
      const end = capture.calendar[299]!;
      const price = {
        version: "csi800-frozen-1",
        start: capture.calendar[0]!,
        end,
        initial: account.initial,
        stocks: capture.stocks.map((stock) => ({
          symbol: stock.symbol,
          bars: stock.bars.filter((bar) => bar.date <= end),
          actions: [],
        })),
        benchmark: capture.benchmark.filter((bar) => bar.date <= end),
      };
      const priceFile = await freeze("input.json", price);
      const panel = await freeze("factor-panel.json.gz", [], true);
      const financial = await freeze(
        "financial-input.json.gz",
        {
          version: "csi800-financial-1",
          priceHash: priceFile.hash,
          reports: {},
          caps: {},
          seriesSources: {},
          issues: [],
          capturedAt: "2025-01-01T00:00:00Z",
        },
        true,
      );
      const origins = [];
      for (const stock of price.stocks) {
        const factors = adjustmentFactors(stock.bars, []),
          anchor = { date: stock.bars[0]!.date, factor: factors[0]!.factor };
        const rawSource = await freeze(
          `${stock.symbol}.json.gz`,
          stock.bars.map((bar) => [
            bar.date,
            bar.open,
            bar.high,
            bar.low,
            bar.close,
            bar.volume,
            bar.amount,
          ]),
          true,
        );
        origins.push({
          symbol: stock.symbol,
          startDate: anchor.date,
          through: end,
          anchor,
          rawSource: { format: "bar-tuples-1", ...rawSource },
          rawPrefixHash: lifecycleRawPrefixHash(stock.bars),
          eventsPrefixHash: cnPaperContentHash([]),
          factorsPrefixHash: cnPaperContentHash(factors),
          signalPrefixHash: lifecycleRawPrefixHash(
            applyAdjustmentAtAnchor(stock.bars, factors, anchor),
          ),
        });
      }
      const tdxRoot = join(root, "tdx");
      await mkdir(join(tdxRoot, "T0002/hq_cache"), { recursive: true });
      const gbbq = Buffer.alloc(4);
      await writeFile(join(tdxRoot, "T0002/hq_cache/gbbq"), gbbq);
      const gbbqPath = join(root, "gbbq.bin");
      await writeFile(gbbqPath, gbbq);
      await mkdir(join(root, "Blocks/申万行业"), { recursive: true });
      await writeFile(
        join(root, "Blocks/申万行业/parent.txt"),
        "SH600000\nSH600001\n",
      );
      const industry = await readIndustryBlocks(join(root, "Blocks"));
      const identities = {
        classic: {
          files: [priceFile, panel, financial],
          industry,
          signalBasis: {
            version: "tdx-first-raw-anchor-1",
            arithmetic: "rawOHLC*(F(t)/F(firstFrozenRawDate))",
            origins,
            gbbq: {
              path: gbbqPath,
              hash: sha(gbbq),
              parserHash: sha("declared-synthetic"),
            },
          },
        },
        lowZone: { membership: null },
        families: { "cn-equity:swing": { firstSignal: capture.firstSignal } },
      };
      const inputHash = cnPaperContentHash(identities);
      const manifestPath = join(root, "source.json");
      await writeFile(
        manifestPath,
        JSON.stringify({
          version: "lifecycle-source-1",
          inputHash,
          configHash: inputHash,
          identities,
        }),
      );
      const liveAccount = {
        ...account,
        candidates: [
          {
            ...account.candidates[0]!,
            sourceContext: {
              ...account.candidates[0]!.sourceContext!,
              inputHash,
              configHash: inputHash,
              manifestPath,
              rawUniverse: {
                symbols: price.stocks.map((stock) => stock.symbol),
                source: priceFile.path,
                hash: priceFile.hash,
              },
            },
          },
        ],
      };
      vi.spyOn(settingsService, "settings").mockReturnValue(
        settingsSchema.parse({ tdxRoot }),
      );
      vi.spyOn(identityService, "forwardExecutionBuildHash").mockReturnValue(
        inputHash,
      );
      vi.spyOn(calendarService, "localCalendarReference").mockResolvedValue({
        days: capture.calendar,
        source: "declared-synthetic-local-calendar",
      } as Awaited<ReturnType<typeof calendarService.localCalendarReference>>);
      vi.spyOn(barService, "readBars").mockImplementation(async (input) => {
        expect(input.source).toBe("local");
        expect(input.live).toBe(false);
        expect(input.adjustment).toBe("none");
        const bars = (
          capture.stocks.find(
            (stock) => stock.symbol === input.instrument.symbol,
          )?.bars ?? capture.benchmark
        ).filter((bar) => bar.date <= first);
        return {
          bars,
          hash: cnPaperContentHash(bars),
          source: "declared-synthetic-local",
          barStore: { formingDates: [] },
        } as unknown as Awaited<ReturnType<typeof barService.readBars>>;
      });
      const input = await loadPaperInput(
        liveAccount,
        Date.parse(`${capture.calendar[301]}T08:30:00+08:00`),
      );
      if (!input)
        throw new Error(
          "Default CN loader did not produce its completed input",
        );
      expect(input.contextVersion).toBe("cn-book-1");
      expect(input.sourceIdentity?.currentCaptureHash).toMatch(
        /^[a-f0-9]{64}$/,
      );
      expect(runPortfolio(input.request).fills.length).toBeGreaterThan(0);
      expect(
        Object.keys(
          input.request.instruments[0]!.external!.preparedRules![0]!.points[0]!
            .sourceHashes,
        ).length,
      ).toBeLessThan(8);
    } finally {
      vi.restoreAllMocks();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("retains61 risk closes and genuine rule points while matching full historical selection/fills", () => {
    const { account, capture, first, ready } = fixture();
    const input = compileCnPaperContext(account, capture, ready);
    expect(input.contextVersion).toBe("cn-book-1");
    expect(input.request.start).toBe(first);
    expect(input.request.calendar[0]).toBe(capture.calendar[239]);
    expect(input.request.instruments[0]!.bars[0]!.date).toBe(
      capture.calendar[239],
    );
    expect(input.request.bookSeeds![0]!.previousSelected?.date).toBe(
      capture.calendar[294],
    );
    expect(
      input.request.instruments[0]!.external!.preparedRules![0]!.priceBasis,
    ).toBe("signal");
    const rps = buildLifecycleRps(capture.stocks, capture.calendar);
    const full = {
      ...input.request,
      calendar: capture.calendar,
      memberships: capture.calendar.map((date) => ({
        strategyId: account.candidates[0]!.strategy.id,
        date,
        availableAt: date,
        symbols: capture.stocks.map((stock) => stock.symbol),
      })),
      instruments: input.request.instruments.map((instrument) => ({
        ...instrument,
        bars: capture.stocks.find(
          (stock) => stock.symbol === instrument.symbol,
        )!.bars,
        signalBars: capture.stocks.find(
          (stock) => stock.symbol === instrument.symbol,
        )!.signalBars!,
        external: { rps: rps.rpsBySymbol.get(instrument.symbol) },
      })),
      bookSeeds: [
        {
          strategyId: account.candidates[0]!.strategy.id,
          date: capture.calendar[299]!,
          availableAt: capture.calendar[299]!,
          selectionFrom: capture.firstSignal,
        },
      ],
    };
    const bounded = runPortfolio(input.request),
      original = runPortfolio(full);
    expect(bounded.fills.length).toBeGreaterThan(0);
    expect(bounded.fills).toEqual(original.fills);
    expect(bounded.curve).toEqual(original.curve);
    expect(bounded.fills.every((fill) => fill.date >= first)).toBe(true);
  });

  it("a Monday14 registration retains Friday selection without inventing a Monday opening fill", () => {
    const { account, capture, first, ready } = fixture(14);
    const input = compileCnPaperContext(account, capture, ready);
    expect(input.request.bookSeeds![0]!.emitOrders).toBe(false);
    expect(runPortfolio(input.request).fills).toEqual([]);
    expect(input.request.start).toBe(first);
  });

  it("uses all registered RPS endpoint eligibility and rejects a true source hole", () => {
    const { account, capture, ready } = fixture();
    const withHole = {
      ...capture,
      stocks: capture.stocks.map((stock, index) =>
        index
          ? stock
          : {
              ...stock,
              bars: stock.bars.filter((_, index) => index !== 280),
              signalBars: stock.signalBars!.filter((_, index) => index !== 280),
            },
      ),
    };
    expect(() => compileCnPaperContext(account, withHole, ready)).toThrow(
      "missing completed CN source",
    );
    expect(() =>
      compileCnPaperContext(
        {
          ...account,
          candidates: [
            {
              ...account.candidates[0]!,
              sourceContext: {
                ...account.candidates[0]!.sourceContext!,
                rawUniverse: undefined,
              },
            },
          ],
        },
        capture,
        ready,
      ),
    ).toThrow("exact frozen raw");
  });

  it("two captures append a real new bar/action hash without changing first-observed provenance or the financial prefix", () => {
    const { account, capture } = fixture();
    const db = new Database(":memory:");
    try {
      migrate(db);
      const repo = new PaperRepository(db);
      repo.create(account);
      const originThrough = capture.calendar[299]!;
      const frozenOrigins = capture.stocks.map((stock): CnPaperSignalOrigin => {
        const bars = stock.bars.filter((bar) => bar.date <= originThrough);
        const factors = adjustmentFactors(bars, []);
        const anchor = { date: bars[0]!.date, factor: factors[0]!.factor };
        return {
          symbol: stock.symbol,
          startDate: bars[0]!.date,
          through: originThrough,
          anchor,
          rawSource: {
            format: "bar-tuples-1",
            path: "declared-synthetic",
            hash: cnPaperContentHash(bars),
            decodedContentHash: cnPaperContentHash(bars),
          },
          rawPrefixHash: lifecycleRawPrefixHash(bars),
          eventsPrefixHash: cnPaperContentHash([]),
          factorsPrefixHash: cnPaperContentHash(factors),
          signalPrefixHash: lifecycleRawPrefixHash(
            applyAdjustmentAtAnchor(bars, factors, anchor),
          ),
        };
      });
      const captureAt = (index: number, prior?: CnPaperSignalPrefix[]) => {
        const date = capture.calendar[index]!;
        const events: TdxXdxr[] =
          index === 300
            ? []
            : [
                {
                  date,
                  category: 1,
                  dividend: 0.2,
                  bonusRatio: 0.1,
                } as TdxXdxr,
              ];
        const normalized = capture.stocks.map((stock, position) =>
          captureCnPaperSignal(
            stock.bars.filter((bar) => bar.date <= date),
            position ? [] : events,
            frozenOrigins[position]!,
            prior?.[position],
          ),
        );
        return {
          ...capture,
          stocks: capture.stocks.map((stock, position) => ({
            ...stock,
            bars: stock.bars.filter((bar) => bar.date <= date),
            signalBars: normalized[position]!.signalBars,
          })),
          actionsBySymbol: new Map(
            capture.stocks.map((stock, position) => [
              stock.symbol,
              researchCorporateActions(
                position ? [] : events,
                cnPaperContentHash(events),
                stock.bars[0]!.date,
                date,
              ),
            ]),
          ),
          observationSourceHashes: {
            gbbq: cnPaperContentHash(events),
            raw: cnPaperContentHash(
              normalized.map((row) => row.proof.rawPrefixHash),
            ),
          },
          sourceIdentity: { origins: normalized.map((row) => row.proof) },
        };
      };
      const firstCapture = captureAt(300);
      const firstDate = capture.calendar[300]!;
      advancePaper(
        repo,
        account.id,
        compileCnPaperContext(account, firstCapture, [firstDate]),
        Date.parse(`${firstDate}T17:00:00+08:00`),
      );
      const before = repo.state(account.id)!;
      const secondCapture = captureAt(301, firstCapture.sourceIdentity.origins);
      const secondDate = capture.calendar[301]!;
      const input = compileCnPaperContext(
        repo.account(account.id)!,
        secondCapture,
        [secondDate],
        before,
      );
      const group = input.request.instruments[0]!.external!.preparedRules![0]!;
      const oldGroup =
        before.request.instruments[0]!.external!.preparedRules![0]!;
      expect(group.sourceHashes).toEqual(oldGroup.sourceHashes);
      expect(group.points.find((point) => point.date === firstDate)).toEqual(
        oldGroup.points.find((point) => point.date === firstDate),
      );
      expect(
        group.points.find((point) => point.date === secondDate)!.sourceHashes
          .gbbq,
      ).not.toBe(oldGroup.points[0]!.sourceHashes.gbbq);
      expect(
        advancePaper(
          repo,
          account.id,
          input,
          Date.parse(`${secondDate}T17:00:00+08:00`),
        ).advanced,
      ).toBe(1);
      expect(
        repo
          .state(account.id)!
          .result.fills.slice(0, before.result.fills.length),
      ).toEqual(before.result.fills);
      const changedPast = [
        { date: firstDate, category: 1, dividend: 0.2 } as TdxXdxr,
      ];
      expect(() =>
        captureCnPaperSignal(
          capture.stocks[0]!.bars.slice(0, 302),
          changedPast,
          frozenOrigins[0]!,
          firstCapture.sourceIdentity.origins[0],
        ),
      ).toThrow("eventsPrefixHash changed");
    } finally {
      db.close();
    }
  });

  it("the single-week compiler produces exactly the historical compiler row without future prices", () => {
    const { capture } = fixture();
    const price: ClassicPriceInput = {
      version: "csi800-frozen-1",
      start: capture.calendar[0]!,
      end: capture.calendar.at(-1)!,
      initial: 1000000,
      stocks: capture.baselineStocks.map((stock) => ({
        symbol: stock.symbol,
        bars: stock.bars,
        actions: stock.actions,
      })),
      benchmark: [...capture.benchmark],
    };
    const financial: ClassicFinancialInput = {
      version: "csi800-financial-1",
      priceHash: "declared-synthetic",
      reports: {},
      caps: {},
      seriesSources: {},
      issues: [],
      capturedAt: "2025-01-01T00:00:00Z",
    };
    const observed = cnPaperWeeklyDates(
      capture.calendar,
      capture.calendar[304]!,
    ).at(-1)!;
    const historic = buildClassicPanel(price, financial, {
      quiet: true,
    }).weeks.find((week) => week.date === observed.date)!;
    const asOf = {
      ...price,
      end: observed.date,
      stocks: price.stocks.map((stock) => ({
        ...stock,
        bars: stock.bars.filter((bar) => bar.date <= observed.date),
      })),
      benchmark: price.benchmark.filter((bar) => bar.date <= observed.date),
    };
    expect(buildClassicObservation(asOf, financial, observed).week).toEqual(
      historic,
    );
  });
});
