# Guanlan optimization plan (2026-11-14): from a clean codebase to a terminal that makes money

## Context

The 2026-11-13 plan (P0–P5) was engineering cleanup and is fully committed (handoff `docs/handoff-2026-11-14.md`). That work covered retiring legacy paths, the page model, typed repositories, gates and docs. The code is now in good order, but the product still does not help you make money.

- **No strategy has proven profitability.** The CSI800 multi-factor main candidate failed its late-period excess target. The B3 event studies are labeled "sample insufficient". The 217-method S7 batch was never backtested on real data (per the 09-21 results register).
- **The rules you actually pick stocks with can't be backtested.** Formula, double breakout and RPS live in screening only.
- **Alerts don't run.** The signal monitor, signal ledger and intraday pre-selection are paused. Stops saved on holdings never alert.

Your directions for this plan:

- Focus on bottlenecks and real usability, not small details.
- Integrate toward the best structure, without compatibility shims.
- Treat it as a general multi-market terminal: A-shares and crypto equally, with universal methods.
- Run **several methods side by side, each with a set share of capital**:
  - **A-shares:** 1–4 week swing trading is the main method. When the market or a stock reaches a **historical low zone**, build long-term positions.
  - **Crypto:** swing trading is the main method, with **short-term breakout trading** as a supplement.
- Build **one unified alert engine** (notifications only).
- Use **free data first, with gaps labeled**.
- Optimize in a **balanced** way: integrate rather than delete capabilities.
- Split the work into **as many rounds as needed** instead of trimming scope.

## Principles

1. **Judge by trading outcomes.** Each round is judged by time-to-decision, signal trust and risk control, not code metrics.
2. **Integrate, don't delete.** Every current capability gets a home in the new structure (see the capability map). Only _duplicate implementations_ are removed, and only after the merged path passes parity tests on the same inputs. Old internal APIs get no compatibility shims. Dropping a user-facing capability needs your sign-off.
3. **Market-agnostic core, with market rules as data.**
   - The same strategy, backtest, alert and account machinery serves A-shares, crypto and futures.
   - A-share specifics (T+1, 100-share lots, price limits, trading calendar) live in a market rule table, not code branches.
   - Crypto specifics (24/7 trading, fractional size, venue fees) live in the same table.
4. **Honest evidence.** Every result carries its bias level: universe completeness, price adjustment and financial point-in-time quality. A strategy is only "validated" after it passes out-of-sample.
5. **Alerts, never automatic real orders.** Crypto testnet simulated trading keeps its current scope. Real-money execution is outside this plan (see Gates).

## Diagnosis: six bottlenecks

| #   | Bottleneck                                            | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                          | Effect on trading                                                     |
| --- | ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| B1  | No proven edge                                        | CSI800 failed its late-period target. `/backtest` runs only a single-security 5-minute SMA5/20. The strategy-center portfolio backtest caps at 50 hand-picked stocks over 2 years and is marked "rule-check-only" (`src/server/strategies/strategy-center-portfolio.ts`). The walk-forward entry was retired with no replacement                                                                                                  | You can't tell which rule makes money                                 |
| B2  | The same idea is implemented four times               | Formula screening (`src/lib/formula`), monitor rules (`src/server/monitoring/monitor-strategy.ts`: dual-breakout/czsc/metrics), the strategy-center catalog (`packages/trading-strategies/src/unified.ts`) and the crypto bot (`crypto-dual-ma.ts` + `crypto-trading/service.ts`). There are also three backtest engines in `quant-backtest`: `runBacktest`, `runClassicStudy` and `runCsi800Study`                               | What gets backtested is not what alerts you or trades                 |
| B3  | The daily loop is broken                              | Three schedulers are paused in `src/server/runtime.ts`. Holding stops are "不自动卖出" and nothing watches them. The home timeline shows intraday batches that never run                                                                                                                                                                                                                                                          | You watch charts by hand and miss exits                               |
| B4  | Inconsistent price basis and an A-share-shaped domain | `Snapshot.adjustment: "none"`. Formula screening is forced to unadjusted prices (`formula-screen-service.ts`), RPS uses backward-adjusted prices, and the chart is optional. `periodSchema` only has `day`/`5m`. Crypto is a separate silo with its own page, bot, tick and periods                                                                                                                                               | False signals at ex-rights dates; crypto can't use the A-share tools  |
| B5  | Slow, duplicated market-data path                     | There are several overlapping daily-bar readers and caches (`tdx-daily-cache`, `tdx-daily-overlay`, `tdx-full-day-cache`, `vipdoc-adapter`, `tdx-increment-refresh`). The full-day cache stores whole bar arrays as JSON in `records`. Historical measurements (11-08 and 11-13 deliveries; to be re-measured): a full-market formula scan took about 15 s for a simple MA cross and about 70–75 s with candidate snapshots saved | Iterative research and parameter sweeps over history aren't practical |
| B6  | Pages organized by module, not by the trading day     | There are 24 routes. One decision means hopping across 盘中预选 → 信号与通知 → 信号台账 → 行情 → 持仓 → 交割单, and research is split between 策略中心 and 策略实验 on different engines                                                                                                                                                                                                                                          | High friction, so the tool gets used less                             |

