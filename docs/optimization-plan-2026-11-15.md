# Guanlan trading lifecycle: bottleneck review and optimization plan (2026-11-15)

## Context

Rounds R1–R3 of the 2026-11-14 plan are committed and deployed (last commit `ee1374f`, real DB schema 18). The engineering is now unified: one BarStore, one strategy object, one portfolio engine, four drivers, one alert engine, paper accounts and six workspaces. The trading result is still empty:

- **0 strategies promoted**, 5 shadow candidates paper-trading since 2026-11-15T11:31Z with 0 forward signals.
- Alerts are in shadow mode, external mirrors are off, crypto capital is 0 and the crypto breakout sleeve still defaults to 25%.

You asked for a lifecycle review covering data → display → trading algorithm → position management → result review. The review should go coarse first, then zoom into each sub-process, then merge the findings into one optimization plan. This document is that review. It is grounded in:

- the history docs: optimization plans 09-29, 11-13 and 11-14; handoffs 11-07, 11-14 and 11-15; `decisions.md` R1a–R3c; the 09-21 results register; the 11-08 CSI800 multi-factor and risk deliveries; the R2a-5 scoreboard
- a code sweep of each lifecycle stage, with file:line evidence

## 1. The road so far, and what it teaches

| Period        | What was tried                                                                                                                                    | Outcome                                                                                                                                                                                                                                                                         |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 09-xx         | Catalogued 695 methods from trading skills; B3/B4/B5 batch event studies on the current A500                                                      | 1.3 M events, labels mostly "样本不足"; 217 S7 methods never backtested; 35 GB of raw output deleted                                                                                                                                                                            |
| 09-29 → 10-xx | Runtime and UX rounds (keep-alive, code splitting, daily-readiness ideas)                                                                         | Faster app; no trading edge work                                                                                                                                                                                                                                                |
| 11-07         | Restarted backtesting as a TS package from one 5m SMA baseline; all old strategies retired                                                        | Clean engine, but only a toy strategy                                                                                                                                                                                                                                           |
| 11-08         | CSI800 classic multi-factor (29 factors, weekly top-20, 15% cap, volatility budget), then per-position risk layers (8%/2%, breakeven, ATR, EMA50) | **Five-family + vol budget: 20.1% annualized, 14.2% max DD (2018-09→2026-11, current-constituent bias)**. The pre-registered main candidate failed late-period excess vs a matched index. The heavy exit layers (ATR, EMA50) cut return by 5–8 points without lowering drawdown |
| 11-10/11      | Unified strategy center, crypto dual-MA testnet bot, account history                                                                              | More surfaces, still no validated edge                                                                                                                                                                                                                                          |
| 11-13         | P0–P5 cleanup: truthful UI, page model, typed repositories, gates                                                                                 | Code in good order                                                                                                                                                                                                                                                              |
| 11-14/15      | R1–R3: market rules, BarStore, strategy object, portfolio engine, validation suite, alert engine, paper, workspaces                               | 609 trials, **0 promoted**; A-share swing fails mainly on drawdown (26–46%) and DSR; crypto 4h/1h/15m all lose; books with a breakout sleeve are negative                                                                                                                       |

Lessons that shape this plan:

1. **Breadth over depth.** Each round adds candidate families and variants instead of improving one book. Under the current DSR rule every added trial raises the bar for all future candidates (see §3.3).
2. **Rigor went into evidence plumbing, not portfolio construction.**
   - The only configuration that ever showed a tolerable drawdown is the cross-sectional, weekly-rebalanced multi-factor book with a volatility budget.
   - The unified strategy object cannot express "rank the universe, hold the top N, rebalance to target weights" (`decisions.md` R1c). So that family never entered the R2a gates, the shadow list or the paper accounts.
3. **Drawdown is a portfolio problem.** In 11-08, on the same factor selection:
   - volatility targeting cut drawdown from 23.3% to 17.8% for about 0.5 point of annual return;
   - a market switch alone cut drawdown only 1.5 points, at a 9-point return cost;
   - the full ATR and EMA50 exit layers cut return 5–8 points and _raised_ drawdown.

   The R2a swing candidates have no market-regime gate and no portfolio-level risk overlay at all.

4. **The holdout is spent.** The universe and gate rule changed after results were seen (R2a-4/5, disclosed). The only clean evidence starts at shadow registration on 2026-11-15. Forward evidence has to be designed so that it can conclude something in months, not years.
5. **The daily loop has never run on real days.** Shadow alerts and paper accounts started today. Nothing yet proves that the EOD pipeline, alerts, plans and review work together on a real trading day.

## 2. Coarse pass: the lifecycle on one page

| Stage                          | What exists                                                                                                        | Main bottleneck                                                                                                                                                                                                        | Severity                         |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| Data                           | Local TDX plus a 17:00 download task; BarStore; Binance official archives; CSI800 current roster; local financials | End-of-day data arrives after the alert window closes. One missing receipt stalls paper accounts. Crypto symbols don't match the reader. No index valuation or market temperature                                      | **Blocker**                      |
| Display                        | Six workspaces; Today shows regime, sleeves, plan table, alerts, risk and readiness                                | Plan table is always empty: no active strategies, and the scan never runs. Readiness almost always says "补齐数据". Candidates are unranked, unmerged and have no "why". One plan takes ≥4 actions across 2 workspaces | High                             |
| Trading algorithm and research | Strategy object, portfolio engine, validation suite, 609 trials, 0 promoted                                        | No regime, ranking or portfolio overlay. The ranked book can't be expressed. Exits all have the same shape. Method artifacts decide some verdicts                                                                      | High (the edge)                  |
| Position management            | Sleeves, risk %, plan sizing, exposure caps (all empty)                                                            | Live sizing differs from what was validated. No heat, weight or sector limits. Capital = 0. Plans are blocked outside the session                                                                                      | High                             |
| Execution support              | Alert engine (shadow), plans, 5 paper accounts, crypto bot                                                         | The close scan never runs. The forward assessment can't pass. Protection isn't attached to real holdings. A fixed 5-minute window applies to daily bars                                                                | **Blocker**                      |
| Review                         | Attribution, decay flag, monthly self-check, cash reconciliation                                                   | Informational only. Expectations and links are manual. No journal. No execution-quality measurement                                                                                                                    | Medium; High once trading starts |

