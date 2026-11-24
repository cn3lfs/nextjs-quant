import { describe, expect, it } from "vitest";
import { strategyObjectSchema } from "trading-strategies";
import {
  nextPanelCache,
  type PanelCacheState,
} from "~/components/workbench/keep-alive";
import {
  buildLabDraftFromHandoff,
  buildScanToLabHandoffHref,
  monthlyReviewHandoffSymbols,
  parseScanToLabHandoff,
  type ScanToLabHandoff,
} from "~/lib/research/diagnose-contract";
import {
  batchCandidatesToLabHref,
  formulaCandidateToLabHref,
  patternCandidateToLabHref,
  rpsCandidateToLabHref,
} from "~/lib/screening/screen-candidate-navigation";
import { rpsHandoffRowAvailable } from "~/components/market/stock-rps-ranking";
import {
  equalizeSleeveWeights,
  validateSleeveDraft,
  type SleeveDraft,
} from "~/components/research/diagnose/format";

const origin = "https://workbench.test";
const symbol = "sh600000";
const frozenDate = "2026-11-20";
const formulaList =
  "/scan?tab=formula&job=job-23&symbol=sz000001&screenSnapshot=snap-1&q=%E6%B5%8B%E8%AF%95+%2B&filter=a&filter=b";
const patternList =
  "/scan?tab=formula&symbol=sh600000&screenSnapshot=pattern-1";
const rpsList = "/scan?tab=rps";
const filteredRpsList =
  "/scan?tab=rps&period=120&search=600&rpsCondition=50%2Cgte%2C90&sortPeriod=20&descending=true";
const portfolioSymbols = Array.from(
  { length: 13 },
  (_, i) => `sh${600000 + i}`,
);

function handoffUrl(href: string | null) {
  if (!href) throw new Error("Expected a scan handoff URL");
  return new URL(href, origin);
}

function readHandoff(href: string | null) {
  const url = handoffUrl(href);
  expect(url.origin).toBe(origin);
  expect(url.pathname).toBe("/lab/backtest");
  expect(url.searchParams.get("handoff")).toBe("1");
  const parsed = parseScanToLabHandoff(url.searchParams);
  if (parsed.kind !== "valid") throw new Error("Expected a valid scan handoff");
  expect(parsed.key).toBe(href);
  return parsed;
}

function checkDraft(
  handoff: ScanToLabHandoff,
  strategyKey: string,
  entry: Record<string, unknown>,
) {
  const draft = buildLabDraftFromHandoff(handoff);
  expect(draft.strategyKey).toBe(strategyKey);
  const serializedStrategy: unknown = JSON.parse(draft.strategyJson);
  expect(serializedStrategy).toEqual(draft.strategy);
  const strategy = strategyObjectSchema.parse(serializedStrategy);
  expect(strategy.universe).toEqual({
    kind: "symbols",
    symbols: [handoff.symbol],
  });
  expect(strategy.entry).toMatchObject(entry);
  expect(draft.scopeNote).toContain("只诊断扫描候选中的一个标的");
  expect(draft.scopeNote).toContain("历史证券池与逐日选股表现需独立验证");
  return draft;
}

