import { describe, expect, it } from "vitest";
import { strategyObjectSchema } from "trading-strategies";
import {
  nextPanelCache,
  type PanelCacheState,
} from "~/components/workbench/keep-alive";
import {
  buildLabDraftFromHandoff,
  parseScanToLabHandoff,
  type ScanToLabHandoff,
} from "~/lib/research/diagnose-contract";
import {
  formulaCandidateToLabHref,
  patternCandidateToLabHref,
  rpsCandidateToLabHref,
} from "~/lib/screening/screen-candidate-navigation";
import { rpsHandoffRowAvailable } from "~/components/market/stock-rps-ranking";

const origin = "https://workbench.test";
const symbol = "sh600000";
const frozenDate = "2026-11-20";
const formulaList =
  "/scan?tab=formula&job=job-23&symbol=sz000001&screenSnapshot=snap-1&q=%E6%B5%8B%E8%AF%95+%2B&filter=a&filter=b";
const patternList =
  "/scan?tab=formula&symbol=sh600000&screenSnapshot=pattern-1";
const rpsList = "/scan?tab=rps";

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
    "/accounts",
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