**Reading the map.**

- The loop is broken in several places before strategy quality even matters:
  - the close scan never runs (E1);
  - the crypto symbols don't match the reader (E2);
  - no strategy is active for scanning (V2);
  - the forward assessment can't pass (E5);
  - plans can't be sized (P3, P4).
- Forward evidence only accumulates from the day these are fixed and deployed, so they come first.
- Next, make what you trade equal what was validated.
- Only then spend research effort, on portfolio construction and under corrected method.

## 3. Fine pass by stage

### 3.1 Data

| #   | Bottleneck                                       | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Effect                                                                                                                                  |
| --- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | **The EOD receipt lands after the alert window** | Receipt only from the 17:00 task (`workflow-task.ps1:20-42`; exit 3 = CDN still stale writes nothing). The engine accepts it 15:05–16:00 (`engine.ts:89-95`). The in-app g4day increment is commented out (`jobs/workflow-runner.ts:17-26,77-127`). BarStore serves the last `.day` file with no staleness flag (`read-bars.ts:103-128`)                                                                                                                                                   | Root cause of E1 and E4; the user doesn't see that data is stale                                                                        |
| D2  | **No live intraday data in the alert path**      | Daily reads pass `to: today`, which disables the online overlay (`alerts/inputs.ts:91`). Holding and plan checks read local `.lc5` 5-minute files (`inputs.ts:421,590`), which TDX doesn't update during the session                                                                                                                                                                                                                                                                       | Intraday backup checks run on yesterday's bars (low priority, since stops are broker orders)                                            |
| D3  | **Crypto gaps and symbols**                      | The live tail only covers yesterday 00:00 UTC onward (`public-data-store.ts:613-636`); backfill is manual. Archive reads skip gap checks. Symbol bug: see E2                                                                                                                                                                                                                                                                                                                               | Being offline for >1 day leaves silent holes                                                                                            |
| D4  | **BarStore redundant work**                      | Every warm read re-reads the whole `.day` file and computes CRC (`local-source.ts:22-40,76`). SHA-256 runs per process and per worker on first touch. A cache miss reads the source 4×. Forward factors are recomputed on every read. Binance zips are SHA'd twice even on a hit, and the cache key rolls daily, leaving orphans (`binance-archive-source.ts:53-89`). The close scan decodes ~5.5k RPS rows per symbol (`inputs.ts:211-222`). The scan runs inside the Next server process | The raw benchmark is 8.46 s vs an 8.4 s budget. An 800-symbol close scan may block the server for seconds (to be measured, not assumed) |
| D5  | **Data quality isn't surfaced**                  | Repairs are flagged (`priceRepaired`) but ignored by alerts. Per-symbol gaps and suspensions go unchecked (`data-health.ts:143`). `data-gap:*` states are written but never read by the UI. The GBBQ coverage check exists for RPS but not for signals. The iWencai trading-status check failing silently drops candidates (`inputs.ts:313-316`, needs `IWENCAI_API_KEY`)                                                                                                                  | Candidates vanish or are built on bad inputs without notice                                                                             |
| D6  | **Universe**                                     | Current CSI800 only (`tstdx/local/blocks.ts:178-197`), with no point-in-time history (`validation-universe.ts:64-66`). Paper accounts freeze 799 names and won't follow rebalances                                                                                                                                                                                                                                                                                                         | Look-ahead bias stays; this is a known gap and paid data needs your approval                                                            |
| D7  | **No index valuation or temperature**            | `index-context.ts:45` has `marketPercentile` null. The "temperature" is a 120-bar close percentile (`observations.ts:52-73`). Per-stock point-in-time PE/PB already exist (`validation-financials.ts:59-95`); aggregation to index level is not implemented                                                                                                                                                                                                                                | The low-zone signal is price-only and can't be corroborated                                                                             |

### 3.2 Display and the daily workflow

