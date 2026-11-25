import { describe, expect, it } from "vitest";
import {
  buildIntentIdempotencyKey,
  canTransitionIntentStatus,
  deployableStrategySpecSchema,
  deploymentProvenanceSchema,
  deploymentRiskPolicySchema,
  deploymentScheduleSchema,
  executionModes,
  executionVenueKinds,
  extractVenueAccountKey,
  isExecutionModeCompatibleWithVenue,
  isLiveVenueKind,
  isTerminalIntentStatus,
  isVenueCompatibleWithMarket,
  liveVenueKinds,
  orderIntentStatuses,
  poolEntrySources,
  poolEntryStatuses,
  poolEvictionRuleSchema,
  poolPolicySchema,
  poolSyncModes,
  poolSyncSnapshotSchema,
  regimeGateSpecSchema,
  simVenueKinds,
  strategyTargetProposalSchema,
  universeSpecSchema,
  venueBindingSchema,
  type OrderIntentStatus,
} from "trading-strategies";

const methodId = "f08-wyckoff-spring-test";
const valueId = "value-magic-formula-pit";

describe("deployable strategies and universes", () => {
  it.each([
    [{ kind: "study-rule", strategyId: "ma", parameters: { window: 5 } }, {}],
    [
      { kind: "theory-screener", methodId },
      { holdBars: 25, useScreenerStops: true },
    ],
    [
      { kind: "etf-rotation", config: { strategyId: "etf-sector-rotation" } },
      { config: { topK: 2, momentumWindows: [20, 60] } },
    ],
    [
      { kind: "alpha-composite", compositeId: "alpha-1" },
      { topN: 10, rebalanceCadence: "weekly" },
    ],
    [{ kind: "macro-clock" }, { rebalanceCadence: "month-end" }],
    [
      { kind: "pair-switch", pairId: "hs300-zz500" },
      { lookback: 60, entryZ: 1.5, exitZ: 0.25 },
    ],
    [
      { kind: "value-pit", strategyId: valueId },
      { topK: 10, rebalanceCadence: "month-end" },
    ],
    [{ kind: "formula", name: "positive", source: "C>0" }, {}],
    [{ kind: "double-breakout", minVolumeRatio: 1.5 }, {}],
    [{ kind: "chan-native", profile: "hold-cash" }, {}],
    [{ kind: "crypto-dual-ma", fast: 2, slow: 3, period: "4h" }, {}],
    [{ kind: "multi-book", preset: "core-4" }, {}],
  ])("parses strategy %j and resolves its defaults", (input, defaults) => {
    const parsed = deployableStrategySpecSchema.parse(input);
    expect(parsed).toMatchObject(input);
    expect(parsed).toMatchObject(defaults);
    expect(
      deployableStrategySpecSchema.safeParse({ ...input, extra: true }).success,
    ).toBe(false);
  });

  it.each([
    [{ kind: "fixed-symbols", symbols: ["sh510300"] }, {}],
    [{ kind: "watchlist" }, { maxSymbols: 50 }],
    [{ kind: "etf-pool" }, { pool: "full" }],
    [{ kind: "rps-filter", period: 120, minRps: 90 }, { maxSymbols: 20 }],
    [
      {
        kind: "formula-screen",
        formulaName: "positive",
        source: "C>0",
        parameters: { n: 2 },
      },
      { maxSymbols: 20 },
    ],
    [
      { kind: "theory-screener-scan", methodId, minScore: 3 },
      { maxSymbols: 20 },
    ],
    [
      {
        kind: "value-pit-topn",
        strategyId: valueId,
        baseSymbols: ["sh510300"],
      },
      { topK: 15 },
    ],
  ])("parses universe %j and resolves its defaults", (input, defaults) => {
    expect(universeSpecSchema.parse(input)).toEqual({ ...input, ...defaults });
    expect(
      universeSpecSchema.safeParse({ ...input, extra: true }).success,
    ).toBe(false);
  });

  it.each(["f08-wyckoff-utad-sow", "unregistered"])(
    "rejects method %s for both deployment and scanning",
    (id) => {
      expect(
        deployableStrategySpecSchema.safeParse({
          kind: "theory-screener",
          methodId: id,
        }).success,
      ).toBe(false);
      expect(
        universeSpecSchema.safeParse({
          kind: "theory-screener-scan",
          methodId: id,
        }).success,
      ).toBe(false);
    },
  );
  it.each(["hold", "unregistered"])("rejects study rule %s", (strategyId) => {
    expect(
      deployableStrategySpecSchema.safeParse({ kind: "study-rule", strategyId })
        .success,
    ).toBe(false);
  });
  it.each([5, 6])("rejects fast window %i when slow is 5", (fast) => {
    expect(
      deployableStrategySpecSchema.safeParse({
        kind: "crypto-dual-ma",
        fast,
        slow: 5,
        period: "5m",
      }).success,
    ).toBe(false);
  });
  it.each(["sh510300", " SH510300 "])(
    "rejects a repeated fixed symbol %s",
    (symbol) => {
      expect(
        universeSpecSchema.safeParse({
          kind: "fixed-symbols",
          symbols: ["sh510300", symbol],
        }).success,
      ).toBe(false);
    },
  );
});

