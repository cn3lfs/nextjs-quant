# 现有能力与本轮理论目录的映射

核对对象为当前工作区的[15 类定义](../../../packages/trading-strategies/src/taxonomy.ts)、[包说明](../../../packages/trading-strategies/README.md)、[方法登记](../../trading-skills-method-map.json)、[历史方法盘点](../../strategy-inventory.md)和[经典规则来源说明](../../data-sources/classic-strategies/README.md)。这里只识别可复用的研究入口，不重新审计代码、不判断现有规则是否精确实现原理论，也不认证数据或收益。

| 研究家族          | 现有 category / 研究入口                                             | 复用与缺口                                                           |
| ----------------- | -------------------------------------------------------------------- | -------------------------------------------------------------------- |
| F01 市场理论      | allocation、rotation；持有对照及环境分析                             | 可复用基准概念；解释理论不强行映射成某个可执行策略                   |
| F02 道氏/趋势结构 | trend、breakout；SW10 均线交叉排列与回踩                             | 有趋势组件，不据此称已实现完整道氏、Livermore 或 Weinstein           |
| F03 趋势指标      | trend；SW10、classic-kama/aroon/trix/coppock/vortex                  | 已有指标基线；原始市场、周期、初始化与买卖规则仍需区分               |
| F04 突破          | breakout；SW01、sw-double-prior20                                    | 双突破具有本地版本；Donchian、海龟和原日内系统应各自核验             |
| F05 图形          | structure、breakout；SW04/SW05 见方法盘点                            | 图形识别与完整价格行为体系不同，人工判别环节不能省略                 |
| F06 波浪/周期     | structure、event（理论关联）                                         | 本轮不认定存在完整波浪、周期或争议流派实现；不新增别名伪装覆盖       |
| F07 缠论          | structure；CH 系列、chan-third-native                                | 复用原生结构边界与历史研究入口；理论正文、流派解释、DLL 算法分别审查 |
| F08 量价/Wyckoff  | volume、structure；VP/WY 系列、wy-sos-daily、classic-force-index/nvi | 成交量代理不是机构真实资金流；已有 SOS 版本不等于完整阶段系统        |
| F09 成长体系      | growth；CA/SE 系列、SE01、canslim-high-98                            | 原法与本地评分/阈值版本分开，两个体系不互换门槛                      |
| F10 动量轮动      | momentum、rotation；多周期 RPS 与横截面规则                          | 当前排名不证明完整历史池；RPS、RSI 与作者专有 RS 评级不同            |
| F11 龙头情绪      | rotation；MS04、CA-S-L2 等登记                                       | 市场情绪或行业领涨不等于已实现连板龙头全交易链                       |
| F12 回归网格      | reversion、allocation；SW08/SW09、classic-connors-rsi/ibs/stoch-rsi  | 有振荡信号基线；完整区间失败退出与库存上限需在方法中明确             |
| F13 基本面因子    | value-quality、factor；FA08 与财务筛选、多因子                       | 当前可查询财务不是历史披露版本齐备；指标定义不等于alpha证据          |
| F14 事件宏观      | event、rotation、allocation                                          | 有日历和信息入口；首次可知时间、预期数据与宏观修订仍需证据           |
| F15 统计套利      | relative-value                                                       | 现有分类表示维护方向；不认证借券、双腿、申赎或对冲模型已经齐备       |
| F16 衍生品/执行   | derivatives、models-execution                                        | 维持理论覆盖；不扩展现货授权为合约、期权、做市或真实执行             |
| F17 资金组合      | allocation；风险、持仓及绩效模块                                     | 复用风险/组合概念；本轮不改用户限额，不把马丁包装成新增预测优势      |
| F18 学习组合      | models-execution、factor、allocation                                 | 因子库与模型训练不同；本轮只给研究伪代码和防泄漏边界                 |

上表为家族级对应，每个方法卡继承所属行；同一已有 ID 被引用只是存在相关能力的证据，不是原法等价声明。没有精确对应的条目保留“理论关联/未认定现有实现”，不猜造 strategyId。参数重复不产生新的理论 ID，方法卡内的原法与研究代理分别标注。
