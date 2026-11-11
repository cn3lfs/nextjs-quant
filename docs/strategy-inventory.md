# 策略全量盘点与分类清单

日期：2026-11-10。本清单区分当前检出事实与目标归属；目标路径为策略包内逻辑子域，不代表已迁移完成。

## 盘点边界与计数

方法事实源 [trading-skills-method-map.json](trading-skills-method-map.json) 含 **695 项方法记录**：22 项 `implemented`、673 项 `implemented-variant`。这些记录包括参数、评分分支、风控、工具和研究方法，不能宣称有 695 个独立可交易策略。历史字段中的已回测标签不是本轮验收结论。

当前日线规则是 39 项规则加 2 项持有对照；经典五项是其子集，不能重复计数。94 项行情因子与197项本地数值条件是输入能力，不是策略数量。九代表仅是历史导航子集。

## 已有能力的目标归属

| 资产                  | 当前来源                                                  | 目标职责                                         | 数据/执行边界                                  |
| --------------------- | --------------------------------------------------------- | ------------------------------------------------ | ---------------------------------------------- |
| 39项日线＋2项持有对照 | quant-backtest 的 study-catalog/study-rules/classic-study | 规则进 trading-strategies；撮合留 quant-backtest | 日线只做多，原版本预热与成交路径需对照         |
| 五分钟双均线/因子组合 | quant-backtest/strategies 与 strategy-experiment          | 规则进策略模块，共享指标不复制                   | 完成根后下一根开盘、T+1、量价估算限制          |
| 中证800多因子         | csi800-factors/composite/study/exposure                   | 特征/评分/配置进策略模块，资金回放留引擎         | 29项特征、11项配方；历史固定当前池有幸存者偏差 |
| 中证800持仓风控       | csi800-position-risk及study中的编排                       | 状态/动作进策略风控，成交留引擎                  | 当前EMA50、8%/2%/5%/30%规则；旧ATR仅历史证据   |
| 公式、财务、RPS筛选   | screening/financial服务及共享因子包                       | 应用编排→策略定义/共享因子                       | 当前可筛选不证明所有历史时点可回测             |
| 盘中双突破/缠论       | monitoring及strategies服务                                | 纯判定进策略模块，采集/台账留应用                | 当下确认不得倒填旧结构点信号日期               |
| 九代表目录            | trading-trading-strategies/taxonomy                                | 作为历史证据/推荐视图，不限制全目录              | 旧结果原样保留，不能由metadata推断可运行       |
| LLM/定性报告          | value/chan/wyckoff/canslim/news服务                       | 统一目录关联研究服务                             | 不执行生成代码，不等同确定性策略               |

## 主流候选及接入条件

| 家族          | 基础规则（非参数重复）                                           | 已有数据支撑与缺口                                             |
| ------------- | ---------------------------------------------------------------- | -------------------------------------------------------------- |
| 趋势          | 均线、MACD、ADX、Supertrend、SAR、一目、吊灯退出                 | 日线规则已有；保留具体平滑与确认时点                           |
| 突破/回调     | 唐奇安、海龟、布林/肯特纳、Dual Thrust、双突破、趋势回踩         | 行情支持；日线改编不称原日内系统                               |
| 动量          | 时序动量、跳过近期动量、横截面Top-K、RPS/相对强弱                | 多证券价格可做研究；可信结果需历史证券池                       |
| 反转          | RSI、KDJ、CCI、Williams、BIAS、短期反转、布林回归                | 行情支持；退出/最长持有期不可省略                              |
| 量价          | 放量突破、OBV、MFI、CMF、流动性排序                              | OHLCV/成交额支持；不是机构真实资金流                           |
| 成长形态      | SEPA趋势模板/VCP、CANSLIM、杯柄/平台/碟形、威科夫、缠论          | 现有规则复用；催化与结构首次确认单独核对                       |
| 价值质量成长  | E/P、B/P、S/P、CF/P、ROE、现金质量、增速、GARP、财务综合评分     | 已有本地财务；公告后可见、历史修订限制                         |
| 规模与低风险  | 总市值、低波、低Beta、反转与动量质量组合                         | 总市值和价格可得；不得用报表股数伪造日频流通市值               |
| 轮动与环境    | 行业/概念动量、指数趋势、市场宽度、情绪过滤                      | 当前成分支持观察；历史成员不足需标注                           |
| 配置与资金    | 等权、反波动、风险平价、目标波动、恒定比例、CPPI、网格、分批建仓 | 多资产协方差与约束需明确；反波动不是风险平价                   |
| 日历与事件    | 月/周效应、季节性、预告/快报/分红事件                            | 日历可得；事件须首次公开时间，不只记录日期                     |
| 配对/统计套利 | 价差、协整、残差动量、市场中性                                   | 缺借券/双腿与共享保证金模型；可研究不等于可交易                |
| 衍生品/carry  | 期现、跨期、期权波动、转债套利、展期                             | 缺完整合约、保证金、期权链、多腿执行                           |
| ML/高频/执行  | 线性/树模型、深度学习、订单流、做市、VWAP/TWAP                   | 因子库不等于模型；需训练验证防泄漏与盘口延迟证据；执行算法单列 |

## 公开来源核对

2026-11-10只读核对下列第一方来源；引用规则思想并独立实现，复制代码必须另核许可：