describe("continuous monitoring pool", () => {
  it("accumulates by default and applies only explicit eviction overrides", () => {
    expect(poolSyncModes).toEqual(["accumulate", "replace"]);
    expect(poolEntrySources).toEqual(["screener", "manual"]);
    expect(poolEntryStatuses).toEqual(["watching", "evicted"]);
    const eviction = {
      maxConsecutiveMissedDays: 5,
      hardEvictBelowMaDays: null,
      hardEvictMaxDrawdownPct: null,
      maxPoolSize: 50,
      maxWatchDays: null,
    };
    expect(poolPolicySchema.parse({})).toEqual({
      mode: "accumulate",
      eviction,
    });
    const override = {
      maxConsecutiveMissedDays: 0,
      hardEvictMaxDrawdownPct: 0.12,
    };
    expect(
      poolPolicySchema.parse({ mode: "replace", eviction: override }),
    ).toEqual({
      mode: "replace",
      eviction: { ...eviction, ...override },
    });
    for (const invalid of [
      { mode: "reset" },
      { extra: true },
      { eviction: { extra: true } },
    ]) {
      expect(poolPolicySchema.safeParse(invalid).success).toBe(false);
    }
  });

  it.each([
    ["maxConsecutiveMissedDays", -1, 0, 60, 61],
    ["hardEvictBelowMaDays", 4, 5, 250, 251],
    ["maxPoolSize", 0, 1, 500, 501],
    ["maxWatchDays", 0, 1, 365, 366],
  ] as const)(
    "enforces the integer range of %s",
    (field, below, min, max, above) => {
      for (const value of [below, min + 0.5, above]) {
        expect(
          poolEvictionRuleSchema.safeParse({ [field]: value }).success,
        ).toBe(false);
      }
      for (const value of [min, max]) {
        expect(poolEvictionRuleSchema.parse({ [field]: value })[field]).toBe(
          value,
        );
      }
    },
  );
  it.each([0, 0.95])("excludes drawdown threshold %f", (value) => {
    expect(
      poolEvictionRuleSchema.safeParse({ hardEvictMaxDrawdownPct: value })
        .success,
    ).toBe(false);
  });

  const snapshot = {
    asOf: "2026-11-25",
    mode: "accumulate",
    sourceHash: "scan-1",
    matchedCount: 2,
    activePoolCount: 3,
    added: [{ symbol: "A", reason: "first match" }],
    retained: ["B"],
    missedGrace: [{ symbol: "C", consecutiveMissedDays: 1 }],
    evicted: [{ symbol: "D", reason: "watch limit" }],
    activeSymbols: ["A", "B", "C"],
  };
  it("records newly matched and still-watched symbols with optional entry evidence", () => {
    expect(poolSyncSnapshotSchema.parse(snapshot)).toEqual({
      ...snapshot,
      added: [{ ...snapshot.added[0], score: null, price: null }],
    });
    const added = [{ symbol: "A", reason: "first match", score: 0, price: 25 }];
    expect(poolSyncSnapshotSchema.parse({ ...snapshot, added }).added).toEqual(
      added,
    );
  });
  it.each([
    { extra: true },
    { asOf: "2026-02-30" },
    { sourceHash: "" },
    { matchedCount: -1 },
    { activePoolCount: 1.5 },
    { retained: [" "] },
    { added: [{ ...snapshot.added[0], price: 0 }] },
    { added: [{ ...snapshot.added[0], score: Infinity }] },
    { added: [{ ...snapshot.added[0], extra: true }] },
    { missedGrace: [{ symbol: "C", consecutiveMissedDays: 0 }] },
    { missedGrace: [{ ...snapshot.missedGrace[0], extra: true }] },
    { evicted: [{ ...snapshot.evicted[0], extra: true }] },
  ])("rejects malformed snapshot fields %j", (invalid) => {
    expect(
      poolSyncSnapshotSchema.safeParse({ ...snapshot, ...invalid }).success,
    ).toBe(false);
  });
  it.each([
    [{ activePoolCount: 2 }, ["activePoolCount"]],
    [{ activeSymbols: ["A", " a ", "C"] }, ["activeSymbols"]],
    [
      { evicted: [{ symbol: " b ", reason: "watch limit" }] },
      ["evicted", 0, "symbol"],
    ],
  ] as const)("rejects inconsistent pool membership %j", (change, path) => {
    const result = poolSyncSnapshotSchema.safeParse({ ...snapshot, ...change });
    expect(result.error?.issues.map((issue) => issue.path)).toContainEqual(
      path,
    );
  });
});

