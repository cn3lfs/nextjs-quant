import type { IndustrySnapshot } from "../src/lib/screening/industry-rps";
import { aggregateIndustryRps } from "../src/lib/screening/industry-rps";
import { calculateRpsDay } from "../src/server/screening/rps-engine";
import { rpsHash } from "~/server/infra/content-hash";
import { rpsCalendar, rpsDate, rpsDay, tenStocks } from "./rps-fixture";

export function industrySnapshot(
  groups: Record<string, string[]> = {
    甲: ["sz000000", "sz000001"],
    乙: ["sz000008", "sz000009"],
    丙: ["sz000003", "sz000004"],
  },
): IndustrySnapshot {
  const files = Object.entries(groups).map(([name, members]) => ({
    name,
    file: `${name}.txt`,
    members,
    hash: rpsHash(members),
    mtimeMs: 1000,
  }));
  return { root: "fixture", files, hash: rpsHash(files) };
}
export function industryDay() {
  const result = aggregateIndustryRps(
    industrySnapshot(),
    calculateRpsDay(tenStocks(), rpsCalendar, rpsDate),
  );
  return {
    day: {
      ...rpsDay().day,
      total: 3,
      pool: result.pool,
      counts: result.counts,
      missing: result.missing,
      industry: result.industry,
    },
    rows: result.rows,
  };
}
