import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  tmtCrowding,
  swIndustries,
  tmtCodes,
  type TmtInput,
} from "~/server/strategies/sentiment/tmt-crowding";
import {
  parseTmtCsv,
  tmtCsvInput,
  readTmtCache,
  tmtCandidateEvidence,
  tmtUsedMethods,
} from "~/server/strategies/sentiment/tmt-cache";
import { contextEvidence } from "~/server/data-sources/hithink/hithink-context";
import type { Snapshot } from "~/lib/domain";
import { get } from "~/server/db";
vi.mock("../../src/server/data-sources/sse/sse-margin", async (original) => ({
  ...(await original<
    typeof import("../../src/server/data-sources/sse/sse-margin")
  >()),
  querySseMargin: vi.fn().mockRejectedValue(new Error("offline test")),
}));

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});
function fixture(): TmtInput {
  const input: TmtInput = {
    cutoff: "2026-09-08",
    maxAgeDays: 7,
    amount: [],
    daily: [],
    margin: [],
  };
  for (let i = 0; i < 64; i++) {
    const date = new Date(Date.UTC(2026, 6, 7 + i)).toISOString().slice(0, 10);
    Object.entries(swIndustries).forEach(([code, name], index) => {
      input.amount.push({ date, code, amount: 10, close: (index + 1) * 100 });
      input.daily.push({
        date,
        code,
        name,
        capital: 100,
        turnover: 1,
        pe: 10,
        pb: 1,
      });
    });
    input.margin.push({ date, balance: 100 });
  }
  return input;
}
function csv(input: TmtInput) {
  return {
    amount:
      "日期,收盘,成交额,代码\n" +
      input.amount
        .map((r) => [r.date, r.close ?? "", r.amount ?? "", r.code].join(","))
        .join("\n"),
    daily:
      "指数代码,指数名称,发布日期,换手率,市盈率,市净率,流通市值\n" +
      input.daily
        .map((r) =>
          [
            r.code,
            r.name,
            r.date,
            r.turnover ?? "",
            r.pe ?? "",
            r.pb ?? "",
            r.capital ?? "",
          ].join(","),
        )
        .join("\n"),
    margin:
      "信用交易日期,融资余额\n" +
      input.margin
        .map((r) => [r.date.replaceAll("-", ""), r.balance ?? ""].join(","))
        .join("\n"),
  };
}
it("computes weighted five dimensions and discloses empirical ties and actual sample windows", () => {
  const facts = tmtCrowding(fixture());
  // Inclusive empirical CDF: constant sample is percentile 100, not fabricated growth.
  // A/B/D/E=100; financing C=.6*100+.4*0=60 => 92.
  expect(facts.score).toBeCloseTo(92, 12);
  expect(facts.factors.map((f) => f.value)).toEqual([100, 100, 60, 100, 100]);
  expect(facts.metrics.concentration.current).toBeCloseTo((4 / 31) * 100);
  expect(facts.metrics.momentum.current).toBe(0);
  expect(facts.metrics.momentum.observations).toBe(4);
  expect(facts.marginGrowth60).toBe(0);
  expect(facts.breakdown[0]).toMatchObject({
    industry: "电子",
    pe: 10,
    peAsOf: "2026-09-08",
  });
});
it("missing financing is excluded and remaining weights renormalize without neutral 50", () => {
  const input = fixture();
  input.margin = [];
  const facts = tmtCrowding(input);
  expect(facts.score).toBe(100);
  expect(facts.used).toBe(4);
  expect(facts.factors[2]!.value).toBeNull();
  expect(facts.factors.map((f) => f.effectiveWeight)).toEqual([
    0.25 / 0.8,
    0.2 / 0.8,
    0,
    0.2 / 0.8,
    0.15 / 0.8,
  ]);
});
it("does not form concentration from fewer than 31 sectors and keeps true source dates", () => {
  const input = fixture();
  input.amount = input.amount.filter(
    (r) => !(r.date === input.cutoff && r.code === "801010"),
  );
  const facts = tmtCrowding(input);
  expect(facts.metrics.concentration.asOf).toBe("2026-09-07");
  expect(facts.coverage.completeAmountDates).toBe(63);
  expect(facts.breakdown.every((r) => r.date === "2026-09-07")).toBe(true);
});
it("uses component returns equally, independent of arbitrary index base levels", () => {
  const input = fixture();
  for (const r of input.amount)
    if (r.date === input.cutoff && r.code === tmtCodes[0]) r.close! *= 2;
  const facts = tmtCrowding(input);
  expect(facts.metrics.momentum.current).toBeCloseTo(25);
  const changed = structuredClone(input);
  for (const r of changed.amount) if (r.code === tmtCodes[0]) r.close! *= 100;
  expect(tmtCrowding(changed).metrics.momentum).toEqual(facts.metrics.momentum);
});
it("excludes missing component windows instead of filling close prices", () => {
  const input = fixture();
  input.amount.find(
    (r) => r.date === "2026-08-01" && r.code === tmtCodes[0],
  )!.close = null;
  expect(tmtCrowding(input).metrics.momentum.value).toBeNull();
});
it("capital-weights turnover and valuations, excludes nonpositive PE and preserves zero turnover", () => {
  const input = fixture();
  for (const r of input.daily)
    if (r.date === input.cutoff && r.code === tmtCodes[0]) {
      r.capital = 300;
      r.turnover = 3;
      r.pe = 30;
    }
  let facts = tmtCrowding(input);
  expect(facts.metrics.turnover.current).toBeCloseTo(2);
  expect(facts.metrics.pe.current).toBeCloseTo(20);
  for (const r of input.daily)
    if (r.date === input.cutoff) {
      r.turnover = 0;
      if (r.code === tmtCodes[0]) r.pe = -10;
    }
  facts = tmtCrowding(input);
  expect(facts.metrics.turnover.current).toBe(0);
  expect(facts.metrics.relativeTurnover.asOf).toBe("2026-09-07");
  expect(facts.metrics.pe.asOf).toBe("2026-09-07");
  expect(facts.factors[1]!.value).toBeNull();
  expect(facts.factors[3]!.value).toBeNull();
});
it("rejects duplicates, wrong industry identity and malformed dates/numbers", () => {
  const input = fixture();
  input.amount.push({ ...input.amount[0]! });
  expect(() => tmtCrowding(input)).toThrow("重复");
  input.amount.pop();
  input.daily[0]!.name = "电子";
  expect(() => tmtCrowding(input)).toThrow("名称不匹配");
  input.daily[0]!.name = "农林牧渔";
  input.margin.push({ ...input.margin[0]! });
  expect(() => tmtCrowding(input)).toThrow("日期重复");
  input.margin.pop();
  input.amount[0]!.date = "2026-02-30";
  expect(() => tmtCrowding(input)).toThrow();
});
it("cuts off future records, gives no current score for old data, and requires at least two observations", () => {
  const input = fixture(),
    baseline = tmtCrowding(input);
  input.margin.push({ date: "2026-09-09", balance: 100000 });
  expect(tmtCrowding(input)).toEqual(baseline);
  input.cutoff = "2026-10-01";
  const stale = tmtCrowding(input);
  expect(stale.score).toBeNull();
  expect(stale.used).toBe(0);
  const one = fixture();
  one.cutoff = "2026-07-07";
  expect(tmtCrowding(one).score).toBeNull();
});
it("CSV parsing handles BOM, quoted separators and escaped quotes and rejects ambiguous structure", () => {
  expect(parseTmtCsv('\uFEFFa,b\r\n"x,y","a""b"\r\n')).toEqual([
    { a: "x,y", b: 'a"b' },
  ]);
  for (const text of ["a,a\n1,2", "a,b\n1", 'a,b\n"x,2', 'a,b\n"x"z,2'])
    expect(() => parseTmtCsv(text)).toThrow();
  const input = fixture(),
    texts = csv(input);
  expect(tmtCsvInput(texts, input.cutoff)).toEqual(input);
  const duplicate = texts.daily + "\n" + texts.daily.split("\n")[1]!;
  expect(tmtCsvInput({ ...texts, daily: duplicate }, input.cutoff)).toEqual(
    input,
  );
  const conflict = duplicate.replace(/100$/, "101");
  expect(() =>
    tmtCsvInput({ ...texts, daily: conflict }, input.cutoff),
  ).toThrow("字段冲突");
  expect(() =>
    tmtCsvInput(
      { ...texts, amount: "日期,收盘,成交额,代码\n2026-09-08,1,=1+2,801010" },
      input.cutoff,
    ),
  ).toThrow("数值格式");
});
it("archives source text, reuses unchanged cache and invalidates after a source revision", async () => {
  const root = await mkdtemp(join(tmpdir(), "tmt-cache-test-"));
  vi.stubEnv("QUANT_DATA_DIR", await mkdtemp(join(tmpdir(), "quant-tmt-db-")));
  const texts = csv(fixture());
  for (const [file, text] of [
    ["amount.csv", texts.amount],
    ["sw_daily.csv", texts.daily],
    ["margin_sse.csv", texts.margin],
  ])
    await writeFile(join(root, file!), text!);
  const first = await readTmtCache(root, "2026-09-08"),
    again = await readTmtCache(root, "2026-09-08");
  expect(again).toBe(first);
  expect(get<{ text: string }>(first.sources[0]!.archiveId)!.text).toBe(
    texts.amount,
  );
  await writeFile(
    join(root, "margin_sse.csv"),
    texts.margin.replace(/100$/, "200"),
  );
  const changed = await readTmtCache(root, "2026-09-08");
  expect(changed.sources[2]!.hash).not.toBe(first.sources[2]!.hash);
  expect(changed.facts.marginGrowth60).toBe(100);
});
it("only attaches current TMT backgrounds to verified A-stock industry; historical and other industries get none", async () => {
  const now = Date.parse("2026-09-09T10:00:00+08:00");
  vi.spyOn(Date, "now").mockReturnValue(now);
  const root = await mkdtemp(join(tmpdir(), "tmt-association-test-")),
    skills = join(root, "skills"),
    data = join(root, "data");
  vi.stubEnv("QUANT_SKILLS_DIR", skills);
  vi.stubEnv("TMT_CROWDING_DATA_DIR", data);
  vi.stubEnv("QUANT_DATA_DIR", join(root, "db"));
  await mkdir(join(skills, "tmt-crowding", "scripts"), { recursive: true });
  await mkdir(data);
  await writeFile(join(skills, "tmt-crowding", "SKILL.md"), "fixture method");
  await writeFile(
    join(skills, "tmt-crowding", "scripts", "tmt_crowding.py"),
    "reference only",
  );
  const texts = csv(fixture());
  for (const [file, text] of [
    ["amount.csv", texts.amount],
    ["sw_daily.csv", texts.daily],
    ["margin_sse.csv", texts.margin],
  ])
    await writeFile(join(data, file!), text!);
  const source = {
    symbol: "sz000001",
    period: "day",
    bars: [{ date: "2026-09-08" }],
  } as Snapshot;
  const identity = (industry: string) =>
    contextEvidence(source.symbol, "hithink-basicinfo-query", "fixture", {
      status_code: 0,
      columns: [],
      datas: [{ 股票代码: "000001.SZ", 所属申万一级行业: industry }],
    });
  // Test identity is synthetic, not a claim about the real company's industry.
  expect(await tmtCandidateEvidence(source, [identity("银行")])).toEqual([]);
  expect(await tmtCandidateEvidence(source, [])).toEqual([]);
  expect(
    await tmtCandidateEvidence({ ...source, historicalAsOf: "2026-09-08" }, [
      identity("电子"),
    ]),
  ).toEqual([]);
  const result = await tmtCandidateEvidence(source, [identity("电子")]);
  expect(result).toHaveLength(2);
  expect(JSON.parse(result[1]!.text).backgroundId).toBe(result[0]!.id);
  expect(JSON.parse(result[0]!.text).facts.used).toBe(5);
  expect(tmtUsedMethods(result)[0]).toMatchObject({
    skillId: "tmt-crowding",
    ruleVersion: "tmt-crowding-1",
  });
  const tampered = structuredClone(result);
  tampered[0]!.text += " ";
  expect(() => tmtUsedMethods(tampered)).toThrow("哈希");
  const altered = identity("电子");
  altered.text = altered.text.replace("电子", "通信");
  expect(await tmtCandidateEvidence(source, [altered])).toEqual([]);
  vi.spyOn(Date, "now").mockReturnValue(
    Date.parse("2026-10-01T10:00:00+08:00"),
  );
  const old = await tmtCandidateEvidence(
    { ...source, bars: [{ ...source.bars[0]!, date: "2026-10-01" }] },
    [identity("电子")],
  );
  expect(old).toHaveLength(1);
  expect(old[0]!.text).toContain("过期");
  expect(old[0]!.envelope).toBeUndefined();
});