| #   | Bottleneck                                      | Evidence                                                                                                                                                                                                                                                                                                 | Effect                                                                      |
| --- | ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| V1  | **Today's plan table is empty by construction** | Only live or shadow-`active` strategies are scanned (`alert-repository.ts:53-58`, verified). Paper registration saves shadow `active:false` (`registration.ts:87-92`, verified, an R3c decision). And the scan never runs (E1)                                                                           | The main panel never fills while paper accounts trade the same 5 strategies |
| V2  | **Readiness is unreliable**                     | `dataMissing = !receipt \|\| needsBackfill` (`today-workspace.tsx:71-78`). The receipt is checked for today only. `needsBackfill` requires all 10 BTC/ETH series (`public-data-store.ts:594-602`), but alerts use only 1d/4h                                                                             | It almost always shows "补齐数据", so you learn to ignore it                |
| V3  | **Candidates are a list, not a decision**       | Newest bar first, 20 per page, no date window; sorting disabled (`candidate-table.tsx:60-61`). The same stock from two strategies shows as two rows (key: strategy × symbol × bar). The reason is a fixed string (`inputs.ts:323-325`) and isn't shown. No strategy signal or trade markers on the chart | You can't tell which candidate is best or why it's there                    |
| V4  | **The plan flow is scattered**                  | Today → /scan → 加入计划 → edit entry/stop/target/expiry (+3 manual fields for crypto, `candidate-plan.tsx:102-121`) → save → /accounts/alerts to see it. Open plans aren't shown on Today                                                                                                               | ≥4 actions across 2 workspaces for one plan                                 |
| V5  | **Refresh inconsistencies**                     | PaperFacts, MarketPulse and the Scan list use `useTaskVisible`, so they pause while the broker window has focus. `AccountRiskLinks` and `TodayIntel` never refresh. The intraday chart polls every 3 s even when hidden (`intraday-chart.tsx:51-67`)                                                     | Trading-critical panels go stale exactly when you're at the broker          |

### 3.3 Trading algorithm and research method

Evidence comes from `packages/trading-strategies/src/research-candidates.ts`, `packages/quant-backtest/src/{portfolio-engine,validation-suite}.ts`, `src/server/research/validation-replay.ts`, `scripts/lib/research/{scoreboard,study,books}.ts`, `src/lib/backtest/multiple-testing.ts` and the frozen R2a-5 artifacts.

**What exists.**

- Candidates are a small declared menu:
  - RPS multi (`RPS20/50/120 ≥ 80`, a state that re-fires daily)
  - double breakout (native status)
  - formula range (`C>REF(HHV(H,20),1) AND V>MA(V,20)`), pullback and MA cross
  - Chan third buy (30 names)
  - historical low
  - crypto dual-MA 10/40 and range breakout
- Exits are ATR (3×ATR14, set once at entry), trailing (8% stop + 10% trail) and "time" (8% stop).
- Sizing is 1/10 equal weight with 2% risk and 10 slots; crypto uses 50% per coin.

**Bottlenecks, ranked by expected impact on passing the gates honestly.**

| #   | Bottleneck                                                                                                               | Evidence                                                                                                                                                                                                                                                                                        | Effect                                                                                                                                                                                   |
| --- | ------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A1  | **No market-regime gate, exposure scaling or portfolio drawdown brake** in the strategy object or engine                 | `strategy-object.ts:114-190` has no such fields. The regime exposure in `allocation-profile.ts:822-832` and the `research/risk/{research-market-regime,research-loss-pause,research-group-risk}` modules are not reachable from the strategy object                                             | Drawdown breaches sit in bear windows: rps-multi-atr 40.3% (2021-10→2023-06). Drawdown is the main failing gate, and Sharpe stays below what DSR needs (~1.7 annualized for A-shares)    |
| A2  | **No signal ranking.** When signals exceed slots, pending buys fill sells-first, then by sleeve, then **alphabetically** | `portfolio-engine.ts:841-847` (verified)                                                                                                                                                                                                                                                        | The 10-slot book is always full (rps-multi ≈ 10 slots × 409/20 bars). Which stocks get bought is decided by symbol order, not signal strength. `sh` beats `sz`                           |
| A3  | **Cross-sectional families can't be expressed.** No "rank universe → hold top N → rebalance to target weights"           | `decisions.md` R1c                                                                                                                                                                                                                                                                              | The only configuration with a tolerable drawdown (11-08 five-family + vol budget, 14% DD) never entered the gates, shadow or paper                                                       |
| A4  | **Exits are all the same shape**                                                                                         | Every swing variant also gets `maxBars` = 20. The ATR stop never trails (`validation-replay.ts:198-219`). Event entries (CROSS, dual-MA) can't re-enter after a time exit; state entries churn                                                                                                  | Trends are cut at 20 days. The three "variants" are almost one hypothesis yet cost three DSR trials                                                                                      |
| A5  | **Low-zone detector over-fires and lacks corroboration**                                                                 | The book target is the max over the index **and ~799 stocks** (`books.ts:112-135`). The valuation check passes vacuously when inputs are missing (`historical-low.ts:181-210`). Temperature is always null                                                                                      | The target is non-zero on ~83% of days (R2a-5). The family can't pass by construction: only 2 CSI800 cycles exist since 2010 vs 3 required, and a low-confidence flag is always appended |
| A6  | **The backtest assumes resting stop orders, but nothing gives you the levels**                                           | The engine fills stops intrabar at min(open, stop) using the bar's high and low (`portfolio-engine.ts:861-884`). Live alerts fire only on a completed-bar close crossing (`alerts/observations.ts:18-50`). You confirmed you use broker 条件单/exchange stops, so the intrabar model is correct | The model only holds if, after every close, you get the exact initial, trailing and time-exit levels to place at the broker. Today nothing produces that list (see P5)                   |
| A7  | **Cost and rule gaps**                                                                                                   | The generic engine uses 5 bp sell tax for all years; the pre-2023-08-28 10 bp stamp duty exists only in `allocation-profile.ts:364`. ST 5% limits and IPO days aren't modelled. Idle cash earns 0, but Sharpe subtracts 2% rf, while DSR uses no rf                                             | 2010–2023 results are ~5 bp per sell too optimistic; the two Sharpe definitions are inconsistent                                                                                         |

**The method defects decide verdicts independently of the strategies.**

