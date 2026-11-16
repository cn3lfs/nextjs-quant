import { describe, expect, it } from "vitest";
import {
  closeScanDate,
  closeScanWindow,
  closeScanOpen,
} from "~/lib/market/close-scan-window";

const at = (date: string, time: string) =>
  Date.parse(`${date}T${time}:00+08:00`);
describe("receipt-driven A-share close window", () => {
  const days = ["2026-11-12", "2026-11-13", "2026-11-16"];
  it("selects only the latest completed trading day, including next morning", () => {
    expect(closeScanDate(at("2026-11-13", "14:59"), days)).toBe("2026-11-12");
    expect(closeScanDate(at("2026-11-13", "15:00"), days)).toBe("2026-11-13");
    expect(closeScanDate(at("2026-11-16", "09:01"), days)).toBe("2026-11-13");
    expect(closeScanDate(at("2026-11-16", "17:05"), days)).toBe("2026-11-16");
    expect(closeScanDate(at("2026-11-13", "17:05"), [])).toBeNull();
  });
  it("holds Friday open through weekend and closes exactly Monday09:00", () => {
    expect(closeScanOpen("2026-11-13", at("2026-11-15", "17:00"), days)).toBe(
      true,
    );
    expect(closeScanOpen("2026-11-13", at("2026-11-16", "08:30"), days)).toBe(
      true,
    );
    expect(closeScanOpen("2026-11-13", at("2026-11-16", "09:00"), days)).toBe(
      false,
    );
  });
  it("uses confirmed holiday dates; otherwise records the conservative weekday fallback", () => {
    expect(
      closeScanWindow("2026-09-30", ["2026-09-30", "2026-10-08"]),
    ).toMatchObject({
      deadline: at("2026-10-08", "09:00"),
      calendarConfirmed: true,
    });
    expect(closeScanWindow("2026-09-30", ["2026-09-30"])).toMatchObject({
      deadline: at("2026-10-01", "09:00"),
      calendarConfirmed: false,
    });
    expect(closeScanWindow("2026-11-13", ["2026-11-13"])).toMatchObject({
      deadline: at("2026-11-16", "09:00"),
      calendarConfirmed: false,
    });
  });
});
