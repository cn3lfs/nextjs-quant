import { randomUUID } from "node:crypto";
import { z } from "zod";
import { sqlite } from "./index";

const configSchema = z.object({
  enabled: z.boolean(),
  pollIntervalSec: z.number().int().min(15).max(300),
  monitorHoldingsStops: z.boolean(),
  monitorPlannedEntries: z.boolean(),
  monitorWatchlistRules: z.boolean(),
  intradayScanEnabled: z.boolean(),
});
export type IntradayAlertConfig = z.infer<typeof configSchema>;
const defaults: IntradayAlertConfig = {
  enabled: false,
  pollIntervalSec: 30,
  monitorHoldingsStops: true,
  monitorPlannedEntries: true,
  monitorWatchlistRules: true,
  intradayScanEnabled: false,
};
type ConfigRow = { [K in keyof IntradayAlertConfig]: number };

export function getIntradayAlertConfig(db = sqlite()): IntradayAlertConfig {
  const row = db
    .prepare<[], ConfigRow>(
      `SELECT enabled,poll_interval_sec AS pollIntervalSec,
    monitor_holdings_stops AS monitorHoldingsStops,monitor_planned_entries AS monitorPlannedEntries,
    monitor_watchlist_rules AS monitorWatchlistRules,intraday_scan_enabled AS intradayScanEnabled
    FROM intraday_alert_config WHERE id='default'`,
    )
    .get();
  if (!row) return { ...defaults };
  return {
    enabled: !!row.enabled,
    pollIntervalSec: row.pollIntervalSec,
    monitorHoldingsStops: !!row.monitorHoldingsStops,
    monitorPlannedEntries: !!row.monitorPlannedEntries,
    monitorWatchlistRules: !!row.monitorWatchlistRules,
    intradayScanEnabled: !!row.intradayScanEnabled,
  };
}

export function saveIntradayAlertConfig(
  input: IntradayAlertConfig,
  db = sqlite(),
) {
  const config = configSchema.parse(input);
  db.prepare(
    `INSERT INTO intraday_alert_config (id,enabled,poll_interval_sec,monitor_holdings_stops,
    monitor_planned_entries,monitor_watchlist_rules,intraday_scan_enabled,updated_at) VALUES ('default',?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET enabled=excluded.enabled,poll_interval_sec=excluded.poll_interval_sec,
    monitor_holdings_stops=excluded.monitor_holdings_stops,monitor_planned_entries=excluded.monitor_planned_entries,
    monitor_watchlist_rules=excluded.monitor_watchlist_rules,intraday_scan_enabled=excluded.intraday_scan_enabled,
    updated_at=excluded.updated_at`,
  ).run(
    Number(config.enabled),
    config.pollIntervalSec,
    Number(config.monitorHoldingsStops),
    Number(config.monitorPlannedEntries),
    Number(config.monitorWatchlistRules),
    Number(config.intradayScanEnabled),
    Date.now(),
  );
  return config;
}

const ruleSchema = z.object({
  id: z.string().trim().min(1).default(randomUUID),
  symbol: z.string().trim().min(1),
  direction: z.enum(["above", "below"]),
  thresholdPrice: z.number().finite().positive(),
  enabled: z.boolean().default(true),
  note: z.string().default(""),
});
export type IntradayWatchRule = z.output<typeof ruleSchema> & {
  lastTriggeredDate: string | null;
  createdAt: number;
  updatedAt: number;
};
type RuleRow = Omit<IntradayWatchRule, "enabled"> & { enabled: number };
const columns = `id,symbol,direction,threshold_price AS thresholdPrice,enabled,note,
  last_triggered_date AS lastTriggeredDate,created_at AS createdAt,updated_at AS updatedAt`;
const fromRow = (row: RuleRow): IntradayWatchRule => ({
  ...row,
  enabled: !!row.enabled,
});

export function listIntradayWatchRules(db = sqlite()) {
  return db
    .prepare<[], RuleRow>(
      `SELECT ${columns} FROM intraday_watch_rules ORDER BY enabled DESC,symbol,id`,
    )
    .all()
    .map(fromRow);
}

export function upsertIntradayWatchRule(
  input: z.input<typeof ruleSchema>,
  db = sqlite(),
) {
  const rule = ruleSchema.parse(input);
  const row = db
    .prepare<Record<string, string | number>, RuleRow>(
      `INSERT INTO intraday_watch_rules
    (id,symbol,direction,threshold_price,enabled,note,created_at,updated_at)
    VALUES (@id,@symbol,@direction,@thresholdPrice,@enabled,@note,@now,@now)
    ON CONFLICT(id) DO UPDATE SET symbol=excluded.symbol,direction=excluded.direction,
    threshold_price=excluded.threshold_price,enabled=excluded.enabled,note=excluded.note,
    updated_at=excluded.updated_at RETURNING ${columns}`,
    )
    .get({ ...rule, enabled: Number(rule.enabled), now: Date.now() })!;
  return fromRow(row);
}

export function deleteIntradayWatchRule(id: string, db = sqlite()) {
  return (
    db.prepare("DELETE FROM intraday_watch_rules WHERE id=?").run(id)
      .changes === 1
  );
}

export function markIntradayWatchRuleTriggered(
  id: string,
  tradeDate: string,
  db = sqlite(),
) {
  const day = z.string().date().parse(tradeDate);
  return (
    db
      .prepare(
        `UPDATE intraday_watch_rules SET last_triggered_date=@day,updated_at=@now
    WHERE id=@id AND enabled=1 AND (last_triggered_date IS NULL OR last_triggered_date<@day)`,
      )
      .run({ id, day, now: Date.now() }).changes === 1
  );
}
