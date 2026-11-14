# 2026-11 策略研究成绩单

> R2a（`cc934c7`）的历史小样本记录。当前 R2a-2 的扩容事实与未完成项见 [规模记录](2026-11-r2a2-scale.md)；下文旧资格结论没有按新规模重算，不能当作本轮全市场成绩单。R2a-2 已将三类数据准入缺口改为严重度标签，其余统计门槛不变。

## 已证实

本报告的数字由内容寻址输入和结果直接生成。这里的已证实指可核查的研究运行事实；规则自检、固定证券样本和样本外诊断均不等于可信策略业绩或实盘盈利证明。未通过门槛的策略保留research，不开启提醒实时模式、订阅或下单。

### A股

输入：`input-f85762b68f8d6910b4ac3ec40297ebe6a513b692bb188547c0b950616306ef5f.json`；结果：`report-4a8f71172cd1e3a98b3f01177ca3ac812367a3a1d82fb1e5c91fa27d2a35cf57.json`。策略/撮合构建：`96108e4a2141e294067a385979b32010632563709c395d7c8d0b52bdfb7d9300`；研究/评价适配构建：`3a923d3d77e1dcef0ac48dec3b0a0634f65b4503d9e6a1e233543e03992019bc`。

请求区间 2017-01-01 至 2026-11-13。本次运行 507066 毫秒，采集/冻结 200304 毫秒。候选成绩行 63，可监视候选 0，未运行候选 0。这些数量分别取结果rows/promoted/missing，并非全市场策略数量。

默认/本次门槛：样本外至少 3 窗口，至少 60% 窗口扣费后正超额；最大回撤 25.00%；至少 30 个闭合交易；训练段数值邻域正超额比例至少 50%；DSR至少 0.95。低位长线另需至少 3 个完整市场周期及足够输入置信。成本翻倍、延后一根的多数窗口和末段留出均须通过。历史池/成交证据未核验时不能晋级。门槛在运行前冻结，代码中的配置可由用户显式修改，本轮未下调。

训练窗固定长度向前滚动，参数只在训练窗按超额、回撤、稳定ID排序选择；各测试窗独立本金。初始训练段用于数值退出邻域，末20%作为固定留出诊断，与滚动样本外重叠，不能累计为额外独立样本。邻域在样本外揭示前声明为ATR倍数、移动幅度或时间长度±10%。保护单不随延迟压力撤销，延后一根只作用于自主入退场。

| 周期 | 实际研究区间 | 标的数 | 原始/信号根数 | 基准 |
|---|---|---:|---:|---|
| day | 2017-01-03 至 2026-11-13 | 8 | 30155 | 沪深300原价价格指数（无股息）；首日开盘持有 |

基准为同窗首个观测开盘买入并持有，A股为沪深300价格指数（无股息）；币种为同来源BTC持有。缺任一基准日时超额留空。分段复用独立quant-performance；币种这里展示收益/回撤，未将252日年化结果当作币种年化业绩。

免费池可枚举 6278 个证券；覆盖等级 `incomplete-local`；可信缓存已退市下界 ≥ 0。没有可枚举痕迹的已移除证券、沪深代码变更及缺少上市日期的成员不能补造。本轮样本由预先排序等距名单选取，包含已知退市缓存的优先项；实际研究不是全市场。原生三买仅使用预先确定的两个可用证券子集。

来源排除 4 项；数据缺口 1 项。

- bj920000 / day：Unsupported / unproven non-cash corporate action in evaluation interval
- sh600717 / day：Unsupported / unproven non-cash corporate action in evaluation interval
- sz300470 / day：Unsupported / unproven non-cash corporate action in evaluation interval
- sz300982 / day：Unsupported / unproven non-cash corporate action in evaluation interval
- sz002002 financials: ENOENT: no such file or directory, stat 'E:\new_tdx64\vipdoc\cw\gpsz002002.dat'

#### 策略成绩

表中收益、超额、回撤和两种压力均为末20%留出段；闭合交易数、正超额窗口数来自滚动样本外之和，不与留出交易数混同。详细逐窗训练选择、压力、市场状态和统计退化原因见结果的suites字段。每个策略对象在包内登记runnable并保存定义；runnable表示规则可执行。

