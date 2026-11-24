import { ledgerOutcome, horizons } from "~/lib/strategy-facts/signal-ledger";
import { beijingClock } from "~/lib/market/market-session";
import { localCalendarReference } from "../market/data-health";
import { settings } from "../infra/settings";
import { readBars } from "../market/bar-store/read-bars";
import { readGbbq } from "tstdx/local";
import { AlertRepository } from "../db/alert-repository";

export async function settleAlertOutcomes(now: number, repo: AlertRepository) {
  const config = settings();
  const events = repo.pendingOutcomes();
  let item = events.next();
  if (item.done) return;
  const reference = await localCalendarReference(
    config.tdxRoot,
    config.calendar,
  );
  let actions: Awaited<ReturnType<typeof readGbbq>> | null = null;
  try {
    actions = await readGbbq(config.tdxRoot);
  } catch {
    /* Unknown coverage stays blank. */
  }
  let coverageEnd: string | null = null;
  if (actions) {
    for (const entries of actions.events.values()) {
      for (const { date } of entries) {
        if (!coverageEnd || date > coverageEnd) coverageEnd = date;
      }
    }
  }
  for (; !item.done; item = events.next()) {
    const event = item.value;
    if (event.type === "plan-expired") {
      repo.outcomes(
        event.key,
        horizons.map((horizon) => ({
          horizon,
          settled: true,
          entryDate: null,
          exitDate: null,
          entry: null,
          exit: null,
          returnPct: null,
          action: "除权状态未知",
          reasons: ["到期事件不是价格入场样本"],
          calendarSource: "不适用",
          actionSource: "不适用",
        })),
      );
      continue;
    }
    const crypto = event.market === "crypto";
    // Anchor forward returns on the signal bar, not on when the scan happened.
    // A close scan finishing after midnight must not shift T+1 by a day.
    const observedDate = event.bar.slice(0, 10);
    const clock = beijingClock(now);
    const completedThrough = crypto
      ? new Date(now - 86400000).toISOString().slice(0, 10)
      : clock.minutes >= 905
        ? clock.date
        : (reference.days.filter((d) => d < clock.date).at(-1) ?? "");
    const days = crypto
      ? Array.from(
          {
            length: Math.max(
              21,
              Math.ceil((now - Date.parse(observedDate)) / 86400000) + 21,
            ),
          },
          (_, i) =>
            new Date(Date.parse(observedDate) + i * 86400000)
              .toISOString()
              .slice(0, 10),
        )
      : reference.days;
    let bars: Awaited<ReturnType<typeof readBars>>["bars"] = [];
    try {
      const data = await readBars({
        instrument: { market: event.market, symbol: event.symbol },
        period: "day",
        adjustment: "none",
        from: observedDate,
        now,
        root: config.tdxRoot,
      });
      bars = data.bars.filter(
        (b) => !data.barStore.formingDates.includes(b.date),
      );
    } catch {
      /* First due observation freezes missing source explicitly, no late rewrite. */
    }
    const evidence = crypto
      ? {
          dates: [],
          coverageEnd: completedThrough,
          source: "数字货币UTC自然日；股票除权不适用",
        }
      : {
          dates: (actions?.events.get(event.symbol) ?? [])
            .filter((e) => [1, 11, 12].includes(e.category))
            .map((e) => e.date),
          coverageEnd,
          source: actions?.path ?? "GBBQ缺失或不可读",
        };
    repo.outcomes(
      event.key,
      horizons.map((h) =>
        ledgerOutcome(
          { observedDate },
          h,
          bars,
          days,
          crypto ? "UTC连续自然日" : reference.source,
          evidence,
          completedThrough,
        ),
      ),
    );
  }
}