- **M1. Neighbourhood gate mis-specified** (`validation-suite.ts:119-125`, verified).
  - It counts neighbours with raw `inSample.excess > 0` over the first training block vs buy-and-hold. Every crypto row is therefore 0%: dual-MA's +51.6% vs BTC's run-up gives −1,139% excess.
  - Only exit parameters are perturbed (×0.9/×1.1).
  - No-op neighbours count as 100% stable: `historical-low-time` maxBars 680/832 can never bind in a 409-bar window, so its rows are byte-identical.
  - Every other gate moved to risk-adjusted in R2a-4; this one was missed.
- **M2. DSR trial pool** (`multiple-testing.ts:198-215` + `scoreboard.ts`).
  - N counts replays, 108 terminal-valuation accounting scenarios and identical rows as separate trials.
  - Trial Sharpe variance is taken from full-period Sharpes, while the tested series is the joined OOS windows.
  - The crypto variance is inflated 21× by 15m/1h trials (mean daily Sharpe −0.30). That makes SR* = 0.35 daily ≈ 6.7 annualized, which is unreachable. Without them, SR* ≈ 0.073 daily.
  - For A-shares N isn't what binds: the best CSI800 daily Sharpe (0.051) is below even an N = 30 threshold.
- **M3. Gate logic implemented 5 times** (`validation-suite.ts`, `validation-scale.ts`, `validation-replay.ts`, `scoreboard.ts`, `paper/assessment.ts`), with different N. The in-app and CLI DSR verdicts can disagree.
- **M4. Unused tools.** CSCV/PBO (`backtest-overfit.ts:99-232`) and the family-selected OOS DSR (`validation-replay.ts:372-384`) exist but aren't in the R2a-5 scoreboard.

**Takeaway.**

- The A-share failures are real: Sharpe is too low and drawdown too high, and both trace to A1–A4.
- The crypto failures are partly method artifacts (M1, M2) on top of a truly low trade count: 52 closed trades in 9 years.

### 3.4 Position management and risk

Evidence comes from `src/server/alerts/plans.ts`, `src/lib/portfolio/account-workspace.ts`, `src/server/portfolio/account-workspace-service.ts` and `src/server/paper/inputs.ts`.

| #   | Bottleneck                                                                    | Evidence                                                                                                                                                                                                                                                                | Effect                                                                                                |
| --- | ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| P1  | **Live sizing ≠ validated sizing**                                            | Plans size min(stage budget ÷ entry, risk budget ÷ (entry − stop)), with risk % of sleeve capital and no position cap (`plans.ts:165-185`). Research and paper use 1/10 equal weight, 2% risk, 10 slots (`paper/inputs.ts:213-220`)                                     | A tight stop can put 100% of a sleeve into one name. You'd trade a risk profile that was never tested |
| P2  | **No portfolio heat, max-weight, max-positions, sector or correlation limit** | Exposure caps default to empty (`account-workspace.ts:19`); correlation is display-only (`account-workspace-service.ts:797-806`)                                                                                                                                        | Concentration is unbounded; drawdowns cluster                                                         |
| P3  | **Capital = 0 blocks everything**                                             | `plans.ts:127-129` throws; every cap says "无法证明未超限"; sleeve-drift alerts are off (`inputs.ts:549`)                                                                                                                                                               | No crypto plan can be sized today                                                                     |
| P4  | **A-share plans can't be created in the evening or at weekends**              | The exposure marker must be < 10 min old and is refreshed only in session or the post-close scan (`plans.ts:131-140`, `engine.ts:78-97`). Imported fills start with sleeve "未知", which blocks every plan (`plans.ts:144-147`, `account-workspace-service.ts:201,240`) | Planning is blocked at exactly the time you plan                                                      |
| P5  | **Protection doesn't reach real holdings**                                    | Only manual-ledger and crypto-bot holdings are watched (`inputs.ts:478-524`). The plan's stop isn't carried to the holding. Trailing and time exits aren't stored on plans (`strategy-repository.ts:31-76`). Imported 交割单 holdings are never watched                 | The exits that make the backtest work are not followed in practice                                    |
| P6  | **Sleeves are budget ceilings plus an advisory drift alert**                  | `inputs.ts:547-577`; drift ignores imported holdings                                                                                                                                                                                                                    | Allocation discipline depends on memory                                                               |

### 3.5 Execution support: alerts, plans, paper

