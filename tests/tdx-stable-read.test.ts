import { afterEach, expect, it, vi } from "vitest";
const io = vi.hoisted(() => ({ open: vi.fn(), stat: vi.fn() }));
vi.mock("node:fs/promises", async (original) => ({
  ...(await original<typeof import("node:fs/promises")>()),
  open: io.open,
  stat: io.stat,
}));
import { readSnapshot } from "../src/server/data-sources/tdx/tdx";
afterEach(() => vi.resetAllMocks());
const state = {
  dev: 1,
  ino: 1,
  size: 32,
  mtimeMs: 1,
  ctimeMs: 1,
  birthtimeMs: 1,
};
function minute() {
  const bytes = Buffer.alloc(32);
  bytes.writeUInt16LE((2026 - 2004) * 2048 + 911, 0);
  bytes.writeUInt16LE(9 * 60 + 35, 2);
  for (const offset of [4, 8, 12, 16]) bytes.writeFloatLE(10, offset);
  bytes.writeFloatLE(1000, 20);
  bytes.writeUInt32LE(100, 24);
  return bytes;
}
it.each(["ino", "ctimeMs"])(
  "rejects a changing %s despite unchanged size and mtime, closing all handles",
  async (field) => {
    const close = vi.fn(async () => {});
    io.open.mockImplementation(async () => ({
      stat: async () => state,
      readFile: async () => minute(),
      close,
    }));
    io.stat.mockResolvedValue({ ...state, [field]: 2 });
    await expect(
      readSnapshot("C:/quant-read-fixture", "sh600001", "5m"),
    ).rejects.toThrow("正在更新");
    expect(io.open).toHaveBeenCalledTimes(3);
    expect(close).toHaveBeenCalledTimes(3);
  },
);
it("retries a replacement and publishes only the stable file content", async () => {
  const close = vi.fn(async () => {});
  io.open.mockImplementation(async () => ({
    stat: async () => state,
    readFile: async () => minute(),
    close,
  }));
  io.stat.mockResolvedValueOnce({ ...state, ino: 2 }).mockResolvedValue(state);
  const result = await readSnapshot("C:/quant-read-fixture", "sh600001", "5m");
  expect(result.bars).toHaveLength(1);
  expect(result.bars[0]?.close).toBe(10);
  expect(io.open).toHaveBeenCalledTimes(2);
  expect(close).toHaveBeenCalledTimes(2);
});
