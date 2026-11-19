import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const mocks = vi.hoisted(() => {
  const row = (symbol: string) => ({
    symbol,
    name: symbol,
    price: 1,
    changePct: 10,
    amount: null,
    floatCap: null,
    turnover: null,
    industry: "",
    streak: 1,
    firstSeal: null,
    lastSeal: null,
    sealFund: null,
    breaks: null,
    limitPrice: null,
    stat: null,
  });
  return {
    row,
    fetchLimitPool: vi.fn(),
    pools: {} as Record<string, ReturnType<typeof row>[]>,
  };
});

vi.mock("../../src/server/data-sources/eastmoney/em-limit-pool", () => ({
  fetchLimitPool: mocks.fetchLimitPool,
}));

/** 北京时间 → epoch 毫秒；UTC 偏移由 Date.UTC 自动跨日。 */
function atBeijing(date: string, hour: number, minute: number, second = 0) {
  const [year, month, day] = date.split("-").map(Number);
  return Date.UTC(year!, month! - 1, day!, hour - 8, minute, second);
}

let nowSpy: ReturnType<typeof vi.spyOn>;
const setNow = (epoch: number) => nowSpy.mockReturnValue(epoch);
const roots: string[] = [];

beforeEach(() => {
  nowSpy = vi.spyOn(Date, "now");
  mocks.pools = {
    zt: [mocks.row("sz000001"), mocks.row("sh600519"), mocks.row("sh600000")],
    zb: [],
    dt: [],
    yzt: [],
  };
  mocks.fetchLimitPool.mockReset();
  mocks.fetchLimitPool.mockImplementation(
    async (kind: string) => mocks.pools[kind] ?? null,
  );
});

afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0))
    await rm(root, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    });
});

async function fixture(
  infoharbor = [
    "#GN_CONCEPT_A,2,880001,20200101,20260910,,",
    "0#000001,1#600519,",
    "#GN_CONCEPT_B,2,880002,20200101,20260910,,",
    "1#600519,1#600000,",
  ].join("\n"),
) {
  const root = await mkdtemp(join(tmpdir(), "limit-concepts-"));
  roots.push(root);
  const cache = join(root, "T0002", "hq_cache");
  await cp("tests/fixtures/tdx-local-blocks", cache, { recursive: true });
  await writeFile(join(cache, "infoharbor_block.dat"), infoharbor);
  await writeFile(
    join(cache, "tdxzs.cfg"),
    "CONCEPT_A_FULL|880001|4|1|0|样本\nCONCEPT_B_FULL|880002|4|1|0|样本",
  );
  return root;
}

/** 用真实 limitSentiment 填充本进程已确认四池，再读取概念交集。 */
async function confirmed(date: string) {
  const { limitSentiment } =
    await import("../../src/server/market/limit-sentiment");
  return limitSentiment(date);
}

it("只把已确认涨停池与本机概念名单取交集，并去重统计映射证券", async () => {
  setNow(atBeijing("2026-11-20", 10, 0, 10));
  const root = await fixture();
  const sentiment = await confirmed("2026-11-20");
  const callsAfterPools = mocks.fetchLimitPool.mock.calls.length;
  const { limitConcepts } =
    await import("../../src/server/market/limit-sentiment");
  const result = await limitConcepts(
    { date: "2026-11-20", fetchedAt: sentiment.fetchedAt },
    root,
  );
  expect(result).toMatchObject({
    date: "2026-11-20",
    status: "ready",
    poolFetchedAt: sentiment.fetchedAt,
    limitUp: 3,
    mapped: 3,
    uncovered: 0,
  });
  expect(result.blocksObservedAt).toBeGreaterThan(0);
  // 同一证券可属于多个概念，概念计数会重叠；映射证券数去重。
  expect(result.concepts).toEqual([
    {
      code: "880001",
      name: "CONCEPT_A_FULL",
      symbols: ["sz000001", "sh600519"],
    },
    {
      code: "880002",
      name: "CONCEPT_B_FULL",
      symbols: ["sh600519", "sh600000"],
    },
  ]);
  // 概念读取只读本机名单，不触发上游四池。
  expect(mocks.fetchLimitPool.mock.calls.length).toBe(callsAfterPools);
});

it("确认集按 symbol 去重后再算涨停家数与每组人数", async () => {
  setNow(atBeijing("2026-11-30", 10, 0, 10));
  const root = await fixture();
  // 上游重复行不能让涨停家数或概念人数重复计算。
  mocks.pools.zt = [
    mocks.row("sh600519"),
    mocks.row("sh600519"),
    mocks.row("sz000001"),
  ];
  const sentiment = await confirmed("2026-11-30");
  const { limitConcepts } =
    await import("../../src/server/market/limit-sentiment");
  const result = await limitConcepts(
    { date: "2026-11-30", fetchedAt: sentiment.fetchedAt },
    root,
  );
  expect(result).toMatchObject({
    status: "ready",
    limitUp: 2,
    mapped: 2,
    uncovered: 0,
  });
  expect(result.concepts).toEqual([
    {
      code: "880001",
      name: "CONCEPT_A_FULL",
      symbols: ["sh600519", "sz000001"],
    },
    {
      code: "880002",
      name: "CONCEPT_B_FULL",
      symbols: ["sh600519"],
    },
  ]);
});

