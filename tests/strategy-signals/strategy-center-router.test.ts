import { createHash } from "node:crypto";
import { beforeEach, expect, it, vi } from "vitest";
import { createPerformanceReport } from "quant-performance";

const store = vi.hoisted(() => ({ jobs: new Map<string, unknown>(), sql: "" }));
vi.mock("~/server/db/jobs", () => ({
  readJob: (id: string) => store.jobs.get(id),
}));
vi.mock("~/server/jobs/jobs", () => ({
  background: vi.fn(),
}));
vi.mock("~/server/db", () => ({
  sqlite: () => ({
    prepare: (sql: string) => {
      store.sql = sql;
      return {
        all: () => [
          {
            id: "own",
            strategyId: "ma",
            status: "completed",
            symbol: "sh600519",
          },
        ],
      };
    },
  }),
}));
vi.mock("~/server/strategies/strategy-center-service", async () => {
  const { z } = await import("zod");
  return { strategyCenterJob: vi.fn(), strategyCenterRunSchema: z.object({}) };
});
vi.mock("~/server/strategies/strategy-center-candidates", async () => {
  const { z } = await import("zod");
  return {
    captureStrategyCandidates: vi.fn(),
    strategyCenterCandidatesSchema: z.object({}),
  };
});
vi.mock("~/server/strategies/strategy-center-portfolio", async () => {
  const { z } = await import("zod");
  return {
    executeStrategyCenterPortfolio: vi.fn(),
    strategyCenterPortfolioSchema: z.object({}),
  };
});
vi.mock("~/server/infra/settings", () => ({
  settings: () => ({ tdxRoot: "unused" }),
}));
import { strategyCenterRouter } from "~/server/api/routers/strategy-center";

const caller = () =>
  strategyCenterRouter.createCaller({ headers: new Headers() });
it("bounds manual risk parity before matrix work without restricting ordinary rankings", async () => {
  const candidates = Array.from({ length: 201 }, (_, i) => ({
    symbol: `asset-${i}`,
    availableAt: "2025-01-06",
    values: { volatility: 0.1, momentum: i },
    returns: [],
  }));
  await expect(
    caller().strategyCenterEvaluate({
      strategyId: "allocation-risk-parity",
      asOf: "2025-01-06",
      candidates,
    }),
  ).rejects.toThrow("最多200");
  const result = await caller().strategyCenterEvaluate({
    strategyId: "rank-momentum",
    asOf: "2025-01-06",
    candidates,
  });
  expect(result.kind).toBe("weights");
  if (result.kind === "weights") expect(result.weights).toHaveLength(10);
});
function archive(strategyId = "ma") {
  const frozen = {
    input: {
      strategyId,
      symbol: "sh600519",
      start: "2025-01-02",
      end: "2025-01-06",
      initial: 1000000,
    },
    sourceHash: "shared-source",
    calendarHash: "shared-calendar",
    strategyBuildHash: "shared-build",
  };
  return {
    frozen,
    inputHash: createHash("sha256")
      .update(JSON.stringify(frozen))
      .digest("hex"),
    result: {
      curve: [
        { date: "2025-01-02", equity: 1000000 },
        { date: "2025-01-03", equity: 1010000 },
        { date: "2025-01-06", equity: 1020000 },
      ],
    },
  };
}
function save(
  id: string,
  result = archive(),
  type = "strategy-center",
  status = "completed",
) {
  store.jobs.set(id, { id, input: { type }, status, result });
}
beforeEach(() => {
  store.jobs.clear();
  store.sql = "";
});

it("compares strategies using the shared performance report on matching frozen contexts", async () => {
  const first = archive(),
    second = archive("breakout");
  save("one", first);
  save("two", second);
  const rows = await caller().strategyCenterCompare(["one", "two"]);
  const expected = createPerformanceReport(
    first.frozen.input.initial,
    first.result.curve.map((p) => ({ date: p.date, value: p.equity })),
  ).overview;
  expect(rows.map((row) => row.strategyId)).toEqual(["ma", "breakout"]);
  expect(rows[0]!.overview).toEqual(expected);
  expect(rows[1]!.overview).toEqual(expected);
});

it("checks native identities among native runs while permitting the same-price ordinary baseline", async () => {
  function nativeArchive(
    change: Partial<{
      dllHash: string;
      configId: string;
      originDate: string;
      priceBasis: string;
    }> = {},
  ) {
    const base = archive("research-chan");
    const frozen = {
      ...base.frozen,
      native: {
        identity: {
          dllHash: change.dllHash ?? "a".repeat(64),
          apiVersion: 22,
          buildCommit: "fixture-native",
          configId: change.configId ?? "default",
          config: 0,
          anchor: 1,
        },
        originDate: change.originDate ?? "2024-06-01",
        baselineDate: "2025-01-01",
        priceBasis: change.priceBasis ?? "forward-cash-dividend-adjusted",
      },
    };
    return {
      ...base,
      frozen,
      inputHash: createHash("sha256")
        .update(JSON.stringify(frozen))
        .digest("hex"),
    };
  }
  save("native-one", nativeArchive());
  save("native-two", nativeArchive());
  save("ma", archive());
  expect(
    await caller().strategyCenterCompare(["native-one", "ma", "native-two"]),
  ).toHaveLength(3);
  for (const change of [
    { dllHash: "b".repeat(64) },
    { configId: "other" },
    { originDate: "2024-06-02" },
    { priceBasis: "raw" },
  ]) {
    save("native-two", nativeArchive(change));
    await expect(
      caller().strategyCenterCompare(["native-one", "native-two"]),
    ).rejects.toThrow("原生策略比较要求");
  }
  save("missing", archive("research-chan"));
  await expect(
    caller().strategyCenterCompare(["missing", "ma"]),
  ).rejects.toThrow("缺少冻结DLL");
});

