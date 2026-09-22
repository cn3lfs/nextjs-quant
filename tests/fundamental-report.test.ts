import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
const mocks = vi.hoisted(() => ({ structured: vi.fn(), context: vi.fn() }));
vi.mock("../src/server/research/research", async (original) => ({
  ...(await original<typeof import("../src/server/research/research")>()),
  structured: mocks.structured,
}));
vi.mock(
  "../src/server/strategies/value/fundamental-dossier",
  async (original) => ({
    ...(await original<
      typeof import("../src/server/strategies/value/fundamental-dossier")
    >()),
    gatherFundamentalContext: mocks.context,
  }),
);
import { financeEvidence } from "~/server/data-sources/hithink/hithink-finance";
import { businessEvidence } from "~/server/data-sources/hithink/hithink-business";
import { ownershipEvidence } from "~/server/data-sources/hithink/hithink-ownership";
import { forecastEvidence } from "~/server/data-sources/hithink/hithink-forecast";
import { macroEvidence } from "~/server/data-sources/hithink/hithink-macro";
import { solvencyEvidence } from "~/server/data-sources/hithink/hithink-solvency";
import { incomeScopeEvidence } from "~/server/data-sources/hithink/hithink-income-scope";
import { capitalEventsEvidence } from "~/server/data-sources/hithink/hithink-capital-events";
import { fundamentalPrompt } from "~/server/strategies/value/fundamental-prompt";
import {
  financialQuality,
  type FinancialQualityArchive,
} from "~/server/strategies/value/financial-quality";
import {
  buildFundamentalDossier,
  fundamentalPrice,
} from "~/server/strategies/value/fundamental-dossier";
import {
  valuationMethod,
  valuationMethodFiles,
} from "~/server/strategies/value/valuation-method";
import {
  analyzeFundamental,
  fundamentalCitationRules,
  fundamentalReportSchema,
} from "~/server/strategies/value/fundamental-report";
import { createCaller } from "~/server/api/root";
import { put, get, sqlite } from "~/server/db";
import { saveValuationScenario } from "~/server/strategies/value/valuation-scenario";
import type { Job, Snapshot } from "~/lib/domain";
const now = Date.parse("2026-09-09T10:00:00+08:00"),
  hash = (value: unknown) =>
    createHash("sha256").update(JSON.stringify(value)).digest("hex");