- [QuantConnect策略库](https://www.quantconnect.com/learning/articles/investment-strategy-library)：可核对动量、反转、配对、事件及模型类别；各文章输入和市场不同，不能直接视为沪深可执行。
- [AQR Time Series Momentum](https://www.aqr.com/Insights/Research/Journal-Article/Time-Series-Momentum)：时序动量研究参照；本地股票只做多改编不等于原多资产期货组合。
- [French动量定义](https://mba.tuck.dartmouth.edu/pages/faculty/ken.french/Data_Library/det_mom_factor.html)：2–12月相对收益排序的原始组合说明；250/20交易日是本地近似，长仓Top-K不是原多空因子。
- [Microsoft Qlib](https://github.com/microsoft/qlib)：公开因子和建模流程来源；本项目已有冻结版本，不能把Alpha158覆盖称为完整模型业绩。
- [米筐RQAlpha](https://github.com/ricequant/rqalpha)：国内公开框架参照；框架支持多资产不意味着本项目已具备对应数据及执行规则。

## 逐项旧ID到目标归属

以下由方法表逐项读取，保留旧ID与原始实现状态。目标子域是迁移清单；bindings中的preset归属及implementation/test原路径继续以方法表为证据源，迁移后应同步实际消费者，原历史档案不改写。

| 旧ID                               | 原名称                            | 原状态              | 分类                | 目标子域                    | 类型                |
| ---------------------------------- | --------------------------------- | ------------------- | ------------------- | --------------------------- | ------------------- |
| SW01                               | 双突破直接确认                    | implemented-variant | 趋势/突破与技术共振 | trading-strategies/research/swing            | 规则/入场/管理组件  |
| SW02                               | 双突破后回踩确认                  | implemented-variant | 趋势/突破与技术共振 | trading-strategies/research/swing            | 规则/入场/管理组件  |
| SW03                               | 支撑压力互换                      | implemented-variant | 趋势/突破与技术共振 | trading-strategies/research/swing            | 规则/入场/管理组件  |
| SW04                               | 反转蜡烛形态                      | implemented-variant | 趋势/突破与技术共振 | trading-strategies/research/swing            | 规则/入场/管理组件  |
| SW05                               | 持续形态突破                      | implemented-variant | 趋势/突破与技术共振 | trading-strategies/research/swing            | 规则/入场/管理组件  |
| SW06                               | MACD交叉动量与背离                | implemented-variant | 趋势/突破与技术共振 | trading-strategies/research/swing            | 规则/入场/管理组件  |
| SW07                               | KDJ交叉与超买超卖                 | implemented-variant | 趋势/突破与技术共振 | trading-strategies/research/swing            | 规则/入场/管理组件  |
| SW08                               | RSI反转背离与趋势                 | implemented-variant | 趋势/突破与技术共振 | trading-strategies/research/swing            | 规则/入场/管理组件  |
| SW09                               | 布林收口反转与沿轨                | implemented-variant | 趋势/突破与技术共振 | trading-strategies/research/swing            | 规则/入场/管理组件  |
| SW10                               | 均线交叉排列与回踩                | implemented-variant | 趋势/突破与技术共振 | trading-strategies/research/swing            | 规则/入场/管理组件  |
| SW11                               | 综合指标与市场过滤                | implemented-variant | 趋势/突破与技术共振 | trading-strategies/research/swing            | 规则/入场/管理组件  |
| SW12                               | 通达信具逻辑示例                  | implemented-variant | 趋势/突破与技术共振 | trading-strategies/research/swing            | 规则/入场/管理组件  |
| VP01                               | 价涨量增                          | implemented-variant | 量价                | trading-strategies/research/volume     | 量价规则/过滤组件   |
| VP02                               | 价涨量平                          | implemented-variant | 量价                | trading-strategies/research/volume     | 量价规则/过滤组件   |
| VP03                               | 价涨量缩                          | implemented-variant | 量价                | trading-strategies/research/volume     | 量价规则/过滤组件   |
| VP04                               | 价平量增                          | implemented-variant | 量价                | trading-strategies/research/volume     | 量价规则/过滤组件   |
| VP05                               | 价平量平                          | implemented-variant | 量价                | trading-strategies/research/volume     | 量价规则/过滤组件   |
| VP06                               | 价平量缩                          | implemented-variant | 量价                | trading-strategies/research/volume     | 量价规则/过滤组件   |
| VP07                               | 价跌量增                          | implemented-variant | 量价                | trading-strategies/research/volume     | 量价规则/过滤组件   |
| VP08                               | 价跌量平                          | implemented-variant | 量价                | trading-strategies/research/volume     | 量价规则/过滤组件   |
| VP09                               | 价跌量缩                          | implemented-variant | 量价                | trading-strategies/research/volume     | 量价规则/过滤组件   |
| VP10                               | 天量天价反转减仓                  | implemented-variant | 量价                | trading-strategies/research/volume     | 量价规则/过滤组件   |
| VP11                               | 地量后放量转强                    | implemented-variant | 量价                | trading-strategies/research/volume     | 量价规则/过滤组件   |
| VP12                               | 缩量回调再放量                    | implemented-variant | 量价                | trading-strategies/research/volume     | 量价规则/过滤组件   |
| VP13                               | 价量与OBV背离                     | implemented-variant | 量价                | trading-strategies/research/volume     | 量价规则/过滤组件   |
| VP14                               | 洗盘与出货判别                    | implemented-variant | 量价                | trading-strategies/research/volume     | 量价规则/过滤组件   |
| VP15                               | 多日量能形态                      | implemented-variant | 量价                | trading-strategies/research/volume     | 量价规则/过滤组件   |
| SE01                               | 两道门VCP枢纽突破                 | implemented-variant | SEPA成长            | trading-strategies/research/canslim           | 趋势模板/VCP/管理   |
| SE02                               | 严格与弹性基本面对照              | implemented-variant | SEPA成长            | trading-strategies/research/canslim           | 趋势模板/VCP/管理   |
| SE03                               | 趋势VCP价量子策略                 | implemented         | SEPA成长            | trading-strategies/research/canslim           | 趋势模板/VCP/管理   |
| SE04                               | 首次突破与回踩再入场              | implemented         | SEPA成长            | trading-strategies/research/canslim           | 趋势模板/VCP/管理   |
| SE05                               | 退出与持仓管理组合                | implemented-variant | SEPA成长            | trading-strategies/research/canslim           | 趋势模板/VCP/管理   |
| CA01                               | 完整因子与杯柄                    | implemented-variant | CANSLIM成长         | trading-strategies/research/canslim           | 选股/评分/形态/管理 |
| CA02                               | 完整因子与平台                    | implemented-variant | CANSLIM成长         | trading-strategies/research/canslim           | 选股/评分/形态/管理 |
| CA03                               | 完整因子与碟形平底                | implemented-variant | CANSLIM成长         | trading-strategies/research/canslim           | 选股/评分/形态/管理 |
| CA04                               | 纯价量杯柄                        | implemented         | CANSLIM成长         | trading-strategies/research/canslim           | 选股/评分/形态/管理 |
| CA05                               | 纯价量平台                        | implemented         | CANSLIM成长         | trading-strategies/research/canslim           | 选股/评分/形态/管理 |
| CA06                               | 纯价量碟形平底                    | implemented         | CANSLIM成长         | trading-strategies/research/canslim           | 选股/评分/形态/管理 |
| CA07                               | 因子筛选排名                      | implemented-variant | CANSLIM成长         | trading-strategies/research/canslim           | 选股/评分/形态/管理 |
| CA08                               | 止损分批止盈与失败退出            | implemented-variant | CANSLIM成长         | trading-strategies/research/canslim           | 选股/评分/形态/管理 |
| WY01                               | Spring确认                        | implemented-variant | 威科夫              | trading-strategies/research/wyckoff          | 结构规则/研究       |
| WY02                               | SOS-JAC突破                       | implemented-variant | 威科夫              | trading-strategies/research/wyckoff          | 结构规则/研究       |
| WY03                               | LPS缩量回踩                       | implemented-variant | 威科夫              | trading-strategies/research/wyckoff          | 结构规则/研究       |
| WY04                               | 再吸筹延续                        | implemented-variant | 威科夫              | trading-strategies/research/wyckoff          | 结构规则/研究       |
| WY05                               | UT-UTAD派发风险                   | implemented-variant | 威科夫              | trading-strategies/research/wyckoff          | 结构规则/研究       |
| WY06                               | SOW-LPSY减仓                      | implemented-variant | 威科夫              | trading-strategies/research/wyckoff          | 结构规则/研究       |
| WY07                               | 破冰退出                          | implemented-variant | 威科夫              | trading-strategies/research/wyckoff          | 结构规则/研究       |
| WY08                               | 无TR趋势回调                      | implemented-variant | 威科夫              | trading-strategies/research/wyckoff          | 结构规则/研究       |
| WY09                               | 日线区域小时确认                  | implemented-variant | 威科夫              | trading-strategies/research/wyckoff          | 结构规则/研究       |
| WY10                               | 周日小时对齐                      | implemented-variant | 威科夫              | trading-strategies/research/wyckoff          | 结构规则/研究       |
| WY11                               | 相对行业市场强弱                  | implemented-variant | 威科夫              | trading-strategies/research/wyckoff          | 结构规则/研究       |
| WY12                               | Stopping Volume                   | implemented-variant | 威科夫              | trading-strategies/research/wyckoff          | 结构规则/研究       |
| WY13                               | No Supply                         | implemented-variant | 威科夫              | trading-strategies/research/wyckoff          | 结构规则/研究       |
| WY14                               | No Demand                         | implemented-variant | 威科夫              | trading-strategies/research/wyckoff          | 结构规则/研究       |
| WY15                               | Absorption                        | implemented-variant | 威科夫              | trading-strategies/research/wyckoff          | 结构规则/研究       |
| WY16                               | Churning                          | implemented-variant | 威科夫              | trading-strategies/research/wyckoff          | 结构规则/研究       |
| WY17                               | SC-BC                             | implemented-variant | 威科夫              | trading-strategies/research/wyckoff          | 结构规则/研究       |
| WY18                               | Volume Profile区域                | implemented-variant | 威科夫              | trading-strategies/research/wyckoff          | 结构规则/研究       |
| WY19                               | 点数图结构目标                    | implemented-variant | 威科夫              | trading-strategies/research/wyckoff          | 结构规则/研究       |
| WY20                               | 评分与半凯利                      | implemented-variant | 威科夫              | trading-strategies/research/wyckoff          | 结构规则/研究       |
| CH01                               | 一类买点                          | implemented-variant | 缠论                | trading-strategies/research/chan             | 结构规则/研究       |
| CH02                               | 二类买点                          | implemented-variant | 缠论                | trading-strategies/research/chan             | 结构规则/研究       |
| CH03                               | 三类买点                          | implemented-variant | 缠论                | trading-strategies/research/chan             | 结构规则/研究       |
| CH04                               | 二三买重合                        | implemented-variant | 缠论                | trading-strategies/research/chan             | 结构规则/研究       |
| CH05                               | 盘整背驰类一买                    | implemented-variant | 缠论                | trading-strategies/research/chan             | 结构规则/研究       |
| CH06                               | 趋势背驰                          | implemented-variant | 缠论                | trading-strategies/research/chan             | 结构规则/研究       |
| CH07                               | 区间套                            | implemented-variant | 缠论                | trading-strategies/research/chan             | 结构规则/研究       |
| CH08                               | 同级别分解                        | implemented-variant | 缠论                | trading-strategies/research/chan             | 结构规则/研究       |
| CH09                               | 下跌上涨组合                      | implemented-variant | 缠论                | trading-strategies/research/chan             | 结构规则/研究       |
| CH10                               | 中枢中阴震荡                      | implemented-variant | 缠论                | trading-strategies/research/chan             | 结构规则/研究       |
| CH11                               | 均线轮动板块强弱                  | implemented-variant | 缠论                | trading-strategies/research/chan             | 结构规则/研究       |
| CH12                               | 短线反弹                          | implemented-variant | 缠论                | trading-strategies/research/chan             | 结构规则/研究       |
| CH13                               | 月线底部                          | implemented-variant | 缠论                | trading-strategies/research/chan             | 结构规则/研究       |
| CH14                               | 持股持币与卖点                    | implemented-variant | 缠论                | trading-strategies/research/chan             | 结构规则/研究       |
| CH15                               | 防狼术资金管理                    | implemented-variant | 缠论                | trading-strategies/research/chan             | 结构规则/研究       |
| OP01                               | 强趋势延续                        | implemented-variant | 开盘应对            | research/opening            | 情景/规则           |
| OP02                               | 底部转折确认                      | implemented-variant | 开盘应对            | research/opening            | 情景/规则           |
| OP03                               | 平台突破与回踩                    | implemented-variant | 开盘应对            | research/opening            | 情景/规则           |
| OP04                               | 高位衰竭减仓                      | implemented-variant | 开盘应对            | research/opening            | 情景/规则           |
| OP05                               | 下跌趋势反弹减仓                  | implemented-variant | 开盘应对            | research/opening            | 情景/规则           |
| OP06                               | 昨收收复失守                      | implemented-variant | 开盘应对            | research/opening            | 情景/规则           |
| OP07                               | 开盘区间确认                      | implemented-variant | 开盘应对            | research/opening            | 情景/规则           |
| OP08                               | 旧仓可卖与新仓分离                | implemented-variant | 开盘应对            | research/opening            | 情景/规则           |
| FA01                               | F-Score                           | implemented-variant | 基本面估值          | research/value              | 研究/估值           |
| FA02                               | DuPont财务质量                    | implemented-variant | 基本面估值          | research/value              | 研究/估值           |
| FA03                               | DCF折价                           | implemented-variant | 基本面估值          | research/value              | 研究/估值           |
| FA04                               | 行业相对估值                      | implemented-variant | 基本面估值          | research/value              | 研究/估值           |
| FA05                               | 历史PE-PB分位                     | implemented-variant | 基本面估值          | research/value              | 研究/估值           |
| FA06                               | Graham                            | implemented-variant | 基本面估值          | research/value              | 研究/估值           |
| FA07                               | PEG                               | implemented-variant | 基本面估值          | research/value              | 研究/估值           |
| FA08                               | 六维评分                          | implemented-variant | 基本面估值          | research/value              | 研究/估值           |
| FA09                               | 多模型安全边际                    | implemented-variant | 基本面估值          | research/value              | 研究/估值           |
| GY01                               | 排雷                              | implemented-variant | 财报重构估值        | research/value              | 研究/估值           |
| GY02                               | 资产重构价值增加                  | implemented-variant | 财报重构估值        | research/value              | 研究/估值           |
| GY03                               | 经营现金流五状态                  | implemented-variant | 财报重构估值        | research/value              | 研究/估值           |
| GY04                               | 保全性支出FCF                     | implemented-variant | 财报重构估值        | research/value              | 研究/估值           |
| GY05                               | 安全边际                          | implemented-variant | 财报重构估值        | research/value              | 研究/估值           |
| GY06                               | 行业专用估值                      | implemented-variant | 财报重构估值        | research/value              | 研究/估值           |
| VI01                               | 生意护城河                        | implemented-variant | 价值定性            | research/value              | 研究方法            |
| VI02                               | 增长持续性                        | implemented-variant | 价值定性            | research/value              | 研究方法            |
| VI03                               | 隐含预期市场分歧                  | implemented-variant | 价值定性            | research/value              | 研究方法            |
| VI04                               | 暂时问题反转                      | implemented-variant | 价值定性            | research/value              | 研究方法            |
| VI05                               | 永久减值退出                      | implemented-variant | 价值定性            | research/value              | 研究方法            |
| VI06                               | 不对称安全边际                    | implemented-variant | 价值定性            | research/value              | 研究方法            |
| VI07                               | 长期持有再平衡                    | implemented-variant | 价值定性            | research/value              | 研究方法            |
| MS01                               | 恐惧贪婪逆向                      | implemented-variant | 市场情绪            | research/sentiment          | 市场环境            |
| MS02                               | 宽度新高新低趋势                  | implemented-variant | 市场情绪            | research/sentiment          | 市场环境            |
| MS03                               | 场内场外热度背离                  | implemented-variant | 市场情绪            | research/sentiment          | 市场环境            |
| MS04                               | 三状态切换                        | implemented-variant | 市场情绪            | research/sentiment          | 市场环境            |
| MS05                               | 杠杆估值宏观过滤                  | implemented-variant | 市场情绪            | research/sentiment          | 市场环境            |
| MS06                               | 官方媒体搜索反转                  | implemented-variant | 市场情绪            | research/sentiment          | 市场环境            |
| TM01                               | 五维拥挤上限过滤                  | implemented-variant | 拥挤度              | research/sentiment          | 市场环境            |
| TM02                               | 拥挤后降仓                        | implemented-variant | 拥挤度              | research/sentiment          | 市场环境            |
| TM03                               | 消退后恢复                        | implemented-variant | 拥挤度              | research/sentiment          | 市场环境            |
| TM04                               | 各维度对照                        | implemented-variant | 拥挤度              | research/sentiment          | 市场环境            |
| GF01                               | 指数低估进入高估退出              | implemented-variant | 估值择时            | trading-strategies/research/factors | 择时/配置           |
| GF02                               | 分位分档仓位                      | implemented-variant | 估值择时            | trading-strategies/research/factors | 择时/配置           |
| GF03                               | 关联境内ETF组合                   | implemented-variant | 估值择时            | trading-strategies/research/factors | 择时/配置           |
| EV01                               | 利好涨扩散小：个股正常兑现        | implemented-variant | 预期差事件          | research/events             | 事件研究            |
| EV02                               | 利好涨扩散大：板块主升浪          | implemented-variant | 预期差事件          | research/events             | 事件研究            |
| EV03                               | 利好跌扩散小：个股利好出尽        | implemented-variant | 预期差事件          | research/events             | 事件研究            |
| EV04                               | 利好跌扩散大：板块兑现退潮        | implemented-variant | 预期差事件          | research/events             | 事件研究            |
| EV05                               | 利空跌扩散小：个股风险释放        | implemented-variant | 预期差事件          | research/events             | 事件研究            |
| EV06                               | 利空跌扩散大：系统性风险          | implemented-variant | 预期差事件          | research/events             | 事件研究            |
| EV07                               | 利空涨扩散小：个股利空出尽        | implemented-variant | 预期差事件          | research/events             | 事件研究            |
| EV08                               | 利空涨扩散大：空头衰竭或市场极强  | implemented-variant | 预期差事件          | research/events             | 事件研究            |
| EV09                               | 利好兑现回撤                      | implemented-variant | 预期差事件          | research/events             | 事件研究            |
| EV10                               | 利空不跌反转                      | implemented-variant | 预期差事件          | research/events             | 事件研究            |
| EV11                               | 消息价格钝化                      | implemented-variant | 预期差事件          | research/events             | 事件研究            |
| EV12                               | 板块扩散共振                      | implemented-variant | 预期差事件          | research/events             | 事件研究            |
| EV13                               | 退出后确认回补                    | implemented-variant | 预期差事件          | research/events             | 事件研究            |
| NW01                               | 新闻密度热点                      | implemented-variant | 新闻热点            | research/events             | 新闻研究            |
| NW02                               | 方向与可验证催化                  | implemented-variant | 新闻热点            | research/events             | 新闻研究            |
| NW03                               | 新闻与估值分位                    | implemented-variant | 新闻热点            | research/events             | 新闻研究            |
| NW04                               | 板块主线轮动                      | implemented-variant | 新闻热点            | research/events             | 新闻研究            |
| ME01                               | 真实性过滤                        | implemented-variant | 消息分析            | research/events             | 消息研究            |
| ME02                               | 六类影响传导                      | implemented-variant | 消息分析            | research/events             | 消息研究            |
| ME03                               | 事件后价格确认                    | implemented-variant | 消息分析            | research/events             | 消息研究            |
| ME04                               | 证伪过期退出                      | implemented-variant | 消息分析            | research/events             | 消息研究            |
| IC01                               | 五维景气                          | implemented-variant | 产业链              | research/industry-chain     | 研究/过滤           |
| IC02                               | 瓶颈环节                          | implemented-variant | 产业链              | research/industry-chain     | 研究/过滤           |
| IC03                               | 催化落地                          | implemented-variant | 产业链              | research/industry-chain     | 研究/过滤           |
| IC04                               | 长中短逻辑组合                    | implemented-variant | 产业链              | research/industry-chain     | 研究/过滤           |
| IC05                               | 直接间接受益                      | implemented-variant | 产业链              | research/industry-chain     | 研究/过滤           |
| SW04-hammer                        | 锤子线                            | implemented-variant | 趋势/突破与技术共振 | trading-strategies/research/swing            | 规则/入场/管理组件  |
| SW04-morning-star                  | 启明星                            | implemented-variant | 趋势/突破与技术共振 | trading-strategies/research/swing            | 规则/入场/管理组件  |
| SW04-morning-doji                  | 启明星十字星                      | implemented-variant | 趋势/突破与技术共振 | trading-strategies/research/swing            | 规则/入场/管理组件  |
| SW04-bull-engulf                   | 看涨吞没                          | implemented-variant | 趋势/突破与技术共振 | trading-strategies/research/swing            | 规则/入场/管理组件  |
| SW04-bottom-doji                   | 底部十字星                        | implemented-variant | 趋势/突破与技术共振 | trading-strategies/research/swing            | 规则/入场/管理组件  |
| SW04-shooting-star                 | 射击之星                          | implemented-variant | 趋势/突破与技术共振 | trading-strategies/research/swing            | 规则/入场/管理组件  |
| SW04-evening-star                  | 黄昏之星                          | implemented-variant | 趋势/突破与技术共振 | trading-strategies/research/swing            | 规则/入场/管理组件  |
| SW04-bear-engulf                   | 看跌吞没                          | implemented-variant | 趋势/突破与技术共振 | trading-strategies/research/swing            | 规则/入场/管理组件  |
| SW04-dark-cloud                    | 乌云盖顶                          | implemented-variant | 趋势/突破与技术共振 | trading-strategies/research/swing            | 规则/入场/管理组件  |
| SW04-top-doji                      | 顶部十字星                        | implemented-variant | 趋势/突破与技术共振 | trading-strategies/research/swing            | 规则/入场/管理组件  |
| SW05-rising-three                  | 上升三法                          | implemented-variant | 趋势/突破与技术共振 | trading-strategies/research/swing            | 规则/入场/管理组件  |
| SW05-falling-three                 | 下降三法                          | implemented-variant | 趋势/突破与技术共振 | trading-strategies/research/swing            | 规则/入场/管理组件  |
| SW05-flag                          | 旗形                              | implemented-variant | 趋势/突破与技术共振 | trading-strategies/research/swing            | 规则/入场/管理组件  |
| SW05-triangle                      | 三角                              | implemented-variant | 趋势/突破与技术共振 | trading-strategies/research/swing            | 规则/入场/管理组件  |
| SW02-half-entry                    | 首仓半仓回踩补仓                  | implemented-variant | 趋势/突破与技术共振 | trading-strategies/research/swing            | 规则/入场/管理组件  |
| SW11-calendar                      | 节前事件日历                      | implemented-variant | 趋势/突破与技术共振 | trading-strategies/research/swing            | 规则/入场/管理组件  |
| SW11-breadth                       | 市场涨跌比                        | implemented-variant | 趋势/突破与技术共振 | trading-strategies/research/swing            | 规则/入场/管理组件  |
| SW11-volatility                    | 波动飙升                          | implemented-variant | 趋势/突破与技术共振 | trading-strategies/research/swing            | 规则/入场/管理组件  |
| SW12-macd-zero                     | MACD柱零轴进退                    | implemented-variant | 趋势/突破与技术共振 | trading-strategies/research/swing            | 规则/入场/管理组件  |
| SW12-boll-reentry                  | 上穿布林下轨入上轨出              | implemented-variant | 趋势/突破与技术共振 | trading-strategies/research/swing            | 规则/入场/管理组件  |
| SW12-buffett                       | 财务阈值选股                      | implemented-variant | 趋势/突破与技术共振 | trading-strategies/research/swing            | 规则/入场/管理组件  |
| SW12-old-duck                      | 老鸭头EMA13-55组合                | implemented-variant | 趋势/突破与技术共振 | trading-strategies/research/swing            | 规则/入场/管理组件  |
| SW12-limit-state                   | 涨跌停状态分类                    | implemented-variant | 趋势/突破与技术共振 | trading-strategies/research/swing            | 规则/入场/管理组件  |
| CH16-ma-kiss                       | 均线吻                            | implemented-variant | 缠论                | trading-strategies/research/chan             | 结构规则/研究       |
| CH17-ma-area                       | 均线面积力度                      | implemented-variant | 缠论                | trading-strategies/research/chan             | 结构规则/研究       |
| CH17-ma-average-force              | 单位时间平均力度                  | implemented-variant | 缠论                | trading-strategies/research/chan             | 结构规则/研究       |
| CH18-small-to-large                | 小转大                            | implemented-variant | 缠论                | trading-strategies/research/chan             | 结构规则/研究       |
| SE05-weekly-ma                     | 周线10MA减半                      | implemented         | SEPA成长            | trading-strategies/research/canslim           | 趋势模板/VCP/管理   |
| SE05-elite                         | 三周20%后的八周观察               | implemented-variant | SEPA成长            | trading-strategies/research/canslim           | 趋势模板/VCP/管理   |
| GY06-bank                          | 银行行业估值                      | implemented-variant | 财报重构估值        | research/value              | 研究/估值           |
| GY06-research                      | 研发行业估值                      | implemented-variant | 财报重构估值        | research/value              | 研究/估值           |
| GY06-long-asset                    | 长资产行业估值                    | implemented-variant | 财报重构估值        | research/value              | 研究/估值           |
| GY06-cycle                         | 周期行业估值                      | implemented-variant | 财报重构估值        | research/value              | 研究/估值           |
| GY06-growth                        | 成长行业估值                      | implemented-variant | 财报重构估值        | research/value              | 研究/估值           |
| GY06-property                      | 地产行业估值                      | implemented-variant | 财报重构估值        | research/value              | 研究/估值           |
| VI08-horizon                       | 时间视角错配                      | implemented-variant | 价值定性            | research/value              | 研究方法            |
| VI08-categorization                | 分类错误                          | implemented-variant | 价值定性            | research/value              | 研究方法            |
| VI08-coverage                      | 覆盖不足                          | implemented-variant | 价值定性            | research/value              | 研究方法            |
| VI08-liquidity                     | 流动性情绪冲击                    | implemented-variant | 价值定性            | research/value              | 研究方法            |
| IC01-inventory                     | 库存景气                          | implemented-variant | 产业链              | research/industry-chain     | 研究/过滤           |
| IC01-capacity                      | 产能景气                          | implemented-variant | 产业链              | research/industry-chain     | 研究/过滤           |
| IC01-demand                        | 需求景气                          | implemented-variant | 产业链              | research/industry-chain     | 研究/过滤           |
| IC01-profit                        | 利润景气                          | implemented-variant | 产业链              | research/industry-chain     | 研究/过滤           |
| IC01-policy                        | 政策景气                          | implemented-variant | 产业链              | research/industry-chain     | 研究/过滤           |
| IC02-technology                    | 技术瓶颈                          | implemented-variant | 产业链              | research/industry-chain     | 研究/过滤           |
| IC02-supply                        | 供应链瓶颈                        | implemented-variant | 产业链              | research/industry-chain     | 研究/过滤           |
| IC02-verification                  | 验证周期瓶颈                      | implemented-variant | 产业链              | research/industry-chain     | 研究/过滤           |
| IC02-commercialization             | 商业化瓶颈                        | implemented-variant | 产业链              | research/industry-chain     | 研究/过滤           |
| IC02-competition                   | 竞争瓶颈                          | implemented-variant | 产业链              | research/industry-chain     | 研究/过滤           |
| WP01-cost                          | 筹码成本趋势                      | implemented-variant | 筹码                | research/chips              | 研究/过滤           |
| WP01-concentration                 | 筹码集中度趋势                    | implemented-variant | 筹码                | research/chips              | 研究/过滤           |
| WP01-profit                        | 获利盘变化                        | implemented-variant | 筹码                | research/chips              | 研究/过滤           |
| QT-astock                          | 逐条查询示例筛选模板              | implemented-variant | 外部查询            | research/query              | 查询模板            |
| QT-sector                          | 逐条查询示例筛选模板              | implemented-variant | 外部查询            | research/query              | 查询模板            |
| QT-etf                             | 逐条查询示例筛选模板              | implemented-variant | 外部查询            | research/query              | 查询模板            |
| QT-cb                              | 逐条查询示例筛选模板              | implemented-variant | 外部查询            | research/query              | 查询模板            |
| QT-fund                            | 逐条查询示例筛选模板              | implemented-variant | 外部查询            | research/query              | 查询模板            |
| QT-fundcompany                     | 逐条查询示例筛选模板              | implemented-variant | 外部查询            | research/query              | 查询模板            |
| QT-fundmanager                     | 逐条查询示例筛选模板              | implemented-variant | 外部查询            | research/query              | 查询模板            |
| QT-futures                         | 逐条查询示例筛选模板              | implemented-variant | 外部查询            | research/query              | 查询模板            |
| QT-hkstock                         | 逐条查询示例筛选模板              | implemented-variant | 外部查询            | research/query              | 查询模板            |
| QT-usstock                         | 逐条查询示例筛选模板              | implemented-variant | 外部查询            | research/query              | 查询模板            |
| RK-A1-percent                      | 百分比初始止损                    | implemented-variant | 风险控制            | risk                        | 风控组件            |
| RK-A2-atr                          | 信号日ATR止损                     | implemented-variant | 风险控制            | risk                        | 风控组件            |
| RK-A3-buffer                       | 双突破结构缓冲                    | implemented-variant | 风险控制            | risk                        | 风控组件            |
| RK-A4-indicator                    | 指标止损                          | implemented-variant | 风险控制            | risk                        | 风控组件            |
| RK-A5-mae                          | MAE统计止损                       | implemented-variant | 风险控制            | risk                        | 风控组件            |
| RK-A6-thesis                       | 逻辑证伪止损                      | implemented-variant | 风险控制            | risk                        | 风控组件            |
| RK-A-max-distance                  | 脚本最大距离选线                  | implemented-variant | 风险控制            | risk                        | 风控组件            |
| RK-B-touch                         | 盘中触碰                          | implemented-variant | 风险控制            | risk                        | 风控组件            |
| RK-B-close                         | 一根收盘确认                      | implemented-variant | 风险控制            | risk                        | 风控组件            |
| RK-B-two-closes                    | 连续两根收盘确认                  | implemented-variant | 风险控制            | risk                        | 风控组件            |
| RK-C-risk                          | 含费风险股数                      | implemented-variant | 风险控制            | risk                        | 风控组件            |
| RK-C-stress                        | 显式压力缓冲仓位                  | implemented-variant | 风险控制            | risk                        | 风控组件            |
| RK-C-kelly                         | 半凯利仓位                        | implemented-variant | 风险控制            | risk                        | 风控组件            |
| RK-C-liquidity                     | 成交容量上限                      | implemented-variant | 风险控制            | risk                        | 风控组件            |
| RK-C-disaster                      | 灾难止损兜底                      | implemented-variant | 风险控制            | risk                        | 风控组件            |
| RK-D1-fixed                        | 固定止损线                        | implemented-variant | 风险控制            | risk                        | 风控组件            |
| RK-D2-breakeven                    | 结构确认后保本                    | implemented-variant | 风险控制            | risk                        | 风控组件            |
| RK-D3-percent                      | 百分比跟随                        | implemented-variant | 风险控制            | risk                        | 风控组件            |
| RK-D3-distance                     | 固定距离跟随                      | implemented-variant | 风险控制            | risk                        | 风控组件            |
| RK-D3-structure                    | 结构跟随                          | implemented-variant | 风险控制            | risk                        | 风控组件            |
| RK-D4-retracement                  | 利润回吐分级收紧                  | implemented-variant | 风险控制            | risk                        | 风控组件            |
| RK-D5-time                         | 时间进展不足退出                  | implemented-variant | 风险控制            | risk                        | 风控组件            |
| RK-D6-partial                      | 分批减仓逐级抬升                  | implemented-variant | 风险控制            | risk                        | 风控组件            |
| RK-V1-chandelier                   | 持仓最高价吊灯跟随                | implemented-variant | 风险控制            | risk                        | 风控组件            |
| RK-V1-rolling-high                 | 窗口最高价吊灯变体                | implemented-variant | 风险控制            | risk                        | 风控组件            |
| RK-V2-boll                         | 布林下轨                          | implemented-variant | 风险控制            | risk                        | 风控组件            |
| RK-V3-keltner                      | Keltner                           | implemented-variant | 风险控制            | risk                        | 风控组件            |
| RK-V4-kase                         | Kase DevStop                      | implemented-variant | 风险控制            | risk                        | 风控组件            |
| RK-V5-kaufman                      | Kaufman区间                       | implemented-variant | 风险控制            | risk                        | 风控组件            |
| RK-V6-safezone                     | Elder SafeZone                    | implemented-variant | 风险控制            | risk                        | 风控组件            |
| RK-V7-beta                         | Beta调整止损                      | implemented-variant | 风险控制            | risk                        | 风控组件            |
| RK-V8-sar                          | Parabolic SAR                     | implemented-variant | 风险控制            | risk                        | 风控组件            |
| RK-E-daily                         | 日亏损上限恢复                    | implemented-variant | 风险控制            | risk                        | 风控组件            |
| RK-E-weekly                        | 周亏损上限恢复                    | implemented-variant | 风险控制            | risk                        | 风控组件            |
| RK-E-monthly                       | 月亏损上限恢复                    | implemented-variant | 风险控制            | risk                        | 风控组件            |
| RK-E-streak                        | 连亏降仓恢复                      | implemented-variant | 风险控制            | risk                        | 风控组件            |
| RK-E-drawdown                      | 峰谷回撤熔断                      | implemented-variant | 风险控制            | risk                        | 风控组件            |
| RK-E-equity                        | 净值曲线开关                      | implemented-variant | 风险控制            | risk                        | 风控组件            |
| RK-F-reduce                        | 主动降仓                          | implemented-variant | 风险控制            | risk                        | 风控组件            |
| RK-F-diversify                     | 分散配置                          | implemented-variant | 风险控制            | risk                        | 风控组件            |
| RK-F-rebalance                     | 再平衡                            | implemented-variant | 风险控制            | risk                        | 风控组件            |
| RK-F-put                           | 保护性看跌                        | implemented-variant | 风险控制            | risk                        | 风控组件            |
| RK-F-collar                        | 领口                              | implemented-variant | 风险控制            | risk                        | 风控组件            |
| SW12-volume                        | 放缩量条件                        | implemented-variant | 趋势/突破与技术共振 | trading-strategies/research/swing            | 规则/入场/管理组件  |
| SW12-price                         | 涨跌及新高条件                    | implemented-variant | 趋势/突破与技术共振 | trading-strategies/research/swing            | 规则/入场/管理组件  |
| SW12-gap                           | 高低开与跳空                      | implemented-variant | 趋势/突破与技术共振 | trading-strategies/research/swing            | 规则/入场/管理组件  |
| SW12-gap-unfilled                  | 向上跳空两日不回补                | implemented-variant | 趋势/突破与技术共振 | trading-strategies/research/swing            | 规则/入场/管理组件  |
| SW12-ma-order                      | 5-10-30多头排列                   | implemented-variant | 趋势/突破与技术共振 | trading-strategies/research/swing            | 规则/入场/管理组件  |
| SW12-base-breakout                 | 底部横盘后新高                    | implemented-variant | 趋势/突破与技术共振 | trading-strategies/research/swing            | 规则/入场/管理组件  |
| SW12-psy-rank                      | PSY横截面排名                     | implemented-variant | 趋势/突破与技术共振 | trading-strategies/research/swing            | 规则/入场/管理组件  |
| SW12-four-limit-down               | 连续四日跌停                      | implemented-variant | 趋势/突破与技术共振 | trading-strategies/research/swing            | 规则/入场/管理组件  |
| SW12-skill-cross                   | 均线金叉示例                      | implemented-variant | 趋势/突破与技术共振 | trading-strategies/research/swing            | 规则/入场/管理组件  |
| SW12-new-high                      | 20日新高示例                      | implemented-variant | 趋势/突破与技术共振 | trading-strategies/research/swing            | 规则/入场/管理组件  |
| SW12-three-volume                  | 连续三日放量示例                  | implemented-variant | 趋势/突破与技术共振 | trading-strategies/research/swing            | 规则/入场/管理组件  |
| SW12-ten-limit                     | 十日内涨停示例                    | implemented-variant | 趋势/突破与技术共振 | trading-strategies/research/swing            | 规则/入场/管理组件  |
| SW12-relative-strength             | 相对大盘强度示例                  | implemented-variant | 趋势/突破与技术共振 | trading-strategies/research/swing            | 规则/入场/管理组件  |
| AR01-time-window                   | 主动建仓时段优先级                | implemented-variant | 交易规则            | execution-policy            | 执行约束            |
| AR02-gain-filter                   | 当日涨幅禁入                      | implemented-variant | 交易规则            | execution-policy            | 执行约束            |
| AR03-st-filter                     | 非ST准入                          | implemented-variant | 交易规则            | execution-policy            | 执行约束            |
| AR04-ipo-age                       | 上市60交易日门槛                  | implemented-variant | 交易规则            | execution-policy            | 执行约束            |
| AR05-resumption                    | 复牌3交易日门槛                   | implemented-variant | 交易规则            | execution-policy            | 执行约束            |
| AR06-report-window                 | 财报5交易日避让                   | implemented-variant | 交易规则            | execution-policy            | 执行约束            |
| AR07-late-size                     | 晚入场降低单笔仓位                | implemented-variant | 交易规则            | execution-policy            | 执行约束            |
| AR08-auction-confirm               | 竞价可撤阶段不作正式依据          | implemented-variant | 交易规则            | execution-policy            | 执行约束            |
| RK-D6-close-atr-tail               | 收盘ATR跟随与全部实际减仓后激活   | implemented-variant | 风险控制            | risk                        | 风控组件            |
| RK-D7-pyramid                      | 50/30/20盈利加仓及整体风险重算    | implemented-variant | 风险控制            | risk                        | 风控组件            |
| SW10-ma-golden-5-10                | 均线5/10金叉死叉                  | implemented-variant | 趋势/突破与技术共振 | trading-strategies/research/swing            | 规则/入场/管理组件  |
| SW10-ma-golden-10-20               | 均线10/20金叉死叉                 | implemented-variant | 趋势/突破与技术共振 | trading-strategies/research/swing            | 规则/入场/管理组件  |
| SW10-ma-golden-20-60               | 均线20/60金叉死叉                 | implemented-variant | 趋势/突破与技术共振 | trading-strategies/research/swing            | 规则/入场/管理组件  |
| SW10-ma-alignment                  | 多头排列进入与失效                | implemented-variant | 趋势/突破与技术共振 | trading-strategies/research/swing            | 规则/入场/管理组件  |
| SW06-macd-golden                   | MACD金叉死叉                      | implemented-variant | 趋势/突破与技术共振 | trading-strategies/research/swing            | 规则/入场/管理组件  |
| SW06-macd-golden-positive          | MACD零轴上金叉                    | implemented-variant | 趋势/突破与技术共振 | trading-strategies/research/swing            | 规则/入场/管理组件  |
| SW06-macd-histogram-turn           | 绿柱首次缩短入与红柱首次缩短出    | implemented-variant | 趋势/突破与技术共振 | trading-strategies/research/swing            | 规则/入场/管理组件  |
| SW07-kdj-golden                    | KDJ金叉死叉                       | implemented-variant | 趋势/突破与技术共振 | trading-strategies/research/swing            | 规则/入场/管理组件  |
| SW07-kdj-extreme                   | KDJ超卖金叉与超买死叉             | implemented-variant | 趋势/突破与技术共振 | trading-strategies/research/swing            | 规则/入场/管理组件  |
| SW07-kdj-macd-confirmed            | MACD方向确认的KDJ交叉             | implemented-variant | 趋势/突破与技术共振 | trading-strategies/research/swing            | 规则/入场/管理组件  |
| SW08-rsi-recovery                  | RSI超卖恢复与超买回落             | implemented-variant | 趋势/突破与技术共振 | trading-strategies/research/swing            | 规则/入场/管理组件  |
| SW08-rsi-50-cross                  | RSI50强弱交叉                     | implemented-variant | 趋势/突破与技术共振 | trading-strategies/research/swing            | 规则/入场/管理组件  |
| SW09-boll-middle-cross             | 布林中轨上穿与下破                | implemented-variant | 趋势/突破与技术共振 | trading-strategies/research/swing            | 规则/入场/管理组件  |
| SW09-boll-band-recovery            | 布林下轨反弹与上轨回落            | implemented-variant | 趋势/突破与技术共振 | trading-strategies/research/swing            | 规则/入场/管理组件  |
| SW06-negative-dead                 | 零轴下死叉的持仓退出              | implemented-variant | 趋势/突破与技术共振 | trading-strategies/research/swing            | 规则/入场/管理组件  |
| SW06-red-grow                      | MACD红柱放大延续                  | implemented-variant | 趋势/突破与技术共振 | trading-strategies/research/swing            | 规则/入场/管理组件  |
| SW06-green-grow                    | MACD绿柱放大风险退出              | implemented-variant | 趋势/突破与技术共振 | trading-strategies/research/swing            | 规则/入场/管理组件  |
| SW06-top-divergence                | MACD顶背离确认                    | implemented-variant | 趋势/突破与技术共振 | trading-strategies/research/swing            | 规则/入场/管理组件  |
| SW06-bottom-divergence             | MACD底背离确认                    | implemented-variant | 趋势/突破与技术共振 | trading-strategies/research/swing            | 规则/入场/管理组件  |
| SW06-double-top-divergence         | 连续两次MACD顶背离                | implemented-variant | 趋势/突破与技术共振 | trading-strategies/research/swing            | 规则/入场/管理组件  |
| SW06-double-bottom-divergence      | 连续两次MACD底背离                | implemented-variant | 趋势/突破与技术共振 | trading-strategies/research/swing            | 规则/入场/管理组件  |
| SW07-zone-filter                   | KDJ极端区不追价                   | implemented-variant | 趋势/突破与技术共振 | trading-strategies/research/swing            | 规则/入场/管理组件  |
| SW07-regime-filter                 | 震荡环境使用KDJ                   | implemented-variant | 趋势/突破与技术共振 | trading-strategies/research/swing            | 规则/入场/管理组件  |
| SW08-zone-state                    | RSI超买超卖区状态策略             | implemented-variant | 趋势/突破与技术共振 | trading-strategies/research/swing            | 规则/入场/管理组件  |
| SW08-neutral-filter                | RSI40至60震荡过滤                 | implemented-variant | 趋势/突破与技术共振 | trading-strategies/research/swing            | 规则/入场/管理组件  |
| SW08-top-divergence                | RSI顶背离                         | implemented-variant | 趋势/突破与技术共振 | trading-strategies/research/swing            | 规则/入场/管理组件  |
| SW08-bottom-divergence             | RSI底背离                         | implemented-variant | 趋势/突破与技术共振 | trading-strategies/research/swing            | 规则/入场/管理组件  |
| SW09-squeeze-breakout              | 布林收口后放量突破                | implemented-variant | 趋势/突破与技术共振 | trading-strategies/research/swing            | 规则/入场/管理组件  |
| SW09-expansion                     | 布林开口顺势                      | implemented-variant | 趋势/突破与技术共振 | trading-strategies/research/swing            | 规则/入场/管理组件  |
| SW09-upper-ride                    | 沿布林上轨持多                    | implemented-variant | 趋势/突破与技术共振 | trading-strategies/research/swing            | 规则/入场/管理组件  |
| SW09-lower-ride                    | 沿布林下轨减仓                    | implemented-variant | 趋势/突破与技术共振 | trading-strategies/research/swing            | 规则/入场/管理组件  |
| SW10-support-20                    | MA20支撑压力互换                  | implemented-variant | 趋势/突破与技术共振 | trading-strategies/research/swing            | 规则/入场/管理组件  |
| SW10-support-60                    | MA60支撑压力互换                  | implemented-variant | 趋势/突破与技术共振 | trading-strategies/research/swing            | 规则/入场/管理组件  |
| SW10-support-120                   | MA120支撑压力互换                 | implemented-variant | 趋势/突破与技术共振 | trading-strategies/research/swing            | 规则/入场/管理组件  |
| SW10-support-250                   | MA250支撑压力互换                 | implemented-variant | 趋势/突破与技术共振 | trading-strategies/research/swing            | 规则/入场/管理组件  |
| SW11-volume-up-up                  | 放量上涨                          | implemented-variant | 趋势/突破与技术共振 | trading-strategies/research/swing            | 规则/入场/管理组件  |
| SW11-volume-up-down                | 缩量上涨                          | implemented-variant | 趋势/突破与技术共振 | trading-strategies/research/swing            | 规则/入场/管理组件  |
| SW11-volume-down-up                | 放量下跌                          | implemented-variant | 趋势/突破与技术共振 | trading-strategies/research/swing            | 规则/入场/管理组件  |
| SW11-volume-down-down              | 缩量下跌                          | implemented-variant | 趋势/突破与技术共振 | trading-strategies/research/swing            | 规则/入场/管理组件  |
| SW11-volume-high-volume-divergence | 新高缩量背离                      | implemented-variant | 趋势/突破与技术共振 | trading-strategies/research/swing            | 规则/入场/管理组件  |
| SW11-volume-low-volume-divergence  | 新低缩量背离                      | implemented-variant | 趋势/突破与技术共振 | trading-strategies/research/swing            | 规则/入场/管理组件  |
| SW11-volume-breakout               | 20日均量1.5/2倍突破与不足均量过滤 | implemented-variant | 趋势/突破与技术共振 | trading-strategies/research/swing            | 规则/入场/管理组件  |
| SW11-volume-ratio                  | 量比3/1.5/0.8分档                 | implemented-variant | 趋势/突破与技术共振 | trading-strategies/research/swing            | 规则/入场/管理组件  |
| SW11-confluence-count              | 五辅助指标确认计数与仓位          | implemented-variant | 趋势/突破与技术共振 | trading-strategies/research/swing            | 规则/入场/管理组件  |
| SW11-direction-conflict            | MACD与均线矛盾等待                | implemented-variant | 趋势/突破与技术共振 | trading-strategies/research/swing            | 规则/入场/管理组件  |
| SW11-kdj-overbought-size           | KDJ超买但MACD金叉减仓操作         | implemented-variant | 趋势/突破与技术共振 | trading-strategies/research/swing            | 规则/入场/管理组件  |
| VP-vp-up-expanded-confirm          | 趋势放量后确认                    | implemented-variant | 量价                | trading-strategies/research/volume     | 量价规则/过滤组件   |
| VP-vp-flat-expanded-break          | 横盘放量后突破                    | implemented-variant | 量价                | trading-strategies/research/volume     | 量价规则/过滤组件   |
| VP-vp-up-contracted-confirm        | 缩量上涨后确认                    | implemented-variant | 量价                | trading-strategies/research/volume     | 量价规则/过滤组件   |
| VP-vp-down-contracted-confirm      | 缩量回调后需求回归                | implemented-variant | 量价                | trading-strategies/research/volume     | 量价规则/过滤组件   |
| VP-vp-up-normal-confirm            | 价涨量平后走强                    | implemented-variant | 量价                | trading-strategies/research/volume     | 量价规则/过滤组件   |
| VP-vp-flat-contracted-break        | 缩量横盘后突破                    | implemented-variant | 量价                | trading-strategies/research/volume     | 量价规则/过滤组件   |
| VP-vp-breakout-1-5                 | 前20有效记录均量1.5倍突破         | implemented-variant | 量价                | trading-strategies/research/volume     | 量价规则/过滤组件   |
| VP-vp-breakout-2                   | 前20有效记录均量2倍突破           | implemented-variant | 量价                | trading-strategies/research/volume     | 量价规则/过滤组件   |
| VP-vp-volume-ma-cross              | 量均线5/10趋势内转强              | implemented-variant | 量价                | trading-strategies/research/volume     | 量价规则/过滤组件   |
| VP-vp-panic-2                      | 恐慌后连续两根缩量再收复          | implemented-variant | 量价                | trading-strategies/research/volume     | 量价规则/过滤组件   |
| VP-vp-panic-3                      | 恐慌后连续三根缩量再收复          | implemented-variant | 量价                | trading-strategies/research/volume     | 量价规则/过滤组件   |
| VP-vp-dry-and                      | 地量三阶段且定义                  | implemented-variant | 量价                | trading-strategies/research/volume     | 量价规则/过滤组件   |
| VP-vp-dry-or                       | 地量三阶段或定义                  | implemented-variant | 量价                | trading-strategies/research/volume     | 量价规则/过滤组件   |
| VP-vp-obv-high                     | 价格与OBV同步新高                 | implemented-variant | 量价                | trading-strategies/research/volume     | 量价规则/过滤组件   |
| VP-vp-obv-top-exit                 | OBV顶背离退出                     | implemented-variant | 量价                | trading-strategies/research/volume     | 量价规则/过滤组件   |
| VP-vp-obv-bottom                   | OBV底背离收复                     | implemented-variant | 量价                | trading-strategies/research/volume     | 量价规则/过滤组件   |
| VP-vp-obv-flat                     | 横盘OBV连续进退                   | implemented-variant | 量价                | trading-strategies/research/volume     | 量价规则/过滤组件   |
| VP-vp-stack-3                      | 三根温和递增量                    | implemented-variant | 量价                | trading-strategies/research/volume     | 量价规则/过滤组件   |
| VP-vp-contract-3                   | 三根递减量后突破                  | implemented-variant | 量价                | trading-strategies/research/volume     | 量价规则/过滤组件   |
| VP-vp-huge-next-exit               | 天量次日确认退出                  | implemented-variant | 量价                | trading-strategies/research/volume     | 量价规则/过滤组件   |
| VP-vp-huge-second-exit             | 天量后二顶退出                    | implemented-variant | 量价                | trading-strategies/research/volume     | 量价规则/过滤组件   |
| VP-vp-interval-3                   | 三次间隔放量突破                  | implemented-variant | 量价                | trading-strategies/research/volume     | 量价规则/过滤组件   |
| VP-vp-isolated-filter              | 基线突破的孤量过滤                | implemented-variant | 量价                | trading-strategies/research/volume     | 量价规则/过滤组件   |
| VP-vp-stall-exit                   | 量增涨幅收敛退出                  | implemented-variant | 量价                | trading-strategies/research/volume     | 量价规则/过滤组件   |
| VP-vp-high-low-volume-exit         | 与前高点量比较的缩量新高退出      | implemented-variant | 量价                | trading-strategies/research/volume     | 量价规则/过滤组件   |
| VP-amount-basis                    | 成交额量价对照                    | implemented-variant | 量价                | trading-strategies/research/volume     | 量价规则/过滤组件   |
| VP-adjusted-volume                 | 后复权价与对应量调整              | implemented-variant | 量价                | trading-strategies/research/volume     | 量价规则/过滤组件   |
| VP-intraday-ratio                  | 盘中每分钟量比                    | implemented-variant | 量价                | trading-strategies/research/volume     | 量价规则/过滤组件   |
| VP-intraday-projection             | 已过时间线性折算全天量            | implemented-variant | 量价                | trading-strategies/research/volume     | 量价规则/过滤组件   |
| VP-board-volume                    | 成长板块放量阈值上调              | implemented-variant | 量价                | trading-strategies/research/volume     | 量价规则/过滤组件   |
| VP-board-price                     | 高波动品种价格阈值放宽            | implemented-variant | 量价                | trading-strategies/research/volume     | 量价规则/过滤组件   |
| VP-etf-volume                      | 指数与ETF的1.3放量阈值            | implemented-variant | 量价                | trading-strategies/research/volume     | 量价规则/过滤组件   |
| VP-small-float-turnover            | 小市值低流通盘以换手为主          | implemented-variant | 量价                | trading-strategies/research/volume     | 量价规则/过滤组件   |
| VP-crypto-time-slot                | 加密同期同时段量能                | implemented-variant | 量价                | trading-strategies/research/volume     | 量价规则/过滤组件   |
| VP-position-bottom-full            | 完整底部位置条件                  | implemented-variant | 量价                | trading-strategies/research/volume     | 量价规则/过滤组件   |
| VP-position-up-full                | 完整上涨中途位置条件              | implemented-variant | 量价                | trading-strategies/research/volume     | 量价规则/过滤组件   |
| VP-position-high-full              | 完整高位位置条件                  | implemented-variant | 量价                | trading-strategies/research/volume     | 量价规则/过滤组件   |
| VP-position-down-full              | 完整下跌中途位置条件              | implemented-variant | 量价                | trading-strategies/research/volume     | 量价规则/过滤组件   |
| VP-position-range-full             | 清晰上下沿的区间位置              | implemented-variant | 量价                | trading-strategies/research/volume     | 量价规则/过滤组件   |
| VP-position-uncertain              | 位置不明时持仓从严开仓从紧        | implemented-variant | 量价                | trading-strategies/research/volume     | 量价规则/过滤组件   |
| VP-controlled-contraction          | 低换手连续小阳守MA5               | implemented-variant | 量价                | trading-strategies/research/volume     | 量价规则/过滤组件   |
| VP-bottom-expanded-2               | 底部颈线平台突破且R至少2          | implemented-variant | 量价                | trading-strategies/research/volume     | 量价规则/过滤组件   |
| VP-expanded-retest                 | 放量上涨后的缩量回踩守位          | implemented-variant | 量价                | trading-strategies/research/volume     | 量价规则/过滤组件   |
| VP-false-break-signal-clock        | 放量后1至3日假突破证伪            | implemented         | 量价                | trading-strategies/research/volume     | 量价规则/过滤组件   |
| VP-next-larger-bearish             | 次根更大量长上影或阴线证伪        | implemented         | 量价                | trading-strategies/research/volume     | 量价规则/过滤组件   |
| VP-high-acceleration-filter        | 高位量价齐升的派发与加速分支      | implemented-variant | 量价                | trading-strategies/research/volume     | 量价规则/过滤组件   |
| VP-down-rebound-resistance         | 下跌位置放量反弹不过前高          | implemented-variant | 量价                | trading-strategies/research/volume     | 量价规则/过滤组件   |
| VP-flat-expanded-down              | 横盘放量后跌破下沿                | implemented-variant | 量价                | trading-strategies/research/volume     | 量价规则/过滤组件   |
| VP-flat-expanded-stale             | 两周无方向降为区间处理            | implemented-variant | 量价                | trading-strategies/research/volume     | 量价规则/过滤组件   |
| VP-normal-transition               | 价涨量平及价跌量平的后续方向路由  | implemented-variant | 量价                | trading-strategies/research/volume     | 量价规则/过滤组件   |
| VP-huge-band-main                  | 主文2倍巨量口径对照               | implemented-variant | 量价                | trading-strategies/research/volume     | 量价规则/过滤组件   |
| VP-high-huge-candle                | 天量长上影光头阴线与冲高回落      | implemented-variant | 量价                | trading-strategies/research/volume     | 量价规则/过滤组件   |
| VP-all-history-extreme-volume      | 历史新高量与60日新高量对照        | implemented-variant | 量价                | trading-strategies/research/volume     | 量价规则/过滤组件   |
| VP-dry-turnover-confirm            | 地量与历史低换手交叉确认          | implemented-variant | 量价                | trading-strategies/research/volume     | 量价规则/过滤组件   |
| VP-volume-slope-5                  | 五根量能斜率及三五根对照          | implemented         | 量价                | trading-strategies/research/volume     | 量价规则/过滤组件   |
| VP-interval-family                 | 其他间隔放量节奏                  | implemented         | 量价                | trading-strategies/research/volume     | 量价规则/过滤组件   |
| VP-wash-price-volume               | 洗盘与派发的跌幅量能证据          | implemented-variant | 量价                | trading-strategies/research/volume     | 量价规则/过滤组件   |
| VP-wash-key-level                  | 洗盘与派发的关键位证据            | implemented-variant | 量价                | trading-strategies/research/volume     | 量价规则/过滤组件   |
| VP-wash-reclaim                    | 洗盘快速缩量企稳收复与弱反抽      | implemented-variant | 量价                | trading-strategies/research/volume     | 量价规则/过滤组件   |
| VP-wash-duration                   | 洗盘1至3日与反复下台阶            | implemented-variant | 量价                | trading-strategies/research/volume     | 量价规则/过滤组件   |
| VP-wash-intraday                   | 早盘急跌尾盘拉回与高开低走        | implemented-variant | 量价                | trading-strategies/research/volume     | 量价规则/过滤组件   |
| VP-wash-chips                      | 温和换手筹码峰与高位密集          | implemented-variant | 量价                | trading-strategies/research/volume     | 量价规则/过滤组件   |
| VP-wash-news                       | 无重大利空与利空业绩不及预期      | implemented-variant | 量价                | trading-strategies/research/volume     | 量价规则/过滤组件   |
| VP-wash-composite                  | 洗盘派发七维组合及不明从严        | implemented-variant | 量价                | trading-strategies/research/volume     | 量价规则/过滤组件   |
| VP-turnover-bands                  | 五档换手状态的具名过滤            | implemented-variant | 量价                | trading-strategies/research/volume     | 量价规则/过滤组件   |
| VP-turnover-location               | 剧烈换手在底部与高位的分支        | implemented-variant | 量价                | trading-strategies/research/volume     | 量价规则/过滤组件   |
| VP-volume-center                   | 5/10/20量能中枢抬升下移           | implemented         | 量价                | trading-strategies/research/volume     | 量价规则/过滤组件   |
| VP-profile-support                 | 成交量分布密集区支撑压力          | implemented-variant | 量价                | trading-strategies/research/volume     | 量价规则/过滤组件   |
| VP-chips-overhang                  | 套牢盘与获利盘位置过滤            | implemented-variant | 量价                | trading-strategies/research/volume     | 量价规则/过滤组件   |
| VP-large-money-confirm             | 大单超大单净流入辅助确认          | implemented-variant | 量价                | trading-strategies/research/volume     | 量价规则/过滤组件   |
| VP-multi-timeframe                 | 大周期方向与小周期择时            | implemented-variant | 量价                | trading-strategies/research/volume     | 量价规则/过滤组件   |
| VP-limit-orderbook                 | 一字板改用封单与开板次数          | implemented-variant | 量价                | trading-strategies/research/volume     | 量价规则/过滤组件   |
| VP-limit-reseal                    | 换手回封与一字板后续对照          | implemented-variant | 量价                | trading-strategies/research/volume     | 量价规则/过滤组件   |
| VP-limit-roundtrip                 | 天地板地天板的极端情绪过滤        | implemented-variant | 量价                | trading-strategies/research/volume     | 量价规则/过滤组件   |
| VP-limit-sequence                  | 首板放量中继换手加速缩量          | implemented-variant | 量价                | trading-strategies/research/volume     | 量价规则/过滤组件   |
| VP-limit-failed-wick               | 炸板后放量长上影派发              | implemented-variant | 量价                | trading-strategies/research/volume     | 量价规则/过滤组件   |
| VP-settlement-by-market            | 量价交易按市场结算与回转约束      | implemented-variant | 量价                | trading-strategies/research/volume     | 量价规则/过滤组件   |
| VP-float-break                     | 定增限售解禁的浮筹可比性断裂      | implemented-variant | 量价                | trading-strategies/research/volume     | 量价规则/过滤组件   |
| VP-block-volume-remove             | 大宗过户污染核对与剔除            | implemented-variant | 量价                | trading-strategies/research/volume     | 量价规则/过滤组件   |
| VP-index-etf-auction               | 指数调整ETF申赎尾盘巨量排除       | implemented-variant | 量价                | trading-strategies/research/volume     | 量价规则/过滤组件   |
| VP-ipo-own-history                 | 上市60日内相对自身量能            | implemented-variant | 量价                | trading-strategies/research/volume     | 量价规则/过滤组件   |
| VP-resumption-calendar             | 复牌首周独立处理与正常化          | implemented-variant | 量价                | trading-strategies/research/volume     | 量价规则/过滤组件   |
| VP-fake-order-shape                | 规整挂单与疑似对倒过滤            | implemented-variant | 量价                | trading-strategies/research/volume     | 量价规则/过滤组件   |
| VP-fake-trade-size                 | 成交笔数与量不匹配过滤            | implemented-variant | 量价                | trading-strategies/research/volume     | 量价规则/过滤组件   |
| VP-isolated-news                   | 孤量消息支撑与真实性复核          | implemented-variant | 量价                | trading-strategies/research/volume     | 量价规则/过滤组件   |
| VP-event-lhb                       | 龙虎榜游资量能持续性过滤          | implemented-variant | 量价                | trading-strategies/research/volume     | 量价规则/过滤组件   |
| VP-event-unlock                    | 限售解禁首日供给冲击              | implemented-variant | 量价                | trading-strategies/research/volume     | 量价规则/过滤组件   |
| VP-event-merger                    | 重组并购后历史形态降权            | implemented-variant | 量价                | trading-strategies/research/volume     | 量价规则/过滤组件   |
| VP-event-index                     | 指数纳入剔除的一次性买卖          | implemented-variant | 量价                | trading-strategies/research/volume     | 量价规则/过滤组件   |
| VP-event-seasonal                  | 季末年末调仓量能异常              | implemented-variant | 量价                | trading-strategies/research/volume     | 量价规则/过滤组件   |
| VP-pollution-sequence              | 六步量能失真排查组合              | implemented-variant | 量价                | trading-strategies/research/volume     | 量价规则/过滤组件   |
| VP-structure-up-v1                 | 已确认高低点递升突破工程版        | implemented-variant | 量价                | trading-strategies/research/volume     | 量价规则/过滤组件   |
| VP-structure-range-v1              | 两次触边区间突破工程版            | implemented-variant | 量价                | trading-strategies/research/volume     | 量价规则/过滤组件   |
| VP-retest-1-v1                     | 结构突破次根回踩工程版            | implemented-variant | 量价                | trading-strategies/research/volume     | 量价规则/过滤组件   |
| VP-retest-5-v1                     | 结构突破五根内回踩工程版          | implemented-variant | 量价                | trading-strategies/research/volume     | 量价规则/过滤组件   |
| SW01-double-down                   | 双向三要素的持仓退出              | implemented-variant | 趋势/突破与技术共振 | trading-strategies/research/swing            | 规则/入场/管理组件  |
| SW01-strength-size                 | 三要素强中信号分级仓位            | implemented-variant | 趋势/突破与技术共振 | trading-strategies/research/swing            | 规则/入场/管理组件  |
| SW01-weak-retest                   | 量能不足双突破等待回踩            | implemented-variant | 趋势/突破与技术共振 | trading-strategies/research/swing            | 规则/入场/管理组件  |
| SW01-line-touch                    | 第三触点趋势线确认                | implemented-variant | 趋势/突破与技术共振 | trading-strategies/research/swing            | 规则/入场/管理组件  |
| SW01-line-span                     | 至少20交易日趋势线质量            | implemented-variant | 趋势/突破与技术共振 | trading-strategies/research/swing            | 规则/入场/管理组件  |
| SW01-line-angle                    | 30至60度趋势线质量                | implemented-variant | 趋势/突破与技术共振 | trading-strategies/research/swing            | 规则/入场/管理组件  |
| SW01-long-body                     | 放量长实体突破质量                | implemented-variant | 趋势/突破与技术共振 | trading-strategies/research/swing            | 规则/入场/管理组件  |
| SW03-swing-level                   | 波段高低点价位组件                | implemented-variant | 趋势/突破与技术共振 | trading-strategies/research/swing            | 规则/入场/管理组件  |
| SW03-platform-level                | 缩量平台上下沿组件                | implemented-variant | 趋势/突破与技术共振 | trading-strategies/research/swing            | 规则/入场/管理组件  |
| SW03-large-close-level             | 放量大阴阳收盘价组件              | implemented-variant | 趋势/突破与技术共振 | trading-strategies/research/swing            | 规则/入场/管理组件  |
| SW03-round-level                   | 整数心理价位组件                  | implemented-variant | 趋势/突破与技术共振 | trading-strategies/research/swing            | 规则/入场/管理组件  |
| SW03-average-level                 | 指定均线支撑压力候选              | implemented-variant | 趋势/突破与技术共振 | trading-strategies/research/swing            | 规则/入场/管理组件  |
| SW03-gap-level                     | 前期跳空上下沿价位                | implemented-variant | 趋势/突破与技术共振 | trading-strategies/research/swing            | 规则/入场/管理组件  |
| SW03-level-priority                | 支撑压力来源强弱排序              | implemented-variant | 趋势/突破与技术共振 | trading-strategies/research/swing            | 规则/入场/管理组件  |
| SW11-market-ma20                   | 大盘MA20方向与价格环境            | implemented-variant | 趋势/突破与技术共振 | trading-strategies/research/swing            | 规则/入场/管理组件  |
| SW11-market-chop                   | 大盘反复穿越MA20禁入              | implemented-variant | 趋势/突破与技术共振 | trading-strategies/research/swing            | 规则/入场/管理组件  |
| SW11-market-boll                   | 大盘布林收口方向过滤              | implemented-variant | 趋势/突破与技术共振 | trading-strategies/research/swing            | 规则/入场/管理组件  |
| SW11-breadth-neutral               | 连续三日中性涨跌比禁入            | implemented-variant | 趋势/突破与技术共振 | trading-strategies/research/swing            | 规则/入场/管理组件  |
| SW11-market-macd                   | 大盘MACD环境输入                  | implemented-variant | 趋势/突破与技术共振 | trading-strategies/research/swing            | 规则/入场/管理组件  |
| SW11-market-volume                 | 大盘量价环境输入                  | implemented-variant | 趋势/突破与技术共振 | trading-strategies/research/swing            | 规则/入场/管理组件  |
| SW11-event-window                  | 预告重大事件前禁入                | implemented-variant | 趋势/突破与技术共振 | trading-strategies/research/swing            | 规则/入场/管理组件  |
| SW02-last30                        | 突破日最后半小时入场              | implemented-variant | 趋势/突破与技术共振 | trading-strategies/research/swing            | 规则/入场/管理组件  |
| SW06-r1-r2-exit                    | 1R与2R各减三分之一                | implemented-variant | 趋势/突破与技术共振 | trading-strategies/research/swing            | 规则/入场/管理组件  |
| SW06-prior-target-tail             | 回撤前目标位退出尾仓              | implemented-variant | 趋势/突破与技术共振 | trading-strategies/research/swing            | 规则/入场/管理组件  |
| SW06-reverse-line-exit             | 趋势线反向突破全退出              | implemented-variant | 趋势/突破与技术共振 | trading-strategies/research/swing            | 规则/入场/管理组件  |
| SW06-fixed-stop-2-3                | 波段2%与3%止损组合                | implemented-variant | 趋势/突破与技术共振 | trading-strategies/research/swing            | 规则/入场/管理组件  |
| SW11-risk-cap3                     | 单笔3%风险预算及超限记录          | implemented-variant | 趋势/突破与技术共振 | trading-strategies/research/swing            | 规则/入场/管理组件  |
| SW11-stop-required                 | 无有效止损禁止新建仓              | implemented-variant | 趋势/突破与技术共振 | trading-strategies/research/swing            | 规则/入场/管理组件  |
| SW11-no-average                    | 亏损头寸禁止追加                  | implemented-variant | 趋势/突破与技术共振 | trading-strategies/research/swing            | 规则/入场/管理组件  |
| SW11-three-loss-pause              | 连续三笔亏损暂停1或2日            | implemented-variant | 趋势/突破与技术共振 | trading-strategies/research/swing            | 规则/入场/管理组件  |
| SW11-min-rr2                       | 最低两倍风险回报准入              | implemented-variant | 趋势/突破与技术共振 | trading-strategies/research/swing            | 规则/入场/管理组件  |
| SW11-emotion-gate                  | 人工情绪状态交易开关              | implemented-variant | 趋势/突破与技术共振 | trading-strategies/research/swing            | 规则/入场/管理组件  |
| SW06-divergence-confirm            | 背离的其他指标确认                | implemented-variant | 趋势/突破与技术共振 | trading-strategies/research/swing            | 规则/入场/管理组件  |
| SW10-bear-alignment                | 四均线空头排列退出                | implemented-variant | 趋势/突破与技术共振 | trading-strategies/research/swing            | 规则/入场/管理组件  |
| SW10-tangle-filter                 | 均线交织震荡观望                  | implemented-variant | 趋势/突破与技术共振 | trading-strategies/research/swing            | 规则/入场/管理组件  |
| SW-P-risk2                         | 波段2%风险与30%单股组合           | implemented-variant | 趋势/突破与技术共振 | trading-strategies/research/swing            | 规则/入场/管理组件  |
| SW-P-stop5                         | 初始止损距离超过5%禁入            | implemented-variant | 趋势/突破与技术共振 | trading-strategies/research/swing            | 规则/入场/管理组件  |
| SW-P-three-positions               | 波段最多同时三只持仓              | implemented-variant | 趋势/突破与技术共振 | trading-strategies/research/swing            | 规则/入场/管理组件  |
| SW-P-total60                       | 波段总仓60%留现金                 | implemented-variant | 趋势/突破与技术共振 | trading-strategies/research/swing            | 规则/入场/管理组件  |
| SW-P-market-cap                    | 强中弱环境60%与30%仓位            | implemented-variant | 趋势/突破与技术共振 | trading-strategies/research/swing            | 规则/入场/管理组件  |
| SW-P-news-exit                     | 重大利空及利好兑现退出            | implemented-variant | 趋势/突破与技术共振 | trading-strategies/research/swing            | 规则/入场/管理组件  |
| SW-P-time5                         | 五交易日无进展退出组合            | implemented-variant | 趋势/突破与技术共振 | trading-strategies/research/swing            | 规则/入场/管理组件  |
| SW-P-win45                         | 历史类似形态胜率45%准入           | implemented-variant | 趋势/突破与技术共振 | trading-strategies/research/swing            | 规则/入场/管理组件  |
| SW-P-expect-positive               | 正期望准入                        | implemented-variant | 趋势/突破与技术共振 | trading-strategies/research/swing            | 规则/入场/管理组件  |
| SW-P-quality3                      | 五类信号至少三分准入              | implemented-variant | 趋势/突破与技术共振 | trading-strategies/research/swing            | 规则/入场/管理组件  |
| SW-P-expect-size                   | 期望值分档标准与半仓              | implemented-variant | 趋势/突破与技术共振 | trading-strategies/research/swing            | 规则/入场/管理组件  |
| SW-P-example-50-2                  | 50%胜率与2R期望示例               | implemented-variant | 趋势/突破与技术共振 | trading-strategies/research/swing            | 规则/入场/管理组件  |
| SW-P-example-40-3                  | 40%胜率与3R期望示例               | implemented-variant | 趋势/突破与技术共振 | trading-strategies/research/swing            | 规则/入场/管理组件  |
| SW-P-example-60-1                  | 60%胜率与1R边际示例               | implemented-variant | 趋势/突破与技术共振 | trading-strategies/research/swing            | 规则/入场/管理组件  |
| SW-P-kelly30                       | 波段风险与半凯利取小              | implemented-variant | 趋势/突破与技术共振 | trading-strategies/research/swing            | 规则/入场/管理组件  |
| SW-P-month-win                     | 连续两月胜率低于35%暂停           | implemented-variant | 趋势/突破与技术共振 | trading-strategies/research/swing            | 规则/入场/管理组件  |
| SW-P-month-rr                      | 连续两月收益风险比低于1.5暂停     | implemented-variant | 趋势/突破与技术共振 | trading-strategies/research/swing            | 规则/入场/管理组件  |
| SW-P-month-negative3               | 连续三月负收益暂停                | implemented-variant | 趋势/突破与技术共振 | trading-strategies/research/swing            | 规则/入场/管理组件  |
| SW-P-day5-week                     | 单日亏损超过5%暂停至少一周        | implemented-variant | 趋势/突破与技术共振 | trading-strategies/research/swing            | 规则/入场/管理组件  |
| SW-P-loss5-week                    | 连续五笔亏损暂停至少一周          | implemented-variant | 趋势/突破与技术共振 | trading-strategies/research/swing            | 规则/入场/管理组件  |
| SW-P-emotion-week                  | 情绪失控暂停至少一周              | implemented-variant | 趋势/突破与技术共振 | trading-strategies/research/swing            | 规则/入场/管理组件  |
| SW-P-discipline-week               | 纪律违规暂停至少一周              | implemented-variant | 趋势/突破与技术共振 | trading-strategies/research/swing            | 规则/入场/管理组件  |
| SW-P-dd15-week                     | 回撤超过15%暂停至少一周           | implemented-variant | 趋势/突破与技术共振 | trading-strategies/research/swing            | 规则/入场/管理组件  |
| SW-P-preflight                     | 波段交易前联合检查                | implemented-variant | 趋势/突破与技术共振 | trading-strategies/research/swing            | 规则/入场/管理组件  |
| SW-P-review                        | 波段逐笔复盘与月度研究记录        | implemented-variant | 趋势/突破与技术共振 | trading-strategies/research/swing            | 规则/入场/管理组件  |
| RK-V2-mid                          | 布林中轨退出                      | implemented-variant | 风险控制            | risk                        | 风控组件            |
| RK-V3-mid                          | Keltner中线退出                   | implemented-variant | 风险控制            | risk                        | 风控组件            |
| RK-V3-opposite                     | Keltner对侧轨退出                 | implemented-variant | 风险控制            | risk                        | 风控组件            |
| RK-V4-stages                       | Kase预警及三级减仓                | implemented-variant | 风险控制            | risk                        | 风控组件            |
| RK-V-structure-farther             | 波动线与结构位取更远者            | implemented-variant | 风险控制            | risk                        | 风控组件            |
| RK-A1-atr-bands                    | ATR价格比分档百分比止损           | implemented-variant | 风险控制            | risk                        | 风控组件            |
| RK-A3-atr-buffer                   | 结构位ATR缓冲                     | implemented-variant | 风险控制            | risk                        | 风控组件            |
| RK-A3-distance2atr                 | 结构止损超过2ATR放弃入场          | implemented-variant | 风险控制            | risk                        | 风控组件            |
| RK-A4-ema20                        | EMA20收盘止损                     | implemented-variant | 风险控制            | risk                        | 风控组件            |
| RK-A4-ma60                         | MA60收盘止损                      | implemented-variant | 风险控制            | risk                        | 风控组件            |
| RK-A4-ma120                        | MA120收盘止损                     | implemented-variant | 风险控制            | risk                        | 风控组件            |
| RK-A4-chan-line                    | 缠论结构线止损                    | implemented-variant | 风险控制            | risk                        | 风控组件            |
| RK-A4-respect                      | 历史沿指标线有效性准入            | implemented-variant | 风险控制            | risk                        | 风控组件            |
| RK-E-sector-risk                   | 同板块高相关合并风险              | implemented-variant | 风险控制            | risk                        | 风控组件            |
| RK-E-week3r                        | 单周亏损3R停手                    | implemented-variant | 风险控制            | risk                        | 风控组件            |
| RK-E-elder2-6                      | Elder单笔2%月回撤6%组合           | implemented-variant | 风险控制            | risk                        | 风控组件            |
| RK-F-no-single-stop                | 均值回归取消单笔止损对照          | implemented-variant | 风险控制            | risk                        | 风控组件            |
| RK-F-event-reduce                  | 重大事件前减仓对照                | implemented-variant | 风险控制            | risk                        | 风控组件            |
| RK-C-swing-system                  | 止损手册波段完整组合              | implemented-variant | 风险控制            | risk                        | 风控组件            |
| RK-D6-half2r                       | 2R减半抬1R及吊灯尾仓              | implemented-variant | 风险控制            | risk                        | 风控组件            |
| RK-D5-time10                       | 10日无进展退出                    | implemented-variant | 风险控制            | risk                        | 风控组件            |
| RK-MAE-q80                         | 盈利交易MAE80分位校准             | implemented-variant | 风险控制            | risk                        | 风控组件            |
| RK-MAE-q90                         | 盈利交易MAE90分位校准             | implemented-variant | 风险控制            | risk                        | 风控组件            |
| RK-MAE-q50                         | MAE50分位紧止损对照               | implemented-variant | 风险控制            | risk                        | 风控组件            |
| RK-MAE-q100                        | MAE100分位宽止损对照              | implemented-variant | 风险控制            | risk                        | 风控组件            |
| RK-MAE-widen-resize                | 止损后反弹诊断放宽并减仓          | implemented-variant | 风险控制            | risk                        | 风控组件            |
| RK-MAE-tighten-resize              | 盈利MAE近零诊断收紧并增仓         | implemented-variant | 风险控制            | risk                        | 风控组件            |
| RK-MAE-overlap                     | 盈亏MAE重叠诊断停调参             | implemented-variant | 风险控制            | risk                        | 风控组件            |
| RK-MAE-mfe-tail                    | MFE利润回吐退出对照               | implemented-variant | 风险控制            | risk                        | 风控组件            |
| RK-MAE-regime                      | 按波动分位指数趋势分组校准        | implemented-variant | 风险控制            | risk                        | 风控组件            |
| RK-MAE-cycle100                    | 每100笔训练后再验证100笔          | implemented-variant | 风险控制            | risk                        | 风控组件            |
| RK-MAE-emotion20                   | 情绪退出超20%纪律诊断             | implemented-variant | 风险控制            | risk                        | 风控组件            |
| RK-C-risk-tiers                    | 风险比例五档对照                  | implemented-variant | 风险控制            | risk                        | 风控组件            |
| RK-C-hard2                         | 单笔风险2%硬上限                  | implemented-variant | 风险控制            | risk                        | 风控组件            |
| RK-C-current-equity                | 当前权益反推风险仓位              | implemented-variant | 风险控制            | risk                        | 风控组件            |
| RK-C-weight15-20                   | 单股15%与20%市值上限              | implemented-variant | 风险控制            | risk                        | 风控组件            |
| RK-C-total-risk4-6                 | 组合在险金额4%与6%上限            | implemented-variant | 风险控制            | risk                        | 风控组件            |
| RK-C-expect02                      | 期望值大于0.2R才放大仓位          | implemented-variant | 风险控制            | risk                        | 风控组件            |
| RK-C-sizing-three                  | 风险市值容量三重仓位组合          | implemented-variant | 风险控制            | risk                        | 风控组件            |
| RK-A-explicit                      | 显式绝对止损覆盖推荐              | implemented-variant | 风险控制            | risk                        | 风控组件            |
| RK-A-buffer-auto                   | 结构缓冲按ATR可用性切换           | implemented-variant | 风险控制            | risk                        | 风控组件            |
| RK-C-slip-report                   | 仅报告滑点风险的原脚本对照        | implemented-variant | 风险控制            | risk                        | 风控组件            |
| RK-C-rr2                           | 目标盈亏比2倍准入及统计例外       | implemented-variant | 风险控制            | risk                        | 风控组件            |
| RK-D-script-r                      | 脚本1R保本与2R减半抬1R组合        | implemented-variant | 风险控制            | risk                        | 风控组件            |
| RK-F-short-script                  | 脚本做空对称止损与R管理           | implemented-variant | 风险控制            | risk                        | 风控组件            |
| RK-X-market-stop                   | 触发后市价型止损                  | implemented-variant | 风险控制            | risk                        | 风控组件            |
| RK-X-stop-limit1                   | 触发价下方1%止损限价              | implemented-variant | 风险控制            | risk                        | 风控组件            |
| RK-X-profit-limit                  | 止盈限价执行                      | implemented-variant | 风险控制            | risk                        | 风控组件            |
| RK-X-manual                        | 人工止损触发时点回放              | implemented-variant | 风险控制            | risk                        | 风控组件            |
| RK-X-conditional                   | 条件单有效时段约束                | implemented-variant | 风险控制            | risk                        | 风控组件            |
| RK-X-t0-old                        | 底仓卖旧买新回转                  | implemented-variant | 风险控制            | risk                        | 风控组件            |
| RK-X-gap10                         | 入场价下方10%跳空预算             | implemented-variant | 风险控制            | risk                        | 风控组件            |
| RK-X-limit-news                    | 跌停伴利空优先退出                | implemented-variant | 风险控制            | risk                        | 风控组件            |
| RK-X-limit-budget                  | 一个跌停损失约束仓位              | implemented-variant | 风险控制            | risk                        | 风控组件            |
| RK-X-halt-cap                      | 已知停牌重组风险降仓上限          | implemented-variant | 风险控制            | risk                        | 风控组件            |
| RK-X-auction-queue                 | 一字跌停后下一竞价排队            | implemented-variant | 风险控制            | risk                        | 风控组件            |
| RK-X-event5                        | 未来5交易日已知事件检查           | implemented-variant | 风险控制            | risk                        | 风控组件            |
| RK-D2-compare                      | 不保本与0.3R及0.5R和1R保本对照    | implemented-variant | 风险控制            | risk                        | 风控组件            |
| RK-D-cycle-switch                  | 预先约定换周期扩止损减仓          | implemented-variant | 风险控制            | risk                        | 风控组件            |
| RK-D-target23                      | 固定2R与3R完整退出                | implemented-variant | 风险控制            | risk                        | 风控组件            |
| RK-D-trend-exit                    | 取消固定目标仅跟随退出            | implemented-variant | 风险控制            | risk                        | 风控组件            |
| RK-D-half-tail                     | 半仓2R兑现与半仓跟随              | implemented-variant | 风险控制            | risk                        | 风控组件            |
| RK-D-add-repair                    | 加仓超风险后的抬线或减仓修复      | implemented-variant | 风险控制            | risk                        | 风控组件            |
| RK-C-kelly-quarter                 | 四分之一凯利独立对照              | implemented-variant | 风险控制            | risk                        | 风控组件            |
| RK-C-kelly-p30                     | 30笔同策略实测胜率                | implemented-variant | 风险控制            | risk                        | 风控组件            |
| RK-C-kelly-quality                 | 信号质量代理凯利                  | implemented-variant | 风险控制            | risk                        | 风控组件            |
| RK-C-kelly-switch30                | 30笔门槛切换凯利参数源            | implemented-variant | 风险控制            | risk                        | 风控组件            |
| RK-C-kelly-uncertain               | 参数不稳定或肥尾时压缩凯利        | implemented-variant | 风险控制            | risk                        | 风控组件            |
| CA-K-kelly25                       | CANSLIM风险与凯利25%组合          | implemented-variant | CANSLIM成长         | trading-strategies/research/canslim           | 选股/评分/形态/管理 |
| SE-K-kelly                         | SEPA枢纽目标凯利组合              | implemented-variant | SEPA成长            | trading-strategies/research/canslim           | 趋势模板/VCP/管理   |
| RK-A-earliest                      | 多止损逻辑取最早离场              | implemented-variant | 风险控制            | risk                        | 风控组件            |
| RK-A-breakout-upper                | 突破后平台上沿下方止损            | implemented-variant | 风险控制            | risk                        | 风控组件            |
| RK-A-breakout-candle               | 突破K线低点止损                   | implemented-variant | 风险控制            | risk                        | 风控组件            |
| RK-A-intraday-time                 | 日内动量结构与时间止损组合        | implemented-variant | 风险控制            | risk                        | 风控组件            |
| RK-A-thesis-disaster               | 中长线逻辑证伪与灾难兜底组合      | implemented-variant | 风险控制            | risk                        | 风控组件            |
| RK-A-crowded-buffer                | 整数关口和明显前低缓冲对照        | implemented-variant | 风险控制            | risk                        | 风控组件            |
| RK-A-stop-diagnosis                | 频繁止损的入场延迟与周期匹配诊断  | implemented-variant | 风险控制            | risk                        | 风控组件            |
| RK-A-scenario-routing              | 八场景止损方案路由与备选对照      | implemented-variant | 风险控制            | risk                        | 风控组件            |
| RK-C-held-risk-repair              | 既有持仓超风险后减仓修复          | implemented-variant | 风险控制            | risk                        | 风控组件            |
| RK-E-chop-frequency                | 频繁止损遇震荡后降频或停手        | implemented-variant | 风险控制            | risk                        | 风控组件            |
| RK-D-fresh-entry-exit              | 空仓重新评估不再愿买则离场        | implemented-variant | 风险控制            | risk                        | 风控组件            |
| RK-A-atr10-20                      | ATR10与ATR20止损周期对照          | implemented-variant | 风险控制            | risk                        | 风控组件            |
| SE-E-five                          | SEPA五步入场组合                  | implemented-variant | SEPA成长            | trading-strategies/research/canslim           | 趋势模板/VCP/管理   |
| SE-E-volume-levels                 | SEPA突破量能三档对照              | implemented         | SEPA成长            | trading-strategies/research/canslim           | 趋势模板/VCP/管理   |
| SE-E-intraday50                    | SEPA盘中半仓与收盘补足            | implemented-variant | SEPA成长            | trading-strategies/research/canslim           | 趋势模板/VCP/管理   |
| SE-E-close                         | SEPA收盘确认后开盘入场            | implemented         | SEPA成长            | trading-strategies/research/canslim           | 趋势模板/VCP/管理   |
| SE-R-min                           | SEPA原始MIN止损公式对照           | implemented-variant | SEPA成长            | trading-strategies/research/canslim           | 趋势模板/VCP/管理   |
| SE-R-max                           | SEPA较高价止损文字版本            | implemented-variant | SEPA成长            | trading-strategies/research/canslim           | 趋势模板/VCP/管理   |
| SE-R-min-cap                       | SEPA先MIN再按10%修正示例          | implemented         | SEPA成长            | trading-strategies/research/canslim           | 趋势模板/VCP/管理   |
| SE-D-be15                          | SEPA盈利15%后保本                 | implemented         | SEPA成长            | trading-strategies/research/canslim           | 趋势模板/VCP/管理   |
| SE-D-review23                      | SEPA两三周不足5%复核              | implemented-variant | SEPA成长            | trading-strategies/research/canslim           | 趋势模板/VCP/管理   |
| SE-D-time4                         | SEPA四周不足10%退出               | implemented         | SEPA成长            | trading-strategies/research/canslim           | 趋势模板/VCP/管理   |
| SE-D-bear4                         | SEPA跌超4%放量退出                | implemented         | SEPA成长            | trading-strategies/research/canslim           | 趋势模板/VCP/管理   |
| SE-D-targets                       | SEPA百分比目标与3倍回报准入       | implemented-variant | SEPA成长            | trading-strategies/research/canslim           | 趋势模板/VCP/管理   |
| SE-D-partial2030                   | SEPA20%与30%各减三分之一          | implemented-variant | SEPA成长            | trading-strategies/research/canslim           | 趋势模板/VCP/管理   |
| SE-D-gapup3                        | SEPA次日高开3%保本                | implemented-variant | SEPA成长            | trading-strategies/research/canslim           | 趋势模板/VCP/管理   |
| SE-D-gapdown3                      | SEPA次日低开3%减半再确认          | implemented-variant | SEPA成长            | trading-strategies/research/canslim           | 趋势模板/VCP/管理   |
| SE-E-volume50                      | SEPA50日均量突破约束              | implemented         | SEPA成长            | trading-strategies/research/canslim           | 趋势模板/VCP/管理   |
| SE-E-earnings13                    | SEPA财报后一至三日入场            | implemented-variant | SEPA成长            | trading-strategies/research/canslim           | 趋势模板/VCP/管理   |
| SE-P-tplus                         | SEPA1.5%25%三至五只组合           | implemented-variant | SEPA成长            | trading-strategies/research/canslim           | 趋势模板/VCP/管理   |
| SE-P-standard                      | SEPA2%30%五至八只对照             | implemented-variant | SEPA成长            | trading-strategies/research/canslim           | 趋势模板/VCP/管理   |
| SE-E-exclusions                    | SEPA不适用品种过滤                | implemented-variant | SEPA成长            | trading-strategies/research/canslim           | 趋势模板/VCP/管理   |
| SE-E-checklist                     | SEPA全项纪律准入版本              | implemented-variant | SEPA成长            | trading-strategies/research/canslim           | 趋势模板/VCP/管理   |
| SE-K-quality                       | SEPA两道门与VCP质量凯利           | implemented-variant | SEPA成长            | trading-strategies/research/canslim           | 趋势模板/VCP/管理   |
| RK-C-kelly-direct                  | 显式胜率优先的凯利实验            | implemented-variant | 风险控制            | risk                        | 风控组件            |
| RK-C-kelly-realized-b              | 实测平均盈亏比凯利对照            | implemented-variant | 风险控制            | risk                        | 风控组件            |
| RK-C-kelly-fraction                | 参数化分数与全凯利对照            | implemented-variant | 风险控制            | risk                        | 风控组件            |
| RK-C-kelly-market-gate             | 凯利正值仍服从熊市派发禁入        | implemented-variant | 风险控制            | risk                        | 风控组件            |
| CA-K-quality                       | CANSLIM质量代理凯利               | implemented-variant | CANSLIM成长         | trading-strategies/research/canslim           | 选股/评分/形态/管理 |
| WY-K-quality                       | 威科夫结构质量代理凯利            | implemented-variant | 威科夫              | trading-strategies/research/wyckoff          | 结构规则/研究       |
| SE-K-script-quality                | SEPA脚本放量质量凯利              | implemented-variant | SEPA成长            | trading-strategies/research/canslim           | 趋势模板/VCP/管理   |
| CA-E-five                          | 五步入场三态清单                  | implemented-variant | CANSLIM成长         | trading-strategies/research/canslim           | 选股/评分/形态/管理 |
| CA-E-rs80                          | 相对强度80准入                    | implemented-variant | CANSLIM成长         | trading-strategies/research/canslim           | 选股/评分/形态/管理 |
| CA-E-markettrend                   | 大盘确认上升趋势准入              | implemented-variant | CANSLIM成长         | trading-strategies/research/canslim           | 选股/评分/形态/管理 |
| CA-E-catalyst                      | 近期催化加分准入                  | implemented-variant | CANSLIM成长         | trading-strategies/research/canslim           | 选股/评分/形态/管理 |
| CA-R-eight                         | 入场价8%固定止损                  | implemented-variant | CANSLIM成长         | trading-strategies/research/canslim           | 选股/评分/形态/管理 |
| CA-R-pivot-max                     | 入场枢纽较高价8%止损              | implemented-variant | CANSLIM成长         | trading-strategies/research/canslim           | 选股/评分/形态/管理 |
| CA-D-target-cost                   | 20%减半抬成本及25%清仓            | implemented-variant | CANSLIM成长         | trading-strategies/research/canslim           | 选股/评分/形态/管理 |
| CA-D-target-plus10                 | 20%减半抬10%及25%清仓             | implemented-variant | CANSLIM成长         | trading-strategies/research/canslim           | 选股/评分/形态/管理 |
| CA-D-be15                          | 盈利15%保本                       | implemented-variant | CANSLIM成长         | trading-strategies/research/canslim           | 选股/评分/形态/管理 |
| CA-D-volume-sell                   | 明显放量下跌减仓                  | implemented-variant | CANSLIM成长         | trading-strategies/research/canslim           | 选股/评分/形态/管理 |
| CA-D-distribution5                 | 连续至少五分布日降仓              | implemented-variant | CANSLIM成长         | trading-strategies/research/canslim           | 选股/评分/形态/管理 |
| CA-D-weekly10                      | 周线跌破10MA减半                  | implemented-variant | CANSLIM成长         | trading-strategies/research/canslim           | 选股/评分/形态/管理 |
| CA-D-time4                         | 四周涨幅不足5%退出                | implemented-variant | CANSLIM成长         | trading-strategies/research/canslim           | 选股/评分/形态/管理 |
| CA-P-risk1525                      | 单笔1.5%风险与25%市值             | implemented-variant | CANSLIM成长         | trading-strategies/research/canslim           | 选股/评分/形态/管理 |
| CA-P-full                          | 高确认一次性目标仓位              | implemented-variant | CANSLIM成长         | trading-strategies/research/canslim           | 选股/评分/形态/管理 |
| CA-P-add23                         | 50%首仓上涨2至3%确认补仓          | implemented-variant | CANSLIM成长         | trading-strategies/research/canslim           | 选股/评分/形态/管理 |
| CA-D-gapup3                        | 次日高开超3%保本                  | implemented-variant | CANSLIM成长         | trading-strategies/research/canslim           | 选股/评分/形态/管理 |
| CA-D-gapdown3                      | 次日低开超3%减半                  | implemented-variant | CANSLIM成长         | trading-strategies/research/canslim           | 选股/评分/形态/管理 |
| CA-D-bear4                         | 放量跌超4%次日清仓                | implemented-variant | CANSLIM成长         | trading-strategies/research/canslim           | 选股/评分/形态/管理 |
| CA-E-earnings5                     | 财报前五交易日禁入                | implemented-variant | CANSLIM成长         | trading-strategies/research/canslim           | 选股/评分/形态/管理 |
| CA-E-cooldown                      | 止损后同股冷静期                  | implemented-variant | CANSLIM成长         | trading-strategies/research/canslim           | 选股/评分/形态/管理 |
| CA-E-reward25                      | 第一目标回报倍数至少2.5           | implemented-variant | CANSLIM成长         | trading-strategies/research/canslim           | 选股/评分/形态/管理 |
| CA-E-m6                            | M因子小于6禁入                    | implemented-variant | CANSLIM成长         | trading-strategies/research/canslim           | 选股/评分/形态/管理 |
| CA-D-review1430                    | 每日1430异常复核次日减仓          | implemented-variant | CANSLIM成长         | trading-strategies/research/canslim           | 选股/评分/形态/管理 |
| CA-E-exclusions                    | 预设止损ST涨停等完整入场门槛      | implemented-variant | CANSLIM成长         | trading-strategies/research/canslim           | 选股/评分/形态/管理 |
| CA-T-cup-u                         | U形杯柄独立预设                   | implemented-variant | CANSLIM成长         | trading-strategies/research/canslim           | 选股/评分/形态/管理 |
| CA-T-cup-w                         | W形杯柄独立预设                   | implemented-variant | CANSLIM成长         | trading-strategies/research/canslim           | 选股/评分/形态/管理 |
| CA-T-cup-v                         | V形杯柄低评分对照                 | implemented-variant | CANSLIM成长         | trading-strategies/research/canslim           | 选股/评分/形态/管理 |
| CA-T-handle-third                  | 柄回调不超过杯深三分之一          | implemented         | CANSLIM成长         | trading-strategies/research/canslim           | 选股/评分/形态/管理 |
| CA-T-handle-half                   | 柄回调二分之一低评分对照          | implemented-variant | CANSLIM成长         | trading-strategies/research/canslim           | 选股/评分/形态/管理 |
| CA-T-cup-score6                    | 杯柄五项十分制至少六分            | implemented-variant | CANSLIM成长         | trading-strategies/research/canslim           | 选股/评分/形态/管理 |
| CA-T-rim                           | 杯沿等高及右沿略低                | implemented-variant | CANSLIM成长         | trading-strategies/research/canslim           | 选股/评分/形态/管理 |
| CA-T-flat-score6                   | 平台整理十分制至少六分            | implemented-variant | CANSLIM成长         | trading-strategies/research/canslim           | 选股/评分/形态/管理 |
| CA-T-saucer-u                      | 圆弧碟形十分制至少六分            | implemented-variant | CANSLIM成长         | trading-strategies/research/canslim           | 选股/评分/形态/管理 |
| CA-T-saucer-w                      | W形碟形低评分对照                 | implemented-variant | CANSLIM成长         | trading-strategies/research/canslim           | 选股/评分/形态/管理 |
| CA-T-priority                      | 杯柄平台碟形确定性优先级          | implemented-variant | CANSLIM成长         | trading-strategies/research/canslim           | 选股/评分/形态/管理 |
| CA-T-hold3                         | 突破后三交易日维持确认            | implemented-variant | CANSLIM成长         | trading-strategies/research/canslim           | 选股/评分/形态/管理 |
| CA-T-fail3                         | 突破后三日回落失败退出            | implemented-variant | CANSLIM成长         | trading-strategies/research/canslim           | 选股/评分/形态/管理 |
| CA-T-volume-wait                   | 无量突破等待确认                  | implemented-variant | CANSLIM成长         | trading-strategies/research/canslim           | 选股/评分/形态/管理 |
| CA-T-sector                        | 板块配合形态过滤                  | implemented-variant | CANSLIM成长         | trading-strategies/research/canslim           | 选股/评分/形态/管理 |
| CA-T-smallcap                      | 中小盘游资影响对照                | implemented-variant | CANSLIM成长         | trading-strategies/research/canslim           | 选股/评分/形态/管理 |
| CA-T-earnings-window               | 财报前后形态谨慎对照              | implemented-variant | CANSLIM成长         | trading-strategies/research/canslim           | 选股/评分/形态/管理 |
| CA-S-C1                            | C1 季度盈利                       | implemented-variant | CANSLIM成长         | trading-strategies/research/canslim           | 选股/评分/形态/管理 |
| CA-S-C2                            | C2 盈利加速                       | implemented-variant | CANSLIM成长         | trading-strategies/research/canslim           | 选股/评分/形态/管理 |
| CA-S-C3                            | C3 营收                           | implemented-variant | CANSLIM成长         | trading-strategies/research/canslim           | 选股/评分/形态/管理 |
| CA-S-A1                            | A1 年度增长                       | implemented-variant | CANSLIM成长         | trading-strategies/research/canslim           | 选股/评分/形态/管理 |
| CA-S-A2                            | A2 ROE                            | implemented-variant | CANSLIM成长         | trading-strategies/research/canslim           | 选股/评分/形态/管理 |
| CA-S-A3                            | A3 现金流                         | implemented-variant | CANSLIM成长         | trading-strategies/research/canslim           | 选股/评分/形态/管理 |
| CA-S-N1                            | N1 催化                           | implemented-variant | CANSLIM成长         | trading-strategies/research/canslim           | 选股/评分/形态/管理 |
| CA-S-N2                            | N2 新高                           | implemented         | CANSLIM成长         | trading-strategies/research/canslim           | 选股/评分/形态/管理 |
| CA-S-S1                            | S1 放量                           | implemented-variant | CANSLIM成长         | trading-strategies/research/canslim           | 选股/评分/形态/管理 |
| CA-S-S2                            | S2 流通市值                       | implemented-variant | CANSLIM成长         | trading-strategies/research/canslim           | 选股/评分/形态/管理 |
| CA-S-L1                            | L1 RS                             | implemented-variant | CANSLIM成长         | trading-strategies/research/canslim           | 选股/评分/形态/管理 |
| CA-S-L2                            | L2 板块龙头                       | implemented-variant | CANSLIM成长         | trading-strategies/research/canslim           | 选股/评分/形态/管理 |
| CA-S-I1                            | I1 机构增持                       | implemented-variant | CANSLIM成长         | trading-strategies/research/canslim           | 选股/评分/形态/管理 |
| CA-S-I2                            | I2 机构质量                       | implemented-variant | CANSLIM成长         | trading-strategies/research/canslim           | 选股/评分/形态/管理 |
| CA-S-M1                            | M1 均线                           | implemented-variant | CANSLIM成长         | trading-strategies/research/canslim           | 选股/评分/形态/管理 |
| CA-S-M2                            | M2 跟进日                         | implemented-variant | CANSLIM成长         | trading-strategies/research/canslim           | 选股/评分/形态/管理 |
| CA-S-M3                            | M3 分布日                         | implemented-variant | CANSLIM成长         | trading-strategies/research/canslim           | 选股/评分/形态/管理 |
| CA-S-C1-turnaround                 | 季度亏损转盈满分分支              | implemented-variant | CANSLIM成长         | trading-strategies/research/canslim           | 选股/评分/形态/管理 |
| CA-S-A1-turnaround                 | 年度亏损转盈满分分支              | implemented-variant | CANSLIM成长         | trading-strategies/research/canslim           | 选股/评分/形态/管理 |
| CA-S-A1-loss-exclusion             | 扣除中间亏损年份对照              | implemented-variant | CANSLIM成长         | trading-strategies/research/canslim           | 选股/评分/形态/管理 |
| CA-S-N1-rumor2                     | 传闻催化两分对照                  | implemented-variant | CANSLIM成长         | trading-strategies/research/canslim           | 选股/评分/形态/管理 |
| CA-S-N1-product                    | 新产品服务市场催化                | implemented-variant | CANSLIM成长         | trading-strategies/research/canslim           | 选股/评分/形态/管理 |
| CA-S-N1-management                 | 新管理层催化                      | implemented-variant | CANSLIM成长         | trading-strategies/research/canslim           | 选股/评分/形态/管理 |
| CA-S-N1-policy                     | 行业政策催化                      | implemented-variant | CANSLIM成长         | trading-strategies/research/canslim           | 选股/评分/形态/管理 |
| CA-S-N1-contract                   | 重大合同订单催化                  | implemented-variant | CANSLIM成长         | trading-strategies/research/canslim           | 选股/评分/形态/管理 |
| CA-S-N1-incentive                  | 股权激励催化                      | implemented-variant | CANSLIM成长         | trading-strategies/research/canslim           | 选股/评分/形态/管理 |
| CA-S-N1-forecast50                 | 盈利预增至少50%催化               | implemented-variant | CANSLIM成长         | trading-strategies/research/canslim           | 选股/评分/形态/管理 |
| CA-S-N2-90                         | 52周高点90%分档上穿               | implemented-variant | CANSLIM成长         | trading-strategies/research/canslim           | 选股/评分/形态/管理 |
| CA-S-N2-95                         | 52周高点95%分档上穿               | implemented-variant | CANSLIM成长         | trading-strategies/research/canslim           | 选股/评分/形态/管理 |
| CA-S-N2-100                        | 52周高点100%分档上穿              | implemented-variant | CANSLIM成长         | trading-strategies/research/canslim           | 选股/评分/形态/管理 |
| CA-S-S1-limitup                    | 缩量涨停放量评分例外              | implemented-variant | CANSLIM成长         | trading-strategies/research/canslim           | 选股/评分/形态/管理 |
| CA-S-S1-crash                      | 暴跌日放量下跌排除                | implemented-variant | CANSLIM成长         | trading-strategies/research/canslim           | 选股/评分/形态/管理 |
| CA-S-S2-unlock                     | 未来三个月解禁扣分                | implemented-variant | CANSLIM成长         | trading-strategies/research/canslim           | 选股/评分/形态/管理 |
| CA-S-S2-buyback                    | 回购计划加分                      | implemented-variant | CANSLIM成长         | trading-strategies/research/canslim           | 选股/评分/形态/管理 |
| CA-S-L1-ipo                        | 次新上市以来相对强度              | implemented-variant | CANSLIM成长         | trading-strategies/research/canslim           | 选股/评分/形态/管理 |
| CA-S-I1-turnover                   | 机构家数增持股比例降例外          | implemented-variant | CANSLIM成长         | trading-strategies/research/canslim           | 选股/评分/形态/管理 |
| CA-S-M1-200                        | 200日均线标题口径对照             | implemented-variant | CANSLIM成长         | trading-strategies/research/canslim           | 选股/评分/形态/管理 |
| CA-S-total-absolute                | CANSLIM绝对分数分档               | implemented-variant | CANSLIM成长         | trading-strategies/research/canslim           | 选股/评分/形态/管理 |
| CA-S-total-ratio                   | CANSLIM总分比例分档对照           | implemented-variant | CANSLIM成长         | trading-strategies/research/canslim           | 选股/评分/形态/管理 |
| CA-S-C-downgrade                   | C低于10降级                       | implemented-variant | CANSLIM成长         | trading-strategies/research/canslim           | 选股/评分/形态/管理 |
| CA-S-M-warning                     | M低于6警告继续分析                | implemented-variant | CANSLIM成长         | trading-strategies/research/canslim           | 选股/评分/形态/管理 |
| CA-S-missing                       | 缺失零贡献与证据完整门槛          | implemented-variant | CANSLIM成长         | trading-strategies/research/canslim           | 选股/评分/形态/管理 |
| CA-B-C1                            | 入口二值季度增速25%满分           | implemented-variant | CANSLIM成长         | trading-strategies/research/canslim           | 选股/评分/形态/管理 |
| CA-B-C2                            | 入口二值两期盈利加速满分          | implemented-variant | CANSLIM成长         | trading-strategies/research/canslim           | 选股/评分/形态/管理 |
| CA-B-C3                            | 入口二值营收20%满分               | implemented-variant | CANSLIM成长         | trading-strategies/research/canslim           | 选股/评分/形态/管理 |
| CA-B-A1                            | 入口二值长期增长25%满分           | implemented-variant | CANSLIM成长         | trading-strategies/research/canslim           | 选股/评分/形态/管理 |
| CA-B-A2                            | 入口二值ROE17%满分                | implemented-variant | CANSLIM成长         | trading-strategies/research/canslim           | 选股/评分/形态/管理 |
| CA-B-A3                            | 入口二值现金流覆盖EPS满分         | implemented-variant | CANSLIM成长         | trading-strategies/research/canslim           | 选股/评分/形态/管理 |
| CA-B-N1                            | 入口二值单一实质催化满分          | implemented-variant | CANSLIM成长         | trading-strategies/research/canslim           | 选股/评分/形态/管理 |
| CA-B-N2                            | 入口二值52周高点98%满分           | implemented-variant | CANSLIM成长         | trading-strategies/research/canslim           | 选股/评分/形态/管理 |
| CA-B-S1                            | 入口二值五日量峰1.5倍满分         | implemented-variant | CANSLIM成长         | trading-strategies/research/canslim           | 选股/评分/形态/管理 |
| CA-B-S2                            | 入口二值流通市值50至500亿满分     | implemented-variant | CANSLIM成长         | trading-strategies/research/canslim           | 选股/评分/形态/管理 |
| CA-B-L1                            | 入口二值RS80满分                  | implemented-variant | CANSLIM成长         | trading-strategies/research/canslim           | 选股/评分/形态/管理 |
| CA-B-L2                            | 入口二值板块内前三满分            | implemented-variant | CANSLIM成长         | trading-strategies/research/canslim           | 选股/评分/形态/管理 |
| CA-B-I1                            | 入口二值两期机构持股数量增加满分  | implemented-variant | CANSLIM成长         | trading-strategies/research/canslim           | 选股/评分/形态/管理 |
| CA-B-I2                            | 入口二值十大股东优质机构任一满分  | implemented-variant | CANSLIM成长         | trading-strategies/research/canslim           | 选股/评分/形态/管理 |
| CA-B-M1                            | 入口二值CSI300高于MA250二值评分   | implemented-variant | CANSLIM成长         | trading-strategies/research/canslim           | 选股/评分/形态/管理 |
| CA-B-M2                            | 入口二值十日任一放量上涨评分      | implemented-variant | CANSLIM成长         | trading-strategies/research/canslim           | 选股/评分/形态/管理 |
| CA-B-M3                            | 入口二值二十日分布日少于五满分    | implemented-variant | CANSLIM成长         | trading-strategies/research/canslim           | 选股/评分/形态/管理 |
| CA-S-weighted-ratio                | 七因子百分比加权对照              | implemented-variant | CANSLIM成长         | trading-strategies/research/canslim           | 选股/评分/形态/管理 |
| CA-T-window120                     | 杯柄120根观察窗口对照             | implemented         | CANSLIM成长         | trading-strategies/research/canslim           | 选股/评分/形态/管理 |
| CA-T-gate2-fallback                | 杯柄低于四分才替代形态            | implemented         | CANSLIM成长         | trading-strategies/research/canslim           | 选股/评分/形态/管理 |
| CA-E-five-soft                     | 五步入场弱信号观察版              | implemented-variant | CANSLIM成长         | trading-strategies/research/canslim           | 选股/评分/形态/管理 |
| CA-E-checklist70                   | 入口七十分纪律组合                | implemented-variant | CANSLIM成长         | trading-strategies/research/canslim           | 选股/评分/形态/管理 |
| CA-E-soft-overrides                | 综合判断允许弱项对照              | implemented-variant | CANSLIM成长         | trading-strategies/research/canslim           | 选股/评分/形态/管理 |
| CA-E-reported5                     | 最近财报后五日等待对照            | implemented-variant | CANSLIM成长         | trading-strategies/research/canslim           | 选股/评分/形态/管理 |
| CA-L-query-screen                  | 六十日强度多头及市值组合查询      | implemented-variant | CANSLIM成长         | trading-strategies/research/canslim           | 选股/评分/形态/管理 |
| CA-E-ipo60-risk                    | 上市不足六十日风险标注对照        | implemented-variant | CANSLIM成长         | trading-strategies/research/canslim           | 选股/评分/形态/管理 |
| CA-S-ipo-year-confidence           | 上市不足一年置信度对照            | implemented-variant | CANSLIM成长         | trading-strategies/research/canslim           | 选股/评分/形态/管理 |

2026-11-11补充：上述目标域采用独立策略包。实际已迁移63路径，统一方法查询按15个稳定分类ID及规则/风控/分析/工具类型投影；表中目标域不等同全部方法已开放执行。


2026-11-11最终补充：整文件实际映射128条，另有成长215项计算、年度质量/成长与盘中/原生/周线政策的partial归属。旧组合/固定公式路径已删除，实际DSL解释器仍由应用唯一绑定。统一91目录与本表695方法仍为不同计量单位；最新状态、验证和数据/执行模型缺口见[本轮交付](deliveries/2026-11-11-strategy-factor-native.md)。