| 策略 | 分仓 | 训练收益/超额 | 留出收益/超额/回撤 | 成本×2超额 / 延迟超额 | 正超额/窗口 · 闭合交易 | 样本外入场观察/订单/成交/拒单尝试 | 结论 |
|---|---|---|---|---|---|---|---|
| r2a-cn-equity-rps-multi-atr | swing | -0.66% / -51.84% | -10.68% / -11.49% / 10.76% | -11.71% / -7.60% | 4/6 · 46 | 387/107/96/16 | research：成本/延迟压力未过门槛；末段留出超额非正或缺失；训练段数值邻域不稳定；DSR未达0.95；历史证券池不完整；历史成交/到账未核验 |
| r2a-cn-equity-rps-multi-atr-neighbor-90 | swing | 0.50% / -50.67% | -10.25% / -11.06% / 10.33% | -11.34% / -7.26% | 4/6 · 46 | 387/104/96/16 | research：成本/延迟压力未过门槛；末段留出超额非正或缺失；训练段数值邻域不稳定；DSR未达0.95；历史证券池不完整；历史成交/到账未核验 |
| r2a-cn-equity-rps-multi-atr-neighbor-110 | swing | -1.76% / -52.93% | -11.00% / -11.81% / 11.01% | -11.99% / -8.15% | 4/6 · 45 | 387/104/94/14 | research：成本/延迟压力未过门槛；末段留出超额非正或缺失；训练段数值邻域不稳定；DSR未达0.95；历史证券池不完整；历史成交/到账未核验 |
| r2a-cn-equity-rps-multi-trailing | swing | 10.69% / -40.48% | -7.31% / -8.12% / 10.65% | -8.70% / -3.58% | 4/6 · 99 | 387/216/200/37 | research：成本/延迟压力未过门槛；末段留出超额非正或缺失；训练段数值邻域不稳定；DSR未达0.95；历史证券池不完整；历史成交/到账未核验 |
| r2a-cn-equity-rps-multi-trailing-neighbor-90 | swing | 10.52% / -40.65% | -6.95% / -7.75% / 9.44% | -8.38% / -1.20% | 4/6 · 103 | 387/224/208/37 | research：成本/延迟压力未过门槛；末段留出超额非正或缺失；训练段数值邻域不稳定；DSR未达0.95；历史证券池不完整；历史成交/到账未核验 |
| r2a-cn-equity-rps-multi-trailing-neighbor-110 | swing | 9.59% / -41.59% | -8.66% / -9.46% / 11.31% | -10.01% / -6.10% | 4/6 · 95 | 387/207/191/35 | research：成本/延迟压力未过门槛；末段留出超额非正或缺失；训练段数值邻域不稳定；DSR未达0.95；历史证券池不完整；历史成交/到账未核验 |
| r2a-cn-equity-rps-multi-time | swing | -1.10% / -52.28% | -7.81% / -8.61% / 8.65% | -8.98% / -6.51% | 4/6 · 64 | 387/139/130/20 | research：成本/延迟压力未过门槛；末段留出超额非正或缺失；训练段数值邻域不稳定；DSR未达0.95；历史证券池不完整；历史成交/到账未核验 |
| r2a-cn-equity-rps-multi-time-neighbor-90 | swing | -2.29% / -53.47% | -10.86% / -11.67% / 10.92% | -11.94% / -6.42% | 4/6 · 68 | 387/147/138/19 | research：成本/延迟压力未过门槛；末段留出超额非正或缺失；训练段数值邻域不稳定；DSR未达0.95；历史证券池不完整；历史成交/到账未核验 |
| r2a-cn-equity-rps-multi-time-neighbor-110 | swing | -0.18% / -51.36% | -7.37% / -8.17% / 8.79% | -8.52% / -9.03% | 4/6 · 60 | 387/131/122/19 | research：成本/延迟压力未过门槛；末段留出超额非正或缺失；训练段数值邻域不稳定；DSR未达0.95；历史证券池不完整；历史成交/到账未核验 |
| r2a-cn-equity-double-breakout-atr | swing | 1.74% / -49.43% | 2.75% / 1.95% / 7.43% | 1.53% / 2.12% | 4/6 · 55 | 72/123/112/12 | research：训练段数值邻域不稳定；DSR未达0.95；历史证券池不完整；历史成交/到账未核验 |
| r2a-cn-equity-double-breakout-atr-neighbor-90 | swing | 1.15% / -50.02% | 4.11% / 3.30% / 6.68% | 2.77% / 4.03% | 4/6 · 55 | 72/123/112/12 | research：训练段数值邻域不稳定；DSR未达0.95；历史证券池不完整；历史成交/到账未核验 |
| r2a-cn-equity-double-breakout-atr-neighbor-110 | swing | 2.64% / -48.54% | 1.95% / 1.14% / 7.99% | 0.66% / 0.74% | 4/6 · 55 | 72/123/112/11 | research：成本/延迟压力未过门槛；训练段数值邻域不稳定；DSR未达0.95；历史证券池不完整；历史成交/到账未核验 |
| r2a-cn-equity-double-breakout-trailing | swing | 0.86% / -50.32% | 1.17% / 0.36% / 4.99% | -0.07% / -1.77% | 4/6 · 58 | 72/128/117/19 | research：成本/延迟压力未过门槛；训练段数值邻域不稳定；DSR未达0.95；历史证券池不完整；历史成交/到账未核验 |
| r2a-cn-equity-double-breakout-trailing-neighbor-90 | swing | 2.84% / -48.33% | 2.97% / 2.17% / 4.54% | 1.74% / 0.47% | 4/6 · 58 | 72/128/117/20 | research：训练段数值邻域不稳定；DSR未达0.95；历史证券池不完整；历史成交/到账未核验 |
| r2a-cn-equity-double-breakout-trailing-neighbor-110 | swing | 0.09% / -51.09% | -0.30% / -1.10% / 5.20% | -1.53% / -3.53% | 4/6 · 57 | 72/126/115/17 | research：成本/延迟压力未过门槛；末段留出超额非正或缺失；训练段数值邻域不稳定；DSR未达0.95；历史证券池不完整；历史成交/到账未核验 |
| r2a-cn-equity-double-breakout-time | swing | 1.61% / -49.57% | 9.29% / 8.48% / 4.03% | 8.04% / -0.32% | 4/6 · 55 | 72/123/112/16 | research：成本/延迟压力未过门槛；训练段数值邻域不稳定；DSR未达0.95；历史证券池不完整；历史成交/到账未核验 |
| r2a-cn-equity-double-breakout-time-neighbor-90 | swing | 0.69% / -50.49% | 6.34% / 5.54% / 4.11% | 5.07% / -0.44% | 4/6 · 57 | 72/125/115/19 | research：成本/延迟压力未过门槛；训练段数值邻域不稳定；DSR未达0.95；历史证券池不完整；历史成交/到账未核验 |
| r2a-cn-equity-double-breakout-time-neighbor-110 | swing | 2.42% / -48.76% | 9.89% / 9.09% / 3.67% | 8.65% / 1.79% | 4/6 · 55 | 72/122/112/16 | research：训练段数值邻域不稳定；DSR未达0.95；历史证券池不完整；历史成交/到账未核验 |
| r2a-cn-equity-chan-third-buy-atr | swing | -0.27% / -51.44% | 0.00% / -0.80% / 0.66% | -0.82% / -3.23% | 4/6 · 5 | 7/12/10/2 | research：成本/延迟压力未过门槛；闭合交易数不足；末段留出超额非正或缺失；训练段数值邻域不稳定；DSR未达0.95；历史证券池不完整；历史成交/到账未核验 |
| r2a-cn-equity-chan-third-buy-atr-neighbor-90 | swing | -0.27% / -51.44% | 0.00% / -0.80% / 0.66% | -0.82% / -2.47% | 4/6 · 5 | 7/12/10/2 | research：成本/延迟压力未过门槛；闭合交易数不足；末段留出超额非正或缺失；训练段数值邻域不稳定；DSR未达0.95；历史证券池不完整；历史成交/到账未核验 |
| r2a-cn-equity-chan-third-buy-atr-neighbor-110 | swing | -0.18% / -51.36% | 0.00% / -0.80% / 0.66% | -0.82% / -3.72% | 4/6 · 5 | 7/12/10/2 | research：成本/延迟压力未过门槛；闭合交易数不足；末段留出超额非正或缺失；训练段数值邻域不稳定；DSR未达0.95；历史证券池不完整；历史成交/到账未核验 |
| r2a-cn-equity-chan-third-buy-trailing | swing | -0.28% / -51.46% | -0.61% / -1.42% / 0.64% | -1.44% / -2.86% | 4/6 · 5 | 7/12/10/3 | research：成本/延迟压力未过门槛；闭合交易数不足；末段留出超额非正或缺失；训练段数值邻域不稳定；DSR未达0.95；历史证券池不完整；历史成交/到账未核验 |
| r2a-cn-equity-chan-third-buy-trailing-neighbor-90 | swing | -0.17% / -51.34% | -0.61% / -1.42% / 0.64% | -1.44% / -2.86% | 4/6 · 5 | 7/12/10/2 | research：成本/延迟压力未过门槛；闭合交易数不足；末段留出超额非正或缺失；训练段数值邻域不稳定；DSR未达0.95；历史证券池不完整；历史成交/到账未核验 |
| r2a-cn-equity-chan-third-buy-trailing-neighbor-110 | swing | 0.60% / -50.58% | 0.00% / -0.80% / 0.66% | -0.82% / -2.14% | 4/6 · 5 | 7/12/10/4 | research：成本/延迟压力未过门槛；闭合交易数不足；末段留出超额非正或缺失；训练段数值邻域不稳定；DSR未达0.95；历史证券池不完整；历史成交/到账未核验 |
| r2a-cn-equity-chan-third-buy-time | swing | -0.09% / -51.26% | 0.00% / -0.80% / 0.66% | -0.82% / -2.43% | 4/6 · 5 | 7/12/10/2 | research：成本/延迟压力未过门槛；闭合交易数不足；末段留出超额非正或缺失；训练段数值邻域不稳定；DSR未达0.95；历史证券池不完整；历史成交/到账未核验 |
| r2a-cn-equity-chan-third-buy-time-neighbor-90 | swing | 0.16% / -51.02% | 0.08% / -0.72% / 0.66% | -0.74% / -2.54% | 4/6 · 5 | 7/12/10/4 | research：成本/延迟压力未过门槛；闭合交易数不足；末段留出超额非正或缺失；训练段数值邻域不稳定；DSR未达0.95；历史证券池不完整；历史成交/到账未核验 |
| r2a-cn-equity-chan-third-buy-time-neighbor-110 | swing | -0.25% / -51.43% | 0.12% / -0.69% / 0.66% | -0.71% / -2.49% | 4/6 · 5 | 7/12/10/2 | research：成本/延迟压力未过门槛；闭合交易数不足；末段留出超额非正或缺失；训练段数值邻域不稳定；DSR未达0.95；历史证券池不完整；历史成交/到账未核验 |
| r2a-cn-equity-formula-ma-atr | swing | 1.17% / -50.01% | 1.40% / 0.60% / 11.32% | -1.19% / 3.28% | 3/6 · 293 | 342/633/606/42 | research：正超额窗口未过多数门槛；成本/延迟压力未过门槛；训练段数值邻域不稳定；DSR未达0.95；历史证券池不完整；历史成交/到账未核验 |
| r2a-cn-equity-formula-ma-atr-neighbor-90 | swing | 1.45% / -49.72% | 1.93% / 1.13% / 11.13% | -0.42% / 4.36% | 4/6 · 294 | 342/634/607/44 | research：成本/延迟压力未过门槛；训练段数值邻域不稳定；DSR未达0.95；历史证券池不完整；历史成交/到账未核验 |
| r2a-cn-equity-formula-ma-atr-neighbor-110 | swing | 2.50% / -48.67% | 1.33% / 0.52% / 11.36% | -1.25% / 2.62% | 3/6 · 293 | 342/633/606/43 | research：正超额窗口未过多数门槛；成本/延迟压力未过门槛；训练段数值邻域不稳定；DSR未达0.95；历史证券池不完整；历史成交/到账未核验 |
| r2a-cn-equity-formula-ma-trailing | swing | 10.42% / -40.75% | 10.13% / 9.32% / 6.95% | 9.23% / 12.43% | 3/6 · 298 | 342/639/612/45 | research：正超额窗口未过多数门槛；成本/延迟压力未过门槛；训练段数值邻域不稳定；DSR未达0.95；历史证券池不完整；历史成交/到账未核验 |
| r2a-cn-equity-formula-ma-trailing-neighbor-90 | swing | 14.14% / -37.03% | 8.19% / 7.39% / 9.17% | 6.87% / 6.56% | 3/6 · 299 | 342/640/613/50 | research：正超额窗口未过多数门槛；成本/延迟压力未过门槛；训练段数值邻域不稳定；DSR未达0.95；历史证券池不完整；历史成交/到账未核验 |
| r2a-cn-equity-formula-ma-trailing-neighbor-110 | swing | 8.17% / -43.00% | 6.73% / 5.92% / 6.77% | 4.04% / 9.44% | 3/6 · 298 | 342/639/612/47 | research：正超额窗口未过多数门槛；成本/延迟压力未过门槛；训练段数值邻域不稳定；DSR未达0.95；历史证券池不完整；历史成交/到账未核验 |
| r2a-cn-equity-formula-ma-time | swing | 3.38% / -47.79% | 1.05% / 0.24% / 9.41% | -1.41% / 2.47% | 3/6 · 294 | 342/634/607/44 | research：正超额窗口未过多数门槛；成本/延迟压力未过门槛；训练段数值邻域不稳定；DSR未达0.95；历史证券池不完整；历史成交/到账未核验 |
| r2a-cn-equity-formula-ma-time-neighbor-90 | swing | 4.68% / -46.50% | 1.32% / 0.51% / 8.42% | -1.30% / -0.14% | 3/6 · 296 | 342/639/610/42 | research：正超额窗口未过多数门槛；成本/延迟压力未过门槛；训练段数值邻域不稳定；DSR未达0.95；历史证券池不完整；历史成交/到账未核验 |
| r2a-cn-equity-formula-ma-time-neighbor-110 | swing | 12.50% / -38.67% | 3.32% / 2.52% / 8.85% | 0.97% / -2.07% | 3/6 · 294 | 342/634/607/43 | research：正超额窗口未过多数门槛；成本/延迟压力未过门槛；训练段数值邻域不稳定；DSR未达0.95；历史证券池不完整；历史成交/到账未核验 |
| r2a-cn-equity-formula-range-atr | swing | -7.21% / -58.39% | 8.74% / 7.94% / 10.27% | 6.41% / 5.76% | 3/6 · 159 | 472/361/337/32 | research：正超额窗口未过多数门槛；成本/延迟压力未过门槛；训练段数值邻域不稳定；DSR未达0.95；历史证券池不完整；历史成交/到账未核验 |
| r2a-cn-equity-formula-range-atr-neighbor-90 | swing | -10.12% / -61.30% | 9.89% / 9.08% / 9.85% | 7.44% / 6.50% | 4/6 · 163 | 472/369/345/33 | research：成本/延迟压力未过门槛；训练段数值邻域不稳定；DSR未达0.95；历史证券池不完整；历史成交/到账未核验 |
| r2a-cn-equity-formula-range-atr-neighbor-110 | swing | -9.41% / -60.59% | 9.76% / 8.95% / 10.66% | 7.38% / 5.30% | 3/6 · 158 | 472/359/335/36 | research：正超额窗口未过多数门槛；成本/延迟压力未过门槛；训练段数值邻域不稳定；DSR未达0.95；历史证券池不完整；历史成交/到账未核验 |
| r2a-cn-equity-formula-range-trailing | swing | 7.85% / -43.33% | 5.48% / 4.67% / 6.70% | 5.34% / 0.45% | 4/6 · 188 | 472/414/388/47 | research：成本/延迟压力未过门槛；训练段数值邻域不稳定；DSR未达0.95；历史证券池不完整；历史成交/到账未核验 |
| r2a-cn-equity-formula-range-trailing-neighbor-90 | swing | 9.98% / -41.19% | 6.77% / 5.97% / 8.65% | 4.74% / 0.67% | 4/6 · 193 | 472/423/397/47 | research：成本/延迟压力未过门槛；训练段数值邻域不稳定；DSR未达0.95；历史证券池不完整；历史成交/到账未核验 |
| r2a-cn-equity-formula-range-trailing-neighbor-110 | swing | 3.61% / -47.57% | 6.08% / 5.27% / 6.73% | 3.69% / 1.13% | 4/6 · 185 | 472/408/382/42 | research：成本/延迟压力未过门槛；训练段数值邻域不稳定；DSR未达0.95；历史证券池不完整；历史成交/到账未核验 |
| r2a-cn-equity-formula-range-time | swing | -3.28% / -54.46% | 9.16% / 8.35% / 11.19% | 6.68% / -1.21% | 3/6 · 164 | 472/370/346/35 | research：正超额窗口未过多数门槛；成本/延迟压力未过门槛；训练段数值邻域不稳定；DSR未达0.95；历史证券池不完整；历史成交/到账未核验 |
| r2a-cn-equity-formula-range-time-neighbor-90 | swing | -1.22% / -52.40% | 10.64% / 9.83% / 10.51% | 9.29% / 2.51% | 3/6 · 171 | 472/384/359/40 | research：正超额窗口未过多数门槛；成本/延迟压力未过门槛；训练段数值邻域不稳定；DSR未达0.95；历史证券池不完整；历史成交/到账未核验 |
| r2a-cn-equity-formula-range-time-neighbor-110 | swing | 0.59% / -50.59% | 9.22% / 8.41% / 11.08% | 6.67% / 5.82% | 3/6 · 165 | 472/371/347/40 | research：正超额窗口未过多数门槛；成本/延迟压力未过门槛；训练段数值邻域不稳定；DSR未达0.95；历史证券池不完整；历史成交/到账未核验 |
| r2a-cn-equity-formula-pullback-atr | swing | -13.60% / -64.78% | 10.02% / 9.22% / 11.74% | 8.06% / 12.64% | 4/6 · 165 | 397/366/340/36 | research：训练段数值邻域不稳定；DSR未达0.95；历史证券池不完整；历史成交/到账未核验 |
| r2a-cn-equity-formula-pullback-atr-neighbor-90 | swing | -12.12% / -63.29% | 13.02% / 12.21% / 11.34% | 10.96% / 14.38% | 5/6 · 168 | 397/371/346/32 | research：训练段数值邻域不稳定；DSR未达0.95；历史证券池不完整；历史成交/到账未核验 |
| r2a-cn-equity-formula-pullback-atr-neighbor-110 | swing | -13.25% / -64.43% | 9.30% / 8.50% / 11.61% | 7.12% / 11.33% | 4/6 · 164 | 397/364/338/35 | research：训练段数值邻域不稳定；DSR未达0.95；历史证券池不完整；历史成交/到账未核验 |
| r2a-cn-equity-formula-pullback-trailing | swing | -8.27% / -59.44% | 13.92% / 13.11% / 7.76% | 11.79% / 17.93% | 5/6 · 228 | 397/492/461/42 | research：训练段数值邻域不稳定；DSR未达0.95；历史证券池不完整；历史成交/到账未核验 |
| r2a-cn-equity-formula-pullback-trailing-neighbor-90 | swing | -7.76% / -58.93% | 15.55% / 14.74% / 8.08% | 14.01% / 23.04% | 5/6 · 238 | 397/512/481/41 | research：训练段数值邻域不稳定；DSR未达0.95；历史证券池不完整；历史成交/到账未核验 |
| r2a-cn-equity-formula-pullback-trailing-neighbor-110 | swing | -9.17% / -60.35% | 13.51% / 12.71% / 8.52% | 11.55% / 18.15% | 5/6 · 220 | 397/474/445/41 | research：训练段数值邻域不稳定；DSR未达0.95；历史证券池不完整；历史成交/到账未核验 |
| r2a-cn-equity-formula-pullback-time | swing | -15.54% / -66.72% | 13.88% / 13.07% / 8.38% | 11.85% / 15.22% | 4/6 · 184 | 397/404/377/36 | research：训练段数值邻域不稳定；DSR未达0.95；历史证券池不完整；历史成交/到账未核验 |
| r2a-cn-equity-formula-pullback-time-neighbor-90 | swing | -15.30% / -66.48% | 13.69% / 12.89% / 7.45% | 11.70% / 11.97% | 4/6 · 190 | 397/417/388/38 | research：训练段数值邻域不稳定；DSR未达0.95；历史证券池不完整；历史成交/到账未核验 |
| r2a-cn-equity-formula-pullback-time-neighbor-110 | swing | -23.04% / -74.21% | 15.76% / 14.96% / 9.32% | 14.08% / 18.20% | 4/6 · 174 | 397/384/360/33 | research：训练段数值邻域不稳定；DSR未达0.95；历史证券池不完整；历史成交/到账未核验 |
| r2a-cn-equity-historical-low-atr | low-zone | 4.60% / -46.58% | -1.91% / -2.71% / 3.90% | -2.73% / -2.69% | 4/6 · 14 | 111/67/60/7 | research：成本/延迟压力未过门槛；闭合交易数不足；末段留出超额非正或缺失；训练段数值邻域不稳定；完整市场周期不足；DSR未达0.95；历史证券池不完整；低位估值/温度置信不足；历史成交/到账未核验 |
| r2a-cn-equity-historical-low-atr-neighbor-90 | low-zone | 4.93% / -46.25% | -1.91% / -2.71% / 3.90% | -2.73% / -2.69% | 4/6 · 14 | 111/67/60/7 | research：成本/延迟压力未过门槛；闭合交易数不足；末段留出超额非正或缺失；训练段数值邻域不稳定；完整市场周期不足；DSR未达0.95；历史证券池不完整；低位估值/温度置信不足；历史成交/到账未核验 |
| r2a-cn-equity-historical-low-atr-neighbor-110 | low-zone | 3.98% / -47.19% | -1.91% / -2.71% / 3.90% | -2.73% / -2.69% | 4/6 · 13 | 111/63/56/7 | research：成本/延迟压力未过门槛；闭合交易数不足；末段留出超额非正或缺失；训练段数值邻域不稳定；完整市场周期不足；DSR未达0.95；历史证券池不完整；低位估值/温度置信不足；历史成交/到账未核验 |
| r2a-cn-equity-historical-low-trailing | low-zone | 5.54% / -45.64% | -1.91% / -2.71% / 3.90% | -2.73% / -2.69% | 4/6 · 11 | 111/55/48/8 | research：成本/延迟压力未过门槛；闭合交易数不足；末段留出超额非正或缺失；训练段数值邻域不稳定；完整市场周期不足；DSR未达0.95；历史证券池不完整；低位估值/温度置信不足；历史成交/到账未核验 |
| r2a-cn-equity-historical-low-trailing-neighbor-90 | low-zone | 3.97% / -47.21% | -1.91% / -2.71% / 3.90% | -2.73% / -2.69% | 4/6 · 14 | 111/62/55/10 | research：成本/延迟压力未过门槛；闭合交易数不足；末段留出超额非正或缺失；训练段数值邻域不稳定；完整市场周期不足；DSR未达0.95；历史证券池不完整；低位估值/温度置信不足；历史成交/到账未核验 |
| r2a-cn-equity-historical-low-trailing-neighbor-110 | low-zone | 2.13% / -49.05% | -1.91% / -2.71% / 3.90% | -2.73% / -2.69% | 4/6 · 10 | 111/54/47/8 | research：成本/延迟压力未过门槛；闭合交易数不足；末段留出超额非正或缺失；训练段数值邻域不稳定；完整市场周期不足；DSR未达0.95；历史证券池不完整；低位估值/温度置信不足；历史成交/到账未核验 |
| r2a-cn-equity-historical-low-time | low-zone | -6.25% / -57.42% | -1.91% / -2.71% / 3.90% | -2.73% / -2.69% | 4/6 · 10 | 111/54/47/8 | research：成本/延迟压力未过门槛；闭合交易数不足；末段留出超额非正或缺失；训练段数值邻域不稳定；完整市场周期不足；DSR未达0.95；历史证券池不完整；低位估值/温度置信不足；历史成交/到账未核验 |
| r2a-cn-equity-historical-low-time-neighbor-90 | low-zone | -6.25% / -57.42% | -1.91% / -2.71% / 3.90% | -2.73% / -2.69% | 4/6 · 10 | 111/54/47/8 | research：成本/延迟压力未过门槛；闭合交易数不足；末段留出超额非正或缺失；训练段数值邻域不稳定；完整市场周期不足；DSR未达0.95；历史证券池不完整；低位估值/温度置信不足；历史成交/到账未核验 |
| r2a-cn-equity-historical-low-time-neighbor-110 | low-zone | -6.25% / -57.42% | -1.91% / -2.71% / 3.90% | -2.73% / -2.69% | 4/6 · 10 | 111/54/47/8 | research：成本/延迟压力未过门槛；闭合交易数不足；末段留出超额非正或缺失；训练段数值邻域不稳定；完整市场周期不足；DSR未达0.95；历史证券池不完整；低位估值/温度置信不足；历史成交/到账未核验 |