describe("deployment safeguards", () => {
  it.each([
    "none",
    "oneil-market-direction",
    "dow-dual-index",
    "sentiment-regime",
    "macro-clock-filter",
  ])("resolves gate %s", (kind) => {
    expect(regimeGateSpecSchema.parse({ kind })).toEqual({
      kind,
      benchmark: "sh000300",
      unlockAvoidanceDays: 10,
    });
  });
  it("resolves all risk limits", () => {
    expect(deploymentRiskPolicySchema.parse({})).toEqual({
      maxSymbolWeight: 0.2,
      maxTotalExposure: 0.95,
      maxDailyOrders: 20,
      maxDailyTurnover: 1,
      maxGapPct: 0.02,
      drawdownPausePct: 0.08,
      maxConsecutiveFailures: 3,
    });
  });
  it.each([
    ["maxSymbolWeight", 0, 1, 1.01],
    ["maxTotalExposure", 0, 1, 1.01],
    ["maxDailyOrders", 0, 100, 101],
    ["maxDailyTurnover", 0, 2, 2.01],
    ["maxGapPct", 0.004, 0.005, 0.21],
    ["drawdownPausePct", 0, 0.5, 0.51],
    ["maxConsecutiveFailures", 0, 10, 11],
  ] as const)("enforces %s at the boundary", (field, below, allowed, above) => {
    expect(
      deploymentRiskPolicySchema.safeParse({ [field]: below }).success,
    ).toBe(false);
    expect(deploymentRiskPolicySchema.parse({ [field]: allowed })[field]).toBe(
      allowed,
    );
    expect(
      deploymentRiskPolicySchema.safeParse({ [field]: above }).success,
    ).toBe(false);
  });
  it("accepts exactly the three simulation bindings", () => {
    const bindings = [
      { kind: "local_sim", simAccountId: "paper" },
      { kind: "ths_mock", accountTag: "default" },
      { kind: "crypto_sim", venue: "okx", accountId: "paper" },
    ];
    expect(simVenueKinds).toEqual(bindings.map((binding) => binding.kind));
    for (const binding of bindings) {
      expect(venueBindingSchema.parse(binding)).toEqual(binding);
      expect(
        venueBindingSchema.safeParse({ ...binding, live: true }).success,
      ).toBe(false);
    }
  });
  it.each([
    { kind: "real", simAccountId: "paper" },
    { kind: "broker", accountId: "live" },
    { kind: "ths_mock", accountTag: "live" },
    { kind: "crypto_sim", venue: "broker", accountId: "paper" },
    { kind: "cn_broker_live", broker: "unknown", accountId: "1" },
    {
      kind: "cn_broker_live",
      broker: "http_bridge",
      accountId: "1",
      endpointUrl: "invalid",
    },
    { kind: "crypto_live", venue: "bybit", accountId: "" },
    { kind: "crypto_live", venue: "unknown", accountId: "1" },
  ])("rejects non-whitelisted venue or account %j", (binding) => {
    expect(venueBindingSchema.safeParse(binding).success).toBe(false);
  });
  const brokerBinding = {
    kind: "cn_broker_live",
    broker: "http_bridge",
    accountId: "1",
  };
  it.each([
    "https://user:pass@broker.example",
    "https://user@broker.example",
    "https://:pass@broker.example",
    "https://broker.example/orders?token=example",
    "https://broker.example/orders#token=example",
    "ftp://broker.example/orders",
  ])("rejects unsafe broker endpoint %s", (endpointUrl) => {
    const result = venueBindingSchema.safeParse({
      ...brokerBinding,
      endpointUrl,
    });
    expect(result.error?.issues[0]?.path).toEqual(["endpointUrl"]);
  });
  it.each(["http://localhost:8080/orders", "https://broker.example/orders"])(
    "accepts broker endpoint %s",
    (endpointUrl) => {
      const binding = { ...brokerBinding, endpointUrl };
      expect(venueBindingSchema.parse(binding)).toEqual(binding);
    },
  );
  it("accepts only the configured live providers and binding fields", () => {
    for (const provider of [
      ...["qmt", "ptrade", "xtquant", "http_bridge", "ths_live"].map(
        (broker) => ({
          kind: "cn_broker_live",
          broker,
        }),
      ),
      ...["binance", "okx", "bybit"].map((venue) => ({
        kind: "crypto_live",
        venue,
      })),
    ]) {
      const binding = { ...provider, accountId: "1" };
      expect(venueBindingSchema.parse(binding)).toEqual(binding);
      expect(
        venueBindingSchema.safeParse({ ...binding, extra: true }).success,
      ).toBe(false);
    }
  });
  it("restricts each market and automatic execution mode to its allowed venues", () => {
    expect(executionVenueKinds).toEqual([...simVenueKinds, ...liveVenueKinds]);
    expect(executionModes).toEqual([
      "shadow",
      "manual_confirm",
      "auto_sim",
      "auto_live",
    ]);
    expect(executionVenueKinds.filter(isLiveVenueKind)).toEqual([
      "cn_broker_live",
      "crypto_live",
    ]);
    for (const market of ["cn-equity", "crypto"] as const) {
      expect(
        executionVenueKinds.filter((kind) =>
          isVenueCompatibleWithMarket(market, kind),
        ),
      ).toEqual(
        market === "cn-equity"
          ? ["local_sim", "ths_mock", "cn_broker_live"]
          : ["crypto_sim", "crypto_live"],
      );
    }
    for (const [mode, allowed] of [
      ["auto_sim", simVenueKinds],
      ["auto_live", liveVenueKinds],
      ["shadow", executionVenueKinds],
      ["manual_confirm", executionVenueKinds],
    ] as const) {
      expect(
        executionVenueKinds.filter((kind) =>
          isExecutionModeCompatibleWithVenue(mode, kind),
        ),
      ).toEqual(allowed);
    }
  });
  it("scopes account keys by venue and provider across endpoint changes", () => {
    const broker = {
      kind: "cn_broker_live",
      broker: "qmt",
      accountId: "default",
    } as const;
    const exchange = {
      kind: "crypto_live",
      venue: "okx",
      accountId: "default",
    } as const;
    const bindings = [
      broker,
      { ...broker, broker: "ptrade" },
      { ...broker, accountId: "other" },
      exchange,
      { ...exchange, venue: "bybit" },
      { ...exchange, kind: "crypto_sim" },
      { kind: "local_sim", simAccountId: "default" },
      { kind: "ths_mock", accountTag: "default" },
    ] as const;
    expect(new Set(bindings.map(extractVenueAccountKey)).size).toBe(
      bindings.length,
    );
    expect(
      extractVenueAccountKey(
        venueBindingSchema.parse({
          ...broker,
          endpointUrl: "https://new.example",
        }),
      ),
    ).toBe(extractVenueAccountKey(broker));
  });
  it("parses all schedule kinds and rejects malformed times or unsupported intervals", () => {
    expect(deploymentScheduleSchema.parse({ kind: "post_close_auto" })).toEqual(
      {
        kind: "post_close_auto",
        runSignalsAfterClose: true,
        executeAtOpen: true,
        openStartTime: "09:31",
        openCutoffTime: "14:55",
      },
    );
    for (const schedule of [
      { kind: "manual_only" },
      { kind: "crypto_interval", intervalMinutes: 240 },
    ]) {
      expect(deploymentScheduleSchema.parse(schedule)).toEqual(schedule);
    }
    expect(
      deploymentScheduleSchema.safeParse({
        kind: "post_close_auto",
        openStartTime: "9:31",
      }).success,
    ).toBe(false);
    expect(
      deploymentScheduleSchema.safeParse({
        kind: "crypto_interval",
        intervalMinutes: 10,
      }).success,
    ).toBe(false);
  });
  it.each(["99:99", "24:00", "12:60"])(
    "rejects invalid 24-hour time %s on either side of the window",
    (time) => {
      for (const schedule of [
        { openStartTime: time, openCutoffTime: time },
        { openStartTime: "00:00", openCutoffTime: time },
      ]) {
        expect(
          deploymentScheduleSchema.safeParse({
            kind: "post_close_auto",
            ...schedule,
          }).success,
        ).toBe(false);
      }
    },
  );
  it("requires cutoff at or after start, including when one time is defaulted", () => {
    for (const window of [
      { openStartTime: "09:32", openCutoffTime: "09:31" },
      { openStartTime: "14:56" },
      { openCutoffTime: "09:30" },
    ]) {
      const result = deploymentScheduleSchema.safeParse({
        kind: "post_close_auto",
        ...window,
      });
      expect(result.error?.issues[0]?.path).toEqual(["openCutoffTime"]);
    }
    for (const openStartTime of ["00:00", "23:59"]) {
      expect(
        deploymentScheduleSchema.safeParse({
          kind: "post_close_auto",
          openStartTime,
          openCutoffTime: "23:59",
        }).success,
      ).toBe(true);
    }
  });
  it("preserves missing provenance and limits note length", () => {
    expect(deploymentProvenanceSchema.parse({ sourceKind: "manual" })).toEqual({
      sourceKind: "manual",
      sourceRefId: null,
      buildHash: null,
      createdFromRoute: "/",
      note: "",
    });
    expect(
      deploymentProvenanceSchema.safeParse({
        sourceKind: "scan",
        note: "x".repeat(501),
      }).success,
    ).toBe(false);
  });
  it("validates dated proposals, inclusive target weights and nullable signal evidence", () => {
    const signal = {
      symbol: "sh510300",
      action: "BUY",
      score: 0,
      stopPrice: null,
      targetPrice: null,
      reason: "cross",
    };
    const proposal = {
      mode: "delta-signals",
      asOf: "2024-02-29",
      targets: {},
      signals: [signal],
      regimeScale: null,
      disclosure: "",
    };
    expect(strategyTargetProposalSchema.parse(proposal)).toEqual(proposal);
    expect(
      strategyTargetProposalSchema.safeParse({
        ...proposal,
        mode: "target-weights",
        targets: { a: 0, b: 1 },
      }).success,
    ).toBe(true);
    for (const invalid of [
      { targets: { a: -0.01 } },
      { targets: { a: 1.01 } },
      { asOf: "2025-02-29" },
      { signals: [{ ...signal, action: "SHORT" }] },
    ]) {
      expect(
        strategyTargetProposalSchema.safeParse({ ...proposal, ...invalid })
          .success,
      ).toBe(false);
    }
  });
});