## Target structure

```text
             ┌──────────── Market rule table (A-share / crypto / futures) ────────────┐
Data sources → BarStore (one cache, adjusted-on-read, live overlay) → Strategy (universe + entry + exit + sizing)
                                                                        │
                       Allocation: per-market sleeves with target capital shares
                       (A-share: swing ▸ long-term low-zone; crypto: swing ▸ short-term breakout)
                                                                        │
             ┌───────────────┬───────────────┬────────────────┬─────────┴──────┐
             Scan (as-of)   Backtest (history)   Watch (alerts)    Paper (sim bots)
             └───────────────┴───────┬───────┴────────────────┴────────────────┘
                     Portfolio event engine + quant-performance metrics
                                     │
     Plans (entry/stop/target/size) → Accounts (A-share ledger + crypto accounts/bots) → Review & attribution
```

### Capability map: every current page keeps a home

| New workspace         | Absorbs (functionality kept)                                                                                                                                                          |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Today**             | 今日总览, the feed parts of 盘中预选 and 信号与通知, market regime (market temperature/index trend, BTC trend)                                                                        |
| **Scan & Chart**      | 行情图表, 证券池, RPS 排名 (as columns/filters plus its data-management tab), 条件选股, 打板情绪 (as pools/filters), and crypto and futures charts (as markets in the same workspace) |
| **Strategy Lab**      | 策略中心, 策略实验, 证据分析, 研究档案, 研究数据指南                                                                                                                                  |
| **Accounts & Review** | 持仓与交易日志, 交割单与交易复盘, 信号台账 (as alert history plus forward returns), crypto accounts and simulated bots                                                                |
| **Intel**             | 新闻/主题, 财联社复盘. They also feed chart annotations and Today                                                                                                                     |
| **System**            | 数据与连接, 任务中心, alert channels/subscriptions, ui-gallery (dev)                                                                                                                  |

### Method allocation (sleeves)

Each market's account is split into **sleeves**. A sleeve is a group of strategies with its own capital share, risk-per-trade limit and holding horizon. The engine, alerts, plans and review all work per sleeve. The shares below are starting proposals; you set the real values in settings, and Round 2 backtests the combined book to check them.

| Market  | Sleeve              | Role          | Proposed share                                        | Typical rules / periods                                                                                                                     |
| ------- | ------------------- | ------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| A-share | Swing               | Main          | 60–70% (all idle capital when no low zone)            | Multi-period RPS strength, double breakout, Chan third buy, saved formulas; daily bars; 1–4 week holds; ATR or trailing stops               |
| A-share | Long-term low-zone  | Opportunistic | 0% normally, rising to 30–40% as the low zone deepens | Activates only when the market or a stock is in a historical low zone. Buys in stages, holds long, exits on valuation recovery or high zone |
| Crypto  | Swing               | Main          | 70–80%                                                | 4h/daily trend (dual MA, breakout); trailing stops                                                                                          |
| Crypto  | Short-term breakout | Supplement    | 20–30%                                                | 15m/1h range breakouts; tight stops and time stops; fee and slippage stress mandatory                                                       |

**Historical low zone** is defined from data the project already has, with a confidence label because some inputs are approximations:

- price percentile over 5–10 years, for the index and for each stock
- PE/PB percentiles computed from local TDX financials (`tstdx` financial model, `src/server/research/index-context.ts`)
- market temperature from the `market-analyst` method the app already reads
- drawdown from the prior high

## Round 1: market and data foundation, one strategy definition, one engine