每行偏差标签随服务端成绩单保存：A股信号为固定截止前复权、RPS为后复权、成交原价；现金按除息日入账是情景假设，ST/IPO/队列与真实到账未核验。低位PE/PB采用本地财务/市值数学并严格过滤公告可见日，当前修订不冒充首次披露；历史市场温度缺失不会用均线状态替代。币种使用单一公开现货来源，数量步长和费用是研究情景，当前高流动性名单不证明历史退市覆盖或容量。
入场观察、订单、成交笔数和闭合轮次是不同集合；保护单/退出可增加订单，受阻卖单可重复尝试，所以拒单尝试数可能大于独立订单数。入场观察或成交为零时不归因任何执行阶段原因，资格栏的未核验项只是数据准入缺口，不是零信号或亏损的已证实原因。

#### 分仓与组合账本

组合使用事先声明的固定ATR代表，不按样本外最优结果拼装；表中组合为全期描述回放。分仓收益扣除每根bar现金划转后连乘，零资本bar留空，不将资金流当收益。分仓相关性只用两边均有效的同日收益，少于20日或零方差留空。

- day：Index or eligible stock low-zone 0/30/35/40 vs static 65/35. Only idle cash rebalances; holdings are never forced closed.
  - default / {"swing":1,"low-zone":0}：组合收益 -2.04%，超额 -23.23%，回撤 17.03%；分仓相关性 0.1604（重叠 2157 日），现金划转 3707 笔。
  - default/swing：有效 2394 日，划转中性收益 -12.65%，回撤 21.21%。
  - default/low-zone：有效 2157 日，划转中性收益 -2.93%，回撤 27.23%。
  - comparison / {"swing":0.65,"low-zone":0.35}：组合收益 -3.40%，超额 -24.59%，回撤 15.93%；分仓相关性 0.1715（重叠 2394 日），现金划转 231 笔。
  - comparison/swing：有效 2394 日，划转中性收益 -13.00%，回撤 21.02%。
  - comparison/low-zone：有效 2394 日，划转中性收益 13.41%，回撤 17.99%。

#### 独立低位检测与周期

低位价格分位采用<=当前价的经验比例；至少5个日历年且1000个观察。价格分位≤20%且距前高回撤≥30%为第一档，≤10%且回撤≥45%为第二档，≤5%且回撤≥60%为第三档；份额30%/35%/40%，非低位0%。已知估值/温度分位须≤30%佐证，缺失标签保留。价格分位恢复≥60%、距高点不足15%或已知估值分位≥70%定义恢复。所有条件只读当前及以前的完成数据。

- sh600156：观察 1998-05-27 至 2026-11-13，共 6802 根；入低位/加深 85 次；周期 11，其中完整 11。
  - 2003-05-27：档2，目标35.00%，置信price-only；价格分位6.80%，回撤-53.88%；PE/PB/温度分别 missing/missing/missing。
  - 2003-06-03：档2，目标35.00%，置信price-only；价格分位8.12%，回撤-53.49%；PE/PB/温度分别 missing/missing/missing。
  - 2003-07-14：档3，目标40.00%，置信price-only；价格分位0.16%，回撤-60.07%；PE/PB/温度分别 missing/missing/missing。
  - 2003-07-18：档3，目标40.00%，置信price-only；价格分位0.08%，回撤-60.84%；PE/PB/温度分别 missing/missing/missing。
  - 2004-04-16：档2，目标35.00%，置信price-only；价格分位9.74%，回撤-63.40%；PE/PB/温度分别 missing/missing/missing。
  - 2004-04-22：档2，目标35.00%，置信price-only；价格分位9.65%，回撤-63.47%；PE/PB/温度分别 missing/missing/missing。
  - 2004-05-25：档3，目标40.00%，置信price-only；价格分位3.29%，回撤-68.81%；PE/PB/温度分别 missing/missing/missing。
  - 2004-06-17：档3，目标40.00%，置信price-only；价格分位4.78%，回撤-68.35%；PE/PB/温度分别 missing/missing/missing。
  - 2004-06-24：档3，目标40.00%，置信price-only；价格分位4.90%，回撤-68.35%；PE/PB/温度分别 missing/missing/missing。
  - 2005-03-17：档3，目标40.00%，置信price-only；价格分位2.77%，回撤-79.96%；PE/PB/温度分别 missing/missing/missing。
  - 2005-09-22：档3，目标40.00%，置信price-only；价格分位3.71%，回撤-83.36%；PE/PB/温度分别 missing/missing/missing。
  - 2006-02-16：档3，目标40.00%，置信price-only；价格分位4.13%，回撤-85.06%；PE/PB/温度分别 missing/missing/missing。
  - 2006-03-07：档3，目标40.00%，置信price-only；价格分位3.19%，回撤-85.30%；PE/PB/温度分别 missing/missing/missing。
  - 2006-04-13：档3，目标40.00%，置信price-only；价格分位4.20%，回撤-85.30%；PE/PB/温度分别 missing/missing/missing。
  - 2006-04-21：档3，目标40.00%，置信price-only；价格分位3.55%，回撤-85.37%；PE/PB/温度分别 missing/missing/missing。
  - 2006-06-28：档1，目标30.00%，置信price-only；价格分位19.80%，回撤-76.94%；PE/PB/温度分别 missing/missing/missing。
  - 2006-07-05：档1，目标30.00%，置信price-only；价格分位19.80%，回撤-76.94%；PE/PB/温度分别 missing/missing/missing。
  - 2006-07-07：档1，目标30.00%，置信price-only；价格分位19.94%，回撤-76.63%；PE/PB/温度分别 missing/missing/missing。
  - 2006-07-14：档1，目标30.00%，置信price-only；价格分位19.52%，回撤-77.40%；PE/PB/温度分别 missing/missing/missing。
  - 2006-07-27：档1，目标30.00%，置信price-only；价格分位19.74%，回撤-77.25%；PE/PB/温度分别 missing/missing/missing。
  - 2006-08-18：档1，目标30.00%，置信price-only；价格分位19.95%，回撤-77.71%；PE/PB/温度分别 missing/missing/missing。
  - 2006-09-07：档1，目标30.00%，置信price-only；价格分位19.91%，回撤-77.48%；PE/PB/温度分别 missing/missing/missing。
  - 2006-09-22：档1，目标30.00%，置信price-only；价格分位19.80%，回撤-77.71%；PE/PB/温度分别 missing/missing/missing。
  - 2006-10-27：档1，目标30.00%，置信price-only；价格分位19.62%，回撤-77.94%；PE/PB/温度分别 missing/missing/missing。
  - 2006-11-01：档1，目标30.00%，置信price-only；价格分位19.84%，回撤-77.71%；PE/PB/温度分别 missing/missing/missing。
  - 2006-11-06：档1，目标30.00%，置信price-only；价格分位19.86%，回撤-77.71%；PE/PB/温度分别 missing/missing/missing。
  - 2006-11-10：档1，目标30.00%，置信price-only；价格分位18.56%，回撤-78.72%；PE/PB/温度分别 missing/missing/missing。
  - 2006-12-06：档1，目标30.00%，置信price-only；价格分位18.95%，回撤-78.80%；PE/PB/温度分别 missing/missing/missing。
  - 2008-08-18：档1，目标30.00%，置信price-only；价格分位19.86%，回撤-80.86%；PE/PB/温度分别 missing/missing/missing。
  - 2008-09-08：档1，目标30.00%，置信price-only；价格分位19.81%，回撤-80.93%；PE/PB/温度分别 missing/missing/missing。
  - 2008-09-16：档1，目标30.00%，置信price-only；价格分位19.14%，回撤-81.18%；PE/PB/温度分别 missing/missing/missing。
  - 2008-09-23：档1，目标30.00%，置信price-only；价格分位19.27%，回撤-81.18%；PE/PB/温度分别 missing/missing/missing。
  - 2008-10-07：档1，目标30.00%，置信price-only；价格分位19.80%，回撤-81.05%；PE/PB/温度分别 missing/missing/missing。
  - 2008-10-27：档2，目标35.00%，置信price-only；价格分位9.84%，回撤-85.74%；PE/PB/温度分别 missing/missing/missing。
  - 2008-10-29：档2，目标35.00%，置信price-only；价格分位9.75%，回撤-85.80%；PE/PB/温度分别 missing/missing/missing。
  - 2008-11-06：档2，目标35.00%，置信price-only；价格分位9.50%，回撤-85.99%；PE/PB/温度分别 missing/missing/missing。
  - 2008-11-18：档1，目标30.00%，置信price-only；价格分位18.28%，回撤-82.13%；PE/PB/温度分别 missing/missing/missing。
  - 2008-11-24：档1，目标30.00%，置信price-only；价格分位18.79%，回撤-81.94%；PE/PB/温度分别 missing/missing/missing。
  - 2008-11-26：档1，目标30.00%，置信price-only；价格分位19.93%，回撤-81.50%；PE/PB/温度分别 missing/missing/missing。
  - 2008-11-28：档1，目标30.00%，置信price-only；价格分位17.60%，回撤-82.45%；PE/PB/温度分别 missing/missing/missing。
  - 2008-12-12：档1，目标30.00%，置信price-only；价格分位18.91%，回撤-81.88%；PE/PB/温度分别 missing/missing/missing。
  - 2008-12-24：档1，目标30.00%，置信price-only；价格分位18.96%，回撤-81.88%；PE/PB/温度分别 missing/missing/missing。
  - 2009-01-07：档1，目标30.00%，置信price-only；价格分位19.48%，回撤-81.75%；PE/PB/温度分别 missing/missing/missing。
  - 2018-02-06：档1，目标30.00%，置信price-only；价格分位10.73%，回撤-77.85%；PE/PB/温度分别 missing/missing/missing。
  - 2018-05-28：档1，目标30.00%，置信price-only；价格分位19.30%，回撤-76.18%；PE/PB/温度分别 missing/missing/missing。
  - 2018-06-19：档2，目标35.00%，置信price-only；价格分位8.98%，回撤-78.19%；PE/PB/温度分别 missing/missing/missing。
  - 2018-06-21：档2，目标35.00%，置信price-only；价格分位7.94%，回撤-78.71%；PE/PB/温度分别 missing/missing/missing。
  - 2018-07-05：档1，目标30.00%，置信price-only；价格分位13.45%，回撤-77.22%；PE/PB/温度分别 missing/missing/missing。
  - 2018-08-02：档1，目标30.00%，置信price-only；价格分位16.99%，回撤-76.64%；PE/PB/温度分别 missing/missing/missing。
  - 2018-09-07：档1，目标30.00%，置信price-only；价格分位15.98%，回撤-76.64%；PE/PB/温度分别 missing/missing/missing。
  - 2018-09-17：档2，目标35.00%，置信price-only；价格分位8.68%，回撤-78.02%；PE/PB/温度分别 missing/missing/missing。
  - 2018-09-27：档2，目标35.00%，置信price-only；价格分位7.81%，回撤-78.13%；PE/PB/温度分别 missing/missing/missing。
  - 2018-10-10：档2，目标35.00%，置信price-only；价格分位9.94%，回撤-77.62%；PE/PB/温度分别 missing/missing/missing。
  - 2018-10-12：档3，目标40.00%，置信price-only；价格分位4.38%，回撤-79.74%；PE/PB/温度分别 missing/missing/missing。
  - 2018-11-06：档1，目标30.00%，置信price-only；价格分位18.16%，回撤-76.30%；PE/PB/温度分别 missing/missing/missing。
  - 2018-11-23：档2，目标35.00%，置信price-only；价格分位7.18%，回撤-78.08%；PE/PB/温度分别 missing/approximate/missing。
  - 2019-08-13：档1，目标30.00%，置信price-only；价格分位19.66%，回撤-75.38%；PE/PB/温度分别 approximate/approximate/missing。
  - 2019-09-26：档1，目标30.00%，置信price-only；价格分位18.12%，回撤-75.67%；PE/PB/温度分别 approximate/approximate/missing。
  - 2019-10-24：档1，目标30.00%，置信price-only；价格分位19.12%，回撤-75.49%；PE/PB/温度分别 approximate/approximate/missing。
  - 2019-11-11：档2，目标35.00%，置信price-only；价格分位7.80%，回撤-77.33%；PE/PB/温度分别 approximate/approximate/missing。
  - 2019-11-15：档2，目标35.00%，置信price-only；价格分位6.42%，回撤-77.56%；PE/PB/温度分别 approximate/approximate/missing。
  - 2020-02-03：档3，目标40.00%，置信price-only；价格分位4.02%，回撤-78.13%；PE/PB/温度分别 approximate/approximate/missing。
  - 2020-04-24：档1，目标30.00%，置信price-only；价格分位16.10%，回撤-76.24%；PE/PB/温度分别 missing/approximate/missing。
  - 2020-04-28：档2，目标35.00%，置信price-only；价格分位9.97%，回撤-77.04%；PE/PB/温度分别 missing/approximate/missing。
  - 2020-05-14：档1，目标30.00%，置信price-only；价格分位18.66%，回撤-75.95%；PE/PB/温度分别 missing/approximate/missing。
  - 2020-06-03：档1，目标30.00%，置信price-only；价格分位19.57%，回撤-75.84%；PE/PB/温度分别 missing/approximate/missing。
  - 2020-06-05：档1，目标30.00%，置信price-only；价格分位19.20%，回撤-75.95%；PE/PB/温度分别 missing/approximate/missing。
  - 2021-04-01：档2，目标35.00%，置信price-only；价格分位7.08%，回撤-77.90%；PE/PB/温度分别 approximate/approximate/missing。
  - 2021-04-12：档3，目标40.00%，置信price-only；价格分位4.54%，回撤-78.42%；PE/PB/温度分别 approximate/approximate/missing。
  - 2021-04-23：档3，目标40.00%，置信price-only；价格分位4.75%，回撤-78.36%；PE/PB/温度分别 approximate/approximate/missing。
  - 2021-04-27：档3，目标40.00%，置信price-only；价格分位4.91%，回撤-78.31%；PE/PB/温度分别 approximate/approximate/missing。
  - 2021-06-07：档1，目标30.00%，置信price-only；价格分位11.66%，回撤-77.33%；PE/PB/温度分别 missing/approximate/missing。
  - 2021-06-09：档1，目标30.00%，置信price-only；价格分位12.83%，回撤-77.16%；PE/PB/温度分别 missing/approximate/missing。
  - 2021-06-10：档2，目标35.00%，置信price-only；价格分位9.75%，回撤-77.62%；PE/PB/温度分别 missing/approximate/missing。
  - 2021-06-15：档2，目标35.00%，置信price-only；价格分位7.25%，回撤-78.02%；PE/PB/温度分别 missing/approximate/missing。
  - 2021-06-28：档2，目标35.00%，置信price-only；价格分位9.00%，回撤-77.79%；PE/PB/温度分别 missing/approximate/missing。
  - 2021-07-01：档3，目标40.00%，置信price-only；价格分位3.88%，回撤-78.82%；PE/PB/温度分别 missing/approximate/missing。
  - 2021-07-08：档3，目标40.00%，置信price-only；价格分位4.67%，回撤-78.65%；PE/PB/温度分别 missing/approximate/missing。
  - 2021-07-14：档3，目标40.00%，置信price-only；价格分位4.71%，回撤-78.65%；PE/PB/温度分别 missing/approximate/missing。
  - 2021-10-27：档3，目标40.00%，置信price-only；价格分位2.33%，回撤-79.63%；PE/PB/温度分别 missing/approximate/missing。
  - 2021-12-06：档2，目标35.00%，置信price-only；价格分位8.63%，回撤-78.19%；PE/PB/温度分别 missing/approximate/missing。
  - 2022-01-24：档1，目标30.00%，置信price-only；价格分位17.66%，回撤-77.04%；PE/PB/温度分别 missing/approximate/missing。
  - 2022-01-25：档2，目标35.00%，置信price-only；价格分位9.08%，回撤-78.13%；PE/PB/温度分别 missing/approximate/missing。
  - 2022-01-27：档2，目标35.00%，置信price-only；价格分位7.36%，回撤-78.42%；PE/PB/温度分别 missing/approximate/missing。
  - 2022-04-27：档3，目标40.00%，置信price-only；价格分位3.75%，回撤-79.17%；PE/PB/温度分别 missing/approximate/missing。
