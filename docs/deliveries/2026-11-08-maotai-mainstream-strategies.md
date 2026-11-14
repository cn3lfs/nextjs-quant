# 贵州茅台主流策略十年对比

已取消五种限制：独立TS回测包现有39项固定日线规则及2项持有对照，34项为本轮新增，逐项规则与数据边界见[规格](../product/specs/mainstream-strategies-maotai.md)和[代码目录](../../packages/trading-strategies/src/study-catalog.ts)。覆盖趋势、突破、时序动量、回调/反转、量价、仓位和季节性。多标的、衍生品、盘口及披露时点证据不足的主流流派均列出缺口，没有宣称单股日线已经覆盖所有量化策略。

## 沿用的实验条件

2016-11-08至2026-11-06，2,428个交易日，本金100万元。双边佣金万一、最低5元；卖出税费万五；主结果零额外滑点。未复权成交/估值，现金后复权信号；只做多、整手、无透支、收盘决策次日开盘，每日最多一方向。分红隔离不复投，主表税前经济权益，不冒充已认证现金交割账。期末不强制平仓。

新策略300日预热，比原输入增加160日；原五项与两项持有仍各裁140日，原递推种子保持。与上次冻结输入重叠的2,568条行情逐项相同，股票源哈希相同。原七项的全部净值、成交、拒单、年度和敏感性逐项完全一致，证据在original-comparison.json。原报告和原输入未改。

## 结果

全部39项规则在该段茅台中均未超过100%买入持有的累计收益。下表选出收益靠前及回撤较低的代表，完整41组保留在报告及CSV中；不按结果删除差策略，不以此段排名确定未来有效性。

| 策略 | 累计收益 | 年化 | 日末最大回撤 | 平均股票敞口 | 成交笔数 |
| --- | ---: | ---: | ---: | ---: | ---: |
| 买入持有100%（对照） | 442.72% | 18.44% | 45.55% | 93.53% | 1 |
| CPPI动态仓位 | 407.61% | 17.65% | 45.56% | 92.37% | 44 |
| 买入持有80%（对照） | 357.03% | 16.42% | 44.26% | 87.49% | 1 |
| 80/20恒定比例 | 303.40% | 14.98% | 36.96% | 74.28% | 35 |
| Supertrend10×3 | 299.22% | 14.86% | 36.72% | 50.29% | 67 |
| 原底仓网格 | 262.09% | 13.74% | 41.48% | 77.38% | 10 |
| 12个月分批建仓 | 257.61% | 13.60% | 43.40% | 81.03% | 12 |
| RSI14动量 | 235.43% | 12.87% | 38.01% | 54.62% | 103 |
| 11月至4月季节性 | 223.63% | 12.47% | 31.86% | 48.25% | 21 |
| 海龟20/10日线简化 | 221.91% | 12.41% | 33.95% | 39.30% | 71 |
| 15%目标波动仓位 | 200.85% | 11.65% | 34.87% | 58.39% | 314 |
| RSI2趋势低吸 | 39.06% | 3.35% | 12.57% | 8.71% | 126 |

CPPI在持续上涨后会接近满仓，本次回撤没有优于持有，不能因其有“底线”概念就声称保本。恒定比例降低了股票风险，但累计收益也低于80%初始投入后持有；不能只与满仓比较。Supertrend在该段有较低日末回撤，但单股同段表现不足以证明通用优势。RSI2低吸的大部分时间在现金，低回撤也伴随低敞口和低收益。

主结果5日短反转和目标波动各有1次受阻，其余无拒单；拒绝请求与理由保留在results.json。重撮合5/10bp滑点会改变拒单、持仓和整手路径，收益不保证单调下降；另列固定主路径只扣额外费用的近似及统一20%分红税情景。

## 报告与复现

