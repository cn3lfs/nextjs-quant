import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  defaultStrategy,
  settingsSchema,
  strategySchema,
  type Channel,
  type Delivery,
  type Monitor,
  type Signal,
  type Snapshot,
} from "../src/lib/domain";
import type { CzscResult } from "../src/lib/czsc";
const mocks = vi.hoisted(() => ({
  worker: vi.fn(),
  engine: vi.fn(),
  calendar: vi.fn(),
  status: vi.fn(),
  background: vi.fn(),
  structured: vi.fn(),
  network: vi.fn(),
  secret: vi.fn(),
}));
// Fail closed at both HTTP surfaces. drain always receives a fake sender; no real
// credentials, MCP, news scheduler or LLM process is reachable in these cases.
vi.mock("undici", () => ({ fetch: mocks.network, ProxyAgent: class {} }));
vi.mock("../src/server/vault", () => ({
  readSecret: mocks.secret,
  saveSecret: vi.fn(),
}));
vi.mock("../src/server/czsc", () => ({ analyzeCzsc: mocks.engine }));
vi.mock("../src/server/jobs", async (original) => ({
  ...(await original<typeof import("../src/server/jobs")>()),
  runWorker: mocks.worker,
  background: mocks.background,
}));
vi.mock("../src/server/research", async (original) => ({
  ...(await original<typeof import("../src/server/research")>()),
  structured: mocks.structured,
}));
vi.mock("../src/server/monitor-calendar", () => ({
  monitorCalendar: mocks.calendar,
}));
vi.mock("../src/server/security-trading-status", () => ({
  verifySecurityTradingStatus: mocks.status,
}));
vi.mock("../src/server/securities", () => ({
  securityDirectory: async () => ({ entries: {} }),
  securityLabel: (s: string) => s.toUpperCase(),
}));
vi.mock("../src/server/news-scheduler", () => ({ scheduleNews: vi.fn() }));
import { tick } from "../src/server/runtime";
import {
  drain,
  notificationRequest,
  SendError,
} from "../src/server/notifications";
import { get, list, put, sqlite } from "../src/server/db";
import { chanMethod } from "../src/server/chan-method";
import { analyzeCzscSignal } from "../src/server/czsc-signal-analysis";
import breakoutFixture from "./fixtures/breakout-valid.json";
process.env.QUANT_DATA_DIR = mkdtempSync(join(tmpdir(), "quant-m4-"));
const today = "2026-09-09";
const at = (time: string, date = today) =>
  Date.parse(`${date}T${time}:00+08:00`);
