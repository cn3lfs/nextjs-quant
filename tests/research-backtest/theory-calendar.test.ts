import { expect, it, vi } from "vitest";
import { loadTheoryCalendar } from "~/server/research/theory-calendar";
it("requires complete open/closed evidence and preserves source identity", async () => {
  const read = vi.fn(async () => ({
    days: ["2026-11-02"],
    closedDays: ["2026-11-01", "2026-11-03"],
    hash: "official",
    source: "fixture",
  }));
  const result = await loadTheoryCalendar("2026-11-01", "2026-11-03", read);
  expect(result.days).toEqual(["2026-11-02"]);
  expect(result.closedDays).toContain("2026-11-01");
  expect(result.hash).toHaveLength(64);
  expect(read).toHaveBeenCalledTimes(1);
});
it("does not infer a missing weekday is closed or fall back when official lookup fails", async () => {
  await expect(
    loadTheoryCalendar("2026-11-01", "2026-11-03", async () => ({
      days: ["2026-11-02"],
      closedDays: ["2026-11-01"],
      hash: "official",
      source: "fixture",
    })),
  ).rejects.toThrow("日期缺失");
  await expect(
    loadTheoryCalendar("2026-11-01", "2026-11-03", async () => {
      throw new Error("offline");
    }),
  ).rejects.toThrow("未将未知日期推断为休市");
});
