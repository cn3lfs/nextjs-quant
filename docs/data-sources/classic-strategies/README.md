# 公开经典指标规则来源与本地改编

核对日期：2026-11-11。新增10个可执行日线信号基线，不是新增10套经作者完整定义或验证盈利的原始交易系统。全部只读完成K线，信号交给既有回测引擎在下一可成交时点执行；规则本身不操作账户，不暗加止损、不按结果优化阈值。

## 固定来源和许可

- [QuantConnect LEAN固定提交](https://github.com/QuantConnect/Lean/tree/054ec0596a66f0ad09ca5101df424cf6697060a7/Indicators)：9个指标源文件及完整Apache-2.0许可，保存于[lean](lean/manifest.json)。保留原文件版权、许可和作者注释。
- [bukosabino/ta固定提交](https://github.com/bukosabino/ta/tree/a890410710a6e483c9ba08da7f3dd5089e4b9dff/ta)：NVI公式所在volume.py及完整MIT许可，保存于[ta](ta/manifest.json)。保留原文件版权、许可和作者注释。

每组manifest记录repository、ref、retrievedAt、license及每个源文件的固定URL、SHA256、字节数。manifest的path为上游路径；本地同组以basename保存文件。源文件仅作为可核验公式证据，不编译、不作为运行时依赖；TypeScript独立实现并复用已有EMA、RSI、SMA、ATR原语。没有新增Python/.NET依赖，不改变已有共享指标的定义。

## 可执行基线

| ID                  | 默认指标                                               | 入场/退出         | 首个允许决策索引（0起算） |
| ------------------- | ------------------------------------------------------ | ----------------- | ------------------------: |
| classic-connors-rsi | 收盘RSI3、涨跌streak RSI2、100个历史收益严格排名的均值 | <50 / >50         |                       101 |
| classic-ibs         | (C-L)/(H-L)                                            | <0.5 / >0.5       |                         0 |
| classic-stoch-rsi   | RSI14的14根区间位置，再SMA3 K/SMA3 D                   | K>D / K<D         |                        31 |
| classic-kama        | ER10，自适应平滑常数fast2/slow30                       | C>KAMA / C<KAMA   |                        10 |
| classic-aroon       | 26根极值时距，名义period25                             | Up>Down / Up<Down |                        25 |
| classic-trix        | 三重EMA15的单根变化率                                  | >0 / <0           |                        43 |
| classic-force-index | EMA13((C-C[-1])×V)                                     | >0 / <0           |                        13 |
| classic-nvi         | 初值1000，仅缩量日乘价格比，与EMA255比较               | NVI>EMA / NVI<EMA |                       254 |
| classic-coppock     | WMA10(ROC11+ROC14)，新值权重大                         | >0 / <0           |                        23 |
| classic-vortex      | 14根VI+、VI-，同窗真实波幅和为分母                     | VI+>VI- / VI+<VI- |                        14 |

买卖规则采用指标自然零轴、双线比较或对称中点，是明确的本地基础规则，不宣称来源代码本身含完整进出场系统。Connors中点反转不是原超卖阈值系统；Force单线不是Elder完整三重滤网；Coppock按日线交易根数日频化，不冒称原月线系统。NVI的EMA255参考线参考[StockCharts官方NVI说明](https://chartschool.stockcharts.com/table-of-contents/technical-indicators-and-overlays/technical-indicators/negative-volume-index-nvi)，该页明确给出255日EMA牛熊参考；ta源只定义NVI本身。本地实现只将参考关系机械化，不采信该页列举的历史胜率或移植为本项目收益证据。

## 初值、预热与缺失

- 共享EMA以首个有效观察为种子，和LEAN的部分SMA初始化不完全同值；共享RSI以首个有效价差初始化，未定义零波动RSI留空，不复制上游预热0或平盘100来造信号。预热全部显式门控。
- Connors只比较当前收益与此前100个真实收益，不纳入上游首个模拟0；严格小于计数，不把并列收益算进百分位。streak按所冻结LEAN实现：上涨/下跌反向时重置并改符号；平收保持既有长度。负streak的RSI复用允许负序列的共享SMA原语。
- KAMA从完整10个价差起算，以前收盘作初始KAMA；零路径波动令ER=0，慢速平滑。未预热不输出平均值。
- Aroon窗口为period+1根，重复极值取最近。StochRSI只使用已预热RSI；完整有效RSI窗口极差为0时按源取100，再做完整K/D移动平均。
- IBS的H=L按源为0.5并保持中性；Vortex同窗TR为0留空。所有未定义值不以0或前值替代；未知/非整数/预热外索引不产生入场退出。已知零成交量按源参与Force/NVI公式，不伪造缺量。
- 所有源行情必须有正且有限OHLC、合法高低关系、有限非负成交量/额和严格递增日期。验证拒绝非法输入，不截取“可用部分”悄悄运行。规则返回纯信号，不改变输入或持仓。

## 验证证据

`packages/trading-strategies/tests/classics.test.ts`覆盖独立手算（含Coppock精确分数2244667/6006）、streak平收与排名并列、零区间/零TR/恒定RSI、预热门控、全部10项未来追加前缀一致性、输入不变性、非法量价及逐来源文件SHA256和完整许可核验。具体命令及最终集成测试由交付记录登记，不能将此来源说明当成策略收益证明。
