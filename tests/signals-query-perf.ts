import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { writeFileSync } from "node:fs";
import {
  monitorWorkspacePage,
  signalWorkspacePage,
  deliveryWorkspacePage,
  monitorWorkspaceSummary,
} from "../src/server/monitoring/monitor-workspace-query";
import { signalsFixtureTime } from "./helpers/signals-fixture";
const directory = resolve(process.env.QUANT_DATA_DIR ?? "");
assert.ok(directory.startsWith(resolve(tmpdir()) + "\\quant-signals-"));
const indexed = process.argv.includes("--indexes");
const db = new Database(join(directory, "quant.sqlite"), {
  readonly: !indexed,
});
const indexes = [
  "CREATE INDEX signals_trial_delivery_created ON records(kind,json_extract(payload,'$.createdAt') DESC,id DESC,json_extract(payload,'$.signalId'),json_extract(payload,'$.channelId'),json_extract(payload,'$.kind'),json_extract(payload,'$.title'),json_extract(payload,'$.status'),json_extract(payload,'$.attempts'),json_extract(payload,'$.nextAt'),json_extract(payload,'$.expiresAt'),json_extract(payload,'$.manualRetry'),json_extract(payload,'$.sourceDeliveryId'),json_extract(payload,'$.summarySignalIds'),substr(json_extract(payload,'$.error'),1,300)) WHERE kind='delivery'",
  "CREATE INDEX signals_trial_signal_created ON records(kind,json_extract(payload,'$.createdAt') DESC,id DESC) WHERE kind='signal'",
  "CREATE INDEX signals_trial_delivery_signal ON records(kind,json_extract(payload,'$.signalId'),id,json_extract(payload,'$.status')) WHERE kind='delivery'",
  "CREATE INDEX signals_trial_summary_members ON records(kind,json_type(payload,'$.summarySignalIds'),json_extract(payload,'$.summarySignalIds'),id,json_extract(payload,'$.status')) WHERE kind='delivery' AND json_type(payload,'$.summarySignalIds')='array'",
];

try {
  if (indexed) for (const sql of indexes) db.exec(sql);
  const plans: unknown[] = [];
  const originalPrepare = db.prepare.bind(db);
  let inspect = false;
  db.prepare = ((sql: string) => {
    const statement = originalPrepare(sql);
    if (!inspect) return statement;
    return new Proxy(statement, {
      get(target, key) {
        if (key === "all" || key === "get")
          return (...args: unknown[]) => {
            plans.push({
              sql,
              plan: originalPrepare("EXPLAIN QUERY PLAN " + sql).all(...args),
            });
            return target[key](...args);
          };
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  }) as typeof db.prepare;
  const results = [];
  for (const [name, run] of [
    ["monitors", () => monitorWorkspacePage(db, {})],
    ["signals", () => signalWorkspacePage(db, {})],
    ["deliveries", () => deliveryWorkspacePage(db, {})],
    ["summary", () => monitorWorkspaceSummary(db, signalsFixtureTime)],
    [
      "delivery-filter-miss",
      () => deliveryWorkspacePage(db, { query: "no-matching-message" }),
    ],
    [
      "delivery-channel",
      () =>
        deliveryWorkspacePage(db, {
          channelId: "channel-fixture-1",
          status: "failed",
        }),
    ],
    [
      "signal-filter-miss",
      () => signalWorkspacePage(db, { query: "no-matching-signal" }),
    ],
  ] as const) {
    const times = [];
    let bytes = 0;
    for (let i = 0; i < 35; i++) {
      const start = performance.now();
      const value = run();
      if (i >= 5) times.push(performance.now() - start);
      bytes = Buffer.byteLength(JSON.stringify(value));
    }
    inspect = true;
    run();
    inspect = false;
    times.sort((a, b) => a - b);
    results.push({ name, p50: times[15], p95: times[28], bytes });
  }
  writeFileSync(
    join(
      tmpdir(),
      `logs/quant-signals/query-${indexed ? "indexed" : "initial"}.json`,
    ),
    JSON.stringify(results, null, 2),
  );
  console.log(JSON.stringify(results));
  writeFileSync(
    join(
      tmpdir(),
      `logs/quant-signals/query-plan-${indexed ? "indexed" : "initial"}.json`,
    ),
    JSON.stringify(plans, null, 2),
  );
} finally {
  if (indexed)
    for (const name of [
      "delivery_created",
      "signal_created",
      "delivery_signal",
      "summary_members",
    ])
      db.exec(`DROP INDEX IF EXISTS signals_trial_${name}`);
  db.close();
}