| #   | Bottleneck                                                         | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Effect                                                                                                                                                                                                    |
| --- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| E1  | **The A-share post-close scan can never run**                      | `engine.ts:89-95` (verified): the receipt is accepted only 15:05–16:00 and marked missed after 16:00. The receipt `download-<date>-close.json` is written only by the 17:00 scheduled task (`workflow-task.ps1`, `install-workflow-tasks.ps1:36`), because the TDX package isn't current until ~16:37                                                                                                                                                                                                                                                                                                                                                                                                                                                        | No A-share candidates, market state, low-zone reading, daily stop check or shadow samples, ever                                                                                                           |
| E2  | **Crypto symbol format bug**                                       | `readBars` validates `instrumentSchema`, which requires `cx` + pair (`lib/market/crypto.ts:9`, `instrument.ts:14-18`, `read-bars.ts:277`). The alert inputs filter `/^[A-Z0-9]+USDT$/` and pass `BTCUSDT`/`ETHUSDT` (`alerts/inputs.ts:192-196,640`). The paper candidates freeze `"symbols":["BTCUSDT","ETHUSDT"]` and `paper/inputs.ts:45` passes them through. Tests mock the reader (`alert-inputs.test.ts:35`)                                                                                                                                                                                                                                                                                                                                          | Crypto signals, crypto regime, bot protection and both crypto paper accounts very likely fail at the first read (confirm against the live log)                                                            |
| E3  | **Fixed 5-minute alert window for all periods**                    | `inputs.ts:145,266-271`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Daily crypto signals require the app to be running 08:00–08:05 Beijing time                                                                                                                               |
| E4  | **Paper A-share accounts stall on one missing receipt**            | Paper advances only on dates with a receipt and stops at the first gap (`paper/inputs.ts:95-100`, `advance.ts:55-63`). The task writes only today's receipt                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | One failed 17:00 download stops forward evidence permanently and silently                                                                                                                                 |
| E5  | **The forward assessment can never recommend anything**            | `paper/assessment.ts:139-161` (verified) re-applies the _frozen backtest_ neighbour results and low-zone cycle count, so neither can change with forward data. That guarantees failure for crypto (neighbourhood 0%) and low-zone (2 < 3 cycles). It also runs DSR ≥ 0.95 on ~60 forward days against the frozen trial distribution. For A-shares that requires a daily Sharpe ≈ 0.29 (~4.6 annualized); for crypto it is impossible. Separately, shadow is off by default (`registration.ts:87-92`), the shadow assessment needs ≥35 gap-free days and is append-only (`shadow.ts:120-162`), paper results don't feed eligibility (`strategy-lab.ts:60-63`), and A-share paper-fill alerts are always missed (>60 min after 15:00, `paper/alerts.ts:33-36`) | **All 5 paper accounts are structurally bound to end as "衰减 / 证据不足"**, whatever happens live. Crypto daily dual-MA averages ~6 trades a year, so 30 signals takes years and 60 days yields ~1 trade |
| E6  | **Unvalidated crypto bot runs beside the validated paper account** | Own 10-second loop (`runtime.ts:53-57`), dual-MA 5/20 on 60m with a 40% allocation (`crypto-trading/model.ts:7-15`). It is the only crypto holding the engine protects, and it blocks Binance mirroring of the validated paper account (`service.ts:103-109`). You chose to keep it                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | It needs a clear "unvalidated" label, and its exposure must not be mistaken for a validated sleeve. The validated paper account's testnet mirror stays off while the bot runs                             |
| E7  | **Everything runs in-process**                                     | All timers live in `runtime.ts:29-66`. Nothing runs when the app is closed, and yesterday's miss isn't even recorded                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Missed days are silent                                                                                                                                                                                    |

### 3.6 Result review and the feedback loop

| #   | Bottleneck                                             | Evidence                                                                                                                                                                    | Effect                                                         |
| --- | ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| R1  | **Review is informational only**                       | The decay flag is read only by the UI (`account-workspace.tsx:620-634`). Nothing changes strategy status, sleeves or risk                                                   | Findings don't change behaviour                                |
| R2  | **Expectations and links are manual**                  | The expectation must be frozen by hand from a matching backtest job (`account-workspace-service.ts:888-978`). Links are 7-day suggestions confirmed by the user (`835-847`) | Attribution stays empty unless you do bookkeeping              |
| R3  | **Decay test is lenient and slow**                     | Observed median < expected P10 with ≥30 samples each side (`account-workspace.ts:120-151`)                                                                                  | Catches only severe decay, months later; crypto takes years    |
| R4  | **No journal**                                         | Only a 500-character note on manual-ledger trades (`trade-ledger.ts:40`); plans have no rationale; imports have nothing                                                     | Habit leaks (chasing, ignoring stops) can't be tied to reasons |
| R5  | **Monthly self-check covers only fully linked rounds** | Unlinked rounds are excluded (`account-monthly-review.ts:226`)                                                                                                              | With 0 plans it is empty                                       |
| R6  | **No execution-quality measurement**                   | Nothing compares alert price → plan entry → actual fill (slippage, delay, skipped alerts)                                                                                   | You can't tell whether a strategy fails or its execution does  |

## 4. Synthesis: five root causes behind the 30+ findings

| Theme                                         | Findings                       | Root cause                                                                                                                                        |
| --------------------------------------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| **T1. The daily loop doesn't actually run**   | D1, E1, E2, E3, E4, E7, V1, V2 | Timing, symbol and activation bugs that tests mocked around. Nothing in the gates runs a real trading day end to end                              |
| **T2. What you'd trade ≠ what was validated** | P1–P6, A6, E6                  | Sizing, limits and protection live in a separate code path (`alerts/plans.ts`), not in the strategy object that research and paper use            |
| **T3. Portfolio construction is missing**     | A1–A5, D7                      | R1–R2 unified _signals_ but not _book management_: no regime, ranking, overlay or ranked rebalancing. The risk modules exist but aren't connected |
| **T4. Method artifacts decide verdicts**      | M1–M4, E5                      | Gate rules were tuned one at a time after results; five copies drifted. The forward assessment reuses frozen backtest failures                    |
| **T5. Feedback is open-loop**                 | R1–R6, V3–V4                   | Review shows numbers but nothing proposes actions. Bookkeeping is manual, there's no journal and no execution quality                             |

Priority follows dependency and the forward-evidence clock:

- **T1** first: every day it stays unfixed is a lost forward day.
- **T2** and the method part of **T4** next, in parallel.
- **T3** then runs as one pre-registered research round under the corrected method.
- The forward part of **T4** and **T5** close the loop.