const center = {
  start: 0,
  end: 2,
  startDate: "2026-09-04",
  endDate: "2026-09-08",
  direction: 1,
  ZG: 11,
  ZD: 10,
  GG: 12,
  DD: 9,
};
function result(kinds: number[] = [], quality = 1): CzscResult {
  return {
    status: "structure",
    sourceCommit: "b67f3c6",
    hash: "c0ac4c5118585553081b649613d4d9f2ed494ddd34abd17d12a2f8964c95549a",
    families: [
      {
        config: 0,
        points: [],
        centers: [center],
        movements: [],
        qualities: [],
        divergences: [],
        signals: kinds.map((kind, index) => ({
          index,
          date: `2026-09-0${index + 1}`,
          kind,
          quality,
          centerId: 1,
          divergence: {
            areaRatio: 65,
            priceRatio: 80,
            speedRatio: 70,
            flags: 16,
            semantic: 1,
          },
        })),
      },
    ],
  };
}
function source(rising = true): Snapshot {
  return {
    id: "snapshot-m4",
    symbol: "sh600519",
    period: "day",
    source: "fixture-local",
    adjustment: "none",
    createdAt: Date.now(),
    hash: "fixture",
    bars: [
      "2026-09-01",
      "2026-09-02",
      "2026-09-03",
      "2026-09-04",
      "2026-09-07",
      "2026-09-08",
      today,
    ].map((date, i) => ({
      date,
      open: 10,
      high: 12,
      low: 9,
      close: i === 6 && rising ? 10.5 : 10,
      volume: 100,
      amount: 1000,
    })),
  };
}
const channelTypes = ["feishu", "wecom", "telegram", "discord"] as const;
const credentials = {
  feishu: { secret: "https://open.feishu.cn/open-apis/bot/v2/hook/fake-only" },
  wecom: {
    secret: "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=fake-only",
  },
  telegram: { secret: "123:fake-only" },
  discord: { secret: "https://discord.com/api/webhooks/123/fake-only" },
};
beforeEach(() => {
  vi.clearAllMocks();
  mocks.network.mockImplementation(() => {
    throw new Error("M4 forbids network delivery");
  });
  vi.stubGlobal("fetch", mocks.network);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(at("15:04"));
  sqlite().prepare("DELETE FROM records").run();
  const runtime = (
    globalThis as typeof globalThis & {
      quantRuntime: { lastTick: number; recovered: boolean };
    }
  ).quantRuntime;
  runtime.lastTick = 0;
  runtime.recovered = false;
  mocks.worker.mockResolvedValue(source());
  mocks.engine.mockResolvedValue(result());
  mocks.calendar.mockResolvedValue({
    days: [today, "2026-09-10"],
    source: "fixture-calendar",
    hash: "fixture",
  });
  mocks.status.mockImplementation(async () => ({
    version: "security-trading-status-1",
    symbol: "sh600519",
    status: "trading",
    asOf: new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10),
    fetchedAt: Date.now(),
    reason: "fixture",
    source: "fixture",
    evidence: { row: {}, columns: [] },
    evidenceHash: "fixture",
  }));
  put(
    "settings",
    "settings",
    // M4 verifies transport/content independently of P2's conservative defaults.
    // Keep every original assertion using explicitly permissive configurable tiers.
    settingsSchema.parse({
      autoAnalysis: false,
      autoNewsAnalysis: false,
      notificationPolicy: {
        czsc: { confirmed: "immediate" },
        breakout: { middle: "immediate" },
        quietOutsideTrading: false,
        dedupTradingDays: 0,
        dailyLimit: 100,
      },
    }),
  );
  const channels = channelTypes.map((type) => {
    const id = `fake-${type}-${crypto.randomUUID()}`;
    put<Channel>("channel", id, {
      id,
      name: `受控假渠道 ${type}`,
      type,
      enabled: true,
      configured: true,
      target: "fake-only",
      thread: "",
    });
    return id;
  });
  put<Monitor>("monitor", "monitor-m4", {
    id: "monitor-m4",
    name: "M4",
    symbols: ["sh600519"],
    strategy: strategySchema.parse({ type: "czsc", params: {} }),
    period: "day",
    source: "local",
    channels,
    ai: true,
    enabled: true,
    states: {},
    createdAt: 1,
    revision: "fixture-run",
  });
});
afterEach(() => {
  expect(mocks.network).toHaveBeenCalledTimes(0);
  expect(mocks.secret).toHaveBeenCalledTimes(0);
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
async function signal(kinds = [3]) {
  await tick(); // 15:04: yesterday's completed bars establish a baseline.
  expect(list("signal")).toHaveLength(0);
  vi.setSystemTime(at("15:05"));
  mocks.engine.mockResolvedValue(result(kinds));
  await tick();
  return list<Signal>("signal")[0]!;
}
it("M5 real dual-breakout calculation reaches the existing four-channel outbox at 15:05 only", async () => {
  const historical = breakoutFixture.cutoff;
  vi.setSystemTime(at("15:04", historical));
  mocks.calendar.mockResolvedValue({
    days: [historical],
    source: "fixture-calendar",
    hash: "fixture",
  });
  const monitor = get<Monitor>("monitor-m4")!;
  put("monitor", monitor.id, {
    ...monitor,
    strategy: strategySchema.parse({ type: "dual-breakout", params: {} }),
    ai: false,
  });
  mocks.worker.mockResolvedValue({ ...source(), bars: breakoutFixture.bars });
  await tick();
  expect(list("signal")).toHaveLength(0);
  vi.setSystemTime(at("15:05", historical));
  await tick();
  expect(list<Signal>("signal")[0]?.breakout?.latest?.long.status).toBe("是");
  const items = list<Delivery>("delivery");
  expect(items).toHaveLength(4);
  for (const d of items) {
    expect(d.body).toContain("策略：双突破");
    expect(d.body).toContain("质量 4/5");
    expect(d.body).toContain("关键位 27.66");
    expect(d.body).toContain("风险回报比 未知");
    expect(d.body).not.toContain("短均线");
  }
  vi.setSystemTime(at("15:06", historical));
  await tick();
  expect(list("delivery")).toHaveLength(4);
  expect(mocks.engine).not.toHaveBeenCalled();
  expect(mocks.background).not.toHaveBeenCalled();
});
it("P2 default policy: actual monitor generation keeps the signal, waits for one closing digest and never uses network", async () => {
  put(
    "settings",
    "settings",
    settingsSchema.parse({ autoAnalysis: false, autoNewsAnalysis: false }),
  );
  await signal([3]);
  expect(list("signal")).toHaveLength(1);
  expect(list("delivery")).toHaveLength(0);
  const send = vi.fn(async () => "fake-summary-accepted");
  await drain(send);
  expect(send).not.toHaveBeenCalled();
  vi.setSystemTime(at("15:15"));
  await drain(send);
  expect(send).toHaveBeenCalledTimes(4);
  expect(
    list<Delivery>("delivery").every(
      (d) => d.kind === "summary" && d.status === "sent",
    ),
  ).toBe(true);
  expect(list("signal")).toHaveLength(1);
});
it("A1/A2: six point types reach real outbox/four formatters, fake delivery only; snapshots are reviewable", async () => {
  await signal([1, 2, 3, -1, -2, -3]);
  expect(list("signal")).toHaveLength(1);
  const items = list<Delivery>("delivery");
  expect(items).toHaveLength(24);
  for (const item of items) {
    for (const label of [
      "买卖点：第",
      "信号质量：确认",
      "所属中枢：ZG 11.00 / ZD 10.00",
      "背驰依据：",
      "失效条件：",
      "数据日期：2026-09-09",
      "策略版本：czsc-monitor-1",
      "DLL：c0ac4c51",
    ])
      expect(item.body).toContain(label);
    const channel = get<Channel>(item.channelId)!;
    const request = notificationRequest(
      channel,
      credentials[channel.type],
      item,
    );
    const payload = JSON.stringify(request.payload);
    expect(payload).toContain("失效条件");
    expect(payload).toContain(item.signalId);
    expect(payload).not.toContain("…");
  }
  const send = vi.fn(async () => "fake-accepted");
  for (let i = 0; i < 6; i++) await drain(send, Date.now() + i * 3001);
  expect(send).toHaveBeenCalledTimes(24);
  expect(list<Delivery>("delivery").every((d) => d.status === "sent")).toBe(
    true,
  );
  const texts = items
    .filter((d) => get<Channel>(d.channelId)!.type === "feishu")
    .map((d) => d.body)
    .sort();
  const pointLesson = (await chanMethod()).passages.find(
    (p) =>
      p.file.includes("05-trading") && p.heading.includes("第三类买卖点定理"),
  )!;
  const rule = list<Signal>("signal")[0]!;
  mocks.structured.mockImplementation(async (_prompt, schema) => ({
    data: schema.parse({
      explanations: [
        {
          text: "第三类买卖点须核对首次回试/回抽和中枢边界，规则信号不代表已执行交易。",
          evidenceId: rule.id,
          passageId: pointLesson.id,
        },
      ],
    }),
    tokens: 1,
  }));
  const analysis = await analyzeCzscSignal(rule);
  texts.push(
    `AI 追加解读（受控模型输出）\n${analysis.summary}\n关联信号：${rule.id}`,
  );
  const document = `# M4 消息文本快照\n\n受控构造数据，仅供排版目视；不是实际股票信号。四渠道共用以下逐点正文，实际网络投递数为 0。B 层真实飞书测试由用户自行触发，未执行。\n\n${texts.map((body) => `\`\`\`text\n${body}\n\`\`\``).join("\n\n")}\n\n## 待人工核对口径\n\n- 日线 15:05 起观察新确认事件；点位日期可以早于发现它的数据日期。\n- 默认配置 0（严格笔中枢），API 也支持 1100；质量 1 为确认、2 为强质量。\n- 所属中枢按 DLL 候选编号关联；零比值显示未知。失效条件是结构观察条件。\n- 每点一条消息；同一根日线的多个点共用规则信号编号。\n- 本文件只提供文本，不判定用户目视通过。\n`;
  if (process.env.M4_UPDATE_SAMPLES === "1")
    writeFileSync("docs/m4-message-samples.md", document);
  expect(readFileSync("docs/m4-message-samples.md", "utf8")).toBe(document);
});
it("accepts strong quality and leaves missing native evidence explicitly unknown", async () => {
  await tick();
  vi.setSystemTime(at("15:05"));
  const native = result([3], 2);
  native.families[0]!.signals[0]!.centerId = 0;
  native.families[0]!.signals[0]!.divergence = undefined;
  mocks.engine.mockResolvedValue(native);
  await tick();
  const body = list<Delivery>("delivery")[0]!.body;
  expect(body).toContain("信号质量：强质量");
  expect(body).toContain("未知（DLL未关联中枢）");
  expect(body).toContain("不推断成立");
});
it("A3: persisted legacy and tagged MA subscriptions produce identical transitions and text", async () => {
  const original = get<Monitor>("monitor-m4")!;
  const legacy = { ...defaultStrategy, fast: 2, slow: 5 };
  const outputs: string[] = [];
  for (const strategy of [
    legacy,
    strategySchema.parse({ type: "ma-cross", params: legacy }),
  ]) {
    sqlite()
      .prepare("DELETE FROM records WHERE kind IN ('signal','delivery')")
      .run();
    put("monitor", original.id, {
      ...original,
      strategy,
      states: {},
      ai: false,
    });
    vi.setSystemTime(at("15:04"));
    await tick();
    vi.setSystemTime(at("15:05"));
    await tick();
    expect(list("signal")).toHaveLength(1);
    outputs.push(list<Delivery>("delivery")[0]!.body);
  }
  expect(outputs[0]).toBe(outputs[1]);
  expect(mocks.engine).not.toHaveBeenCalled();
});
it.each([
  "suspended",
  "unknown",
  "stale-data",
  "holiday",
  "zero-volume",
  "5m",
  "observe",
  "unknown-quality",
  "resume",
])("A4: no signal for %s", async (reason) => {
  await tick();
  vi.setSystemTime(at(reason === "resume" ? "15:08" : "15:05"));
  mocks.engine.mockResolvedValue(
    result(
      [3],
      reason === "observe" ? 0 : reason === "unknown-quality" ? 3 : 1,
    ),
  );
  if (["suspended", "unknown"].includes(reason))
    mocks.status.mockResolvedValue({
      status: reason,
      asOf: today,
      symbol: "sh600519",
      fetchedAt: Date.now(),
      reason,
    });
  if (reason === "holiday")
    mocks.calendar.mockResolvedValue({
      days: [],
      source: "closed",
      hash: "fixture",
    });
  if (reason === "stale-data") {
    const s = source();
    s.bars.pop();
    s.id = "stale-snapshot";
    mocks.worker.mockResolvedValue(s);
  }
  if (reason === "zero-volume") {
    const s = source();
    s.bars.at(-1)!.volume = 0;
    s.id = "zero-volume-snapshot";
    mocks.worker.mockResolvedValue(s);
  }
  if (reason === "5m")
    put("monitor", "monitor-m4", {
      ...get<Monitor>("monitor-m4"),
      period: "5m",
    });
  await tick();
  expect(list("signal")).toHaveLength(0);
  expect(list("delivery")).toHaveLength(0);
});
it("A4: repeated endpoints never re-send, but a different confirmed point on the next day does", async () => {
  await signal();
  vi.setSystemTime(at("15:06"));
  await tick();
  expect(list("signal")).toHaveLength(1);
  const runtime = (
    globalThis as typeof globalThis & { quantRuntime: { lastTick: number } }
  ).quantRuntime;
  vi.setSystemTime(at("15:05", "2026-09-10"));
  runtime.lastTick = Date.now() - 60000;
  const s = source();
  s.bars.push({ ...s.bars.at(-1)!, date: "2026-09-10" });
  s.id = "next-day-snapshot";
  mocks.worker.mockResolvedValue(s);
  mocks.engine.mockResolvedValue(result([3, -2]));
  await tick();
  expect(list("signal")).toHaveLength(2);
  expect(
    list<Signal>("signal")
      .find((s) => s.date === "2026-09-10")!
      .czsc!.points.map((p) => p.kind),
  ).toEqual([-2]);
});
it("A5: LLM failure leaves rules sent and creates no analysis delivery", async () => {
  await signal();
  const send = vi.fn(async () => "fake-accepted");
  await drain(send);
  expect(send).toHaveBeenCalledTimes(4);
  mocks.structured.mockRejectedValueOnce(new Error("controlled LLM failure"));
  await expect(
    mocks.background.mock.calls[0]![2]({}, new AbortController().signal),
  ).rejects.toThrow("controlled LLM failure");
  expect(list<Delivery>("delivery")).toHaveLength(4);
  expect(
    list<Delivery>("delivery").every(
      (d) => d.kind === "signal" && d.status === "sent",
    ),
  ).toBe(true);
});
it("validates skill passage IDs and appends trusted lesson locations; invalid citations fail closed", async () => {
  const s = await signal();
  const passage = (await chanMethod()).passages.find(
    (p) => p.file.includes("05-trading") && p.lessons.includes(20),
  )!;
  mocks.structured.mockImplementation(async (_prompt, schema) => ({
    data: schema.parse({
      explanations: [
        {
          text: "三类点须核对首次回试与中枢边界。",
          evidenceId: s.id,
          passageId: passage.id,
        },
      ],
    }),
    tokens: 1,
  }));
  const report = await mocks.background.mock.calls[0]![2](
    {},
    new AbortController().signal,
  );
  expect(report.summary).toContain(`第${passage.lessons.join("、")}课`);
  expect(report.summary).toContain(passage.quote);
  expect(
    list<Delivery>("delivery").filter((d) => d.kind === "analysis"),
  ).toHaveLength(4);
  mocks.structured.mockImplementation(async (_prompt, schema) => ({
    data: schema.parse({
      explanations: [
        { text: "伪引用", evidenceId: s.id, passageId: "fabricated" },
      ],
    }),
    tokens: 1,
  }));
  await expect(analyzeCzscSignal(s)).rejects.toThrow("课文引用不存在");
});
it("reuses outbox retries without any network request", async () => {
  await signal();
  const send = vi.fn().mockRejectedValue(new SendError("fake transient"));
  await drain(send);
  expect(
    list<Delivery>("delivery").every(
      (d) => d.status === "pending" && d.attempts === 1,
    ),
  ).toBe(true);
  send.mockResolvedValue("fake-retry-accepted");
  await drain(send, Date.now() + 6000);
  expect(
    list<Delivery>("delivery").every(
      (d) => d.status === "sent" && d.attempts === 2,
    ),
  ).toBe(true);
});
it.each([
  { type: "czsc", params: { config: 5 } },
  { type: "dual-breakout", params: { unsupported: true } },
  { type: "ma-cross", params: { fast: 30, slow: 10 } },
])("rejects invalid strategy %j", (input) => {
  expect(() => strategySchema.parse(input)).toThrow();
});