Goal: the same rule screens, backtests and charts identically on A-shares and crypto, on adjusted prices, and fast.

1. **Market model.**
   - Instruments carry `market`.
   - Add a market rule table: calendar/session, settlement (T+1 / T+0), lot size, price limits, fees, shorting.
   - Widen periods to day/week plus intraday (60m/15m/5m, and 4h/1h for crypto), with derived periods built from base bars.
   - Reuse `src/lib/market/{crypto,futures,market-session,security-trading-status}.ts` and the `quant-backtest` `costs`/`execution` modules.
2. **BarStore.**
   - One module replaces the overlapping daily/intraday readers and caches and adds crypto klines (`data-sources/binance/binance-klines.ts`, `crypto-venues/venue-klines.ts`).
   - Binary columnar cache per instrument×period under `QUANT_DATA_DIR`, keyed by source version, updated incrementally.
   - A today-partial-bar overlay from online quotes.
   - Adjustment is applied on read (none/forward/backward), using the GBBQ backward factors that `packages/tstdx/src/local/gbbq.ts` already computes.
   - Signals default to adjusted prices; fills and accounts use raw prices.
   - TDX and Blocks stay read-only.
3. **Free-data universe.**
   - Build the best point-in-time universe from the security-lifecycle cache and `readTdxCodeChanges`, including delisted names where known.
   - Every universe carries a coverage label, reusing `src/server/research/universe-audit.ts`.
4. **Strategy object.**
   - A strategy is a universe, an entry, an exit (stop/target/trailing/time), sizing and a market.
   - Rules are written in the existing formula language (`src/lib/formula`: parse, static check, series evaluation) or as registered native rules:
     - breakout (`trading-strategies/research/breakout`)
     - Chan third buy through the existing serial CZSC worker
     - RPS thresholds (`quant-rps`)
     - `crypto-dual-ma`
     - `factorStrategySchema`
   - The 695-method catalog stays as the rule library, with each method marked "runnable" or "reference only".
5. **One portfolio event engine.**
   - Generalize `quant-backtest` to:
     - many instruments with shared cash
     - the market rule table
     - next-bar-open fills
     - intrabar stops
     - costs and slippage
   - It supports sleeves: per-sleeve capital share and risk limits inside one market account, rebalancing between sleeves, and staged entries (buying in several tranches).
   - It absorbs `runBacktest`, `runClassicStudy`, `runCsi800Study` and `strategy-experiment`. Their existing fixtures become parity tests (same inputs give the same fills) before the old entry points go.
   - `quant-performance` stays the metrics layer.
6. **Four drivers on one evaluation.**
   - Scan, backtest, watch and paper all call the same rule evaluation.
   - The crypto bot tick becomes the paper driver. The exchange adapter (`crypto-trading/adapter.ts`) stays as the venue, with the same testnet scope.
7. **Schema.**
   - Add tables for the bar index, strategies, plans and alerts in one migration window.
   - Test on an isolated `QUANT_DATA_DIR`, back up the user DB before upgrading and bump `user_version`. Old executables will refuse the upgraded DB; report this at delivery.

**Done when:**

- The golden test passes: for fixed dates, scan output, backtest signals and watch triggers are identical for the same strategy (A-share and crypto fixtures).
- All old engine fixtures reach parity.
- Full-market load and simple scan times on real data (isolated data dir, read-only TDX) are measured before and after. The target is a warm simple scan under 5 s, down from about 15 s.
- Charts, RPS and formula all state their adjustment.

## Round 2: find an edge, and make the daily loop work

Goal: an honest scoreboard for each sleeve and for the combined book, plus alerts you can rely on.

1. **Validation suite** in the engine:
   - in-sample/out-of-sample split, and rolling walk-forward (a proper restoration of the retired capability)
   - cost ×2 and +1-day delay stress
   - parameter-neighborhood stability
   - minimum trade count
   - regime breakdown
   - benchmarks: index or equal-weight universe for A-shares, buy-and-hold for crypto
   - reuse `src/lib/backtest/backtest-overfit.ts` and `multiple-testing.ts` for overfitting and multiple-testing control
