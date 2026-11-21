# 全量理论研究分批量化与选股落地交付记录（Wave 0 – Wave 7）

日期：2026-11-21

## 背景与范围

将前期沉淀的 18 大交易理论家族（[F01–F18，228 张研究卡](../research/theory-to-pseudocode/README.md)）与交易技能战法库分 8 个批次（Wave 0 – Wave 7），采用 `multi-agent-commander` 五角色工作流量化为可直接用于 `/scan` 选股工作区、K 线几何画线图层与策略回测的因果代码。

## Wave 0：清理旧形式主义样板与构建统一理论选股底座

- **清理无消费者的 P4 形式主义假组件与锁死测试**：移除 `packages/trading-strategies/src/` 下 `theory-oneil.ts`、`theory-watchlist.ts`、`theory-selection-components.ts`、`theory-confirmation.ts`、`theory-proportions.ts`、`theory-grid.ts`、`theory-composition.ts` 及其配套锁死测试，移除 `scripts/theory-coverage.ts` 与 `tests/research-backtest/theory-coverage.test.ts`，解除 `scripts/verify.ts` 和 `tests/research-backtest/method-pool-bindings.test.ts` 中的死锁计数门禁。
- **修复 `theory-daily.ts` 中的 `theory-box20` 数组下标取模缺陷**：废除原 `i % 20 === 0` 取模冻结箱体的非平稳逻辑，改为基于前 20 根已完成 K 线因果滑动紧箱突破判定。
- **建立统一理论选股引擎（`packages/trading-strategies/src/screener/`）**：
  - [types.ts](../../packages/trading-strategies/src/screener/types.ts)：定义七大理论选股流派 `theoryScreenerFamilyIds`、输入上下文 `TheoryScreenContext`（支持 K 线、基准指数、按日 RPS 与时点校验财务快照）、输出结构 `TheoryScreenMatch`（含枢轴价、结构止损位、量度目标价、盈亏比、量比、1–5 星评分、摘要与兼容 K 线图层的 `geometry.lines`）。
  - [helpers.ts](../../packages/trading-strategies/src/screener/helpers.ts)：提供因果交替摆点过滤 `causalAlternatingPivots`（校验完整 3+3 确认窗口与确认日期，杜绝未来函数）、整数分精确涨停价计算 `astockLimitUpCents`/`isAstockLimitUp`（覆盖 10%/20%/30% 板块规则）、盈亏比与几何线构造工具。
  - [registry.ts](../../packages/trading-strategies/src/screener/registry.ts)：提供流派注册表、`prepareTheoryScreeners` 批量准备器及 `createRuleFromTheoryScreener` 回测规则桥接器。

## Wave 1 – Wave 7：七大流派 57 种理论量化选股器与整手风控仓位

