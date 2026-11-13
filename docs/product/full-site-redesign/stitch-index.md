# Stitch 设计索引与覆盖矩阵

项目：https://stitch.withgoogle.com/projects/8346105525528703944 。浅色设计系统 `assets/5a5a9ddb1a7640ceaa23a7539e785b7a`。旧稿保留，以表中ID识别当前稿。

24个入口均已有Stitch设计。按用户限定次数封板：reviewed表示静态设计审阅，frozen-with-open-issues表示带已登记问题冻结，不代表问题已修好。全部稿件均未运行验证，开发以产品规格和真实数据契约为准，不复制假数据或无能力操作。

| 编号 | 页面             | 路由                   | 当前screen ID                    | 状态                    |
| ---- | ---------------- | ---------------------- | -------------------------------- | ----------------------- |
| L01  | 今日总览         | `/`                    | 7c29d20881e945bd8da0640d3d673aea | frozen-with-open-issues |
| L02  | 数据与连接       | `/settings`            | 5a0798102824478599b57fbb42fab1ad | frozen-with-open-issues |
| L03  | RPS 数据         | `/rps`                 | 901ebbddfdec40fdbd1f75ceea2cfa16 | frozen-with-open-issues |
| L04  | 任务中心         | `/tasks`               | 79ca69d8cb1f4b3592a03408792ca20f | frozen-with-open-issues |
| L05  | 行情图表         | `/market`              | d4913d87783c4d069f30717a6b337025 | frozen-with-open-issues |
| L06  | 条件选股         | `/screen`              | ac94fce81a9046368b25d3eacc939382 | frozen-with-open-issues |
| L07  | 打板情绪         | `/limit-up`            | 584a861c60aa4bf4bfa625dba329caf5 | frozen-with-open-issues |
| L08  | 策略中心         | `/strategies`          | 7c9dee9610b747ccbb21776d92e2248c | frozen-with-open-issues |
| L09  | 策略实验         | `/backtest`            | 5a8d49d1cae543b3a5bed8f057c229f7 | reviewed                |
| L10  | 策略样本研究     | `/research`            | 9a2fb8820a9842ca9505e87f202f2348 | frozen-with-open-issues |
| L11  | 研究数据指南     | `/research/data-guide` | 5d5395eab1164803ac02d858ee9e4eaa | frozen-with-open-issues |
| L12  | 证据分析         | `/analysis`            | 2bf6d3496b6b4854ad39bda33bdcb5d1 | frozen-with-open-issues |
| L13  | 研究档案         | `/reports`             | f2a175137332400fa03b537bdf8c0ef4 | frozen-with-open-issues |
| L14  | 研究报告详情     | `/reports/[kind]/[id]` | eea41162002b40678be282bac5f926aa | reviewed                |
| L15  | 新闻／主题       | `/news`                | 7f4d6ce2e5eb4d5c9ce60157bb4990ab | frozen-with-open-issues |
| L16  | 财联社复盘       | `/cls-review`          | 00f3813039814e3a8c92387ecbf9920f | frozen-with-open-issues |
| L17  | 盘中预选         | `/intraday`            | 1ca4e3455bbf47668b6d617ef4852c4f | reviewed                |
| L18  | 信号与通知       | `/signals`             | 28eb21a4ac394fd28c68e19f41d6d3fe | frozen-with-open-issues |
| L19  | 信号台账         | `/signal-ledger`       | 4728531605ed408ea582e019a807a502 | reviewed                |
| L20  | 持仓与交易日志   | `/trade-ledger`        | 663cfd340e6f4c1ead334e939f1f049c | frozen-with-open-issues |
| L21  | 交割单与交易复盘 | `/trade-review`        | 849f75b481fe4af0a8140611aed11fa5 | frozen-with-open-issues |
| L22  | 数字货币         | `/crypto`              | 8291987b325d472ea7613510629dd640 | frozen-with-open-issues |
| L23  | 资源期货         | `/futures`             | 7db020f648d046fc8d060ec554bb35bf | frozen-with-open-issues |
| L24  | 公共组件参考     | `/ui-gallery`          | ecdcea66022e4801a34eac4590eb2815 | frozen-with-open-issues |

## 独立附加状态画板

主表仍按24个页面计数，下表仅补该页必要状态，不增加页面覆盖数。

