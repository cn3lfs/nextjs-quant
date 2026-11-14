import { expect, it } from "vitest";
import {
  defaultStudyStart,
  isStudyStockSymbol,
  latestHistoricalDate,
  studyDateError,
} from "../../src/lib/research/strategy-center-input";

it("uses the latest available date strictly before Shanghai today, without inventing weekdays", () => {
  const days = [
    "2026-10-09",
    "2026-10-12",
    "2026-10-09",
    "2026-10-13",
    "2026-02-30",
  ];
  expect(latestHistoricalDate(days, Date.parse("2026-10-12T15:59:59Z"))).toBe(
    "2026-10-09",
  );
  expect(latestHistoricalDate(days, Date.parse("2026-10-12T16:00:00Z"))).toBe(
    "2026-10-12",
  );
  expect(
    latestHistoricalDate(["2026-10-12"], Date.parse("2026-10-12T05:00:00Z")),
  ).toBeNull();
  expect(latestHistoricalDate([], Date.now())).toBeNull();
});

it("defaults to a bounded year and validates drafts rather than silently changing them", () => {
  const now = Date.parse("2026-11-13T00:00:00Z");
  expect(defaultStudyStart("2026-10-12")).toBe("2025-10-12");
  expect(defaultStudyStart("2024-02-29")).toBe("2023-03-01");
  expect(defaultStudyStart("")).toBe("");
  expect(studyDateError("2025-10-12", "2026-10-12", now, 366)).toBeNull();
  expect(studyDateError("2025-10-11", "2026-10-12", now, 366)).toContain("366");
  expect(studyDateError("2026-11-13", "2026-11-12", now)).toContain("开始日期");
  expect(studyDateError("2026-11-01", "2026-11-13", now)).toContain("今天之前");
  expect(studyDateError("2026-02-30", "2026-11-12", now)).toContain("有效");
  expect(studyDateError("2026-11-01", "2026-11-12", null)).toContain(
    "正在确定",
  );
});

it("matches the existing daily stock execution boundary without widening it", () => {
  for (const symbol of ["sh600519", "sz000001", "sz300001"])
    expect(isStudyStockSymbol(symbol)).toBe(true);
  for (const symbol of [
    "sh000001",
    "sz399001",
    "sh688001",
    "bj920748",
    "sh510300",
    "pt880001",
    "emBK1234",
    "600519",
    "SH600519",
    "junk",
  ])
    expect(isStudyStockSymbol(symbol)).toBe(false);
});