## 5. Final optimization plan

Rounds are named **L0–L5** (lifecycle) to avoid clashing with the earlier P0–P5 and R1–R3. Each round is one or more Codex dispatches with Claude as manager, following the same mechanics as the 11-14 plan (`.codex-runs/dispatch-<id>.md`, `delivery.json`, polling, per-batch acceptance).

### L0 — Make the daily loop run (bug-fix round; highest priority)

1. **Close scan keyed to the receipt, not the clock** (`src/server/alerts/engine.ts`).
   - Run the A-share close scan once per trading date, as soon as that date's receipt exists, any time before the next session's pre-open (09:00). Mark it missed only after that.
   - Keep "one scan per date, no catch-up burst".
   - Apply the same window to A-share paper-fill alerts (`src/server/paper/alerts.ts`).
2. **Receipts don't stall history** (`src/server/paper/{inputs,advance}.ts`).
   - The receipt gates only the current date. Past dates advance when the completed daily bar and the calendar day exist in local data.
   - The download task retries when exit 3 means the CDN is still stale (`scripts/workflow-task.ps1`, `install-workflow-tasks.ps1`; add e.g. 17:40 and 18:30 triggers).
   - Today shows the local daily-data date per market.
3. **Crypto symbol normalization.**
   - Map bare pairs to `cx` symbols with the existing `cryptoSymbol()` (`src/lib/market/crypto.ts`) at the alert-input, regime and paper-input boundaries (`alerts/inputs.ts:192-196,640`, `paper/inputs.ts:45`).
   - Keep the frozen `paper-candidates.json` bytes and hashes unchanged.
   - First confirm the failure in the real `server.log` / runtime-errors.
   - Add an integration test that uses the real `readBars` with a small Binance archive fixture (no mock).
4. **Alert validity scales with the bar period.**
   - Daily bars are valid until the next session open (A-shares) or for a fixed number of hours (crypto daily, e.g. 12 h). Intraday keeps 5 minutes (`inputs.ts:145,266-271`).
   - The shadow assessment counts observed windows and records gaps, instead of staying pending forever after one gap (`alerts/shadow.ts`).
5. **Candidates can appear.**
   - Today and the Lab show a one-confirmation prompt: "enable shadow scanning for the 5 paper candidates". This keeps R3c's manual-governance rule rather than auto-activating.
   - Candidates are labelled 研究中/影子.
6. **Plans can be made in the evening** (`alerts/plans.ts`).
   - Outside the session, size against the last post-close position snapshot (shown with its time). The 10-minute freshness rule applies only in session.
   - Holdings with an unknown sleeve count as "unassigned" exposure against the market cap, with a prompt to assign, instead of blocking every plan.
7. **Readiness tells the truth** (`today-workspace.tsx`, `public-data-store.ts`).
   - Per-market checks: A-share local daily date = last trading date and the receipt; crypto 1d/4h current.
   - Surface the `data-gap:*` states.
   - If the iWencai status check fails, mark the candidate "status unknown" instead of dropping it.
   - A blocking card prompts for sleeve capital while it is 0.
8. **Measure, then decide** on the close-scan duration on real data. If it blocks the server for more than ~1 s, move the evaluation into the existing task worker. No other performance work.

**Done when:**

- Fake-clock tests pass:
  - a receipt at 17:05 runs exactly one close scan;
  - a receipt the next morning at 08:30 still runs it;
  - a 09:01 receipt marks it missed;
  - a missing past receipt with present bars advances paper;
  - crypto daily signals survive app downtime at 00:00 UTC.
- The crypto integration test passes against the real reader.
- On the real app over 3 trading days:
  - the close scan completes;
  - "明日计划" fills for active shadow strategies;
  - all 5 paper accounts advance;
  - there are no "标的与市场不匹配" errors.
- Deployment needs a repackage of `release/win-unpacked`, which is asked for at delivery. No schema change is expected; the real DB is still backed up first.

### L1 — Trade what you validated (position management and protection)

1. **One sizing policy.**
   - Plans call the same sizing as `runPortfolio`: the strategy's `sizing` (1/maxPositions, capped by risk-at-stop).
   - Overrides need confirmation and are recorded.
   - Remove the separate formula in `alerts/plans.ts:165-185`.
   - Paper and plans then share one function.
2. **Portfolio limits, with defaults you can change.**
   - Max positions per sleeve (from the strategy), max weight per name (proposed 15%), total open risk "heat" (proposed 6% of market capital), and a current-industry cap (proposed 30%).
   - Enforced through the existing exposure-cap path (`src/lib/portfolio/account-workspace.ts`, `account-workspace-service.ts`).
   - Correlation becomes a warning that uses `holdings-correlation-service.ts`.
3. **Protection that follows the trade** (your chosen mode: broker stop orders).
   - Plans store the full exit spec: initial stop, trailing rule, time exit and target, taken from the strategy's `exit`.
   - When a fill is linked (交割单 import, manual ledger or crypto), the holding inherits it.
   - After each completed close, compute the next session's levels: the new trailing stop, and time exits due tomorrow.
   - Today lists **"set / adjust stop orders"**: symbol, old → new level, reason.
   - A close-crossing backup alert covers imported holdings too (`alerts/inputs.ts:478-524`).
4. **Crypto as you decided.**
   - The bot keeps running, labelled "unvalidated" in Today and Accounts, with its exposure shown separately from validated sleeves.
   - The breakout sleeve stays at 25%, shown as "idle — no validated strategy" until L3 produces one.
