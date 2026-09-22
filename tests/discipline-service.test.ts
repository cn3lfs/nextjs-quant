import { it, expect, vi, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import type { ParsedFill } from "../src/lib/delivery-import";
import {
  buildDisciplineSource,
  calculateDiscipline,
  type DisciplineSource,
} from "../src/server/portfolio/discipline-source";
import {
  startDiscipline,
  disciplineStatus,
  cancelDiscipline,
  exportDiscipline,
} from "../src/server/portfolio/discipline-service";
import { runDisciplineGrid } from "../src/lib/discipline-counterfactual";
import { researchUsage } from "../src/server/research/research-usage";
import * as usage from "../src/server/research/research-usage";
import { readTradeReviewSnapshot } from "../src/server/portfolio/trade-review-market";
import { fullLocalCalendarReference } from "../src/server/market/data-health";
import { readGbbq } from "../src/server/data-sources/tdx/tdx-gbbq";

import * as market from "../src/server/portfolio/trade-review-market";
import * as calendarSource from "../src/server/market/data-health";
import * as gbbqSource from "../src/server/data-sources/tdx/tdx-gbbq";

const mock = vi.hoisted(() => ({
  workers: [] as (EventEmitter & { terminate: ReturnType<typeof vi.fn> })[],
}));
vi.mock("node:worker_threads", async () => {
  const { EventEmitter } = await import("node:events");
  return {
    Worker: class extends EventEmitter {
      terminate = vi.fn(async () => 0);
      constructor() {
        super();
        mock.workers.push(this);
      }
    },
  };
});
const fill = (kind: "buy" | "sell", day: string): ParsedFill => ({
  kind,
  rowIndex: 0,
  tradeDate: day,
  tradeTime: null,
  code: "000001",
  symbol: "sz000001",
  instrument: "stock",
  name: null,
  price: 10,
  quantity: 100,
  amount: 1000,
  fees: { commission: 0, stampTax: 0, transferFee: 0, otherFee: 0, total: 0 },
  netAmount: kind === "buy" ? -1000 : 1000,
  balanceCash: null,
  balanceShares: null,
  orderId: null,
  dealId: null,
  businessFlag: null,
  summary: "",
  fingerprintSource: "",
  anomalies: [],
});
const source: DisciplineSource = {
  fills: [fill("buy", "2026-01-05"), fill("sell", "2026-01-06")],
  cashFlows: [],
  openingCash: 5000,
  stopCosts: { commissionBps: 0, minimumCommission: 0, sellTaxBps: 0 },
  tdxRoot: "fixture",
  calendar: ["2026-01-05", "2026-01-06"],
};
function dependencies(coverageEnd = "2026-01-06") {
  const reader = vi.fn<typeof readTradeReviewSnapshot>().mockResolvedValue({
    id: "f",
    symbol: "sz000001",
    period: "day",
    source: "tdx-local",
    dataRoot: "fixture",
    adjustment: "none",
    createdAt: 0,
    hash: "fixture-hash",
    bars: source.calendar.map((date) => ({
      date,
      open: 10,
      high: 10,
      low: 10,
      close: 10,
      volume: 100,
      amount: 1000,
    })),
  });
  const calendar = vi
    .fn<typeof fullLocalCalendarReference>()
    .mockResolvedValue({
      days: source.calendar,
      source: "fixture",
      hash: "calendar-hash",
      coverage: {
        start: source.calendar[0]!,
        end: source.calendar[1]!,
        count: 2,
      },
    });
  const gbbq = vi.fn<typeof readGbbq>().mockResolvedValue({
    path: "fixture/gbbq",
    modified: 0,
    events: new Map([
      ["sz000002", [{ date: coverageEnd, category: 1, name: "除权除息" }]],
    ]),
  });
  return {
    readGbbq: gbbq,
    readTradeReviewSnapshot: reader,
    fullLocalCalendarReference: calendar,
  };
}
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});
it("不同账户的合成 fixture 经 calculateDiscipline 自校验并产出全部网格", async () => {
  const deps = dependencies();
  vi.spyOn(market, "readTradeReviewSnapshot").mockImplementation(
    deps.readTradeReviewSnapshot,
  );
  vi.spyOn(calendarSource, "fullLocalCalendarReference").mockImplementation(
    deps.fullLocalCalendarReference,
  );
  vi.spyOn(gbbqSource, "readGbbq").mockImplementation(deps.readGbbq);
  // 300 股：买入 2100，卖出 2400，两笔费用各 3，净利润 294。
  const synthetic = {
    ...source,
    openingCash: 9000,
    fills: source.fills.map((f) => ({
      ...f,
      quantity: 300,
      price: f.kind === "buy" ? 7 : 8,
      amount: f.kind === "buy" ? 2100 : 2400,
      netAmount: f.kind === "buy" ? -2103 : 2397,
      fees: { ...f.fees, commission: 3, total: 3 },
    })),
  };
  const { result } = await calculateDiscipline(synthetic);
  expect(result.checks).toEqual({
    a: { count: 1, netProfit: 294, passed: true },
    b: { count: 1, netProfit: 294, passed: true },
  });
  expect(result.points).toHaveLength(20);
  expect(result.points.at(-1)!.netProfit).toBe(294);
});
it("GBBQ 覆盖不足在读取行情前停止；检查末笔成交而非仅有效回合", async () => {
  const deps = dependencies("2026-01-05");
  await expect(buildDisciplineSource(source, () => {}, deps)).rejects.toThrow(
    "整批不可用",
  );
  expect(deps.readTradeReviewSnapshot).not.toHaveBeenCalled();
  expect(deps.fullLocalCalendarReference).not.toHaveBeenCalled();
});
it("调用方传递 GBBQ 真值及截止日；证券缺价保留缺失原因", async () => {
  const deps = dependencies();
  deps.readTradeReviewSnapshot.mockRejectedValueOnce(new Error("无文件"));
  const r = await buildDisciplineSource(source, () => {}, deps);
  expect(r.input.coverageEnd).toBe("2026-01-06");
  expect(r.input.exRightsEvents).toEqual([
    { security: "sz000002", date: "2026-01-06" },
  ]);
  expect(r.input.bars).toEqual({});
  expect(r.warnings).toEqual(["sz000001：无文件；缺日线不判定止损"]);
});
it("后台完成只记一次 V5、candidateCount=20；翻页查询与导出不再记账；结果按时释放", async () => {
  vi.useFakeTimers();
  const evidence = await buildDisciplineSource(
    source,
    () => {},
    dependencies(),
  );
  const result = runDisciplineGrid(evidence.input);
  const before = researchUsage({
    start: "2026-01-05",
    end: "2026-01-06",
  }).candidateSum;
  const task = startDiscipline("fixture", source),
    worker = mock.workers.at(-1)!;
  expect(() => startDiscipline("other", source)).toThrow("已有");
  worker.emit("message", { type: "progress", phase: "读取日线 1/1" });
  expect(disciplineStatus(task.id).phase).toBe("读取日线 1/1");
  worker.emit("message", { type: "complete", value: { result, evidence } });
  worker.emit("message", { type: "complete", value: { result, evidence } });
  expect(disciplineStatus(task.id).usageRecorded).toBe(true);
  expect(disciplineStatus(task.id).result!.points).toHaveLength(20);
  expect(disciplineStatus(task.id).result!.points[0]).not.toHaveProperty("nav");
  expect(JSON.parse(exportDiscipline(task.id)).result.points[0]).toHaveProperty(
    "nav",
  );
  expect(JSON.parse(exportDiscipline(task.id)).evidence.input).toEqual(
    evidence.input,
  );
  expect(
    researchUsage({ start: "2026-01-05", end: "2026-01-06" }).candidateSum -
      before,
  ).toBe(20);
  expect(worker.terminate).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(15 * 60000);
  expect(() => disciplineStatus(task.id)).toThrow("过期");
});
it("取消终止 worker，不记账、不保留隐式结果；失败可见且可重试", () => {
  const record = vi.spyOn(usage, "recordResearchUsage");
  const task = startDiscipline("fixture", source),
    worker = mock.workers.at(-1)!;
  cancelDiscipline(task.id);
  worker.emit("message", { type: "complete", value: {} });
  expect(worker.terminate).toHaveBeenCalledTimes(1);
  expect(record).not.toHaveBeenCalled();
  expect(() => exportDiscipline(task.id)).toThrow();
  const retry = startDiscipline("fixture", source);
  mock.workers.at(-1)!.emit("message", { type: "failed", error: "基线不符" });
  expect(disciplineStatus(retry.id)).toMatchObject({
    status: "failed",
    error: "基线不符",
    result: null,
  });
});
it("V5 写入失败保留全报告并明确未记录，worker 异常与超时释放任务", async () => {
  vi.useFakeTimers();
  const evidence = await buildDisciplineSource(
      source,
      () => {},
      dependencies(),
    ),
    result = runDisciplineGrid(evidence.input);
  vi.spyOn(usage, "recordResearchUsage").mockReturnValue(null);
  const task = startDiscipline("fixture", source);
  mock.workers
    .at(-1)!
    .emit("message", { type: "complete", value: { result, evidence } });
  expect(disciplineStatus(task.id)).toMatchObject({
    status: "complete",
    usageRecorded: false,
  });
  const failed = startDiscipline("fixture", source);
  mock.workers.at(-1)!.emit("error", new Error("worker坏了"));
  expect(disciplineStatus(failed.id).error).toBe("worker坏了");
  const timed = startDiscipline("fixture", source);
  await vi.advanceTimersByTimeAsync(10 * 60000);
  expect(disciplineStatus(timed.id)).toMatchObject({
    status: "failed",
    error: "计算超过 10 分钟，已停止，可重试",
  });
  await vi.advanceTimersByTimeAsync(15 * 60000);
});