2. **Candidates for each sleeve** (see the sleeve table):
   - **A-share swing:** multi-period RPS strength, double breakout, Chan third buy, your saved formulas.
   - **A-share long-term low-zone:**
     - build the low-zone detector as its own testable rule
     - staged buys as the zone deepens; exit on recovery or high zone
     - tested on the longest available history, judged per market cycle rather than on short windows
   - **Crypto swing:** 4h/daily trend (dual MA, breakout) on BTC/ETH and high-liquidity pairs.
   - **Crypto short-term breakout:** 15m/1h range breakouts with tight and time stops. Fee and slippage stress decides whether it survives.
   - Exit and sizing variants (ATR stop, trailing stop, time stop) are part of each strategy.
   - **Combined book:** backtest each market with its sleeve shares and rebalancing. Check sleeve correlation and the combined drawdown, and compare against the shares you set.
3. **Promotion gates.** Proposed defaults, which you can adjust:
   - positive after-cost excess return in most out-of-sample windows
   - a drawdown bound
   - survives the stress tests
   - enough trades

   Promoted strategies go to live watch and paper trading; the rest stay in research. If nothing passes, report why and iterate on exits, filters and regime instead of loosening the gates.

4. **Unified alert engine.**
   - Replaces the three paused schedulers and the monitor loop inside `runtime.ts`.
   - Runs crypto 24/7 on the same clock abstraction.
   - Watches:
     - promoted strategies' entries on tomorrow's candidates and the watchlist
     - holding stop, target and trailing levels
     - regime flips
     - the market or a stock entering, deepening or leaving a historical low zone, with the next staged-buy tranche
     - a sleeve drifting far from its target share
   - Delivers through the existing outbox, channels and policy (`infra/notifications.ts`, `db/notification-policy-store.ts`).
   - Dedupe key is strategy × instrument × bar. Missed windows are marked missed with no catch-up burst, and restarts are safe through `infra/lease.ts`.
   - The A-share post-close scan is gated on the existing download receipt (`jobs/workflow-scheduler.ts`).
5. **Alert history becomes the signal ledger.** Each alert gets T+5/10/20 forward returns (already defined in `docs/invariants.md`), giving each strategy a live out-of-sample track record.
6. **Trade plan object.**
   - A plan holds its sleeve, entry (or staged tranches), stop, target and expiry.
   - Size comes from the sleeve's risk % and remaining budget.
   - Plans feed alerts and later review.
7. **Rollout.**
   - Fake-clock tests first.
   - Then 1–2 weeks of shadow mode on real data, logging alerts without sending them.
   - Then enable channels.

**Done when:**

- The scoreboard exists per sleeve and for each market's combined book, with bias labels on every row.
- The low-zone detector is backtested on its own, so you can see when it would have fired in past cycles.
- Shadow-mode alerts match post-hoc scans with no duplicates or missed-window bursts.
- A holding crossing its stop produces exactly one alert.

## Round 3: workspaces, accounts and the feedback loop

Goal: the daily path takes a few interactions, and the system tells you which rules (and habits) make or lose money.

1. **Navigation by trading day** (see the capability map). These are UI merges only; every capability is kept.
   - **Today:** regime and low-zone status per market, sleeve allocation vs target, tomorrow's plan (candidates with entry, stop and size), triggered alerts, holdings at risk and data readiness, with one primary action.
   - **Scan & Chart:** pick a strategy or formula, see the result list, open the chart with entry and stop drawn, then add to plan. Markets switch in place.
2. **Accounts & Review:**
   - Unified positions across the A-share ledger, crypto accounts and simulated bots.
   - Per-position risk: stop distance, R-multiple, exposure by market, sleeve and sector, and correlation (`portfolio/holdings-correlation-service.ts`, `position-risk-service.ts`).
   - Exposure caps checked when a plan is created.
3. **Attribution.**
   - Each trade links to its plan, strategy and alert.
   - Per strategy and per sleeve, compare backtest expectation, live alert record and your actual fills, and flag decay.
   - A monthly review of your own leaks (holding past stop, oversizing, chasing), reusing `src/lib/research/risk/discipline-counterfactual.ts` and `src/lib/portfolio/trade-review-attribution.ts`.
4. **UI debt handled inside these rewrites, not as separate projects:**
   - one number formatter (`toFixed` is scattered across about 44 components)
   - three breakpoints instead of five
   - remove dark-mode leftovers
   - one icon library instead of lucide plus phosphor

**Done when:**

- Playwright daily-path flows at 1440 and 1024 pass.
- Opening the app to reaching tomorrow's plan takes 3 interactions or fewer.
- The review reconciles to imported delivery cash.
- The decay flag fires on a fixture strategy whose live record diverges.