| 页面 | 状态画板                     | screen ID                        | 状态                    |
| ---- | ---------------------------- | -------------------------------- | ----------------------- |
| L14  | 证据展开、方法差异与错误恢复 | f0abfe5d45c64a75960d92101d99b922 | reviewed                |
| L15  | 冻结分析、续作与运行状态     | 38445f73dc7344bf85f4bb33ad41f887 | reviewed                |
| L15  | 行业主题与价格缺失           | bf6afd1a1e4c4aba8da1b9e67e531feb | reviewed                |
| L15  | 历史查询、补采与异常恢复     | c81d9a3fd230460896c4476aa0bdad8f | reviewed                |
| L15  | 行业与零共同主题报告阅读     | 6ebd0248f7444e77834112eb4d9e8ce3 | reviewed                |
| L16  | 固定样本与价格观察           | 518d2b6657564157a53f4fcbad3a0e0f | reviewed                |
| L16  | 导入、调度与异常恢复         | fd40278b464e43468d81fdd709e19ad9 | frozen-with-open-issues |
| L17  | 参数草稿与历史批次           | f7b85b40a7c040d19aaea4092a34d0d2 | reviewed                |
| L17  | 原始依据、收盘核对和清理状态 | d87a02e06077468cab47bbaf90e38a18 | reviewed                |
| L18  | 完整新建订阅表单             | 42d5cdbd6ef6458eba49093a2f7fd732 | frozen-with-open-issues |
| L18  | 信号原始依据                 | 8b421e1110e043eea72bb30d7cb21b8b | reviewed                |
| L18  | 投递与人工重发确认           | 56cf47e8b47c424fbd85e0871b26f97f | reviewed                |
| L18  | 保存、重发、读取及订阅恢复   | d4ecea81c6c54efc9f2227f829bdd272 | reviewed                |
| L19  | 原始依据                     | c793a67b87be4860b11b85e7bb6a5b5b | reviewed                |
| L19  | 全样本分析                   | 97b5d970c8914567b9acdf7bc1b34b47 | reviewed                |
| L19  | 每日任务                     | 522039a2ea5a44d1b287e1966bf2ae4e | reviewed                |
| L19  | 投递决策与取消反馈           | b28141a974664ecd85679ce9e6cc77fc | reviewed                |
| L20  | 交易历史与原记录             | e3b16a5d036542ab9d722504055b2e25 | reviewed                |
| L20  | 新增草稿与提交恢复           | e38b851baafd4fa6b9f377472180c386 | frozen-with-open-issues |
| L20  | 独立送转事件与可卖依据       | 54c1f3ad660c49689c2372a57bae3d08 | reviewed                |
| L20  | 信号比较                     | 72506ece9cbd430c9b322a4eb16498fd | reviewed                |
| L20  | 同花顺模拟盘独立确认         | 905383abe7de49d785aecd8bd820c803 | reviewed                |
| L21  | 冻结预览核对                 | e84b9ad7ab634444888c78351c330f29 | reviewed                |
| L21  | 历史批次                     | fd8cb797c80142cb8ea5a30e9740b7cb | frozen-with-open-issues |
| L21  | 撤销与提交恢复               | e1e59c7d4ad543e586fc90b1b516a963 | reviewed                |
| L21  | 账户复盘概览                 | 6217eb7a87a64537b9f5ab30107d0f70 | reviewed                |
| L21  | 交易轮次与费用               | 5c776146b9a14d6e8100dd5cf830c584 | reviewed                |
| L21  | 买卖点                       | beb5142916544034afce1ac94f587dff | reviewed                |
| L21  | 描述性归因                   | da575358d0ed4783acc0f0e5f18c7c34 | frozen-with-open-issues |
| L21  | 关键交易                     | 66e1b3dd792447779331222cb326259e | reviewed                |
| L21  | 分段时间窗与自然周期汇总     | 9d05e7532f5d40178df0256bbd17603c | frozen-with-open-issues |
| L21  | 分段17项指标详情             | f3d65d7e267c473fabaa56bac3e02bc8 | frozen-with-open-issues |
| L21  | 当前持仓收益矩阵             | e2ce69f485984db6a0d9c5e36c2a90df | reviewed                |
| L21  | 滚动默认配置与输入状态       | 6d7502a855004e3d95354ac425007e5a | frozen-with-open-issues |
| L21  | 滚动三曲线                   | d53f674584654d31a843ff30837b7351 | frozen-with-open-issues |
| L21  | 滚动窗口明细与17指标         | f7ee472a6540429d956ab9a1d3f6955e | frozen-with-open-issues |
| L21  | 持仓集中度                   | 632272c1e75e4578931bb88f786d09ae | frozen-with-open-issues |
| L21  | 持仓相关性                   | 4aa6a3b95be04f178c09f40a2399bda6 | frozen-with-open-issues |
| L21  | 执行质量                     | fb49bb6befe942019fc2a07e4f755f5a | frozen-with-open-issues |
| L21  | 现金核对                     | 130631bd8de949f188eccb60cc8355e1 | frozen-with-open-issues |
| L21  | 准入判定                     | e53cd10603414835a4e1519a716ec038 | frozen-with-open-issues |
| L21  | 纪律反事实                   | d5006620ec3c447ba556753e3bdd3dfd | frozen-with-open-issues |
| L22  | 策略模拟                     | f00299da0150476d9c7d7ad4a16f2b9d | frozen-with-open-issues |
| L22  | 平台账户与历史成交           | 7f1af6661d14451dac5b93162829d7be | frozen-with-open-issues |