| 批次 | 流派 ID | 模块文件 | 涵盖理论与量化战法（共 57 种） |
| :--- | :--- | :--- | :--- |
| **Wave 1** | `trend-breakout` | [trend-breakout.ts](../../packages/trading-strategies/src/screener/trend-breakout.ts) | **F02/F03/F04（14 种）**：道氏高低点 HH/HL 结构突破、确认支撑带拒绝下破、下降趋势线突破、Livermore 关键点领涨突破、Weinstein 二阶段转强突破、均线多头回踩收复、MACD 零轴上金叉与空中加油、DMI 与 Supertrend 趋势共振、一目均衡三役好转突破、Elder 三重滤网日线触发、KAMA 自适应均线突破、海龟 Donchian 通道突破、BB/KC 波动挤压释放突破、NR7 窄幅与内包线突破 |
| **Wave 2** | `growth-oneil` | [growth-oneil.ts](../../packages/trading-strategies/src/screener/growth-oneil.ts) | **F09（8 种）**：SEPA 8 条趋势模板突破、VCP 波动收缩突破、欧奈尔杯柄突破、欧奈尔双底突破、欧奈尔平底与底上底突破、欧奈尔升底与高紧旗（HTF）突破、达瓦斯箱体突破、CANSLIM 成长领涨突破 |
| **Wave 3** | `wyckoff-volume` | [wyckoff-volume.ts](../../packages/trading-strategies/src/screener/wyckoff-volume.ts) | **F08（8 种）**：威科夫 Spring 震仓与测试、威科夫 SOS 强势跃过小溪、威科夫 LPS 缩量回踩支撑、威科夫 UTAD 上冲失败破位、VSA 无供给测试与停止量、OBV/CMF 量价底背离突破、Volume Profile 筹码峰 POC/VAH 突破与回踩、锚定 AVWAP 成本线收复 |
| **Wave 4** | `astock-dragon` | [astock-dragon.ts](../../packages/trading-strategies/src/screener/astock-dragon.ts) | **F11（7 种）**：A 股趋势容量主升龙头、底部平台首板换手突破、连板身位龙头与涨停基因、分歧转一致与弱转强突破、强势龙头首阴缩量承接、阳包阴反包与双阳夹阴、人气龙头缩量回调二波启动 |
| **Wave 5** | `wave-harmonic-smc` | [wave-harmonic-smc.ts](../../packages/trading-strategies/src/screener/wave-harmonic-smc.ts) | **F05/F06（8 种）**：关键支撑位 K 线反转组合（锤子/吞没/启明星）、上升三法与突破缺口延续、Al Brooks H1/H2 趋势回调买点、点数图 X 列双顶突破、波浪三浪主升与 ABC 回调转折、斐波那契黄金分割回撤收复、五点谐波形态（Gartley/Bat/Butterfly/Crab/ABCD）PRZ 反转、SMC/ICT 订单块与 FVG 失衡回踩 |
| **Wave 6** | `momentum-reversion` | [momentum-reversion.ts](../../packages/trading-strategies/src/screener/momentum-reversion.ts) | **F10/F12（7 种）**：多周期 RPS 三线红领涨、短周期 RPS 上穿长线拐点、双动量与跳期动量突破、多头趋势 RSI2/IBS 极值低吸、布林回带与 Z-Score 极值回归、CCI/威廉/KDJ 超卖重夺共振、波段五维指标共振突破 |
| **Wave 7** | `value-multifactor` + 风控 | [value-multifactor.ts](../../packages/trading-strategies/src/screener/value-multifactor.ts)、[risk-position-plan.ts](../../packages/trading-strategies/src/screener/risk-position-plan.ts) | **F13（5 种）+ F17/F18**：魔法公式 ROIC+高盈利收益率突破、Piotroski F-Score 财务质量突破、彼得林奇 GARP 合理估值成长、格雷厄姆安全边际低估值反转、质量+低波+动量多因子共振；以及单笔 1% 风险预算/10% 仓位上限下的 100 股整手建议股数与跨流派 S/A/B 共振评级 |

## `/scan` 选股服务与面板联动

- 服务端 [pattern-screen-service.ts](../../src/server/screening/pattern-screen-service.ts) 新增 `theory` 过滤分支，支持按流派、具体方法、方向、最低分、最小量比和最小盈亏比与既有缠论全谱系、双向双突破、经典形态进行 `any`（并集）或 `all`（同日多维共振）联合筛选；自动加载信号日及前一日已发布 RPS 曲线，本地 GBBQ 复权重算时同步重置缓存；为每个候选输出冻结快照双价锁及 `positionPlan`。
- 前端 [pattern-screen-panel.tsx](../../src/components/screening/pattern-screen-panel.tsx) 新增「七大流派理论战法选股 (F02–F18 · 57 种量化战法)」配置区、快捷流派组合预设按钮及候选列表「风控仓位/共振」列（展示 `S/A/B 级 · 建议股数 (仓位占比%)` 及止损距离提示），点击任意候选行即可在右侧打开对应的冻结信号日 K 线快照。

## 验证命令与结果

```powershell
pnpm packages:build
pnpm --filter trading-strategies test
pnpm exec vitest run tests/screening-rps/pattern-screen-service.test.ts tests/strategy-signals/methods/pattern-breakout-screen.test.ts tests/research-backtest/research-readiness.test.ts tests/research-backtest/method-pool-bindings.test.ts
pnpm exec tsc --noEmit --incremental false
```

- `packages:build`：6 个工作区包全部构建通过。
- `trading-strategies` 单测：43 个测试文件、484 项测试全部通过（其中新增 8 个理论选股器专项测试文件共 136 项用例）。
- 选股服务与集成单测：4 个测试文件、58 项测试全部通过。
- 全仓 TypeScript 类型检查：`tsc --noEmit --incremental false` 零错误通过。