- sh603015：观察 2015-03-03 至 2026-11-13，共 2835 根；入低位/加深 29 次；周期 2，其中完整 2。
  - 2020-12-11：档1，目标30.00%，置信price-only；价格分位19.49%，回撤-75.65%；PE/PB/温度分别 approximate/approximate/missing。
  - 2020-12-18：档1，目标30.00%，置信price-only；价格分位14.22%，回撤-76.33%；PE/PB/温度分别 approximate/approximate/missing。
  - 2020-12-24：档2，目标35.00%，置信price-only；价格分位8.30%，回撤-77.12%；PE/PB/温度分别 approximate/approximate/missing。
  - 2021-01-06：档2，目标35.00%，置信price-only；价格分位8.96%，回撤-77.08%；PE/PB/温度分别 approximate/approximate/missing。
  - 2021-01-07：档3，目标40.00%，置信price-only；价格分位3.95%，回撤-77.84%；PE/PB/温度分别 approximate/approximate/missing。
  - 2021-01-11：档3，目标40.00%，置信price-only；价格分位1.97%，回撤-78.59%；PE/PB/温度分别 approximate/approximate/missing。
  - 2021-01-22：档3，目标40.00%，置信price-only；价格分位4.41%，回撤-77.80%；PE/PB/温度分别 approximate/approximate/missing。
  - 2021-02-23：档3，目标40.00%，置信price-only；价格分位4.08%，回撤-78.06%；PE/PB/温度分别 approximate/approximate/missing。
  - 2021-03-10：档3，目标40.00%，置信price-only；价格分位3.64%，回撤-78.14%；PE/PB/温度分别 approximate/approximate/missing。
  - 2021-03-17：档2，目标35.00%，置信price-only；价格分位9.77%，回撤-77.27%；PE/PB/温度分别 approximate/approximate/missing。
  - 2021-03-23：档2，目标35.00%，置信price-only；价格分位7.91%，回撤-77.46%；PE/PB/温度分别 approximate/approximate/missing。
  - 2021-03-29：档2，目标35.00%，置信price-only；价格分位6.87%，回撤-77.65%；PE/PB/温度分别 approximate/approximate/missing。
  - 2021-03-30：档3，目标40.00%，置信price-only；价格分位3.46%，回撤-78.21%；PE/PB/温度分别 approximate/approximate/missing。
  - 2021-04-08：档1，目标30.00%，置信price-only；价格分位10.15%，回撤-77.31%；PE/PB/温度分别 approximate/approximate/missing。
  - 2021-04-09：档2，目标35.00%，置信price-only；价格分位8.18%，回撤-77.46%；PE/PB/温度分别 approximate/approximate/missing。
  - 2021-04-13：档3，目标40.00%，置信price-only；价格分位4.19%，回撤-78.06%；PE/PB/温度分别 approximate/approximate/missing。
  - 2021-04-20：档2，目标35.00%，置信price-only；价格分位8.48%，回撤-77.46%；PE/PB/温度分别 approximate/approximate/missing。
  - 2021-04-23：档2，目标35.00%，置信price-only；价格分位6.65%，回撤-77.72%；PE/PB/温度分别 approximate/approximate/missing。
  - 2021-04-27：档3，目标40.00%，置信price-only；价格分位2.75%，回撤-78.40%；PE/PB/温度分别 approximate/approximate/missing。
  - 2021-04-29：档1，目标30.00%，置信price-only；价格分位15.47%，回撤-76.74%；PE/PB/温度分别 approximate/approximate/missing。
  - 2021-05-19：档1，目标30.00%，置信price-only；价格分位17.02%，回撤-76.59%；PE/PB/温度分别 approximate/approximate/missing。
  - 2021-06-02：档1，目标30.00%，置信price-only；价格分位18.43%，回撤-76.44%；PE/PB/温度分别 approximate/approximate/missing。
  - 2022-04-08：档1，目标30.00%，置信price-only；价格分位18.31%，回撤-76.17%；PE/PB/温度分别 approximate/approximate/missing。
  - 2022-04-15：档2，目标35.00%，置信price-only；价格分位9.86%，回撤-77.20%；PE/PB/温度分别 approximate/approximate/missing。
  - 2022-04-21：档2，目标35.00%，置信price-only；价格分位7.92%，回撤-77.39%；PE/PB/温度分别 approximate/approximate/missing。
  - 2022-04-25：档3，目标40.00%，置信price-only；价格分位0.64%，回撤-79.38%；PE/PB/温度分别 approximate/approximate/missing。
  - 2022-05-23：档1，目标30.00%，置信price-only；价格分位17.85%，回撤-76.40%；PE/PB/温度分别 approximate/approximate/missing。
  - 2022-05-24：档2，目标35.00%，置信price-only；价格分位9.32%，回撤-77.36%；PE/PB/温度分别 approximate/approximate/missing。
  - 2022-06-08：档1，目标30.00%，置信price-only；价格分位17.40%，回撤-76.48%；PE/PB/温度分别 approximate/approximate/missing。
- sh603800：观察 2015-12-10 至 2026-11-13，共 2648 根；入低位/加深 3 次；周期 1，其中完整 1。
  - 2020-12-10：档3，目标40.00%，置信price-only；价格分位2.63%，回撤-80.94%；PE/PB/温度分别 missing/approximate/missing。
  - 2021-04-23：档3，目标40.00%，置信price-only；价格分位4.98%，回撤-83.26%；PE/PB/温度分别 missing/approximate/missing。
  - 2021-04-27：档3，目标40.00%，置信price-only；价格分位4.21%，回撤-83.58%；PE/PB/温度分别 missing/approximate/missing。
- sh688303：观察 2021-07-22 至 2026-11-13，共 1287 根；入低位/加深 5 次；周期 1，其中完整 0。
  - 2026-07-22：档3，目标40.00%，置信price-only；价格分位0.91%，回撤-79.53%；PE/PB/温度分别 missing/approximate/missing。
  - 2026-08-04：档2，目标35.00%，置信price-only；价格分位8.85%，回撤-76.56%；PE/PB/温度分别 missing/approximate/missing。
  - 2026-08-13：档3，目标40.00%，置信price-only；价格分位4.16%，回撤-77.70%；PE/PB/温度分别 missing/approximate/missing。
  - 2026-08-18：档3，目标40.00%，置信price-only；价格分位3.98%，回撤-77.77%；PE/PB/温度分别 missing/approximate/missing。
  - 2026-11-09：档3，目标40.00%，置信price-only；价格分位4.75%，回撤-78.81%；PE/PB/温度分别 missing/approximate/missing。