it("rejects comparisons across dates, sources or strategy builds", async () => {
  save("one");
  for (const key of ["date", "source", "build"]) {
    const other = archive("breakout");
    if (key === "date") other.frozen.input.start = "2025-01-03";
    if (key === "source") other.frozen.sourceHash = "different-source";
    if (key === "build") other.frozen.strategyBuildHash = "different-build";
    other.inputHash = createHash("sha256")
      .update(JSON.stringify(other.frozen))
      .digest("hex");
    save("two", other);
    await expect(
      caller().strategyCenterCompare(["one", "two"]),
    ).rejects.toThrow("比较要求");
  }
});

it("exports intact frozen input and refuses a corrupted fingerprint", async () => {
  const result = archive();
  save("one", result);
  expect(await caller().strategyCenterExport("one")).toEqual(result);
  result.frozen.sourceHash = "tampered";
  save("one", result);
  await expect(caller().strategyCenterExport("one")).rejects.toThrow(
    "摘要校验失败",
  );
  await expect(caller().strategyCenterEvaluation("one")).rejects.toThrow(
    "摘要校验失败",
  );
  save("two", archive("breakout"));
  await expect(caller().strategyCenterCompare(["one", "two"])).rejects.toThrow(
    "摘要校验失败",
  );
});

it("rejects validly rehashed comparisons when cash distributions or portfolio actions differ", async () => {
  const scenarios = [
    {
      first: { dividends: [{ date: "2025-01-03", perShare: 0.1 }] },
      second: { dividends: [{ date: "2025-01-03", perShare: 0.2 }] },
    },
    {
      first: {
        stocks: [
          {
            symbol: "sh600519",
            actions: [{ date: "2025-01-03", dividend: 0.1, bonus: 0 }],
          },
        ],
      },
      second: {
        stocks: [
          {
            symbol: "sh600519",
            actions: [{ date: "2025-01-03", dividend: 0.1, bonus: 0.1 }],
          },
        ],
      },
    },
  ];
  for (const scenario of scenarios) {
    const first = {
      ...archive(),
      frozen: { ...archive().frozen, ...scenario.first },
    };
    const second = {
      ...archive("breakout"),
      frozen: { ...archive("breakout").frozen, ...scenario.second },
    };
    for (const result of [first, second])
      result.inputHash = createHash("sha256")
        .update(JSON.stringify(result.frozen))
        .digest("hex");
    save("one", first);
    save("two", second);
    await expect(
      caller().strategyCenterCompare(["one", "two"]),
    ).rejects.toThrow("比较要求");
  }
});

it("evaluates only completed strategy-center tasks using the same annual and monthly report", async () => {
  const result = archive();
  save("one", result);
  const { daily: _, ...expected } = createPerformanceReport(
    result.frozen.input.initial,
    result.result.curve.map((p) => ({ date: p.date, value: p.equity })),
  );
  expect(await caller().strategyCenterEvaluation("one")).toEqual(expected);
  save("foreign", result, "ma-baseline");
  save("pending", result, "strategy-center", "running");
  for (const id of ["foreign", "pending", "missing"]) {
    await expect(caller().strategyCenterEvaluation(id)).rejects.toThrow(
      "尚未完成",
    );
    await expect(caller().strategyCenterExport(id)).rejects.toThrow(
      "尚未完成或不存在",
    );
  }
});

it("restricts history lookup to strategy-center jobs and bounded newest-first results", async () => {
  expect(await caller().strategyCenterHistory()).toEqual([
    { id: "own", strategyId: "ma", status: "completed", symbol: "sh600519" },
  ]);
  expect(store.sql).toContain("kind='job'");
  expect(store.sql).toContain(
    "json_extract(payload,'$.input.type')='strategy-center'",
  );
  expect(store.sql).toContain("ORDER BY updated_at DESC LIMIT 30");
});

it("classifies every recorded method and filters categories without promoting tools to executable rules", async () => {
  const all = await caller().strategyCenterMethods({ query: "", page: 0 });
  expect(all.total).toBe(695);
  const risk = await caller().strategyCenterMethods({
    query: "",
    page: 0,
    category: "allocation",
  });
  expect(risk.total).toBeGreaterThan(100);
  expect(
    risk.methods.every(
      (method) =>
        method.category === "allocation" && method.kind === "risk-policy",
    ),
  ).toBe(true);
  const tools = await caller().strategyCenterMethods({
    query: "",
    page: 0,
    category: "models-execution",
  });
  expect(tools.methods.every((method) => method.kind === "data-tool")).toBe(
    true,
  );
  await expect(
    caller().strategyCenterMethods({
      query: "",
      page: 0,
      category: "not-a-category",
    }),
  ).rejects.toThrow("分类无效");
});
