import { expect, it } from "vitest";
import {
  intradayConfigSchema,
  intradaySchedule,
} from "../../../src/lib/strategy-facts/intraday-schedule";

it("uses Shanghai windows and records missed slots without replaying them", () => {
  const config = intradayConfigSchema.parse({ enabled: true });
  const calendar = { days: ["2024-03-01", "2024-03-04"] };
  const at = (time: string) =>
    intradaySchedule(config, Date.parse(`2024-03-04T${time}+08:00`), calendar);
  expect(at("11:19:59").slots[0]?.status).toBe("pending");
  expect(at("11:20:00").slots[0]?.status).toBe("due");
  expect(at("11:25:00").slots[0]?.status).toBe("missed");
  expect(at("14:40:00").slots.map((slot) => slot.status)).toEqual([
    "missed",
    "due",
  ]);
  expect(at("15:05:00").closeDue).toBe(true);
  expect(at("11:20:00").previousTradingDay).toBe("2024-03-01");
});

it("does not infer a trading day from weekdays or unavailable calendars", () => {
  const config = intradayConfigSchema.parse({ enabled: true });
  const now = Date.parse("2024-03-04T11:20:00+08:00");
  expect(intradaySchedule(config, now, { days: [] }).slots[0]?.status).toBe(
    "unknown",
  );
  expect(
    intradaySchedule(config, now, { days: [], closedDays: ["2024-03-04"] })
      .slots[0]?.status,
  ).toBe("closed");
  expect(
    intradaySchedule(intradayConfigSchema.parse({}), now, { days: [] }).slots[0]
      ?.status,
  ).toBe("disabled");
});

it("validates configurable times and supported RPS periods", () => {
  for (const invalid of [
    { noon: "14:00" },
    { late: "15:00" },
    { late: "14:42" },
    { rpsPeriod: 13 },
  ])
    expect(intradayConfigSchema.safeParse(invalid).success).toBe(false);
  expect(
    intradayConfigSchema.parse({ noon: "11:25", late: "14:50" }).late,
  ).toBe("14:50");
});

it("keeps launch and close boundaries exact to a millisecond", () => {
  const config = intradayConfigSchema.parse({ enabled: true });
  const calendar = { days: ["2024-03-01", "2024-03-04"] };
  for (const [slot, time] of [
    [0, "11:20"],
    [1, "14:40"],
  ] as const) {
    const start = Date.parse(`2024-03-04T${time}:00+08:00`);
    expect(
      intradaySchedule(config, start - 1, calendar).slots[slot]?.status,
    ).toBe("pending");
    expect(intradaySchedule(config, start, calendar).slots[slot]?.status).toBe(
      "due",
    );
    expect(
      intradaySchedule(config, start + 300000 - 1, calendar).slots[slot]
        ?.status,
    ).toBe("due");
    expect(
      intradaySchedule(config, start + 300000, calendar).slots[slot]?.status,
    ).toBe("missed");
  }
  const close = Date.parse("2024-03-04T15:05:00+08:00");
  expect(intradaySchedule(config, close - 1, calendar).closeDue).toBe(false);
  expect(intradaySchedule(config, close, calendar).closeDue).toBe(true);
});