5. **Today becomes the decision page** (V3–V5).
   - Candidates are merged per symbol across strategies, ordered by the strategy's rank (L3) or RPS for now, from the latest scan only, each with a "why" line built from the rule inputs.
   - An inline plan drawer replaces the hop to /scan. Open plans and stop-order tasks appear on Today.
   - Trading-critical panels switch to `useScreenVisible`; hidden charts stop polling.

**Schema:** plan exit-spec fields and holding protection links likely need migration 19. Back up first via the System page; old exes will refuse the DB.

**Done when:**

- A fixture candidate's plan size equals the paper/backtest size at the same equity.
- The heat and weight caps flag and record overrides.
- After a fixture close, Today lists correct trailing-stop updates.
- An imported holding linked to a plan inherits its protection.
- From app open, a plan is saved in ≤3 interactions without leaving Today.

### L2 — Method corrections, declared before the next research run

1. **One gate module.** `packages/quant-backtest/src/validation-suite.ts` owns the reasons. The CLI scoreboard (`scripts/lib/research/scoreboard.ts`), the app worker (`validation-replay.ts`, `validation-scale.ts`) and `paper/assessment.ts` import it, and the copies are deleted.
2. **Neighbourhood gate.**
   - Use the same risk-adjusted out-of-sample criterion as the other gates.
   - Perturb entry parameters as well as exit parameters.
   - Neighbours whose trade list equals the base are "not testable" (they no longer count as stable, and no longer count as DSR trials).
3. **DSR pool hygiene.**
   - Families are market × sleeve, so crypto breakout is its own family and its re-research can't move the swing bar.
   - N is the effective number of independent trials, from clustering on the correlation of OOS daily returns. Replays, identical rows and terminal-valuation accounting scenarios don't add trials.
   - The Sharpe variance comes from the same OOS series that is tested.
   - Add per-family CSCV/PBO (`src/lib/backtest/backtest-overfit.ts`) as a co-gate.
4. **Costs and definitions.**
   - The historical stamp-duty schedule (10 bp before 2023-08-28) goes into core costs.
   - ST 5% limits apply where ST status is known; otherwise a bias label.
   - One Sharpe definition for the gates and DSR.
5. **Disclosure.**
   - Record the change in `decisions.md` _before_ running anything.
   - The R2a-5 replay must still reproduce the old verdicts exactly under the old config.
   - Re-evaluating old rows under the new method is labelled "post-hoc re-evaluation" and can never promote on its own.

**Done when:**

- Unit tests cover no-op neighbour detection, effective-N clustering (identical series → 1), CSCV per family, and the stamp-duty dates.
- `replay --config research/configs/r2a4.json` is unchanged.

### L3 — Find an edge through portfolio construction (one pre-registered round)

1. **Extend the strategy object** (`packages/trading-strategies/src/strategy-object.ts`, `packages/quant-backtest/src/portfolio-engine.ts`). All four drivers inherit the changes.
   - `rank`: a score that orders entries when slots are scarce. It replaces alphabetical fill (`portfolio-engine.ts:841-847`).
   - `regime`: a market gate or exposure scaler (index trend + breadth), reusing `packages/trading-strategies/src/research/risk/{research-market-regime,research-market-admission}.ts`.
   - `overlay`: portfolio volatility target plus a drawdown brake (`research-loss-pause.ts`, and `allocation-profile.ts` "regime" mode), and a sector/correlation group cap (`research-group-risk.ts`).
   - `rebalance`: cross-sectional top-N with target weights, weekly (`allocation-profile.ts`). This brings in the 11-08 five-family + vol-budget book. A parity test must reproduce its frozen weekly targets.
   - Exits:
     - a chandelier ATR that trails (`research-volatility-stops.ts`);
     - a time exit only where declared;
     - an explicit re-entry rule after a time exit.
2. **Pre-registered menu** in `research/configs/l3.json`, written before any run, with ≤ ~12 trials per family:
   - **A-share swing, signal:**
     - double-breakout-trailing and formula-range-trailing;
     - × {no regime, regime gate};
     - ranked by an RPS composite;
     - with the vol overlay.
   - **A-share swing, ranked book** (your choice):
     - five-family + vol budget, weekly top-20;
     - the same with the regime switch;
     - an RPS-only technical ranking.
   - **A-share low-zone:**
     - Market-level detector: index position plus breadth, measured as the share of constituents in a low zone. It replaces the max over 799 stocks.
     - Corroborated by an index PE/PB synthesized from the per-stock point-in-time PE/PB in `validation-financials.ts`.
     - Judged per cycle on the longest index history: sh000300 from 2005, sh000001 earlier.
   - **Crypto swing:** daily dual-MA trailing ± a BTC regime, with both sizings.
   - **Crypto breakout** (your choice; its own family): 4h/1d range breakout with a regime gate and a cost filter (expected move > k × round-trip cost), under fee stress.
3. **Gates unchanged in thresholds**, under the L2 method. Zero promotions is an acceptable, reportable outcome. Candidates that come close join shadow and paper under L4.

**Done when:**

- The scoreboard covers each family with a drawdown-by-window attribution.
- The ranked-book parity test against the 11-08 frozen targets passes.
- Input hashes and replay are reproducible.

### L4 — Forward evidence that can reach a verdict

