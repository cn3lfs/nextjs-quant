import { afterEach, expect, it, vi } from "vitest";
import {
  EastmoneyBlockedError,
  emFetch,
  emGroup,
  resetEastmoneyCooldowns,
} from "../../src/server/data-sources/eastmoney/em-fetch";

afterEach(() => resetEastmoneyCooldowns());

it("按 WAF 分组：push2 系列与 datacenter 独立", () => {
  expect(emGroup("https://push2his.eastmoney.com/a")).toBe("quote");
  expect(emGroup("https://push2ex.eastmoney.com/a")).toBe("quote");
  expect(emGroup("https://datacenter-web.eastmoney.com/a")).toBe("datacenter");
  expect(emGroup("https://reportapi.eastmoney.com/a")).toBe("other");
});

it("默认带浏览器 UA 与 Referer", async () => {
  const fetcher = vi.fn<typeof fetch>(async () => new Response("{}"));
  await emFetch("https://push2.eastmoney.com/x", {}, fetcher);
  const headers = new Headers(fetcher.mock.calls[0]![1]!.headers);
  expect(headers.get("user-agent")).toMatch(/Mozilla/);
  expect(headers.get("referer")).toBe("https://quote.eastmoney.com/");
});

it("403 后该组冷却、另一组不受影响", async () => {
  const fetcher = vi.fn<typeof fetch>(async () => new Response("", { status: 403 }));
  await expect(
    emFetch("https://push2.eastmoney.com/x", {}, fetcher),
  ).rejects.toBeInstanceOf(EastmoneyBlockedError);
  await expect(
    emFetch("https://push2his.eastmoney.com/y", {}, fetcher),
  ).rejects.toBeInstanceOf(EastmoneyBlockedError);
  expect(fetcher).toHaveBeenCalledTimes(1);
  const ok = vi.fn<typeof fetch>(async () => new Response("{}"));
  await emFetch("https://datacenter-web.eastmoney.com/z", {}, ok);
  expect(ok).toHaveBeenCalledTimes(1);
});
