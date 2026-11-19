# 观澜模块树与实现走查

代码基线为 `927defa`。七个 Claude agent 各负责一个分支，每人追踪一次代表操作。主线程复核了模块之间的交接与关键条件。本文依据源码，正式包、账户配置和后台调度的实际运行状态未纳入本次走查。

## 模块树

- [01 今日](#01-今日) · 看数据是否就绪，决定今天关注谁、下一步做什么
  - 市场与数据总览 / 盘中预选历史 / 收盘候选与明日计划
- [02 扫描与图表](#02-扫描与图表) · 找标的，查看候选的依据
  - 行情与原生缠论 / 证券池与 RPS / 公式选股 / 情绪、数字货币与期货
- [03 策略实验室](#03-策略实验室) · 看规则、跑实验、确认策略资格
  - 策略版本 / 组合回测与任务 / 方法目录与运行比较 / 研究证据与前推
- [04 账户与复盘](#04-账户与复盘) · 看交易事实和执行结果
  - 统一持仓 / 手工账本与券商交割单 / 纸面与交易所模拟 / 归因、周月复盘与信号台账
- [05 情报](#05-情报) · 读新闻，验证盘前观点
  - 原文与主题 / 持仓和计划匹配 / 财联社固定样本与盘后观察
- [06 系统](#06-系统) · 管理连接、任务与通知
  - 数据源与配置 / 任务中心 / 通知订阅与投递 / 数据库备份
- [07 共用工程底座](#07-共用工程底座) · 支撑上面六个工作区
  - Electron 与本机服务 / 后台计算与原生 DLL / 原始数据、SQLite 与缓存

今日候选来自自动扫描事件，公式候选来自手动提交的选股任务。两类候选都可以跳到图表，各有自己的生成时点和证据。计划经人工确认后可关联成交。研究侧沿策略版本连接实验、纸面前推和提醒资格。 [工作区导航](../../src/components/workbench/navigation.ts#L48) · [当前产品范围](../roadmap.md#当前范围与决定)

## 01 今日

**从收盘候选建一份明日计划**

1. 后台按交易日、行情下载回执和收盘窗口跑扫描。即使零命中，完成的扫描也会记录进度。页面按服务端确认的应扫描日标明本次收盘、历史、盘中或待核验。 [收盘扫描](../../src/server/alerts/engine.ts#L82) · [候选时点判定](../../src/server/alerts/candidate-scan.ts#L57)
2. 市场筛选和翻页精确读取对应列表。刷新失败时保留同一筛选下最近成功读取的行，仍可看图，并暂停打开新的计划表单。页面已有草稿保留。 [候选查询与状态](../../src/components/overview/today-workspace.tsx#L103)
3. 人工确认入场、止损和目标。服务器按当前账户、分仓和风险上限重算数量，重复检查后保存一份未完成计划。候选事件和计划分别存储，计划可回查原候选。 [计划前置校验](../../src/server/alerts/plans.ts#L167) · [保存入口](../../src/server/api/routers/alerts.ts#L216)

**请核对计划准入。** 今日页会过滤历史候选的建计划来源，盘中或待核验来源仍可能打开表单。扫描页核对候选身份后可打开同类表单，服务端提交也没有按「今日看到的收盘新鲜度」统一拦截。如果你的原则是「未核实为当日就只能看」，当前两个入口口径不同。 [今日可用来源](../../src/components/overview/today-workspace.tsx#L160) · [扫描页计划表单](../../src/components/screening/scan-workspace.tsx#L327) · [建计划校验](../../src/server/alerts/plans.ts#L167)

## 02 扫描与图表

**跑一次公式，再逐只看候选**

1. 公式先通过语法与未来函数校验。服务端以最新一批已完成的本地日线为基准，按全 A 股、前复权口径发起后台任务。数据落后或异常的标的分开登记。 [任务创建](../../src/server/screening/formula-screen-service.ts#L99)
2. 后台保存任务结果与候选快照。页面按任务、分页和排序读取候选。点「个股研究」或切换同页候选时，先核对快照身份与标的，再写入浏览器地址。普通行情加载和冻结候选各有自己的状态。 [候选任务执行](../../src/server/screening/formula-screen-work.ts#L38) · [候选跳图](../../src/components/workbench/screen-view.tsx#L195) · [冻结快照恢复](../../src/components/market/market-page.tsx#L21)
3. 从已确认的个股 RPS 榜打开股票时，有单独的「返回个股 RPS 排名」入口。普通搜索、证券池和公式任务各有自己的浏览上下文。 [RPS 返回入口](../../src/components/workbench/market-view.tsx#L429)

**请核对选股时点。** 公式基准日取决于本地日线的完成进度。盘中打开普通图表可能看到当日更新，统一提醒候选有自己的扫描时间。若你期望盘中公式纳入当天行情，需要明确使用哪一根行情，以及如何标明尚未收盘。 [公式扫描口径](../../src/server/screening/formula-screen-service.ts#L121) · [图表在线补尾](../../src/server/charts/chart-bars.ts#L207)

## 03 策略实验室

**用一个明确的策略版本跑回测**

1. 从策略详情点「用此策略对象回测」。表单等到读回与链接一致的策略和版本才打开。首次读取失败可重试，已确认的同版本草稿在后台刷新失败时保留。提交时校验策略、日期、本金和成本情景。回执记录这次请求和任务编号，后续编辑只改草稿。 [策略入口](../../src/components/research/strategy-lab.tsx#L410) · [实验表单](../../src/components/research/lab-backtest.tsx#L176)
2. 后台将行情、证券范围、公司行动、成本和执行版本冻结，再运行组合撮合，产生权益、成交、拒单和绩效。任务中心保存运行结果。登记策略版本是另一项操作。 [任务入口](../../src/server/api/routers/strategy-lab.ts#L43) · [冻结与执行](../../src/server/research/lab-backtest.ts#L259)
3. 方法目录的「同口径比较」核对策略中心任务的区间、本金、标的或池、行情来源和成交假设，逐项链接原任务。策略详情的晋级资格另看同版本纸面前推与执行构建身份，操作需要人工确认。 [运行比较校验](../../src/server/api/routers/strategy-center.ts#L90) · [前推资格](../../src/server/db/strategy-lab.ts#L72)

**请核对回测与研究资格的关系。** 从「策略实验」完成的组合回测，现阶段进入任务历史。「同口径比较」只接收策略中心任务，组合回测也不会自动更新成绩单或授予晋级资格。如果你预期一份组合实验可以直接进入横向比较或形成候选晋级证据，这是两个需要分别确认的产品决定。 [回测数据去向](../../src/server/api/routers/strategy-lab.ts#L52) · [比较任务准入](../../src/server/api/routers/strategy-center.ts#L102) · [资格定义](../../src/server/db/strategy-lab.ts#L90)

## 04 账户与复盘

**导入交割单，再追溯一笔成交**

1. 先预览文件，把新行、重复行、冲突行单列。确认时重核文件内容和账户版本，在事务中写入批次、成交与现金流水。导入按账户和文件或行的身份识别重复，冲突会阻断写入。 [预览确认](../../src/server/portfolio/delivery-preview-workspace.ts#L244) · [入账事务](../../src/server/db/delivery-store.ts#L153)
2. 统一持仓汇集券商导入、手工录入、纸面账户和已读取的交易所模拟钱包。默认显示真实账户，切换类型可以查看本地纸面或交易所模拟。A 股估值使用符合时点的原价行情，缺价格的持仓会保留缺失状态，CNY 与 USDT 分列汇总。 [账户读取](../../src/server/portfolio/account-workspace-service.ts#L80) · [模拟钱包](../../src/server/portfolio/account-workspace-service.ts#L395) · [持仓汇总](../../src/server/portfolio/account-workspace-service.ts#L497)
3. 复盘时选择成交，确认关联到哪条计划或提醒。关联和复盘日志单独写入，有原始成交可回查。归因、执行质量及周月复盘从这些关系取证。 [关联确认与日志](../../src/server/portfolio/account-review-service.ts#L241)

**请核对真实持仓的合计。** 券商导入和手工账本是独立账户，同一实际成交若在两边都登记，可能被合计两次。现有界面提示避免重复录入。若你期望看到一个真实总仓位，需要先确定重叠时以哪一本账为依据。 [手工账本持仓](../../src/server/portfolio/account-workspace-service.ts#L274) · [真实账户汇总](../../src/server/portfolio/account-workspace-service.ts#L497)

## 05 情报

**固定一份盘前报告的观察样本**

1. 从本地文件预览并导入报告。完成标记与文件身份用于判断哪一版在盘前已就绪。新闻 / 主题页可以做行业分类和摘要，持仓情报从当前持仓与未完成计划匹配原文。 [报告预览](../../src/server/news/cls-report-files.ts#L24) · [持仓与计划匹配](../../src/server/news/intel-service.ts#L42)
2. 在交易日北京时间 09:30 前固定一份样本。服务端把报告提及的标的、上一交易日 RPS 或板块成员作为候选依据，保存当日样本。错过窗口只能登记缺样本，不能用盘后信息补选。 [样本固定](../../src/server/news/cls-review-service.ts#L72) · [定时复盘](../../src/server/news/cls-review-scheduler.ts#L47)
3. 盘后用本地未复权行情观察各期限从样本日开盘到相应收盘的涨跌。待观察、停牌与缺价有独立状态。模型用于新闻分类和主题解读，样本固定及价格核对走明确规则。 [价格观察](../../src/server/news/cls-outcomes.ts#L19) · [新闻分析](../../src/server/news/news-analysis.ts#L229)

**请核对情报的用途。** 现行流程在资讯、主题和盘后方向观察处形成证据。如果你希望某项主题自动进入策略候选或纸面观察，需要先定义从观点到可检验信号的规则以及进入哪个工作区。 [模块职责](../modules/news-cls.md)

## 06 系统

**看到一条信号后，查提醒有没有送到渠道**

1. 后台调度驱动扫描、RPS、复盘与纸面推进。事件入队时检查运行模式、匹配订阅和渠道。默认影子模式可以留下观察记录，真实投递依赖显式开启和授权。 [调度入口](../../src/server/runtime.ts#L19) · [事件入队](../../src/server/infra/notifications.ts#L43)
2. 发送前复核订阅与渠道的当前版本，并认领待发记录。渠道接受后记为 `sent`，永久失败、临时退避以及异常退出后结果不确定分别有状态。 [出站处理](../../src/server/infra/notifications.ts#L650) · [退出恢复](../../src/server/infra/notifications.ts#L740)
3. 任务中心反映计算任务与部分运行错误，「信号与通知」反映投递结果。渠道接受请求是本机能追到的终点，是否送达个人终端由渠道决定。 [任务概览](../../src/server/db/task-overview.ts#L18) · [投递详情](../../src/components/signals/monitor-detail.tsx#L269)

**请核对配置归属。** 当前在系统页管订阅、渠道和投递状态，在策略实验室管策略资格与提醒模式。数据库备份是本机业务库的快照，原始行情和 Windows 凭证有各自的位置。 [策略提醒模式](../../src/server/api/routers/strategy-lab.ts#L59) · [数据库备份](../../src/server/db/backups.ts#L67) · [本机凭证](../../src/server/vault.ts#L23)

## 07 共用工程底座

**打开一只股票，看 K 线和缠论**

1. Electron 启动随包分发的本机 Node 服务。页面通过 tRPC 把请求交给对应领域。普通行情快照优先由交互 worker 读本地数据。这次读取可以走 worker，任务中心不会因此多一个用户可管理的任务。 [桌面宿主](../../electron/main.ts#L36) · [业务接口](../../src/server/api/root.ts#L20) · [快照读取](../../src/server/market/snapshot.ts#L37)
2. 图表服务处理周期和复权。普通图表在满足条件时可在线补当日尾段；公式和回测分别冻结自己的研究输入。应用保存业务事实和快照，派生行情缓存可重建。 [图表服务](../../src/server/charts/chart-bars.ts#L207) · [行情缓存](../../src/server/market/bar-store/column-cache.ts#L25)
3. 原生缠论进入每宿主一个专用子进程，串行调用 DLL。失败可以单独显示，K 线仍可浏览。它与普通读行情、后台选股以及组合撮合分开运行。 [专用子进程](../../src/server/strategies/chan/czsc.ts#L75) · [架构与计算包](../architecture.md#六个计算与数据包)

`tstdx` 读通达信，`quant-rps` 负责排名。策略及公式归 `trading-strategies`，共享指标归 `trading-strategy-core`。`quant-backtest` 处理撮合，`quant-performance` 评价结果。 [仓库架构决定](../roadmap.md#架构与正确性决定)

**请核对数据用途。** 在同一只股票上，普通图表、选股快照和回测输入可能对应不同的行情截止时点和处理方式。缠论标注基于当次传入的价量序列。若你期望从图表一键形成决策证据，需明确页面应引用哪份数据、是否接受当日在线补尾，以及哪些状态要一眼看见。 [缠论计算](../../src/server/strategies/chan/czsc.ts#L329)