describe("order intent lifecycle", () => {
  // Check incoming edges independently of the production outgoing-edge table.
  it.each([
    ["planned", []],
    ["queued", ["planned"]],
    ["submitting", ["planned", "queued"]],
    ["submitted", ["submitting", "unknown_reconcile"]],
    [
      "filled",
      ["submitting", "submitted", "partial_filled", "unknown_reconcile"],
    ],
    ["partial_filled", ["submitting", "submitted", "unknown_reconcile"]],
    [
      "rejected",
      [
        "planned",
        "queued",
        "submitting",
        "submitted",
        "partial_filled",
        "unknown_reconcile",
      ],
    ],
    [
      "cancelled",
      ["planned", "queued", "submitted", "partial_filled", "unknown_reconcile"],
    ],
    ["unknown_reconcile", ["submitting", "submitted", "partial_filled"]],
  ] satisfies [OrderIntentStatus, OrderIntentStatus[]][])(
    "only permits the specified predecessors of %s",
    (to, predecessors) => {
      expect(
        orderIntentStatuses.filter((from) =>
          canTransitionIntentStatus(from, to),
        ),
      ).toEqual(predecessors);
    },
  );
  it("treats only filled, rejected and cancelled as terminal", () => {
    expect(orderIntentStatuses.filter(isTerminalIntentStatus)).toEqual([
      "filled",
      "rejected",
      "cancelled",
    ]);
  });
  const intent = {
    deploymentId: "Desk-A",
    decisionDate: "2026-11-24",
    executeDate: "2026-11-25",
    symbol: "sh510300",
    side: "BUY",
    phase: "open",
  };
  it("reuses a key across retries, whitespace and symbol/side/phase casing", () => {
    const key = buildIntentIdempotencyKey(intent);
    expect(buildIntentIdempotencyKey({ ...intent })).toBe(key);
    expect(
      buildIntentIdempotencyKey({
        ...intent,
        symbol: " SH510300",
        side: "buy ",
        phase: " OPEN ",
      }),
    ).toBe(key);
  });
  it("distinguishes every identity field, even when values contain delimiters", () => {
    const key = buildIntentIdempotencyKey(intent);
    for (const change of [
      { deploymentId: "desk-a" },
      { decisionDate: "2026-11-23" },
      { executeDate: "2026-11-26" },
      { symbol: "sz159915" },
      { side: "SELL" },
      { phase: "close" },
    ]) {
      expect(buildIntentIdempotencyKey({ ...intent, ...change })).not.toBe(key);
    }
    expect(
      buildIntentIdempotencyKey({ ...intent, symbol: "A|B", side: "C" }),
    ).not.toBe(
      buildIntentIdempotencyKey({ ...intent, symbol: "A", side: "B|C" }),
    );
  });
  it("preserves the legacy daily key and scopes intraday retries to their trimmed slot", () => {
    const daily =
      '["Desk-A","2026-11-24","2026-11-25","SH510300","BUY","open"]';
    const keyFor = (runSlot: string) =>
      buildIntentIdempotencyKey({ ...intent, runSlot });
    expect(buildIntentIdempotencyKey(intent)).toBe(daily);
    expect(keyFor("daily")).toBe(daily);
    expect(keyFor(" daily ")).toBe(daily);
    expect(keyFor("09:15")).not.toBe(daily);
    expect(keyFor(" 09:15 ")).toBe(keyFor("09:15"));
    expect(keyFor("09:30")).not.toBe(keyFor("09:15"));
  });
});