- sz000529：观察 1993-11-18 至 2026-11-13，共 7045 根；入低位/加深 72 次；周期 6，其中完整 5。
  - 2003-04-09：档1，目标30.00%，置信price-only；价格分位20.00%，回撤-72.68%；PE/PB/温度分别 missing/missing/missing。
  - 2003-04-18：档1，目标30.00%，置信price-only；价格分位19.76%，回撤-72.86%；PE/PB/温度分别 missing/missing/missing。
  - 2003-06-30：档1，目标30.00%，置信price-only；价格分位18.98%，回撤-74.44%；PE/PB/温度分别 missing/missing/missing。
  - 2003-10-30：档2，目标35.00%，置信price-only；价格分位9.97%，回撤-79.05%；PE/PB/温度分别 missing/missing/missing。
  - 2003-11-05：档2，目标35.00%，置信price-only；价格分位8.79%，回撤-79.54%；PE/PB/温度分别 missing/missing/missing。
  - 2003-12-16：档2，目标35.00%，置信price-only；价格分位9.63%，回撤-79.54%；PE/PB/温度分别 missing/missing/missing。
  - 2003-12-24：档3，目标40.00%，置信price-only；价格分位4.55%，回撤-81.36%；PE/PB/温度分别 missing/missing/missing。
  - 2003-12-30：档2，目标35.00%，置信price-only；价格分位9.59%，回撤-79.66%；PE/PB/温度分别 missing/missing/missing。
  - 2004-01-08：档2，目标35.00%，置信price-only；价格分位9.68%，回撤-79.66%；PE/PB/温度分别 missing/missing/missing。
  - 2004-02-13：档1，目标30.00%，置信price-only；价格分位18.50%，回撤-76.50%；PE/PB/温度分别 missing/missing/missing。
  - 2004-02-19：档1，目标30.00%，置信price-only；价格分位19.59%，回撤-76.14%；PE/PB/温度分别 missing/missing/missing。
  - 2004-03-03：档1，目标30.00%，置信price-only；价格分位18.87%，回撤-76.38%；PE/PB/温度分别 missing/missing/missing。
  - 2004-03-08：档1，目标30.00%，置信price-only；价格分位16.76%，回撤-77.05%；PE/PB/温度分别 missing/missing/missing。
  - 2004-04-14：档1，目标30.00%，置信price-only；价格分位18.10%，回撤-76.62%；PE/PB/温度分别 missing/missing/missing。
  - 2004-06-02：档2，目标35.00%，置信price-only；价格分位9.75%，回撤-79.66%；PE/PB/温度分别 missing/missing/missing。
  - 2004-06-04：档2，目标35.00%，置信price-only；价格分位9.46%，回撤-79.72%；PE/PB/温度分别 missing/missing/missing。
  - 2004-06-14：档3，目标40.00%，置信price-only；价格分位4.06%，回撤-81.78%；PE/PB/温度分别 missing/missing/missing。
  - 2004-07-30：档3，目标40.00%，置信price-only；价格分位4.60%，回撤-81.84%；PE/PB/温度分别 missing/missing/missing。
  - 2004-08-05：档3，目标40.00%，置信price-only；价格分位4.39%，回撤-81.97%；PE/PB/温度分别 missing/missing/missing。
  - 2004-08-26：档3，目标40.00%，置信price-only；价格分位4.43%，回撤-82.09%；PE/PB/温度分别 missing/missing/missing。
  - 2004-09-01：档3，目标40.00%，置信price-only；价格分位4.23%，回撤-82.21%；PE/PB/温度分别 missing/missing/missing。
  - 2004-09-22：档2，目标35.00%，置信price-only；价格分位8.62%，回撤-80.99%；PE/PB/温度分别 missing/missing/missing。
  - 2004-10-13：档2，目标35.00%，置信price-only；价格分位9.46%，回撤-80.81%；PE/PB/温度分别 missing/missing/missing。
  - 2004-10-15：档3，目标40.00%，置信price-only；价格分位3.82%，回撤-82.33%；PE/PB/温度分别 missing/missing/missing。
  - 2004-10-20：档3，目标40.00%，置信price-only；价格分位4.61%，回撤-82.15%；PE/PB/温度分别 missing/missing/missing。
  - 2004-11-24：档3，目标40.00%，置信price-only；价格分位3.69%，回撤-83.06%；PE/PB/温度分别 missing/missing/missing。
  - 2018-02-01：档2，目标35.00%，置信price-only；价格分位7.10%，回撤-68.17%；PE/PB/温度分别 missing/missing/missing。
  - 2018-02-06：档3，目标40.00%，置信price-only；价格分位2.28%，回撤-71.11%；PE/PB/温度分别 missing/missing/missing。
  - 2018-03-02：档2，目标35.00%，置信price-only；价格分位9.87%，回撤-67.55%；PE/PB/温度分别 missing/missing/missing。
  - 2018-03-20：档1，目标30.00%，置信price-only；价格分位18.13%，回撤-65.89%；PE/PB/温度分别 missing/missing/missing。
  - 2018-03-26：档1，目标30.00%，置信price-only；价格分位10.04%，回撤-67.50%；PE/PB/温度分别 missing/missing/missing。
  - 2018-03-28：档2，目标35.00%，置信price-only；价格分位9.88%，回撤-67.55%；PE/PB/温度分别 missing/missing/missing。
  - 2018-04-03：档2，目标35.00%，置信price-only；价格分位9.60%，回撤-67.65%；PE/PB/温度分别 missing/missing/missing。
  - 2018-05-03：档2，目标35.00%，置信price-only；价格分位8.41%，回撤-68.07%；PE/PB/温度分别 missing/missing/missing。
  - 2018-05-09：档2，目标35.00%，置信price-only；价格分位9.55%，回撤-67.76%；PE/PB/温度分别 missing/missing/missing。
  - 2018-05-14：档1，目标30.00%，置信price-only；价格分位14.10%，回撤-66.77%；PE/PB/温度分别 missing/missing/missing。
  - 2018-05-29：档1，目标30.00%，置信price-only；价格分位16.97%，回撤-66.26%；PE/PB/温度分别 missing/missing/missing。
  - 2018-05-30：档2，目标35.00%，置信price-only；价格分位7.73%，回撤-68.17%；PE/PB/温度分别 missing/missing/missing。
  - 2018-06-01：档2，目标35.00%，置信price-only；价格分位7.92%，回撤-68.12%；PE/PB/温度分别 missing/missing/missing。
  - 2018-06-08：档2，目标35.00%，置信price-only；价格分位6.31%，回撤-68.48%；PE/PB/温度分别 missing/missing/missing。
  - 2018-06-19：档3，目标40.00%，置信price-only；价格分位1.64%，回撤-71.99%；PE/PB/温度分别 missing/missing/missing。
  - 2018-12-10：档3，目标40.00%，置信price-only；价格分位1.17%，回撤-75.47%；PE/PB/温度分别 approximate/approximate/missing。
  - 2018-12-17：档3，目标40.00%，置信price-only；价格分位1.21%，回撤-75.52%；PE/PB/温度分别 approximate/approximate/missing。
  - 2019-01-30：档3，目标40.00%，置信price-only；价格分位1.20%，回撤-76.15%；PE/PB/温度分别 approximate/approximate/missing。
  - 2021-01-25：档1，目标30.00%，置信price-only；价格分位19.12%，回撤-67.19%；PE/PB/温度分别 approximate/approximate/missing。
  - 2021-01-27：档1，目标30.00%，置信price-only；价格分位19.50%，回撤-67.09%；PE/PB/温度分别 approximate/approximate/missing。
  - 2021-02-04：档2，目标35.00%，置信price-only；价格分位9.91%，回撤-69.60%；PE/PB/温度分别 approximate/approximate/missing。
  - 2021-03-02：档1，目标30.00%，置信price-only；价格分位19.72%，回撤-67.09%；PE/PB/温度分别 approximate/approximate/missing。
  - 2021-03-04：档1，目标30.00%，置信price-only；价格分位19.76%，回撤-67.09%；PE/PB/温度分别 approximate/approximate/missing。
  - 2021-03-09：档1，目标30.00%，置信price-only；价格分位17.40%，回撤-67.51%；PE/PB/温度分别 approximate/approximate/missing。
  - 2021-04-12：档1，目标30.00%，置信price-only；价格分位19.24%，回撤-67.25%；PE/PB/温度分别 approximate/approximate/missing。
  - 2021-04-14：档1，目标30.00%，置信price-only；价格分位18.38%，回撤-67.35%；PE/PB/温度分别 approximate/approximate/missing。
  - 2021-04-26：档1，目标30.00%，置信price-only；价格分位19.53%，回撤-67.19%；PE/PB/温度分别 approximate/approximate/missing。
  - 2021-06-08：档2，目标35.00%，置信price-only；价格分位9.92%，回撤-69.71%；PE/PB/温度分别 approximate/approximate/missing。
  - 2021-06-29：档2，目标35.00%，置信price-only；价格分位9.62%，回撤-70.30%；PE/PB/温度分别 approximate/approximate/missing。
  - 2021-07-08：档2，目标35.00%，置信price-only；价格分位9.49%，回撤-70.46%；PE/PB/温度分别 approximate/approximate/missing。
  - 2021-07-12：档2，目标35.00%，置信price-only；价格分位9.92%，回撤-70.30%；PE/PB/温度分别 approximate/approximate/missing。
  - 2021-10-14：档1，目标30.00%，置信price-only；价格分位19.79%，回撤-67.84%；PE/PB/温度分别 approximate/approximate/missing。
  - 2021-10-21：档1，目标30.00%，置信price-only；价格分位19.71%，回撤-67.89%；PE/PB/温度分别 approximate/approximate/missing。
  - 2021-11-11：档1，目标30.00%，置信price-only；价格分位19.24%，回撤-68.05%；PE/PB/温度分别 approximate/approximate/missing。
  - 2021-11-18：档1，目标30.00%，置信price-only；价格分位17.30%，回撤-68.38%；PE/PB/温度分别 approximate/approximate/missing。
  - 2021-11-22：档1，目标30.00%，置信price-only；价格分位17.42%，回撤-68.33%；PE/PB/温度分别 approximate/approximate/missing。
  - 2022-01-25：档1，目标30.00%，置信price-only；价格分位16.92%，回撤-68.55%；PE/PB/温度分别 approximate/approximate/missing。
  - 2022-03-14：档1，目标30.00%，置信price-only；价格分位18.83%，回撤-68.22%；PE/PB/温度分别 approximate/approximate/missing。
  - 2022-04-26：档1，目标30.00%，置信price-only；价格分位18.30%，回撤-68.33%；PE/PB/温度分别 approximate/approximate/missing。
  - 2022-05-06：档1，目标30.00%，置信price-only；价格分位16.80%，回撤-68.60%；PE/PB/温度分别 approximate/approximate/missing。
  - 2024-01-31：档1，目标30.00%，置信price-only；价格分位19.64%，回撤-67.39%；PE/PB/温度分别 approximate/approximate/missing。
  - 2024-02-02：档2，目标35.00%，置信price-only；价格分位9.88%，回撤-69.51%；PE/PB/温度分别 approximate/approximate/missing。
  - 2024-02-28：档1，目标30.00%，置信price-only；价格分位11.13%，回撤-69.11%；PE/PB/温度分别 approximate/approximate/missing。
  - 2024-03-27：档1，目标30.00%，置信price-only；价格分位18.41%，回撤-67.68%；PE/PB/温度分别 approximate/approximate/missing。
  - 2024-04-16：档1，目标30.00%，置信price-only；价格分位16.50%，回撤-68.02%；PE/PB/温度分别 approximate/approximate/missing。
  - 2026-11-13：档2，目标35.00%，置信price-only；价格分位8.15%，回撤-55.27%；PE/PB/温度分别 missing/missing/missing。
