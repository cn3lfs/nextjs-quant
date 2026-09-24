import { afterEach, expect, it, vi } from "vitest";
import fixture from "../fixtures/eastmoney-datacenter-events.json";
import { resetEastmoneyCooldowns } from "../../src/server/data-sources/eastmoney/em-fetch";
import {
  datacenterQuery,
  parseDatacenter,
} from "../../src/server/data-sources/eastmoney/em-datacenter";
import {
  forecastEvents,
  holderEvents,
  pledgeEvents,
  surveyEvents,
  unlockEvents,
} from "../../src/server/research/stock-events";

afterEach(() => resetEastmoneyCooldowns());
const rows = (name: keyof typeof fixture) => parseDatacenter(fixture[name]);

it("「返回数据为空」视为空表，其他失败抛出", () => {
  expect(rows("RPTA_WEB_GETHGLIST_NEW")).toEqual([]);
  expect(() => parseDatacenter({ success: false, message: "参数错误" })).toThrow("参数错误");
});

it("查询参数带 reportName / filter / 排序", async () => {
  const fetcher = vi.fn<typeof fetch>(async () => Response.json(fixture.RPT_LIFT_STAGE));
  const got = await datacenterQuery(
    { report: "RPT_LIFT_STAGE", filter: '(SECURITY_CODE="002475")', sortColumns: "FREE_DATE" },
    undefined,
    fetcher,
  );
  expect(got).toHaveLength(3);
  const url = new URL(String(fetcher.mock.calls[0]![0]));
  expect(url.hostname).toBe("datacenter-web.eastmoney.com");
  expect(url.searchParams.get("reportName")).toBe("RPT_LIFT_STAGE");
  expect(url.searchParams.get("filter")).toBe('(SECURITY_CODE="002475")');
});

it("事件映射：预告、调研、增减持、质押、解禁", () => {
  const f = forecastEvents(rows("RPT_PUBLIC_OP_NEWPREDICT"));
  expect(f[0]).toMatchObject({ date: "2026-08-25", type: "forecast", tone: "positive" });
  expect(f[0]!.title).toContain("略增");
  expect(surveyEvents(rows("RPT_ORG_SURVEYNEW"))[0]).toMatchObject({
    date: "2026-08-27",
    title: "机构调研：268 家（业绩说明会）",
  });
  expect(holderEvents(rows("RPT_SHARE_HOLDER_INCREASE"))[0]).toMatchObject({
    tone: "negative",
    title: expect.stringContaining("减持 13,870.84 万股"),
  });
  expect(pledgeEvents(rows("RPT_CSDC_LIST"))).toEqual([
    expect.objectContaining({ date: "2026-09-18", title: "股权质押比例 14.07%", tone: "neutral" }),
  ]);
  expect(unlockEvents(rows("RPT_LIFT_STAGE"))[0]).toMatchObject({
    date: "2017-10-24",
    detail: expect.stringContaining("占总股本 11.11%"),
    tone: "negative",
  });
});
