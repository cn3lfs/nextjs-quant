# 模块化技术因子与公开因子库

2026-11-07：用户授权重构策略模块，技术因子优先，随后要求查找并引入聚宽等量化平台的公开因子。

## 使用与范围

回测页选择“模块化因子组合”，编辑入场/退出条件。每侧 1–12 个条件，可全部或任一满足；支持大于、小于、含等号比较、上穿和下穿。右侧可以是固定值或另一个因子，参数由同一目录驱动。提供双均线交叉、放量通道突破、RSI 回升三组用法示例，不据此推荐收益。

默认双均线 SMA5/20 基线保留；历史策略继续弃用。因子组合沿用现有单标的五分钟引擎、下一根开盘、100 股、T+1、受阻退出保留、固定实验费用及规则自检标签。运行中不能编辑；复用实验恢复完整因子配置，编辑草稿不改变原报告；取消、分页、导出、删除沿用原任务生命周期。

当前共 **76 个可组合原生模块**，周期参数按“根”计算，不按窗口变体重复计数：

| 来源 | 原生模块数 | 范围 |
| --- | ---: | --- |
| 共享技术指标 | 22 | 收盘、MA、EMA、BIAS、MACD 三线、ROC、RSI、KDJ 三线、ATR、ATR%、布林三轨、相对成交量、成交量均线、OBV、前高/前低 |
| Microsoft Qlib Alpha158 | 41 | 9 个 K 线、3 个价格比例、29 个滚动特征；默认 5/10/20/30/60 窗口展开为 157 个可计算特征 |
| WorldQuant Alpha101 | 13 | #006、009、012、023、024、026、035、046、049、051、053、054、101；仅单标的 OHLCV 时序子集 |

Alpha158 的 VWAP0 未接入，不能用 HLC3、收盘价或未核验单位的 amount/volume 代替。Alpha101 其余 88 个不是可执行模块；完整编号和逐项依赖见[覆盖清单](../../data-sources/public-factors/alpha101-coverage.json)。横截面 rank/scale 需要同一历史时点的证券池；行业中性化需要当时分类，市值和 VWAP 需要对应证据；adv 在论文的 dollar volume 与常见平台成交量均值之间存在口径歧义，相关公式未启用。Alpha191 本次只列为查阅来源，未实现。

## 来源与核验

- [聚宽官方目录](https://test.demo.joinquant.com/data)列出 Alpha101、Alpha191、技术分析和聚宽因子库。未查到名为“108 因子”的正式系列；官网帮助页当前地区拒绝访问，未获得平台公式或因子值 API 对照，不宣称聚宽全量兼容。
- [Qlib Alpha158 官方定义](https://github.com/microsoft/qlib/blob/da920b7f954f48ab1bb64117c976710de198373e/qlib/contrib/data/loader.py)固定到 v0.9.7，源码、算子说明、MIT 许可和 SHA-256 见[冻结来源](../../data-sources/public-factors/qlib-v0.9.7/manifest.json)。本地为 TypeScript 适配，无 Python 运行依赖。许可证进入第三方声明及下次桌面准备流程。
- [101 Formulaic Alphas 原论文 v3](https://arxiv.org/abs/1601.00991v3) Appendix A 是 Alpha101 公式依据。仅独立实现上述 13 个公式，不复制聚宽代码或第三方 Python 库，保留原始编号、来源、版本及限制。论文相关权利声明见根 THIRD_PARTY_NOTICES.md。

原始公开因子以日频定义；在本回测页使用五分钟数据时，明确是**按根迁移的五分钟变体**，不等同日频平台值。因子层也接受调用方提供的日线，但本次未新增日线交易引擎或多证券资金模型。

## 口径与边界

- 共享指标仍以 trading-strategy-core/indicators 为唯一实现源。MA/STD 需要完整窗口；ATR 为既有算术 TR 均值，布林为样本标准差。RSI/EMA/KDJ 递推口径不更改，冻结输入起点影响递推值，不能宣称等同全历史计算。
- Qlib 的 ROC 是 `Ref(close,N)/close` 比例，与普通 ROC 涨跌百分比不同；MA、STD、BETA 等按当前收盘归一。时序排名采用平均名次/N；高低点索引为窗口内首次极值的 1-based 索引。保留官方 epsilon；严格完整窗口/非法值留空，与上游 min_periods=1 的早期窗口行为不同。
- 相对成交量 = 当前量 / 前 N 根均量，排除当前根，包含连续行情的零量；前高前低通道也严格排除当前根。量价因子只能说明输入数据的特征，未认证 LC5 估算量真实性。
- 条件的缺失状态为 unknown。all：有 false 即 false，否则有 unknown 即 unknown；any：有 true 即 true，否则有 unknown 即 unknown。退出为 true 时优先；退出 unknown 时不入场。持续满足的数值条件可重复发出请求，引擎仍不加仓；交叉仅在实际穿越时触发。
- 参数在 UI、RPC 和包边界验证，未知因子/参数、非有限数、非法窗口和空条件组拒绝。归一后的完整配置随任务、报告和导出冻结，构建指纹包含全部因子源码。因子函数与缓存均为调用内内存，不新建持久表或后台服务。
- 按条件实际最大 lookback（交叉额外一根）冻结预热。按交易日历核对多日预热尾部和研究窗口的所有五分钟时段；缺时段、修复源、已知公司行动仍拒绝。

## 验证与交付

持久用例：共享包 `factors.test.ts`；回测包 `factor-strategy.test.ts`；应用 `public-factor-reference.test.ts`、`factor-workspace.test.ts`、`ma-baseline-work.test.ts`、原 API 和工作台用例。其中 Qlib 的 157 个窗口变体逐项对照冻结官方表达式经 pandas/numpy 独立解释产生的合成参考值，生成器在 tests/helpers/generate-qlib-factor-golden.py；这不是 Qlib 服务或聚宽平台实值核验。

最终运行结果见[本次交付](../../deliveries/2026-11-07-modular-factors.md)。未增加数据库迁移，未修改外部行情，未更新运行中的 release，用户已授权本地提交；未推送或打包。