- sz002002：观察 2004-06-25 至 2024-01-18，共 4239 根；入低位/加深 54 次；周期 1，其中完整 0。
  - 2016-09-26：档1，目标30.00%，置信price-only；价格分位19.66%，回撤-83.43%；PE/PB/温度分别 missing/missing/missing。
  - 2017-12-20：档1，目标30.00%，置信price-only；价格分位19.56%，回撤-82.71%；PE/PB/温度分别 missing/missing/missing。
  - 2018-02-06：档1，目标30.00%，置信price-only；价格分位18.47%，回撤-82.83%；PE/PB/温度分别 missing/missing/missing。
  - 2018-06-26：档2，目标35.00%，置信price-only；价格分位8.45%，回撤-85.96%；PE/PB/温度分别 missing/missing/missing。
  - 2018-07-16：档3，目标40.00%，置信price-only；价格分位4.93%，回撤-89.69%；PE/PB/温度分别 missing/missing/missing。
  - 2019-01-22：档3，目标40.00%，置信price-only；价格分位3.86%，回撤-91.79%；PE/PB/温度分别 missing/missing/missing。
  - 2019-01-30：档3，目标40.00%，置信price-only；价格分位4.66%，回撤-91.47%；PE/PB/温度分别 missing/missing/missing。
  - 2019-03-20：档2，目标35.00%，置信price-only；价格分位9.24%，回撤-86.51%；PE/PB/温度分别 missing/missing/missing。
  - 2019-03-28：档2，目标35.00%，置信price-only；价格分位8.91%，回撤-86.84%；PE/PB/温度分别 missing/missing/missing。
  - 2019-04-25：档1，目标30.00%，置信price-only；价格分位12.82%，回撤-83.68%；PE/PB/温度分别 missing/missing/missing。
  - 2019-04-26：档2，目标35.00%，置信price-only；价格分位9.86%，回撤-85.29%；PE/PB/温度分别 missing/missing/missing。
  - 2019-07-08：档2，目标35.00%，置信price-only；价格分位9.43%，回撤-86.36%；PE/PB/温度分别 missing/missing/missing。
  - 2020-01-08：档2，目标35.00%，置信price-only；价格分位9.04%，回撤-89.59%；PE/PB/温度分别 missing/missing/missing。
  - 2020-01-17：档2，目标35.00%，置信price-only；价格分位9.89%，回撤-89.44%；PE/PB/温度分别 missing/missing/missing。
  - 2020-01-21：档2，目标35.00%，置信price-only；价格分位8.67%，回撤-89.84%；PE/PB/温度分别 missing/missing/missing。
  - 2020-02-11：档2，目标35.00%，置信price-only；价格分位9.49%，回撤-89.59%；PE/PB/温度分别 missing/missing/missing。
  - 2020-02-13：档2，目标35.00%，置信price-only；价格分位9.07%，回撤-89.76%；PE/PB/温度分别 missing/missing/missing。
  - 2020-03-17：档2，目标35.00%，置信price-only；价格分位9.33%，回撤-89.66%；PE/PB/温度分别 missing/missing/missing。
  - 2020-07-17：档2，目标35.00%，置信price-only；价格分位9.36%，回撤-90.42%；PE/PB/温度分别 missing/missing/missing。
  - 2020-07-24：档2，目标35.00%，置信price-only；价格分位8.51%，回撤-90.52%；PE/PB/温度分别 missing/missing/missing。
  - 2020-09-03：档2，目标35.00%，置信price-only；价格分位9.87%，回撤-90.37%；PE/PB/温度分别 missing/missing/missing。
  - 2020-09-28：档2，目标35.00%，置信price-only；价格分位9.99%，回撤-90.34%；PE/PB/温度分别 missing/missing/missing。
  - 2020-09-30：档2，目标35.00%，置信price-only；价格分位8.91%，回撤-90.49%；PE/PB/温度分别 missing/missing/missing。
  - 2020-10-19：档2，目标35.00%，置信price-only；价格分位9.90%，回撤-90.39%；PE/PB/温度分别 missing/missing/missing。
  - 2020-10-21：档2，目标35.00%，置信price-only；价格分位8.63%，回撤-90.52%；PE/PB/温度分别 missing/missing/missing。
  - 2020-12-10：档2，目标35.00%，置信price-only；价格分位9.76%，回撤-90.49%；PE/PB/温度分别 missing/missing/missing。
  - 2020-12-15：档3，目标40.00%，置信price-only；价格分位4.83%，回撤-91.44%；PE/PB/温度分别 missing/missing/missing。
  - 2021-02-04：档3，目标40.00%，置信price-only；价格分位4.31%，回撤-92.09%；PE/PB/温度分别 missing/missing/missing。
  - 2021-02-24：档2，目标35.00%，置信price-only；价格分位9.95%，回撤-90.69%；PE/PB/温度分别 missing/missing/missing。
  - 2021-03-04：档2，目标35.00%，置信price-only；价格分位8.59%，回撤-90.87%；PE/PB/温度分别 missing/missing/missing。
  - 2021-03-25：档2，目标35.00%，置信price-only；价格分位9.24%，回撤-90.82%；PE/PB/温度分别 missing/missing/missing。
  - 2021-03-30：档2，目标35.00%，置信price-only；价格分位8.68%，回撤-90.94%；PE/PB/温度分别 missing/missing/missing。
  - 2021-04-12：档1，目标30.00%，置信price-only；价格分位17.59%，回撤-90.07%；PE/PB/温度分别 missing/missing/missing。
  - 2021-04-27：档2，目标35.00%，置信price-only；价格分位9.10%，回撤-90.87%；PE/PB/温度分别 missing/missing/missing。
  - 2021-05-14：档1，目标30.00%，置信price-only；价格分位18.44%，回撤-90.07%；PE/PB/温度分别 missing/missing/missing。
  - 2021-05-19：档1，目标30.00%，置信price-only；价格分位19.47%，回撤-89.99%；PE/PB/温度分别 missing/missing/missing。
  - 2021-06-16：档1，目标30.00%，置信price-only；价格分位18.91%，回撤-90.04%；PE/PB/温度分别 missing/missing/missing。
  - 2021-06-24：档1，目标30.00%，置信price-only；价格分位18.21%，回撤-90.09%；PE/PB/温度分别 missing/missing/missing。
  - 2021-06-29：档1，目标30.00%，置信price-only；价格分位17.74%，回撤-90.14%；PE/PB/温度分别 missing/missing/missing。
  - 2022-04-20：档1，目标30.00%，置信price-only；价格分位19.18%，回撤-89.99%；PE/PB/温度分别 missing/missing/missing。
  - 2022-04-25：档2，目标35.00%，置信price-only；价格分位5.80%，回撤-91.57%；PE/PB/温度分别 missing/missing/missing。
  - 2022-06-09：档2，目标35.00%，置信price-only；价格分位9.36%，回撤-90.94%；PE/PB/温度分别 missing/missing/missing。
  - 2022-06-22：档2，目标35.00%，置信price-only；价格分位9.80%，回撤-90.87%；PE/PB/温度分别 missing/missing/missing。
  - 2022-07-04：档2，目标35.00%，置信price-only；价格分位9.71%，回撤-90.89%；PE/PB/温度分别 missing/missing/missing。
  - 2022-07-25：档2，目标35.00%，置信price-only；价格分位9.31%，回撤-90.99%；PE/PB/温度分别 missing/missing/missing。
  - 2022-08-02：档2，目标35.00%，置信price-only；价格分位9.75%，回撤-90.97%；PE/PB/温度分别 missing/missing/missing。
  - 2022-08-09：档2，目标35.00%，置信price-only；价格分位9.13%，回撤-91.02%；PE/PB/温度分别 missing/missing/missing。
  - 2022-08-24：档2，目标35.00%，置信price-only；价格分位8.78%，回撤-91.07%；PE/PB/温度分别 missing/missing/missing。
  - 2022-09-15：档1，目标30.00%，置信price-only；价格分位19.96%，回撤-90.22%；PE/PB/温度分别 missing/missing/missing。
  - 2022-09-26：档2，目标35.00%，置信price-only；价格分位8.87%，回撤-91.07%；PE/PB/温度分别 missing/missing/missing。
  - 2022-09-28：档2，目标35.00%，置信price-only；价格分位7.63%，回撤-91.32%；PE/PB/温度分别 missing/missing/missing。
  - 2022-12-12：档2，目标35.00%，置信price-only；价格分位8.36%，回撤-91.42%；PE/PB/温度分别 missing/missing/missing。
  - 2022-12-29：档3，目标40.00%，置信price-only；价格分位5.00%，回撤-91.92%；PE/PB/温度分别 missing/missing/missing。
  - 2023-01-05：档3，目标40.00%，置信price-only；价格分位1.41%，回撤-92.59%；PE/PB/温度分别 missing/missing/missing。
- sz002497：观察 2010-11-09 至 2026-11-13，共 3830 根；入低位/加深 0 次；周期 0，其中完整 0。
- sz003016：观察 2020-10-26 至 2026-11-13，共 1469 根；入低位/加深 1 次；周期 1，其中完整 0。
  - 2026-11-13：档1，目标30.00%，置信price-only；价格分位10.48%，回撤-58.48%；PE/PB/温度分别 missing/missing/missing。
- sh000300：观察 2005-01-04 至 2026-11-13，共 5309 根；入低位/加深 6 次；周期 1，其中完整 1。
  - 2024-01-17：档1，目标30.00%，置信price-only；价格分位17.33%，回撤-44.40%；PE/PB/温度分别 missing/missing/missing。
  - 2024-01-30：档1，目标30.00%，置信price-only；价格分位18.03%，回撤-44.13%；PE/PB/温度分别 missing/missing/missing。
  - 2024-08-05：档1，目标30.00%，置信price-only；价格分位19.24%，回撤-42.43%；PE/PB/温度分别 missing/missing/missing。
  - 2024-08-20：档1，目标30.00%，置信price-only；价格分位17.71%，回撤-42.62%；PE/PB/温度分别 missing/missing/missing。
  - 2024-09-09：档2，目标35.00%，置信price-only；价格分位9.04%，回撤-45.02%；PE/PB/温度分别 missing/missing/missing。
  - 2024-09-11：档2，目标35.00%，置信price-only；价格分位8.75%，回撤-45.14%；PE/PB/温度分别 missing/missing/missing。

长线策略另按指数低位→恢复的市场周期独立回放，不用短窗口表现代替完整周期。检测覆盖早于成交研究区间的周期，仅是检测器历史事实，缺少可支持公司行动的完整执行输入时不宣称已经回测其长线资金业绩。

- r2a-cn-equity-historical-low-atr / 2024-01-17 至 2024-09-30 / 完整：收益1.49%，超额-20.59%，回撤1.92%，闭合交易1。
- r2a-cn-equity-historical-low-atr-neighbor-90 / 2024-01-17 至 2024-09-30 / 完整：收益1.49%，超额-20.59%，回撤1.92%，闭合交易1。
- r2a-cn-equity-historical-low-atr-neighbor-110 / 2024-01-17 至 2024-09-30 / 完整：收益1.49%，超额-20.59%，回撤1.92%，闭合交易1。
- r2a-cn-equity-historical-low-trailing / 2024-01-17 至 2024-09-30 / 完整：收益1.49%，超额-20.59%，回撤1.92%，闭合交易1。
- r2a-cn-equity-historical-low-trailing-neighbor-90 / 2024-01-17 至 2024-09-30 / 完整：收益1.49%，超额-20.59%，回撤1.92%，闭合交易1。
- r2a-cn-equity-historical-low-trailing-neighbor-110 / 2024-01-17 至 2024-09-30 / 完整：收益1.49%，超额-20.59%，回撤1.92%，闭合交易1。
- r2a-cn-equity-historical-low-time / 2024-01-17 至 2024-09-30 / 完整：收益1.49%，超额-20.59%，回撤1.92%，闭合交易1。
- r2a-cn-equity-historical-low-time-neighbor-90 / 2024-01-17 至 2024-09-30 / 完整：收益1.49%，超额-20.59%，回撤1.92%，闭合交易1。
- r2a-cn-equity-historical-low-time-neighbor-110 / 2024-01-17 至 2024-09-30 / 完整：收益1.49%，超额-20.59%，回撤1.92%，闭合交易1。

核查路径：`report-4a8f71172cd1e3a98b3f01177ca3ac812367a3a1d82fb1e5c91fa27d2a35cf57.json` 的 `result.rows`、`result.suites[*].suite`、`result.combinedBooks`、`result.lowZone`；时间和采集耗时来自 `cn-equity-result.json`。重放使用隔离QUANT_DATA_DIR和 `pnpm exec tsx scripts/research-validation.ts --market cn-equity --replay f85762b68f8d6910b4ac3ec40297ebe6a513b692bb188547c0b950616306ef5f`，不得在构建身份漂移后静默重算。

### 数字货币

输入：`input-492eb073596c2d6b8c250307e9a616c526ebe6482cf40fa892387890f7312b4e.json`；结果：`report-7a4c46a5643d3c1a6dc3113a4452d782496cfd3853235c57b405fa4afb603110.json`。策略/撮合构建：`96108e4a2141e294067a385979b32010632563709c395d7c8d0b52bdfb7d9300`；研究/评价适配构建：`3a923d3d77e1dcef0ac48dec3b0a0634f65b4503d9e6a1e233543e03992019bc`。

请求区间 2017-01-01 至 2026-11-13。本次运行 816337 毫秒，采集/冻结 82354 毫秒。候选成绩行 54，可监视候选 0，未运行候选 0。这些数量分别取结果rows/promoted/missing，并非全市场策略数量。

