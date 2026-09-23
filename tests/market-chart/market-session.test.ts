import { expect, it } from "vitest";
import { dayPhase, marketSession } from "../../src/lib/market/market-session";

const at = (iso: string) => Date.parse(`${iso}+08:00`);

it("labels A-share sessions in Beijing time and treats weekends as closed", () => {
  expect(marketSession(at("2026-09-16T09:10:00")).kind).toBe("pre-open");
  expect(marketSession(at("2026-09-16T09:20:00")).kind).toBe("auction");
  expect(marketSession(at("2026-09-16T10:00:00")).label).toBe("上午盘");
  expect(marketSession(at("2026-09-16T12:00:00")).kind).toBe("lunch");
  expect(marketSession(at("2026-09-16T14:32:00")).hhmm).toBe("14:32");
  expect(marketSession(at("2026-09-16T15:00:00")).kind).toBe("closed");
  expect(marketSession(at("2026-09-19T10:00:00")).kind).toBe("closed-day");
  expect(marketSession(at("2026-10-01T10:00:00"), "closed").kind).toBe(
    "closed-day",
  );
});

it("advances the overview phase after each five-minute launch window", () => {
  const cutoffs = { noon: "11:20", late: "14:40" };
  expect(dayPhase(9 * 60 + 29, cutoffs)).toBe("盘前");
  expect(dayPhase(11 * 60 + 24, cutoffs)).toBe("午盘前");
  expect(dayPhase(11 * 60 + 25, cutoffs)).toBe("尾盘前");
  expect(dayPhase(14 * 60 + 45, cutoffs)).toBe("收盘后");
});