it("名单存在但没有命中时保留真实零覆盖，不当作缺快照", async () => {
  setNow(atBeijing("2026-11-23", 10, 0, 10));
  const root = await fixture();
  mocks.pools.zt = [mocks.row("sh600001")];
  const sentiment = await confirmed("2026-11-23");
  const { limitConcepts } =
    await import("../../src/server/market/limit-sentiment");
  const result = await limitConcepts(
    { date: "2026-11-23", fetchedAt: sentiment.fetchedAt },
    root,
  );
  expect(result).toMatchObject({
    status: "ready",
    limitUp: 1,
    mapped: 0,
    uncovered: 1,
    concepts: [],
  });
});

it("涨停池为空时仍区分真实零与缺快照", async () => {
  setNow(atBeijing("2026-11-24", 10, 0, 10));
  const root = await fixture();
  mocks.pools.zt = [];
  const sentiment = await confirmed("2026-11-24");
  const { limitConcepts } =
    await import("../../src/server/market/limit-sentiment");
  const empty = await limitConcepts(
    { date: "2026-11-24", fetchedAt: sentiment.fetchedAt },
    root,
  );
  expect(empty).toMatchObject({
    status: "ready",
    limitUp: 0,
    mapped: 0,
    uncovered: 0,
    concepts: [],
  });

  const noSnapshot = await fixture("#ZS_INDEX_ONLY,0,,20240923,,,");
  const missing = await limitConcepts(
    { date: "2026-11-24", fetchedAt: sentiment.fetchedAt },
    noSnapshot,
  );
  expect(missing).toMatchObject({
    status: "snapshot-missing",
    limitUp: 0,
    mapped: null,
    uncovered: null,
    concepts: [],
  });
  expect(missing.blocksObservedAt).toBeGreaterThan(0);
});

it("概念成员全为空按缺快照处理", async () => {
  setNow(atBeijing("2026-11-25", 10, 0, 10));
  const root = await fixture("#GN_CONCEPT_A,0,880001,20200101,20260910,,");
  const sentiment = await confirmed("2026-11-25");
  const { limitConcepts } =
    await import("../../src/server/market/limit-sentiment");
  const result = await limitConcepts(
    { date: "2026-11-25", fetchedAt: sentiment.fetchedAt },
    root,
  );
  expect(result).toMatchObject({
    status: "snapshot-missing",
    limitUp: 3,
    mapped: null,
    uncovered: null,
  });
});

it("fetchedAt 不一致或四池不在本进程时要求重新同步", async () => {
  setNow(atBeijing("2026-11-26", 10, 0, 10));
  const sentiment = await confirmed("2026-11-26");
  const { limitConcepts } =
    await import("../../src/server/market/limit-sentiment");
  const root = await fixture();
  const stale = await limitConcepts(
    { date: "2026-11-26", fetchedAt: sentiment.fetchedAt + 1 },
    root,
  );
  expect(stale).toMatchObject({
    status: "sync-required",
    poolFetchedAt: null,
    limitUp: 0,
    mapped: null,
    uncovered: null,
  });
  // 历史日期不提供概念分布，沿用按日与行业行为。
  const historical = await limitConcepts(
    { date: "2026-11-19", fetchedAt: sentiment.fetchedAt },
    root,
  );
  expect(historical.status).toBe("unsupported-day");
});

it("未配置目录与名单损坏分别返回明确状态", async () => {
  setNow(atBeijing("2026-11-27", 10, 0, 10));
  const sentiment = await confirmed("2026-11-27");
  const { limitConcepts } =
    await import("../../src/server/market/limit-sentiment");
  const unconfigured = await limitConcepts(
    { date: "2026-11-27", fetchedAt: sentiment.fetchedAt },
    "",
  );
  expect(unconfigured).toMatchObject({
    status: "source-unconfigured",
    limitUp: 3,
    mapped: null,
  });

  const root = await fixture();
  await writeFile(join(root, "T0002", "hq_cache", "infoharbor_block.dat"), "x");
  const broken = await limitConcepts(
    { date: "2026-11-27", fetchedAt: sentiment.fetchedAt },
    root,
  );
  expect(broken.status).toBe("source-unavailable");
  expect(broken.message).toContain("概念名单不可用");
});