默认/本次门槛：样本外至少 3 窗口，至少 60% 窗口扣费后正超额；最大回撤 25.00%；至少 30 个闭合交易；训练段数值邻域正超额比例至少 50%；DSR至少 0.95。低位长线另需至少 3 个完整市场周期及足够输入置信。成本翻倍、延后一根的多数窗口和末段留出均须通过。历史池/成交证据未核验时不能晋级。门槛在运行前冻结，代码中的配置可由用户显式修改，本轮未下调。

训练窗固定长度向前滚动，参数只在训练窗按超额、回撤、稳定ID排序选择；各测试窗独立本金。初始训练段用于数值退出邻域，末20%作为固定留出诊断，与滚动样本外重叠，不能累计为额外独立样本。邻域在样本外揭示前声明为ATR倍数、移动幅度或时间长度±10%。保护单不随延迟压力撤销，延后一根只作用于自主入退场。

| 周期 | 实际研究区间 | 标的数 | 原始/信号根数 | 基准 |
|---|---|---:|---:|---|
| day | 2017-08-17 至 2026-11-13 | 4 | 12333 | BTCUSDT binance 持有（无费用，首日开盘） |
| 4h | 2026-04-17 至 2026-11-13 | 4 | 5064 | BTCUSDT binance 持有（无费用，首日开盘） |
| 1h | 2026-04-17 至 2026-11-13 | 4 | 20256 | BTCUSDT binance 持有（无费用，首日开盘） |
| 15m | 2026-04-17 至 2026-11-13 | 4 | 81024 | BTCUSDT binance 持有（无费用，首日开盘） |

基准为同窗首个观测开盘买入并持有，A股为沪深300价格指数（无股息）；币种为同来源BTC持有。缺任一基准日时超额留空。分段复用独立quant-performance；币种这里展示收益/回撤，未将252日年化结果当作币种年化业绩。

来源排除 0 项；数据缺口 0 项。


#### 策略成绩

表中收益、超额、回撤和两种压力均为末20%留出段；闭合交易数、正超额窗口数来自滚动样本外之和，不与留出交易数混同。详细逐窗训练选择、压力、市场状态和统计退化原因见结果的suites字段。每个策略对象在包内登记runnable并保存定义；runnable表示规则可执行。

| 策略 | 分仓 | 训练收益/超额 | 留出收益/超额/回撤 | 成本×2超额 / 延迟超额 | 正超额/窗口 · 闭合交易 | 样本外入场观察/订单/成交/拒单尝试 | 结论 |
|---|---|---|---|---|---|---|---|
| r2a-crypto-range-day-atr | swing | 175.83% / -1015.09% | 7.69% / 40.87% / 7.81% | 39.83% / 39.92% | 4/6 · 106 | 359/222/217/5 | research：训练段数值邻域不稳定；历史证券池不完整；历史平台数量规则/流动性未核验 |
| r2a-crypto-range-day-atr-neighbor-90 | swing | 180.34% / -1010.57% | 8.96% / 42.14% / 7.26% | 41.09% / 41.01% | 4/6 · 108 | 359/224/220/4 | research：训练段数值邻域不稳定；历史证券池不完整；历史平台数量规则/流动性未核验 |
| r2a-crypto-range-day-atr-neighbor-110 | swing | 169.59% / -1021.33% | 6.27% / 39.45% / 8.36% | 38.45% / 38.83% | 4/6 · 106 | 359/222/217/4 | research：训练段数值邻域不稳定；历史证券池不完整；历史平台数量规则/流动性未核验 |
| r2a-crypto-range-day-trailing | swing | 51.70% / -1139.21% | 4.48% / 37.66% / 5.29% | 36.58% / 33.98% | 4/6 · 131 | 359/271/265/9 | research：训练段数值邻域不稳定；DSR未达0.95；历史证券池不完整；历史平台数量规则/流动性未核验 |
| r2a-crypto-range-day-trailing-neighbor-90 | swing | 46.03% / -1144.88% | 4.51% / 37.69% / 5.24% | 36.56% / 35.33% | 4/6 · 138 | 359/285/279/5 | research：训练段数值邻域不稳定；DSR未达0.95；历史证券池不完整；历史平台数量规则/流动性未核验 |
| r2a-crypto-range-day-trailing-neighbor-110 | swing | 56.95% / -1133.96% | 6.85% / 40.03% / 5.81% | 38.96% / 38.23% | 4/6 · 124 | 359/257/252/6 | research：训练段数值邻域不稳定；历史证券池不完整；历史平台数量规则/流动性未核验 |
| r2a-crypto-range-day-time | swing | 140.04% / -1050.87% | 5.66% / 38.84% / 7.83% | 37.80% / 41.15% | 4/6 · 120 | 359/248/244/4 | research：训练段数值邻域不稳定；DSR未达0.95；历史证券池不完整；历史平台数量规则/流动性未核验 |
| r2a-crypto-range-day-time-neighbor-90 | swing | 122.10% / -1068.81% | 4.61% / 37.79% / 9.03% | 39.04% / 41.86% | 4/6 · 121 | 359/250/246/5 | research：训练段数值邻域不稳定；历史证券池不完整；历史平台数量规则/流动性未核验 |
| r2a-crypto-range-day-time-neighbor-110 | swing | 153.39% / -1037.52% | 2.87% / 36.05% / 9.13% | 35.07% / 37.54% | 4/6 · 117 | 359/242/238/6 | research：训练段数值邻域不稳定；DSR未达0.95；历史证券池不完整；历史平台数量规则/流动性未核验 |
| r2a-crypto-dual-ma-day-atr | swing | 40.22% / -1150.69% | 12.02% / 45.20% / 11.20% | 41.95% / 45.21% | 4/6 · 110 | 117/228/225/4 | research：训练段数值邻域不稳定；历史证券池不完整；历史平台数量规则/流动性未核验 |
| r2a-crypto-dual-ma-day-atr-neighbor-90 | swing | 41.57% / -1149.34% | 12.53% / 45.71% / 10.82% | 42.44% / 45.70% | 4/6 · 110 | 117/228/225/6 | research：训练段数值邻域不稳定；历史证券池不完整；历史平台数量规则/流动性未核验 |
| r2a-crypto-dual-ma-day-atr-neighbor-110 | swing | 38.07% / -1152.84% | 11.43% / 44.61% / 11.52% | 41.40% / 44.29% | 4/6 · 110 | 117/228/225/5 | research：训练段数值邻域不稳定；历史证券池不完整；历史平台数量规则/流动性未核验 |
| r2a-crypto-dual-ma-day-trailing | swing | 11.73% / -1179.19% | 13.22% / 46.40% / 8.41% | 43.11% / 46.10% | 4/6 · 111 | 117/228/226/5 | research：训练段数值邻域不稳定；历史证券池不完整；历史平台数量规则/流动性未核验 |
| r2a-crypto-dual-ma-day-trailing-neighbor-90 | swing | 10.27% / -1180.64% | 14.67% / 47.85% / 7.15% | 44.49% / 47.43% | 4/6 · 111 | 117/228/226/6 | research：训练段数值邻域不稳定；历史证券池不完整；历史平台数量规则/流动性未核验 |
| r2a-crypto-dual-ma-day-trailing-neighbor-110 | swing | 11.50% / -1179.41% | 14.40% / 47.58% / 9.23% | 44.26% / 49.34% | 4/6 · 111 | 117/228/226/3 | research：训练段数值邻域不稳定；历史证券池不完整；历史平台数量规则/流动性未核验 |
| r2a-crypto-dual-ma-day-time | swing | 24.80% / -1166.12% | 15.08% / 48.26% / 10.09% | 44.96% / 47.26% | 4/6 · 111 | 117/228/226/4 | research：训练段数值邻域不稳定；历史证券池不完整；历史平台数量规则/流动性未核验 |
| r2a-crypto-dual-ma-day-time-neighbor-90 | swing | 22.94% / -1167.98% | 11.84% / 45.02% / 9.82% | 42.15% / 45.00% | 4/6 · 111 | 117/228/226/4 | research：训练段数值邻域不稳定；历史证券池不完整；历史平台数量规则/流动性未核验 |
| r2a-crypto-dual-ma-day-time-neighbor-110 | swing | 24.67% / -1166.24% | 18.03% / 51.21% / 9.62% | 47.33% / 43.31% | 4/6 · 111 | 117/228/226/3 | research：训练段数值邻域不稳定；历史证券池不完整；历史平台数量规则/流动性未核验 |
| r2a-crypto-range-4h-atr | swing | -2.73% / 13.32% | -3.08% / 15.36% / 3.08% | 15.50% / 15.55% | 2/6 · 15 | 82/41/41/0 | research：正超额窗口未过多数门槛；成本/延迟压力未过门槛；闭合交易数不足；DSR未达0.95；历史证券池不完整；历史平台数量规则/流动性未核验 |
| r2a-crypto-range-4h-atr-neighbor-90 | swing | -3.24% / 12.81% | -2.77% / 15.67% / 2.77% | 15.78% / 15.86% | 2/6 · 17 | 82/45/45/4 | research：正超额窗口未过多数门槛；成本/延迟压力未过门槛；闭合交易数不足；DSR未达0.95；历史证券池不完整；历史平台数量规则/流动性未核验 |
| r2a-crypto-range-4h-atr-neighbor-110 | swing | -2.56% / 13.49% | -3.36% / 15.08% / 3.36% | 15.31% / 15.26% | 2/6 · 12 | 82/37/37/0 | research：正超额窗口未过多数门槛；成本/延迟压力未过门槛；闭合交易数不足；DSR未达0.95；历史证券池不完整；历史平台数量规则/流动性未核验 |
| r2a-crypto-range-4h-trailing | swing | -2.50% / 13.55% | -4.51% / 13.93% / 4.51% | 13.79% / 13.87% | 2/6 · 9 | 82/32/32/0 | research：正超额窗口未过多数门槛；成本/延迟压力未过门槛；闭合交易数不足；DSR未达0.95；历史证券池不完整；历史平台数量规则/流动性未核验 |
| r2a-crypto-range-4h-trailing-neighbor-90 | swing | -1.92% / 14.14% | -4.33% / 14.11% / 4.33% | 13.96% / 14.09% | 2/6 · 9 | 82/33/33/0 | research：正超额窗口未过多数门槛；成本/延迟压力未过门槛；闭合交易数不足；DSR未达0.95；历史证券池不完整；历史平台数量规则/流动性未核验 |
| r2a-crypto-range-4h-trailing-neighbor-110 | swing | -2.86% / 13.20% | -4.53% / 13.91% / 4.53% | 13.77% / 13.81% | 2/6 · 9 | 82/32/32/0 | research：正超额窗口未过多数门槛；成本/延迟压力未过门槛；闭合交易数不足；DSR未达0.95；历史证券池不完整；历史平台数量规则/流动性未核验 |
| r2a-crypto-range-4h-time | swing | -1.83% / 14.23% | -4.53% / 13.91% / 4.53% | 13.77% / 13.81% | 2/6 · 8 | 82/30/30/0 | research：正超额窗口未过多数门槛；成本/延迟压力未过门槛；闭合交易数不足；DSR未达0.95；历史证券池不完整；历史平台数量规则/流动性未核验 |
| r2a-crypto-range-4h-time-neighbor-90 | swing | -3.00% / 13.05% | -5.41% / 13.03% / 5.41% | 12.87% / 13.12% | 2/6 · 9 | 82/32/32/2 | research：正超额窗口未过多数门槛；成本/延迟压力未过门槛；闭合交易数不足；DSR未达0.95；历史证券池不完整；历史平台数量规则/流动性未核验 |
| r2a-crypto-range-4h-time-neighbor-110 | swing | -2.59% / 13.46% | -4.71% / 13.74% / 4.71% | 13.60% / 13.59% | 2/6 · 3 | 82/25/25/0 | research：正超额窗口未过多数门槛；成本/延迟压力未过门槛；闭合交易数不足；DSR未达0.95；历史证券池不完整；历史平台数量规则/流动性未核验 |
| r2a-crypto-dual-ma-4h-atr | swing | -1.21% / 14.85% | -2.84% / 15.60% / 3.10% | 15.23% / 15.07% | 2/6 · 41 | 52/93/91/4 | research：正超额窗口未过多数门槛；成本/延迟压力未过门槛；DSR未达0.95；历史证券池不完整；历史平台数量规则/流动性未核验 |
| r2a-crypto-dual-ma-4h-atr-neighbor-90 | swing | -0.98% / 15.08% | -2.85% / 15.59% / 3.10% | 15.22% / 15.13% | 2/6 · 42 | 52/94/92/5 | research：正超额窗口未过多数门槛；成本/延迟压力未过门槛；DSR未达0.95；历史证券池不完整；历史平台数量规则/流动性未核验 |
| r2a-crypto-dual-ma-4h-atr-neighbor-110 | swing | -1.33% / 14.72% | -2.99% / 15.45% / 3.25% | 15.40% / 14.90% | 2/6 · 41 | 52/93/91/4 | research：正超额窗口未过多数门槛；成本/延迟压力未过门槛；DSR未达0.95；历史证券池不完整；历史平台数量规则/流动性未核验 |
| r2a-crypto-dual-ma-4h-trailing | swing | -1.42% / 14.64% | -3.40% / 15.04% / 3.65% | 14.67% / 14.47% | 2/6 · 40 | 52/92/90/4 | research：正超额窗口未过多数门槛；成本/延迟压力未过门槛；DSR未达0.95；历史证券池不完整；历史平台数量规则/流动性未核验 |
| r2a-crypto-dual-ma-4h-trailing-neighbor-90 | swing | -1.40% / 14.65% | -3.33% / 15.11% / 3.58% | 14.75% / 14.57% | 2/6 · 40 | 52/92/90/4 | research：正超额窗口未过多数门槛；成本/延迟压力未过门槛；DSR未达0.95；历史证券池不完整；历史平台数量规则/流动性未核验 |
| r2a-crypto-dual-ma-4h-trailing-neighbor-110 | swing | -1.53% / 14.52% | -2.95% / 15.49% / 3.20% | 15.12% / 14.76% | 2/6 · 40 | 52/92/90/4 | research：正超额窗口未过多数门槛；成本/延迟压力未过门槛；DSR未达0.95；历史证券池不完整；历史平台数量规则/流动性未核验 |
| r2a-crypto-dual-ma-4h-time | swing | -1.53% / 14.52% | -2.95% / 15.49% / 3.20% | 15.12% / 14.76% | 2/6 · 40 | 52/92/90/4 | research：正超额窗口未过多数门槛；成本/延迟压力未过门槛；DSR未达0.95；历史证券池不完整；历史平台数量规则/流动性未核验 |
| r2a-crypto-dual-ma-4h-time-neighbor-90 | swing | -1.53% / 14.52% | -2.95% / 15.49% / 3.20% | 15.12% / 14.76% | 2/6 · 40 | 52/92/90/4 | research：正超额窗口未过多数门槛；成本/延迟压力未过门槛；DSR未达0.95；历史证券池不完整；历史平台数量规则/流动性未核验 |
| r2a-crypto-dual-ma-4h-time-neighbor-110 | swing | -1.53% / 14.52% | -2.95% / 15.49% / 3.20% | 15.12% / 14.76% | 2/6 · 40 | 52/92/90/4 | research：正超额窗口未过多数门槛；成本/延迟压力未过门槛；DSR未达0.95；历史证券池不完整；历史平台数量规则/流动性未核验 |
| r2a-crypto-range-1h-atr | breakout | -14.73% / 0.83% | -7.62% / 11.85% / 8.89% | 7.15% / 12.40% | 1/6 · 233 | 527/536/468/104 | research：正超额窗口未过多数门槛；成本/延迟压力未过门槛；DSR未达0.95；历史证券池不完整；历史平台数量规则/流动性未核验 |
| r2a-crypto-range-1h-atr-neighbor-90 | breakout | -14.77% / 0.79% | -7.38% / 12.08% / 8.81% | 8.13% / 12.85% | 1/6 · 236 | 527/542/474/108 | research：正超额窗口未过多数门槛；成本/延迟压力未过门槛；DSR未达0.95；历史证券池不完整；历史平台数量规则/流动性未核验 |
| r2a-crypto-range-1h-atr-neighbor-110 | breakout | -15.13% / 0.43% | -8.59% / 10.87% / 9.73% | 6.73% / 11.41% | 1/6 · 233 | 527/536/468/107 | research：正超额窗口未过多数门槛；成本/延迟压力未过门槛；DSR未达0.95；历史证券池不完整；历史平台数量规则/流动性未核验 |
| r2a-crypto-range-1h-trailing | breakout | -13.74% / 1.82% | -10.05% / 9.42% / 11.01% | 6.52% / 10.28% | 1/6 · 234 | 527/542/470/113 | research：正超额窗口未过多数门槛；成本/延迟压力未过门槛；DSR未达0.95；历史证券池不完整；历史平台数量规则/流动性未核验 |
| r2a-crypto-range-1h-trailing-neighbor-90 | breakout | -13.35% / 2.21% | -9.08% / 10.38% / 10.17% | 7.33% / 10.94% | 1/6 · 236 | 527/545/474/111 | research：正超额窗口未过多数门槛；成本/延迟压力未过门槛；DSR未达0.95；历史证券池不完整；历史平台数量规则/流动性未核验 |
| r2a-crypto-range-1h-trailing-neighbor-110 | breakout | -10.60% / 4.96% | -10.35% / 9.11% / 11.46% | 6.64% / 10.00% | 2/6 · 233 | 527/540/468/115 | research：正超额窗口未过多数门槛；成本/延迟压力未过门槛；DSR未达0.95；历史证券池不完整；历史平台数量规则/流动性未核验 |
| r2a-crypto-range-1h-time | breakout | -11.35% / 4.20% | -9.09% / 10.38% / 10.29% | 6.68% / 10.79% | 1/6 · 230 | 527/535/462/113 | research：正超额窗口未过多数门槛；成本/延迟压力未过门槛；DSR未达0.95；历史证券池不完整；历史平台数量规则/流动性未核验 |
| r2a-crypto-range-1h-time-neighbor-90 | breakout | -10.93% / 4.63% | -7.23% / 12.23% / 9.08% | 7.79% / 12.16% | 1/6 · 235 | 527/546/474/121 | research：正超额窗口未过多数门槛；成本/延迟压力未过门槛；DSR未达0.95；历史证券池不完整；历史平台数量规则/流动性未核验 |
| r2a-crypto-range-1h-time-neighbor-110 | breakout | -10.54% / 5.02% | -9.05% / 10.41% / 10.81% | 6.08% / 8.81% | 2/6 · 217 | 527/514/436/98 | research：正超额窗口未过多数门槛；成本/延迟压力未过门槛；DSR未达0.95；历史证券池不完整；历史平台数量规则/流动性未核验 |
| r2a-crypto-range-15m-atr | breakout | -33.09% / -17.32% | -19.47% / 0.17% / 20.09% | -6.26% / 3.02% | 1/6 · 850 | 2317/2246/1702/943 | research：正超额窗口未过多数门槛；成本/延迟压力未过门槛；回撤超过上限或缺失；训练段数值邻域不稳定；DSR未达0.95；历史证券池不完整；历史平台数量规则/流动性未核验 |
| r2a-crypto-range-15m-atr-neighbor-90 | breakout | -32.06% / -16.30% | -19.36% / 0.28% / 19.99% | -6.74% / 2.72% | 1/6 · 855 | 2317/2257/1712/988 | research：正超额窗口未过多数门槛；成本/延迟压力未过门槛；回撤超过上限或缺失；训练段数值邻域不稳定；DSR未达0.95；历史证券池不完整；历史平台数量规则/流动性未核验 |
| r2a-crypto-range-15m-atr-neighbor-110 | breakout | -33.54% / -17.78% | -19.80% / -0.16% / 20.43% | -6.46% / 3.32% | 1/6 · 847 | 2317/2241/1696/925 | research：正超额窗口未过多数门槛；成本/延迟压力未过门槛；回撤超过上限或缺失；末段留出超额非正或缺失；训练段数值邻域不稳定；DSR未达0.95；历史证券池不完整；历史平台数量规则/流动性未核验 |
| r2a-crypto-range-15m-trailing | breakout | -36.11% / -20.34% | -19.21% / 0.43% / 19.80% | -6.71% / 4.26% | 1/6 · 829 | 2317/2205/1662/926 | research：正超额窗口未过多数门槛；成本/延迟压力未过门槛；回撤超过上限或缺失；训练段数值邻域不稳定；DSR未达0.95；历史证券池不完整；历史平台数量规则/流动性未核验 |
| r2a-crypto-range-15m-trailing-neighbor-90 | breakout | -36.04% / -20.27% | -19.17% / 0.48% / 19.76% | -6.74% / 4.21% | 1/6 · 831 | 2317/2207/1666/918 | research：正超额窗口未过多数门槛；成本/延迟压力未过门槛；回撤超过上限或缺失；训练段数值邻域不稳定；DSR未达0.95；历史证券池不完整；历史平台数量规则/流动性未核验 |
| r2a-crypto-range-15m-trailing-neighbor-110 | breakout | -36.10% / -20.33% | -19.38% / 0.26% / 19.97% | -6.84% / 4.23% | 1/6 · 828 | 2317/2203/1660/925 | research：正超额窗口未过多数门槛；成本/延迟压力未过门槛；回撤超过上限或缺失；训练段数值邻域不稳定；DSR未达0.95；历史证券池不完整；历史平台数量规则/流动性未核验 |
| r2a-crypto-range-15m-time | breakout | -35.31% / -19.54% | -18.05% / 1.59% / 18.65% | -5.55% / 4.18% | 1/6 · 827 | 2317/2201/1658/921 | research：正超额窗口未过多数门槛；成本/延迟压力未过门槛；回撤超过上限或缺失；训练段数值邻域不稳定；DSR未达0.95；历史证券池不完整；历史平台数量规则/流动性未核验 |
| r2a-crypto-range-15m-time-neighbor-90 | breakout | -33.65% / -17.89% | -19.00% / 0.64% / 19.65% | -6.28% / 4.28% | 1/6 · 847 | 2317/2247/1698/888 | research：正超额窗口未过多数门槛；成本/延迟压力未过门槛；回撤超过上限或缺失；训练段数值邻域不稳定；DSR未达0.95；历史证券池不完整；历史平台数量规则/流动性未核验 |
| r2a-crypto-range-15m-time-neighbor-110 | breakout | -31.84% / -16.07% | -16.38% / 3.27% / 17.14% | -4.60% / 5.31% | 1/6 · 803 | 2317/2151/1610/923 | research：正超额窗口未过多数门槛；成本/延迟压力未过门槛；训练段数值邻域不稳定；DSR未达0.95；历史证券池不完整；历史平台数量规则/流动性未核验 |

