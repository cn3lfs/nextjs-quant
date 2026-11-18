# 共用研究方法来源

核验日期：2026-11-17。这里只记录实际读取层级和本研究引用的命题，不宣称读完所有书籍或复现任何收益。各理论专属来源由分组台账补充。

| ID    | 作者、作品与版本                                                                                                                                                                                                                                                     | 本轮读取                                                               | 支持范围与局限                                                                                                    |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| C-S01 | David H. Bailey、Marcos López de Prado，_The Deflated Sharpe Ratio: Correcting for Selection Bias, Backtest Overfitting and Non-Normality_，2014-07-31 版本，[作者 PDF](https://www.davidhbailey.com/dhbpapers/deflated-sharpe.pdf)                                  | 摘要和正文前部：选择偏差、多重检验、过拟合讨论                         | 支持记录完整研究尝试及区分最佳历史表现与稳健证据；没有在本轮计算 DSR，不把它当未来盈利概率的无条件认证            |
| C-S02 | Bailey、Borwein、López de Prado、Zhu，_The Probability of Backtest Overfitting_，2015-02 修订，[作者 PDF](https://www.davidhbailey.com/dhbpapers/backtest-prob.pdf)                                                                                                  | 摘要、引言、§5 Limitations and misuse 相关正文                         | 支持检查策略选择过程与完整试验集；CSCV/PBO 有样本依赖、分割与应用限制，不能机械替代全部验证                       |
| C-S03 | Andrew W. Lo、Harry Mamaysky、Jiang Wang，_Foundations of Technical Analysis: Computational Algorithms, Statistical Inference, and Empirical Implementation_，Journal of Finance 55(4)，2000，[作者 MIT PDF](https://web.mit.edu/wangj/www/pap/LoMamayskyWang00.pdf) | 摘要、引言及 §III “Is Technical Analysis Informative?”（PDF 第 22 页） | 支持把主观图形变成可重复的识别与信息检验；论文明确区分信息含量与可获利策略。本轮不把其美股历史样本外推为 A 股结论 |
| C-S04 | David Aronson，_Evidence-Based Technical Analysis_，Wiley 第 1 版，2006，[出版社书目与目录](https://www.wiley-vch.de/en/?isbn=978-0-470-00874-4&option=com_eshop&view=product)                                                                                       | 出版社介绍与目录：客观规则、科学方法、统计检验、数据挖掘偏差等章节     | 只确认著作研究范围与章节定位；未读取全书正文，不引用书中实验数字作为本项目结论                                    |

## 对模型初稿的共用校订

- **保留**：理论、信号、仓位、执行需要分层；把主观判断改成明确条件后才有一致的比较对象。
- **补充（C-S03）**：信号改变条件收益分布，并不直接证明可形成费用后盈利的完整交易策略；入场、退出、交易限制与资本使用仍须单独研究。
- **补充（C-S01/C-S02）**：本轮收录更多流派会增加未来可尝试的规则数量。未来实验不仅记录最后留下的赢家，也需记录试验选择过程。若事后筛选了一小组漂亮结果，再据此评估可靠性，会丢失关键背景。
- **限制（C-S02）**：统计修正也依赖输入完整性和适用假设，不能用一个合格统计量覆盖数据错误、不可成交或制度变化。
- **书籍缺口（C-S04）**：Aronson 这里只作为研究方法的参考书定位，不能把出版社目录写成其全部论证的总结。

这些校订解释为什么每卡都保留反例和未解决项。它们没有否定某个特定流派，也没有对任何策略给出晋级结论。

访问故障记录：NBER 的论文页面和 PDF 在本轮返回 403，改读作者 MIT 托管版本；Wiley 主站书目返回 403，改读 Wiley-VCH 的有效产品入口。没有购买资料或绕过访问控制。
