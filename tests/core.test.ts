import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseBars, isAStock } from "~/server/data-sources/tdx/tdx";
import { backtest } from "~/server/backtest/quant";
import { metrics } from "~/lib/screening-metrics";
import {
  defaultStrategy,
  strategySchema,
  type Bar,
  type Channel,
  type Delivery,
  type Signal,
} from "~/lib/domain";
import { freshCompleted, transition } from "~/server/runtime";
import {
  notificationRequest,
  validateDestination,
  classifyResponse,
  SendError,
  drain,
  enqueue,
  recoverDeliveries,
} from "~/server/infra/notifications";
import { put, get, list, sqlite, atomic } from "~/server/db";
process.env.QUANT_DATA_DIR = mkdtempSync(join(tmpdir(), "quant-tests-"));
function day(date = 20260907) {
  const b = Buffer.alloc(32);
  b.writeUInt32LE(date, 0);
  [1000, 1200, 900, 1100].forEach((v, i) => b.writeUInt32LE(v, 4 + i * 4));
  b.writeFloatLE(123456, 20);
  b.writeUInt32LE(10000, 24);
  return b;
}
function series(n = 80): Bar[] {
  return Array.from({ length: n }, (_, i) => ({
    date: new Date(Date.UTC(2025, 0, i + 1)).toISOString().slice(0, 10),
    open: 10 + i,
    high: 12 + i,
    low: 9 + i,
    close: 11 + i,
    volume: 10000,
    amount: 100000,
  }));
}
beforeEach(() => sqlite().prepare("DELETE FROM records").run());
describe("本地数据边界", () => {
  it("按小端读取 A 股价格与原始股数", () =>
    expect(parseBars(day(), "day")).toEqual([
      {
        date: "2026-09-07",
        open: 10,
        high: 12,
        low: 9,
        close: 11,
        volume: 10000,
        amount: 123456,
      },
    ]));
  it("拒绝截断记录（负向控制）", () =>
    expect(() => parseBars(day().subarray(0, 31), "day")).toThrow("不完整"));
  it("拒绝非法日期和价格", () => {
    expect(() => parseBars(day(20260230), "day")).toThrow("非法");
    const b = day();
    b.writeUInt32LE(1, 8);
    expect(() => parseBars(b, "day")).toThrow("非法");
  });
  it("拒绝重复或倒序", () =>
    expect(() => parseBars(Buffer.concat([day(), day()]), "day")).toThrow(
      "重复",
    ));
  it("独立解码分钟线日期、分钟和浮点价格", () => {
    const b = Buffer.alloc(32);
    b.writeUInt16LE((2026 - 2004) * 2048 + 907, 0);
    b.writeUInt16LE(575, 2);
    [10, 12, 9, 11].forEach((v, i) => b.writeFloatLE(v, 4 + i * 4));
    b.writeFloatLE(1000, 20);
    b.writeUInt32LE(100, 24);
    expect(parseBars(b, "5m")[0]?.date).toBe("2026-09-07T09:35:00+08:00");
  });
  it("仅将 A 股加入首期股票池", () => {
    expect(isAStock("sh600519")).toBe(true);
    expect(isAStock("bj920001")).toBe(true);
    expect(isAStock("sh000001")).toBe(false);
    expect(isAStock("sh510300")).toBe(false);
  });
});
describe("确定性策略", () => {
  it("校验不支持的均线组合", () =>
    expect(() =>
      strategySchema.parse({ ...defaultStrategy, fast: 30, slow: 10 }),
    ).toThrow());
  it("数据不足不产生信号", () =>
    expect(metrics(series(10), defaultStrategy)).toBeNull());
  it("趋势条件可计算，价格下降导致条件失效", () => {
    expect(metrics(series(), defaultStrategy)?.matched).toBe(true);
    const bars = series();
    bars.at(-1)!.close = 1;
    expect(metrics(bars, defaultStrategy)?.matched).toBe(false);
  });
  it("同快照同参数得到相同收益，未来变化不能修改过去成交", () => {
    const bars = series(),
      a = backtest(bars, defaultStrategy, "snap"),
      b = backtest(bars, defaultStrategy, "snap");
    expect(a).toEqual(b);
    expect(a.trades[0]?.date).toBe(bars[21]?.date);
    const altered = series();
    altered[70]!.close = 1;
    const c = backtest(altered, defaultStrategy, "snap");
    expect(c.trades.filter((t) => t.date < bars[70]!.date)).toEqual(
      a.trades.filter((t) => t.date < bars[70]!.date),
    );
    expect(a.cash).toBeGreaterThanOrEqual(0);
    expect(a.trades.every((t) => t.shares % 100 === 0)).toBe(true);
  });
  it("无量及一字行情不成交", () => {
    const bars = series().map((b) => ({ ...b, volume: 0 }));
    expect(backtest(bars, defaultStrategy, "s").trades).toHaveLength(0);
  });
});
describe("信号时间与去重", () => {
  it("首次基线、连续满足、重复 K 线、恢复睡眠都不触发", () => {
    const current = { date: "2026-09-08", matched: true };
    expect(transition(undefined, current, true, false)).toBe(false);
    expect(
      transition({ date: "2026-09-07", matched: true }, current, true, false),
    ).toBe(false);
    expect(
      transition({ date: current.date, matched: false }, current, true, false),
    ).toBe(false);
    expect(
      transition({ date: "2026-09-07", matched: false }, current, true, true),
    ).toBe(false);
    expect(
      transition({ date: "2026-09-07", matched: false }, current, false, false),
    ).toBe(false);
    expect(
      transition({ date: "2026-09-07", matched: false }, current, true, false),
    ).toBe(true);
  });
  it("日线须在交易日收盘后并且是今日数据", () => {
    const now = Date.parse("2026-09-08T15:06:00+08:00");
    expect(freshCompleted("2026-09-08", "day", now, ["2026-09-08"])).toBe(true);
    expect(freshCompleted("2026-09-07", "day", now, ["2026-09-08"])).toBe(
      false,
    );
    expect(freshCompleted("2026-09-08", "day", now, [])).toBe(false);
    expect(
      freshCompleted("2026-09-08", "day", now - 3600000, ["2026-09-08"]),
    ).toBe(false);
  });
  it("分钟线拒绝未来时间和十分钟前旧数据", () => {
    const now = Date.parse("2026-09-08T10:05:00+08:00");
    expect(
      freshCompleted("2026-09-08T10:00:00+08:00", "5m", now, ["2026-09-08"]),
    ).toBe(true);
    expect(
      freshCompleted("2026-09-08T10:10:00+08:00", "5m", now, ["2026-09-08"]),
    ).toBe(false);
    expect(
      freshCompleted("2026-09-08T09:40:00+08:00", "5m", now, ["2026-09-08"]),
    ).toBe(false);
  });
});
const channel = (id = "c", type: Channel["type"] = "feishu"): Channel => ({
  id,
  name: id,
  type,
  enabled: true,
  target: "123",
  thread: "",
  configured: true,
});
const delivery = (id = "d", channelId = "c"): Delivery => ({
  id,
  signalId: "s",
  channelId,
  kind: "signal",
  title: "test",
  body: "规则信号 @everyone",
  status: "pending",
  attempts: 0,
  nextAt: 0,
  expiresAt: Date.now() + 1e6,
  createdAt: Date.now(),
});
describe("消息适配", () => {
  it("拒绝其他平台和内网 webhook（负向控制）", () => {
    expect(() =>
      validateDestination("feishu", "http://127.0.0.1/hook"),
    ).toThrow();
    expect(() =>
      validateDestination("discord", "https://evil.test/api/webhooks/1/a"),
    ).toThrow();
  });
  it("飞书签名与去提及", () => {
    const r = notificationRequest(
      channel(),
      {
        secret: "https://open.feishu.cn/open-apis/bot/v2/hook/abc",
        signingSecret: "secret",
      },
      delivery(),
      1000000,
    );
    expect(r.payload.timestamp).toBe("1000");
    expect(r.payload.sign).toEqual(expect.any(String));
    expect(JSON.stringify(r.payload)).not.toContain("@everyone");
  });
  it("企业微信使用文本，Telegram 使用 chat_id，Discord 禁用 mentions", () => {
    expect(
      notificationRequest(
        channel("w", "wecom"),
        { secret: "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=x" },
        delivery(),
      ).payload.msgtype,
    ).toBe("text");
    expect(
      notificationRequest(
        channel("t", "telegram"),
        { secret: "123:abc" },
        delivery(),
      ).payload.chat_id,
    ).toBe("123");
    expect(
      notificationRequest(
        channel("d", "discord"),
        { secret: "https://discord.com/api/webhooks/123/abc" },
        delivery(),
      ).payload.allowed_mentions,
    ).toEqual({ parse: [] });
  });
  it("HTTP 200 业务错误仍失败，429 保留 retry_after", () => {
    expect(() =>
      classifyResponse("wecom", 200, { errcode: 40014 }, null),
    ).toThrow(SendError);
    try {
      classifyResponse(
        "telegram",
        429,
        { parameters: { retry_after: 12 } },
        null,
      );
    } catch (e) {
      expect((e as SendError).retryAfter).toBe(12000);
    }
    expect(() =>
      classifyResponse("telegram", 200, { ok: true }, null),
    ).not.toThrow();
  });
});
describe("持久化投递", () => {
  function authorize(channelIds: string[]) {
    put("monitor", "m", {
      id: "m",
      createdAt: 1,
      revision: "fixture",
      enabled: true,
      ai: true,
      symbols: ["sh600519"],
      channels: channelIds,
    });
    put("signal", "s", {
      id: "s",
      monitorId: "m",
      monitorRun: { createdAt: 1, revision: "fixture" },
      symbol: "sh600519",
    });
  }
  it("同一事件和目标只入队一次", () => {
    put("channel", "c", channel());
    const signal = {
      id: "s",
      symbol: "sh600519",
      strategy: defaultStrategy,
      period: "day",
      date: "2026-09-08",
      createdAt: Date.now(),
      expiresAt: Date.now() + 1e6,
      metrics: metrics(series(), defaultStrategy)!,
      snapshotId: "snap",
      source: "tdx-local",
      monitorId: "m",
    } satisfies Signal;
    enqueue(signal, ["c"], "signal");
    enqueue(signal, ["c"], "signal");
    expect(list("delivery")).toHaveLength(1);
  });
  it("原子写入失败时事件和通知一起回滚", () => {
    expect(() =>
      atomic(() => {
        put("signal", "s", {});
        put("delivery", "d", delivery());
        throw new Error("rollback");
      }),
    ).toThrow();
    expect(get("s")).toBeUndefined();
    expect(get("d")).toBeUndefined();
  });
  it("渠道分别处理：永久失败不阻塞其他渠道", async () => {
    authorize(["a", "b"]);
    put("channel", "a", channel("a"));
    put("channel", "b", channel("b"));
    put("delivery", "da", delivery("da", "a"));
    put("delivery", "db", delivery("db", "b"));
    await drain(async (c) => {
      if (c.id === "a") throw new SendError("invalid", true);
      return "remote";
    });
    expect(get<Delivery>("da")?.status).toBe("failed");
    expect(get<Delivery>("db")?.status).toBe("sent");
  });
  it("过期信号不发送，网络错误重试且记录次数", async () => {
    authorize(["retry"]);
    put("channel", "retry", channel("retry"));
    put("delivery", "expired", {
      ...delivery("expired", "retry"),
      expiresAt: 0,
    });
    put("delivery", "retry-delivery", delivery("retry-delivery", "retry"));
    let count = 0;
    await drain(async () => {
      count++;
      throw new Error("network");
    });
    expect(count).toBe(1);
    expect(get<Delivery>("expired")?.status).toBe("expired");
    expect(get<Delivery>("retry-delivery")?.status).toBe("pending");
    expect(get<Delivery>("retry-delivery")?.attempts).toBe(1);
  });
  it("中断发送恢复为结果不确定，不丢失记录", () => {
    authorize(["c"]);
    put("delivery", "d", { ...delivery(), status: "sending", attempts: 1 });
    recoverDeliveries();
    expect(get<Delivery>("d")?.status).toBe("pending");
    expect(get<Delivery>("d")?.error).toContain("不确定");
  });
});