describe("portfolio handoff", () => {
  it.each(["watchlist", "pool"] as const)(
    "round-trips one to twelve %s candidates and clips overflow",
    (handoffSource) => {
      const returnTo = `/scan?tab=${handoffSource}`;
      expect(
        batchCandidatesToLabHref({ symbols: [], handoffSource }),
      ).toBeNull();
      for (const count of [1, 12, 13]) {
        const input = portfolioSymbols.slice(0, count);
        const result = batchCandidatesToLabHref({
          symbols: [input[0]!, ...input],
          handoffSource,
          returnTo,
        });
        expect(result?.truncatedCount).toBe(count > 12 ? 1 : 0);
        expect(readHandoff(result?.href ?? null).handoff).toMatchObject({
          scope: "portfolio-diagnose",
          handoffSource,
          symbol: input[0],
          symbols: input.slice(0, 12),
          returnTo,
        });
      }
    },
  );
  it("reserves all 12 monthly review slots for distinct Shanghai and Shenzhen A shares in round order", () => {
    const shares = ["sz300750", ...portfolioSymbols.slice(0, 12)];
    expect(
      monthlyReviewHandoffSymbols([
        "sh510300",
        shares[0]!,
        "sz159915",
        "bj430047",
        ...shares,
      ]),
    ).toEqual({
      symbols: shares.slice(0, 12),
      truncatedCount: 1,
      droppedInvalidCount: 3,
    });
  });
  it.each([1, 2, 12])(
    "preserves %i unique symbols in selection order",
    (count) => {
      const expected = portfolioSymbols.slice(0, count);
      const result = batchCandidatesToLabHref({
        symbols: [expected[0]!, ...expected],
        handoffSource: "formula",
        label: "确认公式",
        frozenDate,
        returnTo: formulaList,
      });
      expect(result).toMatchObject({ symbols: expected, truncatedCount: 0 });
      const { handoff } = readHandoff(result?.href ?? null);
      expect(handoff).toMatchObject({
        scope: "portfolio-diagnose",
        handoffSource: "formula",
        symbol: expected[0],
        symbols: expected,
        label: "确认公式",
        frozenDate,
        returnTo: formulaList,
      });
    },
  );

  it("truncates the 13th unique symbol and keeps the filtered RPS return link", () => {
    const result = batchCandidatesToLabHref({
      symbols: [portfolioSymbols[0]!, ...portfolioSymbols],
      handoffSource: "rps",
      returnTo: filteredRpsList,
    });
    const symbols = portfolioSymbols.slice(0, 12);
    expect(result).toMatchObject({ symbols, truncatedCount: 1 });
    expect(readHandoff(result?.href ?? null).handoff).toMatchObject({
      handoffSource: "rps",
      symbols,
      returnTo: filteredRpsList,
    });
  });

  it("filters invalid symbols and strips unsafe return URLs independently", () => {
    const result = batchCandidatesToLabHref({
      symbols: ["BTCUSDT", "sz000001", "600000", "bj430047", "SH600519"],
      handoffSource: "pattern",
      returnTo: "https://outside.example/scan",
    });
    expect(result).toMatchObject({
      symbols: ["sz000001", "bj430047"],
      truncatedCount: 0,
    });
    const href = result?.href ?? null;
    expect(readHandoff(href).handoff.returnTo).toBeUndefined();
    expect(handoffUrl(href).searchParams.has("returnTo")).toBe(false);
  });

  it.each([{ symbols: [] }, { symbols: ["invalid"] }])(
    "returns null for $symbols",
    ({ symbols }) => {
      expect(
        batchCandidatesToLabHref({ symbols, handoffSource: "rps" }),
      ).toBeNull();
    },
  );

  it("allowlists the account review page for account-review handoffs", () => {
    const accountHandoff = {
      scope: "portfolio-diagnose" as const,
      handoffSource: "account-review" as const,
      symbol,
      symbols: [symbol],
    };
    const returnTo = "/accounts/review?account=paper&month=2026-11";
    expect(
      readHandoff(buildScanToLabHandoffHref({ ...accountHandoff, returnTo }))
        .handoff,
    ).toMatchObject({ handoffSource: "account-review", returnTo });
    for (const unsafe of [
      "/accounts/review-other",
      "/accounts/review?next=%2F%2Foutside.example",
    ])
      expect(() =>
        buildScanToLabHandoffHref({ ...accountHandoff, returnTo: unsafe }),
      ).toThrow();
  });
});

