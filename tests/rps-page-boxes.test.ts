import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  rpsLogIdPrefix,
  rpsLogTime,
  rpsPercent,
  summarizeRpsProgress,
  toRpsLogEntry,
  type RpsLogEntry,
} from "../src/lib/rps-log";
import { poolMembersHref } from "../src/lib/market-pool";
import { RpsRunStatus } from "../src/components/rps-run-status";
import { RpsWorkflowLog } from "../src/components/rps-workflow-log";
import { PoolMembersLink } from "../src/components/pool-members-link";
import type { RpsProgress } from "../src/lib/rps";

const progress: RpsProgress = {
  target: "industry",
  id: "job-1",
  mode: "backfill",
  status: "running",
  phase: "读取日线",
  scanned: 500,
  total: 2000,
  completedDays: 25,
  totalDays: 250,
  startedAt: Date.UTC(2026, 0, 5, 1, 0, 0),
  updatedAt: Date.UTC(2026, 0, 5, 1, 30, 0),
};
const record = (
  id: string,
  payload: Record<string, unknown>,
  updatedAt = Date.UTC(2026, 0, 5, 7, 5, 0),
) => ({ id, payload, updatedAt });

describe("RPS 历史日志记录", () => {
  it("只保留可解析的RPS批次并按可用时间戳定位", () => {
    const entry = toRpsLogEntry(
      record(`${rpsLogIdPrefix}2026-01-05-close`, {
        phase: "close",
        date: "2026-01-05",
        status: "complete",
        startedAt: 1,
        completedAt: 2,
      }),
    );
    expect(entry).toEqual({
      id: `${rpsLogIdPrefix}2026-01-05-close`,
      date: "2026-01-05",
      phase: "close",
      status: "complete",
      at: 2,
    });
    expect(
      toRpsLogEntry(record("x", { phase: "noon", date: "2026-01-05" })),
    ).toBeNull();
  });

  it("失败记录保留错误文本，缺时间戳时退回记录更新时间", () => {
    const entry = toRpsLogEntry(
      record(`${rpsLogIdPrefix}2026-01-05-noon`, {
        phase: "noon",
        date: "2026-01-05",
        status: "failed",
        error: "当前交易日未由在线指数确认",
      }),
    );
    expect(entry?.error).toBe("当前交易日未由在线指数确认");
    expect(entry?.at).toBe(Date.UTC(2026, 0, 5, 7, 5, 0));
  });

  it("时间按上海墙钟展示，与本机时区无关", () => {
    expect(rpsLogTime(Date.UTC(2026, 0, 5, 7, 5, 0))).toBe(
      "2026-01-05 15:05:00",
    );
  });
});

describe("当前运行状态", () => {
  it("汇总目标、模式与两个进度百分比", () => {
    expect(rpsPercent(0, 0)).toBe(0);
    expect(summarizeRpsProgress(null)).toBeNull();
    expect(summarizeRpsProgress(progress)).toMatchObject({
      target: "行业",
      mode: "回填",
      statusLabel: "运行中",
      scanPercent: 25,
      dayPercent: 10,
    });
  });

  it("渲染独立矩形框，含进度条与起止时间", () => {
    const html = renderToStaticMarkup(
      createElement(RpsRunStatus, { progress }),
    );
    expect(html).toContain("当前运行状态");
    expect(html).toContain("行业任务");
    expect(html).toContain("运行中");
    expect(html).toContain("读取 500/2000");
    expect(html).toContain("提交 25/250 日");
    expect(html).toContain('aria-valuenow="25"');
    expect(html).toContain("2026-01-05 09:00:00");
  });

  it("无任务时显示空闲而不是历史内容", () => {
    const html = renderToStaticMarkup(
      createElement(RpsRunStatus, { progress: null }),
    );
    expect(html).toContain("空闲");
    expect(html).toContain("尚未运行RPS任务");
    expect(html).not.toContain("progressbar");
  });

  it("失败原因以警告角色展示", () => {
    const html = renderToStaticMarkup(
      createElement(RpsRunStatus, {
        progress: { ...progress, status: "failed", error: "租约超时" },
      }),
    );
    expect(html).toContain("失败");
    expect(html).toContain('role="alert"');
    expect(html).toContain("租约超时");
  });
});

describe("历史日志框", () => {
  const entries: RpsLogEntry[] = [
    {
      id: "a",
      date: "2026-01-05",
      phase: "close",
      status: "complete",
      at: Date.UTC(2026, 0, 5, 7, 40, 0),
    },
    {
      id: "b",
      date: "2026-01-05",
      phase: "noon",
      status: "failed",
      error: "下载数据尚未包含今日收盘",
      at: Date.UTC(2026, 0, 5, 4, 5, 0),
    },
  ];

  it("在可滚动容器内按条列出批次与中文时段", () => {
    const html = renderToStaticMarkup(
      createElement(RpsWorkflowLog, { entries }),
    );
    expect(html).toContain("历史日志");
    expect(html).toContain("overflow-y-auto");
    expect(html).toContain("收盘批次");
    expect(html).toContain("午盘批次");
    expect(html).toContain("已完成");
    expect(html).toContain("下载数据尚未包含今日收盘");
    expect(html).toContain('role="alert"');
    expect(html).not.toContain("财联社");
  });

  it("为空时说明手工回填不写入自动批次日志", () => {
    const html = renderToStaticMarkup(
      createElement(RpsWorkflowLog, { entries: [] }),
    );
    expect(html).toContain("暂无RPS批次记录");
  });
});

describe("板块成分股入口", () => {
  it("行业与概念都链接到股票池深链，名称编码后传递", () => {
    expect(poolMembersHref("industry", "电力设备")).toBe(
      "/?poolCategory=industry&poolName=%E7%94%B5%E5%8A%9B%E8%AE%BE%E5%A4%87",
    );
    const html = renderToStaticMarkup(
      createElement(PoolMembersLink, {
        category: "industry",
        name: "通达信·半导体",
      }),
    );
    expect(html).toContain("poolCategory=industry");
    expect(html).toContain(encodeURIComponent("通达信·半导体"));
    expect(html).toContain("查看成分股");
  });
});