1. **Replace "re-run the full gates on 60 days" with a conformance test** (`src/server/paper/assessment.ts`). Compare forward observations with the frozen backtest distribution of the same version:
   - signal rate;
   - per-trade return distribution (bootstrap band);
   - modelled vs actual slippage;
   - equity path vs a bootstrapped 5th-percentile band.
   - Minimum samples are set per frequency: e.g. A-share swing 60 market days and ≥20 entries; crypto daily 120 days, judged on its daily equity path.
   - Verdicts: conforming / degraded / insufficient.
2. **Eligibility for live alerts** = backtest gates passed (L2/L3 method) **and** forward conforming.
   - A shadow candidate that failed backtest gates can reach at most "conforming shadow". You may still enable it live manually, with that warning shown.
3. **Wiring.**
   - Paper and shadow verdicts feed the Lab list and Today chips (`src/server/db/strategy-lab.ts`).
   - Paper sizing equals plan sizing (L1).

**Done when:** fake-clock fixtures with forward returns drawn from the backtest distribution come out "conforming", a shifted distribution "degraded", and thin data "insufficient".

### L5 — Close the review loop

1. **Expectations freeze automatically** when a version is registered, shadowed or promoted, from its validation run. No manual freeze (`account-workspace-service.ts:888-978`).
2. **Bulk link suggestions at import.** Same symbol, side, inside the plan's validity window; you confirm in one pass.
3. **Execution quality:** alert price → plan entry → fill; stop level → actual exit; skipped and late alerts.
4. **Journal.** Plans get a short rationale and optional tags; closes get an exit reason. The monthly self-check counts unlinked rounds as "unplanned trades" instead of dropping them (`account-monthly-review.ts:226`).
5. **Review proposes actions.**
   - Decay or conformance breach → a Lab suggestion "pause live" (one click + confirm).
   - Over-risk sleeve → a suggestion to reduce.
   - A weekly review page in Accounts.
   - All of these remain suggestions; you keep control.

**Schema:** journal and execution-quality fields probably need one more migration. Back up first.

**Done when:** a fixture month with plans, alerts, fills and a stop breach produces linked attribution, execution-quality rows, a self-check with unplanned trades, and a pause suggestion.

### Order and dependencies

```text
L0 ──▶ deploy (starts the forward clock for real)
L0 ──▶ L1 ──┐
L2 ─────────┼─▶ L3 ──▶ L4 ──▶ L5
            └───────────────▶ L5 (protection links)
```

- L1 and L2 touch different areas and can run in parallel in separate worktrees.
- L3 needs L2 (method) and L1's sizing in the strategy object.
- L4 needs L2's gate module and the L3 frozen distributions.

## 6. Decisions

**Recorded from your answers (2026-11-15):**

1. **Stops are broker stop orders**, so the intrabar stop model stays. The app must supply exact levels and trailing updates after each close (L1.3).
2. **Add the ranked-book family** to the A-share swing sleeve (L3).
3. **Keep the crypto breakout share at 25% and keep the old bot running.** Breakout is re-researched in L3 as its own DSR family. Two consequences, made visible in the UI:
   - the 25% sits idle until a breakout strategy validates;
   - the validated paper account's testnet mirror stays off while the bot runs.

**Still needed from you at the right moment:**

- Sleeve capital amounts (crypto is 0) — L0's blocking card.
- One confirmation to enable shadow scanning for the 5 candidates — L0.
- Portfolio-limit defaults (15% name, 6% heat, 30% industry) — L1.
- Repackaging authorization after L0 and after L1.

**Method choices made under your delegation** (gate-delegation): the L2 neighbourhood and DSR corrections and the L4 conformance design. All of them are disclosed in `decisions.md` before they are used. None of them lower a threshold.

## 7. Not doing now

- No paid data: point-in-time constituents stay a labelled gap unless an L3 result is only valid in early windows.
- No new strategy families beyond the L3 menu, and no 695-method batch work.
- No real-money orders and no auto-enabled live alerts.
- No BarStore performance work unless L0.8 measures a real block.
- No UI redesign beyond Today and the plan flow.

## 8. Execution and verification

- **Roles and mechanics** are as in the 11-14 plan: Claude writes dispatches and accepts batches; Codex implements without committing.
- **Isolation:** every check uses an absolute-path isolated `QUANT_DATA_DIR`; TDX/Blocks stay read-only; `src/server/mcp.ts` is untouched.
- **Approval scope:** approving this plan authorizes local commits per accepted batch. Push, packaging and real-DB migrations each need their own approval (back up first).
- **Per batch:** related Vitest + typecheck. At the end of each batch, `pnpm check --build` on isolated data; `pnpm desktop:prepare` at each round's delivery.
- **End-to-end checks per round:**
  - **L0:** fake-clock suites (receipt timing, period-scaled windows, gap-tolerant shadow); a real-reader crypto integration test; then 3 real trading days on the user's app (close scan done, plan table filled, 5 paper accounts advancing, zero symbol errors in runtime-errors).
  - **L1:** a sizing parity test (plan = paper = backtest); cap enforcement tests; a Playwright daily path at 1440/1024 ("open → see stop-order tasks → save a plan" in ≤3 interactions).
  - **L2:** method unit tests; the R2a-4/R2a-5 replay byte-identical under the old config.
  - **L3:** the ranked-book parity test against the 11-08 frozen targets; a reproducible scoreboard with input hashes.
  - **L4/L5:** conformance and review fixtures, as listed under each round.
- **Docs:** at each round start, update `roadmap.md`, `next-plan.md` and `architecture.md`. Put the method changes in `decisions.md` before use.
- **Housekeeping:** each batch has one task directory and a dry-run cleanup script, run after acceptance.