describe("custom sleeve editor", () => {
  const rows: SleeveDraft[] = [
    "dual-ma",
    "double-breakout",
    "formula",
    "research-chan-first",
    "research-chan-second",
    "research-sepa-pit",
    "research-canslim-pit",
  ].map((strategyKey, i) => ({
    id: `sleeve-${i + 1}`,
    strategyKey,
    share: "",
  }));

  it.each([2, 3, 4, 5, 6])(
    "equalizes %i sleeves without rounding out of tolerance",
    (count) => {
      const selected = rows.slice(0, count);
      const result = validateSleeveDraft(equalizeSleeveWeights(selected));
      expect(result.error).toBe("");
      expect(Math.abs(result.sum - 1)).toBeLessThanOrEqual(1e-9);
      expect(result.book?.sleeves).toEqual(
        selected.map((row) => ({ ...row, share: 1 / count })),
      );
    },
  );

  it.each([0, 1, 7])("rejects %i sleeves", (count) => {
    expect(
      validateSleeveDraft(equalizeSleeveWeights(rows.slice(0, count))).book,
    ).toBeNull();
  });

  it("enforces the 1e-9 tolerance on each side of 100%", () => {
    const book = (share: string) =>
      validateSleeveDraft([
        { ...rows[0]!, share: "0.5" },
        { ...rows[1]!, share },
      ]).book;
    expect(book("0.4999999995")).not.toBeNull();
    expect(book("0.5000000005")).not.toBeNull();
    expect(book("0.499999998")).toBeNull();
    expect(book("0.500000002")).toBeNull();
  });

  it("accepts repeated strategies under distinct IDs and rejects duplicate trimmed IDs", () => {
    const first = { id: "sleeve-1", strategyKey: "dual-ma", share: "0.5" };
    const second = { id: " sleeve-2 ", strategyKey: " dual-ma ", share: "0.5" };
    const valid = validateSleeveDraft([first, second]);
    expect(valid.error).toBe("");
    expect(valid.book?.sleeves).toEqual([
      { id: "sleeve-1", strategyKey: "dual-ma", share: 0.5 },
      { id: "sleeve-2", strategyKey: "dual-ma", share: 0.5 },
    ]);

    const duplicate = validateSleeveDraft([
      first,
      { ...second, id: " sleeve-1 " },
    ]);
    expect(duplicate.book).toBeNull();
    expect(duplicate.error).toBe("分仓编号不能重复。");
  });

  it.each([
    { strategyKey: " " },
    { strategyKey: "unknown-strategy" },
    { id: " " },
    { id: "../sleeve-2" },
    { share: "" },
    { share: "0" },
    { share: "-0.5" },
    { share: "Infinity" },
  ])("rejects invalid sleeve fields %j", (override) => {
    const [first, second] = equalizeSleeveWeights(rows.slice(0, 2));
    expect(
      validateSleeveDraft([first!, { ...second!, ...override }]).book,
    ).toBeNull();
  });
});

describe("scan candidate links to the Lab", () => {
  it("round-trips a formula candidate, its frozen date, label and full result URL", () => {
    const formulaLabel = "量价 & 新高 + 确认";
    const { handoff } = readHandoff(
      formulaCandidateToLabHref({
        symbol,
        frozenDate,
        formulaLabel,
        returnTo: formulaList,
      }),
    );
    expect(handoff).toEqual({
      handoffSource: "formula",
      symbol,
      frozenDate,
      strategyHint: "formula",
      label: formulaLabel,
      scope: "single-symbol-diagnose",
      returnTo: formulaList,
    });
    const draft = checkDraft(handoff, "formula", { kind: "formula" });
    expect(draft).toMatchObject({ start: "2025-11-20", end: frozenDate });
    expect(draft.scopeNote).toContain("诊断示例公式");
  });

  const patternCases = [
    {
      matches: { chanCodes: ["1B"] },
      strategyKey: "research-chan-first",
      entry: { kind: "chan-native", profile: "chan-first-native" },
    },
    {
      matches: { chanCodes: ["2B"] },
      strategyKey: "research-chan-second",
      entry: { kind: "chan-native", profile: "chan-second-native" },
    },
    {
      matches: { chanCodes: ["3B"] },
      strategyKey: "research-chan",
      entry: { kind: "chan-third-buy" },
    },
    {
      matches: { theoryFamilies: ["growth-oneil"] },
      strategyKey: "research-sepa-pit",
      entry: { kind: "external", id: "research-sepa-pit" },
    },
    {
      matches: { patternKinds: ["triangle"] },
      strategyKey: "double-breakout",
      entry: { kind: "double-breakout" },
    },
    {
      matches: { patternKinds: ["double-breakout"] },
      strategyKey: "double-breakout",
      entry: { kind: "double-breakout" },
    },
    {
      matches: {
        chanCodes: ["1S", "P1B"],
        patternKinds: ["unmapped"],
        theoryFamilies: ["wyckoff-volume"],
      },
      strategyKey: "dual-ma",
      entry: { kind: "dual-ma" },
    },
  ];

  it.each(patternCases)(
    "maps pattern matches $matches to $strategyKey",
    ({ matches, strategyKey, entry }) => {
      const { handoff } = readHandoff(
        patternCandidateToLabHref({
          symbol,
          frozenDate,
          ...matches,
          label: "确认信号",
          returnTo: patternList,
        }),
      );
      expect(handoff).toEqual({
        handoffSource: "pattern",
        symbol,
        frozenDate,
        strategyHint: strategyKey,
        label: "确认信号",
        scope: "single-symbol-diagnose",
        returnTo: patternList,
      });
      expect(checkDraft(handoff, strategyKey, entry).end).toBe(frozenDate);
    },
  );

  it("uses the same strategy when overlapping pattern matches arrive in a different order", () => {
    const input = {
      symbol,
      chanCodes: ["2B", "1B", "3B"],
      patternKinds: ["wedge"],
      theoryFamilies: ["growth-oneil"],
    };
    const href = patternCandidateToLabHref(input);
    expect(
      patternCandidateToLabHref({
        ...input,
        chanCodes: [...input.chanCodes].reverse(),
      }),
    ).toBe(href);
    expect(readHandoff(href).handoff.strategyHint).toBe("research-chan");
  });

  it("preserves the confirmed RPS batch date and period in a single-symbol diagnostic", () => {
    const { handoff } = readHandoff(
      rpsCandidateToLabHref({
        symbol,
        frozenDate,
        period: 120,
        rpsValue: 97.25,
        returnTo: rpsList,
      }),
    );
    expect(handoff).toEqual({
      handoffSource: "rps",
      symbol,
      frozenDate,
      strategyHint: "dual-ma",
      label: "RPS120=97.25",
      scope: "single-symbol-diagnose",
      returnTo: rpsList,
    });
    const draft = checkDraft(handoff, "dual-ma", { kind: "dual-ma" });
    expect(draft.end).toBe(frozenDate);
    expect(draft.scopeNote).toContain("RPS 排名仅用于选择候选");
  });

  it("keeps unknown RPS and dates distinct from a genuine zero", () => {
    const { handoff } = readHandoff(
      rpsCandidateToLabHref({ symbol, period: 5 }),
    );
    expect(handoff.label).toBe("RPS5=—");
    expect(handoff.frozenDate).toBeUndefined();
    expect(
      readHandoff(rpsCandidateToLabHref({ symbol, period: 5, rpsValue: 0 }))
        .handoff.label,
    ).toBe("RPS5=0");
    const draft = checkDraft(handoff, "dual-ma", { kind: "dual-ma" });
    expect(draft).toMatchObject({ start: "", end: "" });
  });
});