## Throughout all rounds

- Gate: `pnpm check --build` on isolated data. Add golden/parity tests and performance budgets for the full-market scan and backtest. `desktop:prepare` at each round's delivery; packaging, commits and pushes each need their own authorization.
- Docs: at the start of each round, `roadmap.md`, `next-plan.md` and `architecture.md` are updated to this plan. That includes the multi-market goal and the sleeve-based trading style, so later sessions don't treat the project as A-share-only. Historical docs are not purged.
- Unchanged invariants:
  - the CZSC native single serial process
  - TDX and external Blocks are read-only
  - `src/server/mcp.ts` is left untouched
  - credentials use DPAPI
  - no user-DB work without an isolated test first

## Execution: Claude directs, Codex implements

- **Roles.**
  - Claude acts as manager: writes dispatches, sets acceptance gates, reviews diffs, re-runs key checks and commits.
  - Codex is the executor: implements and verifies, and never commits, pushes or packages.
  - Standing rules for Codex come from `docs/executor-brief.md` §4–§7. §1–§3 and §6's "methods only" rule apply to the old method-batch work, not to this plan; each dispatch overrides them explicitly.
- **Mechanics.**
  - Each dispatch is written to `.codex-runs/dispatch-<id>.md`: goal, files and reused modules from this plan, done-when, and forbidden actions.
  - It runs in the background: `codex exec --disable code_mode ... < /dev/null`, with a log in `.codex-runs/<id>/`.
  - Codex keeps `.codex-runs/delivery.json` updated with real exit codes.
  - Claude polls about every 9.5 minutes. If the log or delivery file hasn't advanced for two polls, the run is treated as hung, stopped and re-dispatched from `nextStart`.
- **Batches.** Round 1 runs as sequential dispatches; independent parts may run in parallel only in separate git worktrees.
  - **R1a:** market rule table and widened periods; BarStore with adjusted-on-read, live overlay and crypto klines; parity against the current readers; real-data timing before and after (isolated `QUANT_DATA_DIR`, read-only TDX).
  - **R1b:** strategy object (formula plus native rules, sleeves); portfolio event engine with parity tests against `runBacktest`, `runClassicStudy`, `runCsi800Study` and `strategy-experiment`.
  - **R1c:** the four drivers (scan, backtest, watch, paper) wired to the engine; cross-driver golden test; schema migration on isolated data; consumers switched over; duplicate paths removed only after parity passes.
  - Rounds 2 and 3 are dispatched the same way once Round 1 is accepted.
- **Acceptance per batch.**
  - Claude reads the diff.
  - Claude re-runs the batch's tests and typecheck, then `pnpm check --build` on isolated data at the end of the batch.
  - Claude checks that no protected path changed: `src/server/mcp.ts`, the TDX/Blocks directories, and source snapshots.
  - Approving this plan authorizes **local commits per accepted batch**. Push, packaging and user-DB upgrades still need separate approval.
- **Housekeeping.**
  - Disk: D: has about 29 GB free and `.codex-runs` already holds 4.1 GB.
  - Each batch keeps its artifacts in one task directory with a dry-run-by-default cleanup script. Claude runs it after acceptance.

## Gates and out of scope

- **Real-money automatic orders** (A-share or crypto mainnet) are not in this plan. If you want them, a separate proposal can come after a strategy has a live alert track record.
- **Paid data** gets revisited after Round 2 only if a promising strategy proves sensitive to survivorship or point-in-time bias.

## Verification

- **Round 1:**
  - BarStore output matches the current readers bar-for-bar on fixtures.
  - Adjusted series match GBBQ factor math.
  - Old engine fixtures reach parity.
  - The cross-driver golden test passes.
  - Real-data timings are taken before and after.
- **Round 2:**
  - Validation reports are reproducible from frozen inputs, with input hashes.
  - Fake-clock alert tests pass: dedupe, missed window, restart, holiday, crypto 24/7.
  - The shadow-mode log is compared against scans.
- **Round 3:**
  - Playwright daily-path and keyboard flows pass.
  - Account and review reconciliation tests pass.
  - The decay-flag fixture fires.
- **Every round:** `pnpm check --build` exits 0, `pnpm desktop:prepare` passes, and the delivery note lists the schema version impact and any artifacts kept or cleaned.