const directory = mkdtempSync(join(tmpdir(), "quant-fundamental-test-"));
process.env.QUANT_DATA_DIR = directory;
const caller = createCaller({ headers: new Headers() });
function fixture(years = [2023, 2024, 2025]) {
  const row: Record<string, unknown> = { 股票代码: "600519.SH" },
    columns: { key: string; timestamp: string; unit: string }[] = [];
  years.forEach((year, index) => {
    for (const [name, value] of Object.entries({
      净利润: 10 + index,
      营业收入: 100 + index * 10,
      资产总计: 200 + index * 10,
      所有者权益合计: 100,
      营业成本: 50,
      经营活动产生的现金流量净额: 15,
    })) {
      const timestamp = `${year}1231`,
        key = `${name}[${timestamp}]`;
      row[key] = value;
      columns.push({ key, timestamp, unit: "人民币元" });
    }
  });
  const evidence = [
    financeEvidence(
      "sh600519",
      { status_code: 0, datas: [row], columns },
      "fixture",
      now,
    ),
  ];
  const content = {
    facts: financialQuality("sh600519", evidence, now),
    evidence,
    missingProfiles: [] as string[],
  };
  const digest = hash(content);
  const finance: FinancialQualityArchive = {
    id: `financial-quality-${digest}`,
    hash: digest,
    createdAt: now,
    ...content,
  };
  const source: Snapshot = {
    id: "fixture-day",
    hash: "untrusted-hash",
    symbol: "sh600519",
    period: "day",
    source: "fixture",
    adjustment: "none",
    createdAt: now,
    bars: ["2026-09-07", "2026-09-08", "2026-09-09"].map((date) => ({
      date,
      open: 10,
      high: 12,
      low: 9,
      close: 11,
      volume: 100,
      amount: 1100,
    })),
  };
  return { finance, source };
}
beforeEach(() => {
  sqlite().prepare("DELETE FROM records").run();
  mocks.structured.mockReset();
  mocks.context.mockReset();
  mocks.context.mockResolvedValue([]);
  vi.stubEnv("QUANT_SKILLS_DIR", join(directory, "skills"));
  for (const file of new Set(Object.values(valuationMethodFiles).flat())) {
    const path = join(directory, "skills", file);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `fixture method ${file}`);
  }
});
afterEach(() => vi.unstubAllEnvs());
function reply(
  dossier: ReturnType<typeof buildFundamentalDossier>,
  method: Awaited<ReturnType<typeof valuationMethod>>,
) {
  return {
    title: "测试资料复核",
    summary: "资料覆盖与反证",
    valuationConclusion: null,
    overallScore: null,
    stages: fundamentalCitationRules(dossier, method).map((rule) => ({
      id: rule.id,
      status: "missing",
      summary: "该步骤资料复核",
      citations: [rule.evidenceIds[0]!],
      methodCitations: [rule.methodIds[0]!],
      supporting: [],
      opposing: ["口径尚未独立核验"],
      missing: ["资料不足"],
      nextChecks: ["核对原始财报"],
    })),
    risks: ["资料存在缺口"],
    nextSteps: ["补充证据"],
  };
}
it("includes validated annual business evidence and keeps unrelated context gaps", () => {
  const { finance, source } = fixture();
  const raw = {
    status_code: 0,
    code_count: 1,
    columns: [
      {
        key: "销售额占比[20251231]",
        index_name: "客户销售额合计占比(前五大)",
        timestamp: "20251231",
        type: "DOUBLE",
        unit: "%",
      },
    ],
    datas: [{ 股票代码: "600519.SH", "销售额占比[20251231]": 10 }],
  };
  const entry = businessEvidence(
    source.symbol,
    2025,
    "customers",
    "q",
    [raw],
    now,
  );
  const dossier = buildFundamentalDossier(
    finance,
    source,
    [entry],
    "fundamental",
    undefined,
    now,
  );
  expect(dossier.evidence.some((e) => e.id === entry.id)).toBe(true);
  expect(dossier.missing).not.toContain("同年度前五大客户销售占比缺失");
  expect(dossier.missing).toContain("同年度主营构成缺失");
  expect(dossier.missing).toContain("证券及行业背景不完整");
  const changed = structuredClone(entry);
  changed.envelope!.reportPeriod = "20241231";
  expect(() =>
    buildFundamentalDossier(
      finance,
      source,
      [changed],
      "fundamental",
      undefined,
      now,
    ),
  ).toThrow(/经营资料/);
});
it("archives annual ownership evidence without treating it as complete governance or valuation inputs", () => {
  const { finance, source } = fixture();
  const raw = {
    status_code: 0,
    code_count: 1,
    datas: [
      {
        股票代码: "600519.SH",
        "总股本[20251231]": 1000,
        "持股比例[20251231]": 65,
      },
    ],
    columns: [
      {
        key: "总股本[20251231]",
        index_name: "总股本",
        type: "DOUBLE",
        unit: "股",
        timestamp: "20251231",
      },
      {
        key: "持股比例[20251231]",
        index_name: "前十大股东持股比例合计(报告期)",
        type: "DOUBLE",
        unit: "%",
        timestamp: "20251231",
      },
    ],
  };
  const evidence = ownershipEvidence(
    source.symbol,
    2025,
    "annual-capital",
    "q",
    raw,
    now,
  );
  const dossier = buildFundamentalDossier(
    finance,
    source,
    [evidence],
    "value",
    undefined,
    now,
  );
  expect(dossier.evidence.some((e) => e.id === evidence.id)).toBe(true);
  expect(dossier.missing).not.toContain("同年度股权集中度与总股本缺失");
  expect(dossier.missing).toContain("控股股东与实控人资料缺失");
  expect(dossier.formalValuationEligible).toBe(false);
  const changed = structuredClone(evidence),
    payload = JSON.parse(changed.text);
  payload.facts.totalShares = 2000;
  changed.text = JSON.stringify(payload);
  changed.envelope!.payloadHash = hash(payload);
  changed.id = `ownership-${hash(payload)}`;
  expect(() =>
    buildFundamentalDossier(
      finance,
      source,
      [changed],
      "value",
      undefined,
      now,
    ),
  ).toThrow(/股权资料/);
});
it("includes forecast evidence while retaining aggregation and valuation gaps", () => {
  const { finance, source } = fixture();
  const raw = {
    status_code: 0,
    code_count: 1,
    datas: [{ 股票代码: "600519.SH", "每股收益中值[20261231]": 3 }],
    columns: [
      {
        key: "每股收益中值[20261231]",
        index_name: "预测每股收益中值(虚拟表)",
        type: "DOUBLE",
        unit: "元",
        timestamp: "20261231",
      },
    ],
  };
  const entry = forecastEvidence(source.symbol, 2026, "q", raw, now);
  const dossier = buildFundamentalDossier(
    finance,
    source,
    [entry],
    "fundamental",
    undefined,
    now,
  );
  expect(dossier.missing).not.toContain("未来三年盈利预测资料缺失");
  expect(dossier.missing).toContain(
    "盈利预测聚合更新时点、机构名单、币种及利润/EPS口径尚未核验",
  );
  expect(dossier.formalValuationEligible).toBe(false);
  const changed = structuredClone(entry),
    p = JSON.parse(changed.text);
  p.annual[0].epsMedian = 999;
  changed.text = JSON.stringify(p);
  changed.envelope!.payloadHash = hash(p);
  changed.id = `forecast-${hash(p)}`;
  expect(() =>
    buildFundamentalDossier(
      finance,
      source,
      [changed],
      "fundamental",
      undefined,
      now,
    ),
  ).toThrow(/盈利预测/);
});
it("accepts verified global macro evidence without changing valuation assumptions", () => {
  const { finance, source } = fixture();
  const raw = {
    status_code: 0,
    code_count: 1,
    datas: [
      {
        国家: "中国",
        时间: "20260908",
        指标: "十年期国债即期收益率",
        指标值: 1.6798,
        周期: "日",
        macro_id: "M005959895",
        macro_name: "国债收益率:10年",
        单位: "%",
        地区级别: ["国家"],
      },
    ],
    columns: [
      { key: "时间", type: "DATE", index_name: "宏观@交易日期" },
      { key: "指标值", type: "DOUBLE", index_name: "宏观@经济核算值" },
      { key: "单位", type: "STR", index_name: "宏观@单位" },
    ],
  };
  const entry = macroEvidence("bond-10y", "q", raw, now);
  const dossier = buildFundamentalDossier(
    finance,
    source,
    [entry],
    "guo",
    undefined,
    now,
  );
  expect(dossier.evidence.some((e) => e.id === entry.id)).toBe(true);
  expect(dossier.scenario).toBeNull();
  expect(dossier.formalValuationEligible).toBe(false);
  expect(dossier.missing).not.toContain("中国十年期国债即期收益率资料缺失");
  expect(dossier.missing).toContain("中国年度GDP同比资料缺失");
  const changed = structuredClone(entry),
    p = JSON.parse(changed.text);
  p.facts.rateFraction = 0.5;
  changed.text = JSON.stringify(p);
  changed.envelope!.payloadHash = hash(p);
  changed.id = `macro-${hash(p)}`;
  expect(() =>
    buildFundamentalDossier(finance, source, [changed], "guo", undefined, now),
  ).toThrow(/宏观资料/);
});
it("cross-checks solvency assets and equity against the selected immutable financial archive", () => {
  const { finance, source } = fixture(),
    assets = finance.facts.annual.at(-1)!.amounts.assets.value!,
    equity = finance.facts.annual.at(-1)!.amounts.equity.value!;
  const raw = {
    status_code: 0,
    code_count: 1,
    datas: [
      {
        股票代码: "600519.SH",
        "总资产[20251231]": assets,
        "负债[20251231]": assets - equity,
        "所有者权益[20251231]": equity,
      },
    ],
    columns: [
      {
        key: "总资产[20251231]",
        index_name: "资产总计",
        unit: "元",
        type: "DOUBLE",
        timestamp: "20251231",
      },
      {
        key: "负债[20251231]",
        index_name: "负债合计",
        unit: "元",
        type: "DOUBLE",
        timestamp: "20251231",
      },
      {
        key: "所有者权益[20251231]",
        index_name: "所有者权益合计",
        unit: "元",
        type: "DOUBLE",
        timestamp: "20251231",
      },
    ],
  };
  const entry = solvencyEvidence(source.symbol, 2025, "balance", "q", raw, now);
  const dossier = buildFundamentalDossier(
    finance,
    source,
    [entry],
    "fundamental",
    undefined,
    now,
  );
  expect(dossier.missing).not.toContain("资产负债等式及负债率资料缺失");
  expect(dossier.formalValuationEligible).toBe(false);
  raw.datas[0]!["总资产[20251231]"] += 10;
  raw.datas[0]!["负债[20251231]"] += 10;
  const restated = solvencyEvidence(
    source.symbol,
    2025,
    "balance",
    "q",
    raw,
    now,
  );
  expect(() =>
    buildFundamentalDossier(
      finance,
      source,
      [restated],
      "fundamental",
      undefined,
      now,
    ),
  ).toThrow(/重新获取/);
  const changed = structuredClone(entry),
    p = JSON.parse(changed.text);
  p.facts.debtToAssets = 0.01;
  changed.text = JSON.stringify(p);
  changed.envelope!.payloadHash = hash(p);
  changed.id = `solvency-${hash(p)}`;
  expect(() =>
    buildFundamentalDossier(
      finance,
      source,
      [changed],
      "fundamental",
      undefined,
      now,
    ),
  ).toThrow(/偿债资料/);
});
it("revalidates capital events and never upgrades an empty response to a no-issuance point", () => {
  const { finance, source } = fixture(),
    original = JSON.stringify(finance);
  const raw = {
    status_code: 0,
    code_count: 1,
    row_count: 1,
    datas: [{ 股票代码: "600519.SH" }],
    columns: [
      { key: "预案公告日", index_name: "增发预案日", type: "DATE", unit: "" },
      { key: "进度", index_name: "增发进度", type: "STR", unit: "" },
      { key: "发行数量", index_name: "增发发行数量", type: "LONG", unit: "股" },
      { key: "上市日", index_name: "增发上市日", type: "DATE", unit: "" },
      {
        key: "最新公告日",
        index_name: "增发最新公告日期",
        type: "DATE",
        unit: "",
      },
    ],
  };
  const entry = capitalEventsEvidence(
    source.symbol,
    2025,
    "placement",
    "q",
    [raw],
    now,
  );
  const build = (e = entry) =>
    buildFundamentalDossier(finance, source, [e], "value", undefined, now);
  expect(
    build().finance.facts.fScore.items.find(
      (i) => i.id === "no-equity-offering",
    )?.point,
  ).toBeNull();
  expect(build().missing).not.toContain("增发事件资料缺失");
  expect(build().missing).toContain("配股事件资料缺失");
  expect(JSON.stringify(finance)).toBe(original);
  const changed = structuredClone(entry),
    p = JSON.parse(changed.text);
  p.facts.noEquityOffering = true;
  p.facts.absenceVerified = true;
  changed.text = JSON.stringify(p);
  changed.envelope!.payloadHash = hash(p);
  changed.id = `capital-events-${hash(p)}`;
  expect(() => build(changed)).toThrow(/资本事件/);
  expect(() =>
    build(
      capitalEventsEvidence(source.symbol, 2024, "placement", "q", [raw], now),
    ),
  ).toThrow(/年度/);
});
it("revalidates income scope, preserves conflicting archives and exposes only recomputed reconciliation citations", async () => {
  const { finance, source } = fixture(),
    original = JSON.stringify(finance);
  const raw = {
    status_code: 0,
    code_count: 1,
    datas: [
      {
        股票代码: "600519.SH",
        "营业收入[20251231]": 120,
        "营业总收入[20251231]": 130,
        "利息收入[20251231]": 10,
      },
    ],
    columns: ["营业收入", "营业总收入", "利息收入"].map((label) => ({
      key: `${label}[20251231]`,
      index_name: label,
      timestamp: "20251231",
      type: "DOUBLE",
      unit: "元",
    })),
  };
  const entry = incomeScopeEvidence(source.symbol, 2025, "q", raw, now);
  const build = (e = entry) =>
    buildFundamentalDossier(finance, source, [e], "value", undefined, now);
  const dossier = build(),
    result = dossier.revenueReconciliation;
  expect(result.archiveRevenueMatches).toBe(true);
  expect(result.differenceMatchesInterest).toBe(true);
  expect(dossier.formalValuationEligible).toBe(false);
  const method = await valuationMethod("value");
  expect(
    fundamentalCitationRules(dossier, method).every((r) =>
      r.evidenceIds.includes(result.id),
    ),
  ).toBe(true);
  raw.datas[0]!["营业收入[20251231]"] = 121;
  expect(
    build(incomeScopeEvidence(source.symbol, 2025, "q", raw, now))
      .revenueReconciliation.archiveRevenueMatches,
  ).toBe(false);
  expect(JSON.stringify(finance)).toBe(original);
  const forged = structuredClone(entry),
    p = JSON.parse(forged.text);
  p.facts.amounts.totalRevenue = 999;
  forged.text = JSON.stringify(p);
  forged.envelope!.payloadHash = hash(p);
  forged.id = `income-scope-${hash(p)}`;
  expect(() => build(forged)).toThrow(/收入口径资料/);
});
it("indexes references losslessly without altering source payloads, calculations or literal alias-like text", async () => {
  const { finance, source } = fixture(),
    dossier = buildFundamentalDossier(
      finance,
      source,
      [],
      "fundamental",
      undefined,
      now,
    ),
    method = await valuationMethod("fundamental");
  dossier.missing.push("@e1", "@m1");
  const before = JSON.stringify(dossier),
    rules = fundamentalCitationRules(dossier, method),
    prepared = fundamentalPrompt(dossier, rules);
  const restore = (v: unknown): unknown =>
    typeof v === "string"
      ? (prepared.references[v] ?? v)
      : Array.isArray(v)
        ? v.map(restore)
        : v && typeof v === "object"
          ? Object.fromEntries(
              Object.entries(v).map(([k, value]) => [k, restore(value)]),
            )
          : v;
  const restored = restore(prepared.data) as Omit<
    typeof dossier,
    "evidence"
  > & {
    evidence: { id: string; envelope: unknown; payload: unknown }[];
  };
  expect(restored.finance.facts).toEqual(dossier.finance.facts);
  expect(restored.growth).toEqual(dossier.growth);
  expect(restored.missing).toEqual(dossier.missing);
  restored.evidence.forEach((entry, index) => {
    expect(entry.id).toBe(dossier.evidence[index]!.id);
    expect(entry.envelope).toEqual(dossier.evidence[index]!.envelope);
    expect(entry.payload).toEqual(JSON.parse(dossier.evidence[index]!.text));
  });
  expect(restore(prepared.rules)).toEqual(rules);
  expect(JSON.stringify(dossier)).toBe(before);
  expect(prepared.references["@e1"]).toBeUndefined();
  expect(prepared.references["@m1"]).toBeUndefined();
});
it("expands only citation fields and preserves original whitelist and type validation", async () => {
  const { finance, source } = fixture(),
    dossier = buildFundamentalDossier(
      finance,
      source,
      [],
      "fundamental",
      undefined,
      now,
    ),
    method = await valuationMethod("fundamental");
  const prepared = fundamentalPrompt(
      dossier,
      fundamentalCitationRules(dossier, method),
    ),
    schema = fundamentalReportSchema(dossier, method),
    value = reply(dossier, method);
  const alias = (id: string) =>
    Object.entries(prepared.references).find(
      ([, original]) => original === id,
    )![0];
  value.stages.forEach((stage) => {
    stage.citations = stage.citations.map(alias);
    stage.methodCitations = stage.methodCitations.map(alias);
  });
  value.summary = "@e1 is literal prose";
  const canonical = schema.parse(prepared.decodeReply(value));
  expect(canonical.stages[0]!.citations[0]).toBe(dossier.finance.id);
  expect(canonical.summary).toBe(value.summary);
  value.stages[0]!.citations = ["@unknown"];
  expect(() => schema.parse(prepared.decodeReply(value))).toThrow();
  value.stages[0]!.citations = [value.stages[0]!.methodCitations[0]!];
  expect(() => schema.parse(prepared.decodeReply(value))).toThrow();
  expect(() => schema.parse(prepared.decodeReply({ stages: "bad" }))).toThrow();
});
it("archives canonical IDs after the structured provider validates a short-reference reply", async () => {
  const { finance, source } = fixture(),
    dossier = buildFundamentalDossier(
      finance,
      source,
      [],
      "value",
      undefined,
      now,
    ),
    method = await valuationMethod("value");
  const prepared = fundamentalPrompt(
      dossier,
      fundamentalCitationRules(dossier, method),
    ),
    value = reply(dossier, method);
  const alias = (id: string) =>
    Object.entries(prepared.references).find(
      ([, original]) => original === id,
    )![0];
  value.stages.forEach((stage) => {
    stage.citations = stage.citations.map(alias);
    stage.methodCitations = stage.methodCitations.map(alias);
  });
  mocks.structured.mockImplementation(async (_prompt, schema) => ({
    data: schema.parse(value),
    tokens: 42,
  }));
  const report = await analyzeFundamental(
    dossier,
    "short reference verification",
    undefined,
    "codex:default",
  );
  expect(report.promptVersion).toBe("fundamental-review-prompt-3");
  expect(report.result.stages[0]!.citations).toEqual([dossier.finance.id]);
  expect(report.dossier).toEqual(dossier);
  expect(fundamentalReportSchema(dossier, method).parse(report.result)).toEqual(
    report.result,
  );
});
it("validates financial calculations and price content, rejecting historical or insufficient records", () => {
  const { finance, source } = fixture();
  const dossier = buildFundamentalDossier(
    finance,
    source,
    [],
    "fundamental",
    undefined,
    now,
  );
  expect(dossier.price.asOf).toBe("2026-09-08");
  expect(dossier.formalValuationEligible).toBe(false);
  expect(
    buildFundamentalDossier(
      finance,
      { ...source, bars: source.bars.map((bar) => ({ ...bar, close: 12 })) },
      [],
      "fundamental",
      undefined,
      now,
    ).id,
  ).not.toBe(dossier.id);
  const changed = structuredClone(finance);
  changed.facts.annual[2]!.ratios.roe.value = 999;
  changed.hash = hash({
    facts: changed.facts,
    evidence: changed.evidence,
    missingProfiles: changed.missingProfiles,
  });
  changed.id = `financial-quality-${changed.hash}`;
  expect(() =>
    buildFundamentalDossier(changed, source, [], "fundamental", undefined, now),
  ).toThrow("校验失败");
  expect(() =>
    fundamentalPrice({ ...source, historicalAsOf: "2026-09-08" }, now),
  ).toThrow("历史");
  expect(() =>
    fundamentalPrice(
      { ...source, bars: [{ ...source.bars[0]!, close: NaN }] },
      now,
    ),
  ).toThrow("数值");
  expect(() =>
    buildFundamentalDossier(
      fixture([2022, 2024, 2025]).finance,
      source,
      [],
      "value",
      undefined,
      now,
    ),
  ).toThrow("连续年度");
});
it.each(["fundamental", "guo", "value"] as const)(
  "requires the complete %s workflow and correct method/evidence citations",
  async (mode) => {
    const { finance, source } = fixture(),
      dossier = buildFundamentalDossier(
        finance,
        source,
        [],
        mode,
        undefined,
        now,
      ),
      method = await valuationMethod(mode),
      schema = fundamentalReportSchema(dossier, method),
      result = reply(dossier, method);
    expect(schema.safeParse(result).success).toBe(true);
    expect(result.stages).toHaveLength(
      mode === "fundamental" ? 5 : mode === "guo" ? 7 : 8,
    );
    expect(
      schema.safeParse({ ...result, stages: result.stages.slice(1) }).success,
    ).toBe(false);
    expect(
      schema.safeParse({
        ...result,
        stages: [...result.stages, result.stages[0]!],
      }).success,
    ).toBe(false);
    const bad = structuredClone(result);
    bad.stages[0]!.citations = ["fake-id"];
    expect(schema.safeParse(bad).success).toBe(false);
    const badMethod = structuredClone(result);
    badMethod.stages[0]!.methodCitations = ["fake-file"];
    expect(schema.safeParse(badMethod).success).toBe(false);
    expect(schema.safeParse({ ...result, overallScore: 90 }).success).toBe(
      false,
    );
    const index = fundamentalCitationRules(dossier, method).findIndex(
      (rule) => rule.mustBeMissing,
    );
    const unsupported = structuredClone(result);
    unsupported.stages[index]!.status = "hypothesis";
    expect(schema.safeParse(unsupported).success).toBe(false);
  },
);
it("keeps explicit valuation scenarios independent and rejects wrong methods or altered arithmetic", () => {
  const { finance, source } = fixture();
  const scenario = saveValuationScenario({
    symbol: "sh600519",
    title: "人工场景",
    scenarios: [
      {
        name: "基准",
        assumptions: {
          method: "fcff-wacc",
          cashFlowBasis: "fcff",
          currency: "CNY",
          amountUnit: "yuan",
          sharesUnit: "shares",
          totalShares: 10,
          growthRate: 0,
          discountRate: 0.1,
          terminalGrowthRate: 0,
          forecastYears: 5,
          baseFcff: 100,
          cashAndNonOperatingAssets: 0,
          debtValue: 0,
          minorityInterestValue: 0,
          otherClaimsValue: 0,
          assumptionNote: "人工假设",
        },
      },
    ],
  });
  expect(
    buildFundamentalDossier(finance, source, [], "fundamental", scenario, now)
      .scenario?.id,
  ).toBe(scenario.id);
  expect(() =>
    buildFundamentalDossier(finance, source, [], "guo", scenario, now),
  ).toThrow("方法不匹配");
  const changed = structuredClone(scenario);
  changed.scenarios[0]!.perShareValue = 999;
  expect(() =>
    buildFundamentalDossier(finance, source, [], "fundamental", changed, now),
  ).toThrow("内容校验");
});
it("caches by full method and data, and rejects corrupt cached reports without another model call", async () => {
  const { finance, source } = fixture(),
    dossier = buildFundamentalDossier(
      finance,
      source,
      [],
      "fundamental",
      undefined,
      now,
    ),
    method = await valuationMethod("fundamental");
  mocks.structured.mockResolvedValue({
    data: reply(dossier, method),
    tokens: 100,
  });
  const first = await analyzeFundamental(
    dossier,
    "核验",
    undefined,
    "codex:default",
  );
  expect(
    await analyzeFundamental(dossier, "核验", undefined, "codex:default"),
  ).toEqual(first);
  expect(mocks.structured).toHaveBeenCalledTimes(1);
  const prompt = mocks.structured.mock.calls[0]![0] as string;
  expect(prompt).toContain("不是完整估值结论");
  expect(prompt).toContain(method.documents[0]!.text);
  put("fundamental-report", first.id, {
    ...first,
    result: { ...first.result, overallScore: 100 },
  });
  await expect(
    analyzeFundamental(dossier, "核验", undefined, "codex:default"),
  ).rejects.toThrow("缓存校验");
  expect(mocks.structured).toHaveBeenCalledTimes(1);
});
it("freezes the selected model, deduplicates running jobs and returns only an archive reference", async () => {
  const { finance, source } = fixture();
  put("financial-quality", finance.id, finance);
  put("snapshot", source.id, source);
  put("settings", "settings", { llmProvider: "codex" });
  let release!: (value: []) => void;
  mocks.context.mockImplementation(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const dossier = buildFundamentalDossier(
      finance,
      source,
      [],
      "fundamental",
      undefined,
      Date.now(),
    ),
    method = await valuationMethod("fundamental");
  mocks.structured.mockResolvedValue({
    data: reply(dossier, method),
    tokens: 100,
  });
  const input = {
    financeId: finance.id,
    snapshotId: source.id,
    mode: "fundamental" as const,
    question: "核验",
  };
  const first = await caller.fundamentalAnalyze(input);
  expect((await caller.fundamentalAnalyze(input)).id).toBe(first.id);
  put("settings", "settings", { llmProvider: "claude" });
  release([]);
  await vi.waitFor(() => expect(get<Job>(first.id)?.status).toBe("completed"));
  expect(mocks.structured.mock.calls[0]![2]).toBe("codex:default");
  const result = get<Job>(first.id)!.result as { reportId: string };
  expect(Object.keys(result)).toEqual(["reportId"]);
  expect((await caller.fundamentalReport(result.reportId))?.model).toBe(
    "codex:default",
  );
  expect(await caller.fundamentalHistory()).toHaveLength(1);
});
it("does not archive late model replies after cancellation", async () => {
  const { finance, source } = fixture(),
    dossier = buildFundamentalDossier(
      finance,
      source,
      [],
      "value",
      undefined,
      now,
    ),
    method = await valuationMethod("value");
  let finish!: (value: unknown) => void;
  mocks.structured.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const controller = new AbortController();
  const pending = analyzeFundamental(
    dossier,
    "核验",
    controller.signal,
    "codex:default",
  );
  const rejected = expect(pending).rejects.toThrow();
  await vi.waitFor(() => expect(mocks.structured).toHaveBeenCalledTimes(1));
  controller.abort();
  finish({ data: reply(dossier, method), tokens: 1 });
  await rejected;
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(await caller.fundamentalHistory()).toEqual([]);
});
