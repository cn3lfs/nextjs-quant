import { expect, it, vi } from "vitest";
import {
  downloadDailyIncrement,
  extractDailyIncrement,
} from "../src/server/tdx-increment-download";
import { readFileSync } from "node:fs";

it.skipIf(process.platform !== "win32")(
  "extracts only the six expected files and rejects path traversal or wrong dates",
  async () => {
    const zip = readFileSync("tests/fixtures/tdx-daily-increment/sample.zip");
    const result = await extractDailyIncrement(zip, "2026-09-10");
    expect(result.map((pack) => pack.market)).toEqual(["sh", "sz", "bj"]);
    expect(result[0]!.cod).toEqual(
      readFileSync("tests/fixtures/tdx-daily-increment/sample.cod"),
    );
    await expect(extractDailyIncrement(zip, "2026-09-11")).rejects.toThrow();
    await expect(
      extractDailyIncrement(
        readFileSync("tests/fixtures/tdx-daily-increment/invalid-path.zip"),
        "2026-09-10",
      ),
    ).rejects.toThrow();
  },
);
it("distinguishes publication delay from success and other server failures", async () => {
  const request = vi
    .fn<typeof fetch>()
    .mockResolvedValue(new Response(null, { status: 404 }));
  expect(await downloadDailyIncrement("2026-09-11", request)).toMatchObject({
    status: "not-published",
  });
  expect(request.mock.calls[0]![0]).toBe(
    "https://www.tdx.com.cn/products/data/data/g4day/20260911.zip",
  );
  request.mockResolvedValue(new Response(null, { status: 503 }));
  await expect(downloadDailyIncrement("2026-09-11", request)).rejects.toThrow(
    "503",
  );
});
it("rejects HTML responses and excessive declared payloads", async () => {
  const request = vi
    .fn<typeof fetch>()
    .mockResolvedValue(new Response("<html>verification required</html>"));
  await expect(downloadDailyIncrement("2026-09-10", request)).rejects.toThrow(
    "不是ZIP",
  );
  request.mockResolvedValue(
    new Response(null, {
      headers: { "content-length": String(17 * 1024 * 1024) },
    }),
  );
  await expect(downloadDailyIncrement("2026-09-10", request)).rejects.toThrow(
    "上限",
  );
});
it("bounds streamed payloads even if content-length is absent", async () => {
  const request = vi.fn<typeof fetch>().mockResolvedValue(
    new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(16 * 1024 * 1024));
          controller.enqueue(new Uint8Array(1));
          controller.close();
        },
      }),
    ),
  );
  await expect(downloadDailyIncrement("2026-09-10", request)).rejects.toThrow(
    "上限",
  );
});