- [交互报告](C:/Users/jm/Documents/Codex/2026-11-08/maotai-mainstream/report.html)：默认原七项，可按流派、全选/清空及逐项对照；41行结果按历史收益排序，包含固定规则和平均敞口。
- [完整报告](C:/Users/jm/Documents/Codex/2026-11-08/maotai-mainstream/report.md)：全部规则、结果、缺口、年度及敏感性。
- [汇总CSV](C:/Users/jm/Documents/Codex/2026-11-08/maotai-mainstream/summary.csv)、[逐年CSV](C:/Users/jm/Documents/Codex/2026-11-08/maotai-mainstream/annual.csv)、[规则CSV](C:/Users/jm/Documents/Codex/2026-11-08/maotai-mainstream/strategies.csv)，另有每项净值及成交CSV。
- [曲线图片](C:/Users/jm/Documents/Codex/2026-11-08/maotai-mainstream/comparison.png)、[完整页面](C:/Users/jm/Documents/Codex/2026-11-08/maotai-mainstream/equity.png)。静态HTML无需服务或网络。

输入SHA256：1cf586f23c288e4a06118f9868fab4c7a54ca8a5b9e9e3dda8eb1e8c8abe4982。
结果SHA256：5cce08a51fd6c719e15f6aa039e4fd5e504df9093230e9938a22b74d94c6a33e。

同一冻结输入完全离线重放到独立maotai-mainstream-replay目录，输入与结果哈希完全一致。manifest.json记录计算时输入/结果和代码摘要，report-manifest.json另记录最终导出器、图表库和HTML摘要，报告使用冻结结果内规则定义。仓库外replay-verification.json和ledger-verification.json记录独立复核。

```powershell
$env:QUANT_DATA_DIR = Join-Path $env:TEMP 'quant-maotai-mainstream-isolated'
pnpm trading-strategy-core:build
pnpm backtest-engine:build
pnpm exec tsx scripts/backtest-maotai-classics.ts --suite mainstream --out C:/Users/jm/Documents/Codex/2026-11-08/maotai-mainstream-new
pnpm exec tsx scripts/export-classic-study.ts --dir C:/Users/jm/Documents/Codex/2026-11-08/maotai-mainstream-new
# 使用已有冻结输入，仍须指定尚不存在的输出目录：
pnpm exec tsx scripts/backtest-maotai-classics.ts --suite mainstream --replay C:/Users/jm/Documents/Codex/2026-11-08/maotai-mainstream/input.json --out C:/Users/jm/Documents/Codex/2026-11-08/maotai-mainstream-offline-new
```

## 验证边界

- 独立TS十进制账本验证41组、99,548个日末估值，核对费用、现金、持股、分红、净值、总收益和最大回撤；误改成交费用1元并同步改文件哈希的负对照仍被正确拒绝。
- 定向覆盖全部策略未来追加/未来分红隔离、输入不变、下一开盘、整手/T+1/现金及用户费用；补充MA200买卖、分批建仓12次/失败重试、信号日收盘决定再平衡数量、15%目标波动手算和云层26日前引用。新指标另有CCI/MFI/%R/CMF/DMI手算与趋势反转/未来隔离。
- Chrome实际打开报告，41个复选控件、全选/清空、原七项及各流派筛选均通过；无页面错误。图表及完整页面已截图查看。
- 原有未跟踪__pycache__保留；未改受保护MCP、应用页面、正式数据库、通达信源文件或release。未提交、推送或打包；无迁移。

`pnpm test`退出0：根测试554个文件/11,922项通过，17个文件/28项按原条件跳过；三个workspace分别5、18、13项通过。全量之后补充仓位边界一项，新文件7项再次定向通过；此前原策略、目录/指标和包边界3文件17项通过。`pnpm typecheck`通过，最终报告修改后的根`tsc --noEmit`也通过；本轮代码定向Prettier及`git diff --check`通过。输出仍含既有Vite扩展名提示和研究台账写入失败提示，不据此声称台账业务验收。

`pnpm runtime:build`退出0，worker已重建；最终根`tsc --noEmit`通过。新增规格及交付链接逐项存在，41组均有实际成交记录。

本次交付离线研究与静态报告，无Next页面/宿主变化，不运行应用build或desktop:prepare，不替换release。数据完整性、历史ST与涨跌停状态/队列容量、公司行动全量独立认证、分红支付日及持有期税仍未补足，所有输出保持rule-check-only，不能称为可信策略业绩。
