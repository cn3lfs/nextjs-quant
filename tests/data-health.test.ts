import { expect, it } from "vitest";
import {
  screenDataHealth,
  localCalendarReference,
  requireCurrentScreen,
} from "../src/server/market/data-health";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
const calendar = {
  days: ["2026-09-07", "2026-09-08"],
  source: "fixture",
  hash: "fixture",
};
const at = (time: string) => Date.parse(`2026-09-08T${time}:00+08:00`);
it("strict current screening refuses stale and unverified data and permits aligned completed bars", () => {
  expect(() =>
    requireCurrentScreen(
      screenDataHealth("2026-09-07", "day", at("16:00"), calendar),
    ),
  ).toThrow("落后");
  expect(() =>
    requireCurrentScreen(
      screenDataHealth("2026-09-08", "day", at("16:00"), {
        ...calendar,
        days: [],
      }),
    ),
  ).toThrow("无法核验");
  expect(() =>
    requireCurrentScreen(
      screenDataHealth("2026-09-08", "day", at("16:00"), calendar),
    ),
  ).not.toThrow();
  expect(() =>
    requireCurrentScreen(
      screenDataHealth("2026-09-07", "day", at("10:00"), calendar),
    ),
  ).not.toThrow();
  expect(() =>
    requireCurrentScreen(
      screenDataHealth(
        "2026-09-08T11:30:00+08:00",
        "5m",
        at("12:00"),
        calendar,
      ),
    ),
  ).not.toThrow();
});
it("uses a declared recent calendar window without rewriting invalid ancient source records", async () => {
  const root = await mkdtemp(join(tmpdir(), "quant-calendar-"));
  const directory = join(root, "vipdoc", "sh", "lday");
  await mkdir(directory, { recursive: true });
  const bytes = Buffer.alloc(401 * 32);
  for (let index = 1; index <= 400; index++) {
    const day = Number(
      new Date(Date.UTC(2025, 0, index))
        .toISOString()
        .slice(0, 10)
        .replaceAll("-", ""),
    );
    bytes.writeUInt32LE(day, index * 32);
    for (let field = 1; field <= 4; field++)
      bytes.writeUInt32LE(1000, index * 32 + field * 4);
    bytes.writeFloatLE(10000, index * 32 + 20);
    bytes.writeUInt32LE(1000, index * 32 + 24);
  }
  const path = join(directory, "sh000001.day");
  await writeFile(path, bytes);
  const reference = await localCalendarReference(root, []);
  expect(reference.days).toHaveLength(400);
  expect(reference.source).toContain("400");
  expect(reference.hash).toBe(
    createHash("sha256").update(bytes.subarray(32)).digest("hex"),
  );
  expect(await readFile(path)).toEqual(bytes);
  await writeFile(path, bytes.subarray(0, bytes.length - 1));
  expect(await localCalendarReference(root, [])).toEqual({
    days: [],
    source: "交易日期参考不可用",
    hash: null,
  });
});
it("day completion uses the prior date until 15:05 and does not mistake uniformly old data for current", () => {
  expect(
    screenDataHealth("2026-09-07", "day", at("15:04"), calendar).status,
  ).toBe("aligned");
  expect(
    screenDataHealth("2026-09-07", "day", at("15:05"), calendar),
  ).toMatchObject({ status: "lagging", referenceAsOf: "2026-09-08" });
  expect(
    screenDataHealth("2022-11-30T15:00:00+08:00", "5m", at("15:05"), calendar)
      .status,
  ).toBe("lagging");
});
it("minute reference respects pre-open, lunch, afternoon opening and close", () => {
  for (const [time, reference] of [
    ["09:34", "2026-09-07T15:00:00+08:00"],
    ["09:35", "2026-09-08T09:35:00+08:00"],
    ["12:30", "2026-09-08T11:30:00+08:00"],
    ["13:04", "2026-09-08T11:30:00+08:00"],
    ["13:05", "2026-09-08T13:05:00+08:00"],
    ["17:00", "2026-09-08T15:00:00+08:00"],
  ])
    expect(
      screenDataHealth(reference!, "5m", at(time!), calendar),
    ).toMatchObject({ status: "aligned", referenceAsOf: reference });
});
it("missing calendar coverage cannot prove freshness or infer suspension", () => {
  const oldCalendar = { ...calendar, days: ["2026-09-07"] };
  expect(
    screenDataHealth("2026-09-07", "day", at("17:00"), oldCalendar),
  ).toMatchObject({
    status: "unknown",
    referenceAsOf: "2026-09-07",
    tradingStatus: "unknown",
  });
  expect(
    screenDataHealth("2026-09-04", "day", at("17:00"), oldCalendar).status,
  ).toBe("lagging");
  expect(
    screenDataHealth(null, "day", at("17:00"), { ...calendar, days: [] })
      .status,
  ).toBe("unknown");
  expect(
    screenDataHealth("2026-09-09", "day", at("17:00"), calendar).status,
  ).toBe("unknown");
});
