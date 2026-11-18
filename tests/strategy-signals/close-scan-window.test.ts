import { describe, expect, it } from "vitest";
import {
  closeScanDate,
  closeScanPhase,
  closeScanWindow,
  closeScanOpen,
} from "~/lib/market/close-scan-window";
import { candidateScanFreshness } from "~/server/alerts/candidate-scan";

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

describe("close scan phase", () => {
  const days = ["2026-11-17", "2026-11-18"];
  it("keeps unknown, waiting, unconfirmed, running, missed and finished apart", () => {
    expect(
      closeScanPhase(null, undefined, at("2026-11-18", "16:00"), days).phase,
    ).toBe("unknown-date");
    expect(
      closeScanPhase("2026-11-18", undefined, at("2026-11-18", "14:00"), days)
        .phase,
    ).toBe("waiting");
    expect(
      closeScanPhase("2026-11-18", undefined, at("2026-11-18", "16:00"), days)
        .phase,
    ).toBe("unconfirmed");
    expect(
      closeScanPhase(
        "2026-11-18",
        { status: "running" },
        at("2026-11-18", "16:00"),
        days,
      ).phase,
    ).toBe("running");
    expect(
      closeScanPhase(
        "2026-11-18",
        { status: "complete" },
        at("2026-11-18", "16:00"),
        days,
      ).phase,
    ).toBe("complete");
    const throughNext = [...days, "2026-11-19"];
    expect(
      closeScanPhase(
        "2026-11-18",
        undefined,
        at("2026-11-19", "09:00"),
        throughNext,
      ).phase,
    ).toBe("missed");
  });
  it("uses the readiness date at weekends, pre-close and after the next 09:00", () => {
    const weekend = ["2026-11-13", "2026-11-16"];
    expect(
      closeScanPhase(
        "2026-11-13",
        { status: "complete" },
        at("2026-11-15", "20:00"),
        weekend,
      ),
    ).toMatchObject({ phase: "complete", calendarConfirmed: true });
    // Monday 10:00 still refers to Friday; its 09:00 deadline has passed.
    expect(
      closeScanPhase(
        "2026-11-13",
        undefined,
        at("2026-11-16", "10:00"),
        weekend,
      ).phase,
    ).toBe("missed");
    // Monday 15:30 has an open window and no confirmed record.
    expect(
      closeScanPhase(
        "2026-11-16",
        undefined,
        at("2026-11-16", "15:30"),
        weekend,
      ).phase,
    ).toBe("unconfirmed");
    // A missing calendar cannot confirm the next deadline.
    expect(
      closeScanPhase("2026-11-18", undefined, at("2026-11-18", "16:00"), []),
    ).toMatchObject({ phase: "unconfirmed", calendarConfirmed: false });
  });
});

describe("candidate source freshness", () => {
  const calendar = ["2026-11-17", "2026-11-18"];
  const reference = { closeDate: "2026-11-18", calendar };
  it("labels A-share day watermarks against the completed close", () => {
    expect(
      candidateScanFreshness(
        { bar: "2026-11-18", observedAt: at("2026-11-18", "16:00") },
        "day",
        reference,
      ),
    ).toBe("current");
    expect(
      candidateScanFreshness(
        { bar: "2026-11-17", observedAt: at("2026-11-17", "16:00") },
        "day",
        reference,
      ),
    ).toBe("stale");
    // A bar outside the confirmed coverage cannot be called historical either.
    expect(
      candidateScanFreshness(
        { bar: "2026-11-16", observedAt: at("2026-11-16", "16:00") },
        "day",
        reference,
      ),
    ).toBe("unknown");
    expect(
      candidateScanFreshness(
        { bar: "2026-11-18", observedAt: at("2026-11-18", "16:00") },
        "day",
        { closeDate: null, calendar },
      ),
    ).toBe("unknown");
    expect(
      candidateScanFreshness(
        { bar: "2026-11-18", observedAt: at("2026-11-18", "16:00") },
        "day",
        { closeDate: "2026-11-18", calendar: [] },
      ),
    ).toBe("unknown");
  });
  it("uses scan time for week and only labels intraday scans as 盘中", () => {
    expect(
      candidateScanFreshness(
        { bar: "2026-11-13", observedAt: at("2026-11-18", "16:00") },
        "week",
        reference,
      ),
    ).toBe("current");
    expect(
      candidateScanFreshness(
        { bar: "2026-11-13", observedAt: at("2026-11-17", "16:00") },
        "week",
        reference,
      ),
    ).toBe("stale");
    expect(
      candidateScanFreshness(
        { bar: "2026-11-18", observedAt: at("2026-11-18", "16:00") },
        "5m",
        reference,
      ),
    ).toBe("intraday");
  });
});