每行偏差标签随服务端成绩单保存：A股信号为固定截止前复权、RPS为后复权、成交原价；现金按除息日入账是情景假设，ST/IPO/队列与真实到账未核验。低位PE/PB采用本地财务/市值数学并严格过滤公告可见日，当前修订不冒充首次披露；历史市场温度缺失不会用均线状态替代。币种使用单一公开现货来源，数量步长和费用是研究情景，当前高流动性名单不证明历史退市覆盖或容量。
入场观察、订单、成交笔数和闭合轮次是不同集合；保护单/退出可增加订单，受阻卖单可重复尝试，所以拒单尝试数可能大于独立订单数。入场观察或成交为零时不归因任何执行阶段原因，资格栏的未核验项只是数据准入缺口，不是零信号或亏损的已证实原因。

#### 分仓与组合账本

组合使用事先声明的固定ATR代表，不按样本外最优结果拼装；表中组合为全期描述回放。分仓收益扣除每根bar现金划转后连乘，零资本bar留空，不将资金流当收益。分仓相关性只用两边均有效的同日收益，少于20日或零方差留空。

- 15m：4h swing + 1h breakout on the shared 15m execution clock; 75/25 vs 80/20; completed native-timeframe decisions only, stops monitored every 15m. Time stops scaled by interval duration.
  - default / {"swing":0.75,"breakout":0.25}：组合收益 -2.69%，超额 6.58%，回撤 7.08%；分仓相关性 0.5236（重叠 211 日），现金划转 1563 笔。
  - default/swing：有效 211 日，划转中性收益 2.25%，回撤 4.99%。
  - default/breakout：有效 211 日，划转中性收益 -16.52%，回撤 17.55%。
  - comparison / {"swing":0.8,"breakout":0.19999999999999996}：组合收益 -1.70%，超额 7.56%，回撤 6.62%；分仓相关性 0.5237（重叠 211 日），现金划转 1574 笔。
  - comparison/swing：有效 211 日，划转中性收益 2.26%，回撤 4.99%。
  - comparison/breakout：有效 211 日，划转中性收益 -16.52%，回撤 17.55%。

核查路径：`report-7a4c46a5643d3c1a6dc3113a4452d782496cfd3853235c57b405fa4afb603110.json` 的 `result.rows`、`result.suites[*].suite`、`result.combinedBooks`、`result.lowZone`；时间和采集耗时来自 `crypto-result.json`。重放使用隔离QUANT_DATA_DIR和 `pnpm exec tsx scripts/research-validation.ts --market crypto --replay 492eb073596c2d6b8c250307e9a616c526ebe6482cf40fa892387890f7312b4e`，不得在构建身份漂移后静默重算。

## 推测与下一步

本轮尚不能区分价格规则本身、样本证券选择、公司行动排除、市场状态和实验成交条件各自造成的影响，不能归因其解释了全部失败。可在新的预先冻结训练方案里研究过滤与退出；本次样本外结果不得回头用于本次参数选择。优先补全历史证券日期、退市行情、财务首次版本和真实平台数量/容量证据；费用敏感的分钟规则需要独立后续窗口验证。

所有晋级结果只是研究资格；持续真实影子观察、提醒对账和账户核验仍是独立运行验收。本报告不触发通知、实时模式或交易。
