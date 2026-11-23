# 下一阶段主计划：策略原生适配、PIT 成长与规则健康基线（2026-11-23）

> 范围与决策依据：截至 2026-11-23（本地 `master` 提交 `8698d1c6`），`feat/global-optimization-20261119`、`feat/thsdk-data-source`、`feat/backtest-infra-p0-degovernance` 均已合入 `master`。本计划冻结接下来的 M1–M3 工程/研究诊断主线与 M4 挂起边界，不改变任何生产默认，也不产出可交易业绩结论。

## 1. 背景与当前基线

- **工程底座**：`AccountBook` + BigInt 执行账本、券商时点公司行动、`pnpm check` 异步进程树超时门禁（6/6 通过，主套件 8,130 通过 / 28 跳过）。
- **冻结研究口径**：见[回测研究假设](2026-11-22-backtest-assumptions.md)——`E:/new_tdx64` 只读日线截止 2026-11-20、`sh000001` 基准日历、逐 bar 因果 GBBQ 复权（首根原价锚）、未复权原价次开盘成交、`base` 历史印花税费用、`strict` 基线 + `clamp` 强制敏感性 + 单标的全历史 `0.5% + clip` 容量档。
- **已完成诊断覆盖**：5 个 adapter key + 94 个可构造 catalog study key + `hold` 对照；量价 170/170 ok、威科夫 119/119 ok；GBBQ 按标的归因；主板 ST 2026-07-06 起 10%。
- **前置探针结论**：
  - 缠论原生捕获：[spike](2026-11-22-chan-native-spike.md) 验证 `sh600519` 5,908 前缀 / 87.1 秒，DLL 身份可冻结；
  - 成长 PIT 财务：[审计](2026-11-22-growth-pit-audit.md) 验证 5 标的 36–114 期财报公告日 100% 齐全，`strict` 下 `availableFrom` 为公告后首个交易日；
  - 威科夫零入场：[归因](2026-11-22-wyckoff-zero-entry.md) 判定三策略在五标的全历史上属当前参数下的稀有结构，不改规则阈值。

## 2. 里程碑与验收标准

### M1：原生缠论诊断适配（`research-chan`）

- **架构路径**：不走 `study-rule`，也不走 `replayDailyStudy`（不支持非现金公司行动、`base` 历史印花税、`strict`/`clamp`/`0.5% clip` 及 `runDiagnostics` 账本核对）；复用 `StrategyObjectInput` 原生 `entry: { kind: "chan-third-buy", firstIndex }` + `exit: { maxBars: 5 }` + `instrument.external.chan: FrozenChanObservation[]` 接入 `runPortfolio` 与 12 项诊断。
- **关键工程约束**：
  1. `prepareLabBacktest` 生产/UI 默认继续拒绝 `chan-third-buy`，仅诊断侧显式传 `allowNativeChan: true` 放行；`replayLabBacktest` 强制校验 `external.chan` 非空；
  2. 原生捕获在 `prepare-request.ts` 完成 `sh000001` 基准日历过滤（off-calendar 删除）与因果复权 proof 刷新**之后**执行，保持 `firstIndex >= 140` 与原始首根因果锚不变；
  3. 修复 `strategy-object.ts` `chan-third-buy` 编译分支的 $O(N^2)$ 校验热点：保持空序列 `prepareStrategy` 不抛错语义，首次求值 `>= firstIndex` 时一次调用 `createNativeStudyRule` 完成全量严格校验并缓存 $O(1)$ 查表；
  4. `run.json` / `summary.json` / `report.md` 完整披露 DLL 身份（`dllHash`/`apiVersion`/`buildCommit`/`configId`/`config`/`anchor`）、`captureElapsedMs`、`prefixCount`、`originDate`、`baselineDate`、`auditCount`、`pendingCount` 及信号价基；
  5. 支持隔离目录下的只读观察快照复用，同标的 `strict` / `clamp` / `cap-0.5-clip` 三档只需捕获一次 DLL；CLI 退出前调用 `closeCzsc()` 关闭单例 `czsc-worker`。
- **验收**：定向单测全过；`sh600519` 单标的 `strict`/`clamp`/`cap-0.5-clip` 全通过且成交/费用/账本核对无误；进一步完成五标的 `per-symbol` 三档原生诊断报告。

### M2：成长 CANSLIM strict-PIT 适配器（`research-canslim-pit`）

- **架构路径**：新增逐日 PIT 财务适配层 `src/server/financial/canslim-pit-series.ts`，只读 `readLocalFinancialHistory(..., { strict: true })`，严格按 `availableFrom <= date`（公告后首个交易日）逐日投影至 `canslimEarnings`，亏损/负基数与缺失字段不推定为零；新增独立诊断 key `research-canslim-pit`（保留现有纯价格代理 `research-growth` 作对照）。
- **验收**：公告日前后对照单测通过（如 `sh600519` 2020 年报 `2021-03-31` 不可见、`2021-04-01` 首次可见）、负基数/缺失字段不误触发；五标的 `strict`/`clamp`/`cap-0.5-clip` 跑通并与 `research-growth` 并列披露信号漏斗差异与本地财务包边界。

### M3：威科夫口径对齐 & 94-key 真实健康基线

- **威科夫**：不改规则阈值，仅对齐 `packages/trading-strategies/src/research/wyckoff/research-wyckoff.ts` 中 `WY08` `wyckoffBoundary` 文字描述（补齐代码已生效的 `MA60 上升`）。
- **94-key 健康摸底**：在隔离目录以 `sh600519` `strict` 单标的实测全部 94 个通用 catalog study key，归档正常成交 / 合理零信号 / 数据或预热阻断 / 真实抛错清单（`docs/research-backtest/2026-11-23-catalog-94-health.md`）。

### M4：明确挂起边界（需外部条件或单独授权）

- RPS / 经典横截面全市场外推（缺历史成分、退市清单、历史名称变更、历史 ST/IPO 证据）；
- `sz000001` 1991–1993 年 39 根周末 bar 第二数据源核对；
- THSDK 真实 `hq.dll` E2E 回归与桌面正式包发版（`pnpm desktop:pack`）；
- 真实账户成交执行质量长期样本与提醒 live 投递；
- 本地 `master` 推送与已合并特性分支清理（需单独授权）。

## 3. 验证与收尾纪律

- 开发期在隔离 `QUANT_DATA_DIR=.test-data/...` 跑受影响的定向 Vitest 与 `pnpm typecheck`；
- 真实数据诊断严格遵循 `--plan` → 小样本冒烟 → 全量、不同 execution profile 顺序执行；
- M1–M3 集成收口时在干净 shell 执行一次完整 `pnpm check`，确认 `check-result.json` 6/6 `timedOut: false`、exit 0；
- 不触碰 `src/server/mcp.ts`，不打开默认生产库，不未经授权提交或推送。