describe("RPS handoff row availability", () => {
  const settled = {
    visible: true,
    rankingReady: true,
    isFetching: false,
    isPlaceholderData: false,
    isError: false,
    conditionUnavailable: false,
  };

  it("allows the handoff only from a settled successful page", () => {
    expect(rpsHandoffRowAvailable(settled)).toBe(true);
  });

  it.each([
    ["isRefetching", { isFetching: true }],
    ["showsPlaceholderRows", { isPlaceholderData: true }],
    ["failed", { isError: true }],
    ["isHidden", { visible: false }],
    ["hasNoRankingBatch", { rankingReady: false }],
    ["hasUnavailableConditionPeriods", { conditionUnavailable: true }],
  ])(
    "rejects a handoff row when the page %s so stale rows cannot emit links",
    (_reason, override) => {
      expect(rpsHandoffRowAvailable({ ...settled, ...override })).toBe(false);
    },
  );
});

describe("return navigation and retained draft recovery", () => {
  const firstHref = formulaCandidateToLabHref({
    symbol,
    frozenDate,
    returnTo: formulaList,
  });
  const secondHref = patternCandidateToLabHref({
    symbol: "sz000002",
    frozenDate: "2026-11-19",
    chanCodes: ["2B"],
    returnTo: "/scan?tab=formula&symbol=sz000002&screenSnapshot=pattern-2",
  });

  it("resolves the original candidate, date and return context on URL back and forward", () => {
    const first = readHandoff(firstHref);
    const second = readHandoff(secondHref);
    expect(first.key).not.toBe(second.key);
    const sameListOtherSymbol = readHandoff(
      formulaCandidateToLabHref({
        symbol: "sz000002",
        frozenDate,
        returnTo: formulaList,
      }),
    );
    expect(sameListOtherSymbol.key).not.toBe(first.key);
    const refreshed = readHandoff(
      formulaCandidateToLabHref({
        symbol,
        frozenDate: "2026-11-23",
        returnTo: formulaList,
      }),
    );
    expect(refreshed.key).not.toBe(first.key);

    const history = [firstHref, secondHref, firstHref, secondHref].map(
      readHandoff,
    );
    expect(history).toEqual([first, second, first, second]);
    expect(
      history.map(({ handoff }) => {
        const draft = buildLabDraftFromHandoff(handoff);
        return [draft.strategy.universe, draft.end, handoff.returnTo];
      }),
    ).toEqual([
      [{ kind: "symbols", symbols: ["sh600000"] }, "2026-11-20", formulaList],
      [
        { kind: "symbols", symbols: ["sz000002"] },
        "2026-11-19",
        "/scan?tab=formula&symbol=sz000002&screenSnapshot=pattern-2",
      ],
      [{ kind: "symbols", symbols: ["sh600000"] }, "2026-11-20", formulaList],
      [
        { kind: "symbols", symbols: ["sz000002"] },
        "2026-11-19",
        "/scan?tab=formula&symbol=sz000002&screenSnapshot=pattern-2",
      ],
    ]);
  });

  it("keeps both routes cached and changes a simulated dirty draft only on explicit apply", () => {
    const lab = "/lab/backtest";
    let cache: PanelCacheState = { mounted: [lab], recent: [lab] };
    const dirtyDraft = Object.freeze({
      strategyJson: '{ "id": "unfinished edit"',
      start: "2024-03-01",
      end: "2025-05-30",
    });
    let retainedDraft: Pick<
      ReturnType<typeof buildLabDraftFromHandoff>,
      "strategyJson" | "start" | "end"
    > = dirtyDraft;
    const previews = [firstHref, secondHref, firstHref, secondHref].map(
      (href) => {
        cache = nextPanelCache(cache, "/scan");
        cache = nextPanelCache(cache, handoffUrl(href).pathname);
        const preview = buildLabDraftFromHandoff(readHandoff(href).handoff);
        expect(cache.mounted).toEqual([lab, "/scan"]);
        expect(retainedDraft).toBe(dirtyDraft);
        return preview;
      },
    );
    const selected = previews.at(-1)!;
    expect(selected.strategy.universe).toEqual({
      kind: "symbols",
      symbols: ["sz000002"],
    });
    const applyPreview = () => {
      retainedDraft = {
        strategyJson: selected.strategyJson,
        start: selected.start,
        end: selected.end,
      };
    };
    applyPreview();
    expect(retainedDraft).toEqual({
      strategyJson: selected.strategyJson,
      start: selected.start,
      end: "2026-11-19",
    });
    const applied = retainedDraft;
    const { handoff } = readHandoff(firstHref);
    cache = nextPanelCache(
      cache,
      handoffUrl(handoff.returnTo ?? null).pathname,
    );
    cache = nextPanelCache(cache, handoffUrl(firstHref).pathname);
    expect(buildLabDraftFromHandoff(handoff).strategyJson).not.toBe(
      applied.strategyJson,
    );
    expect(retainedDraft).toBe(applied);
    expect(cache.mounted).toEqual([lab, "/scan"]);
  });
});

describe("invalid scan handoffs", () => {
  it.each([
    "https://workbench.test/scan?tab=formula",
    "//evil.com",
    "/accounts/trades",
    "/scan/../accounts",
    "/scan?next=javascript%3Aalert%281%29",
    "/scan?next=%252F%252Fevil.com",
  ])(
    "drops unsafe builder return targets and rejects forged targets: %s",
    (returnTo) => {
      const href = formulaCandidateToLabHref({ symbol, returnTo });
      expect(readHandoff(href).handoff.returnTo).toBeUndefined();
      const { searchParams } = handoffUrl(href);
      searchParams.set("returnTo", returnTo);
      expect(parseScanToLabHandoff(searchParams).kind).toBe("invalid");
    },
  );

  it.each(["", "600000", "SH600000", "sh60000", "sh600000/other"])(
    "returns no link for a malformed symbol: %j",
    (badSymbol) => {
      expect(formulaCandidateToLabHref({ symbol: badSymbol })).toBeNull();
      expect(patternCandidateToLabHref({ symbol: badSymbol })).toBeNull();
      expect(
        rpsCandidateToLabHref({ symbol: badSymbol, period: 50 }),
      ).toBeNull();
    },
  );

  it.each([
    ["symbol", null],
    ["symbol", "bad-symbol"],
    ["handoffSource", "unknown"],
    ["scope", null],
    ["scope", "historical-pool"],
    ["frozenDate", "2026-02-30"],
    ["handoff", "2"],
  ])("rejects invalid URL parameter %s=%j", (key, value) => {
    const { searchParams } = handoffUrl(
      formulaCandidateToLabHref({ symbol, frozenDate }),
    );
    if (value === null) searchParams.delete(key);
    else searchParams.set(key, value);
    expect(parseScanToLabHandoff(searchParams).kind).toBe("invalid");
  });

  it("rejects malformed dates at the builder and recognizes a plain Lab visit", () => {
    expect(
      formulaCandidateToLabHref({ symbol, frozenDate: "2026-02-30" }),
    ).toBeNull();
    expect(parseScanToLabHandoff(new URLSearchParams())).toEqual({
      kind: "none",
    });
  });
});
