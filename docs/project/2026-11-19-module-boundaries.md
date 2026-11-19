# 观澜模块树与实现边界

代码基线 **`f385adb`**。七个 Claude agent 分别走查六个工作区和共用工程底座，主线程复核了跨模块交接与关键条件。本文记录源码行为，实际账户、行情覆盖、正式包和后台调度状态需要运行态证据。

## 模块树

```text
观澜 · 个人量化工作台
├─ 01 今日 /
│  ├─ 数据是否就绪：市场总览、下载回执和扫描状态
│  ├─ 今天关注谁：盘中预选、收盘候选、持仓情报
│  └─ 下一步做什么：人工确认入场、止损和交易计划
├─ 02 扫描与图表 /scan
│  ├─ 看盘：行情、原生缠论、双突破
│  ├─ 找标的：证券池、多周期 RPS、公式选股
│  └─ 看其他盘面：打板情绪、数字货币、资源期货
├─ 03 策略实验室 /lab
│  ├─ 管规则：策略定义、版本及状态
│  ├─ 跑实验：组合回测、研究任务、方法目录与运行比较
│  └─ 查证据：研究档案、成绩单、纸面前推与晋级
├─ 04 账户与复盘 /accounts
│  ├─ 查事实：真实持仓、手工账本、券商交割单
│  ├─ 查模拟：本地纸面、交易所模拟钱包与成交
│  └─ 查执行：计划与成交关联、策略归因、周月复盘
├─ 05 情报 /intel
│  ├─ 看新闻：原文、主题分析、持仓与计划相关报道
│  └─ 做复盘：财联社报告、盘前固定样本、盘后价格观察
├─ 06 系统 /system
│  ├─ 数据与连接：来源、配置、健康和数据库备份
│  ├─ 任务中心：进度、产物、失败和取消
│  └─ 信号与通知：订阅、渠道、投递记录
└─ 07 共用工程底座
   ├─ 宿主与接口：Electron、本机 Node 服务、Next.js／tRPC
   ├─ 数据：原始行情、业务 SQLite、衍生缓存
   └─ 后台执行：调度器、任务 worker、串行 CZSC DLL
```

[界面导航](../../src/components/workbench/navigation.ts#L48) · [产品范围](../roadmap.md#当前范围与决定)

## 01 今日

**从收盘候选建一份计划。** 后台按交易日、行情就绪条件和扫描窗口生成候选，零命中的收盘扫描也会留下完成记录。今日页按服务端确认的基准日区分本次收盘、历史、盘中和待核验。用户填写入场、止损、目标后，服务端复算数量、检查重复与敞口，再写入本地计划。扫描页承接候选看图，账户页承接成交关联。真实交易由用户操作。 [扫描引擎](../../src/server/alerts/engine.ts#L67) · [候选时点](../../src/server/alerts/candidate-scan.ts#L57) · [保存计划](../../src/server/alerts/plans.ts#L51)

**需要定口径的是候选准入。** 今日页的建计划来源过滤历史候选，盘中和待核验仍可进入。扫描页能从已确认的候选直接打开计划表单，保存接口按候选有效性和风控校验，当前没有统一校验今日页的扫描新鲜度。若希望历史候选在全局只读，或要求数据核验完成才可建计划，需要明确适用入口和市场。 [今日来源过滤](../../src/components/overview/today-workspace.tsx#L159) · [扫描页表单](../../src/components/screening/scan-workspace.tsx#L327) · [计划前置校验](../../src/server/alerts/plans.ts#L167)

## 02 扫描与图表

**跑一次公式，再打开某只入选股。** 公式任务按本地已完成日线、前复权口径执行，服务端保存入选证券的快照。点「个股研究」时，页面先校验任务、快照和标的，再进入冻结图表。K 线从存档取数，缠论使用快照数据。普通行情另有在线补尾，RPS 榜单可跳到该标的普通图表。 [公式任务](../../src/server/screening/formula-screen-service.ts#L99) · [候选跳转](../../src/components/workbench/screen-view.tsx#L195) · [冻结图表](../../src/server/charts/chart-bars.ts#L80) · [缠论计算](../../src/server/api/routers/strategy.ts#L74)

**需要定口径的是冻结范围。** 公式候选的日线和相应分析使用任务快照，图旁 RPS 仍按标的单独读取，其日期可以晚于快照。准备交易计划时取冻结序列末根的原价，图上可能显示前复权价。如果用户要用同一时点复核信号，应明确哪些辅助数据一起冻结，以及两个价格各自用于什么。 [RPS 曲线读取](../../src/components/market/chart-workspace.tsx#L103) · [计划价格来源](../../src/server/api/routers/alerts.ts#L45)

## 03 策略实验室

**用明确的策略版本跑组合回测。** 从策略详情进入后，表单先回读并核对策略版本，再提交后台任务。worker 冻结行情、公司行动、成本和执行配置，撮合后把权益、成交及诊断写回该任务。方法目录可导出服务端确认的比较结果，晋级另由同版本的纸面前推证据和人工操作决定。 [实验表单](../../src/components/research/lab-backtest.tsx#L176) · [回测执行](../../src/server/research/lab-backtest.ts#L93) · [比较导出](../../src/components/research/strategy-center.tsx#L784) · [前推资格](../../src/server/db/strategy-lab.ts#L72)

**需要定口径的是实验结果的去向。** 策略实验的组合回测在任务中心查看，方法目录的同口径比较只收已完成的策略中心任务。若期望同一份组合实验进入比较，或进一步成为晋级证据，这涉及两道独立的准入决定。 [回测任务入口](../../src/server/api/routers/strategy-lab.ts#L52) · [比较任务准入](../../src/server/api/routers/strategy-center.ts#L90)

## 04 账户与复盘

**导入券商交割单，再追一笔成交。** 确认导入时重核文件和账户版本，重复行按账户识别，冲突阻断入账。持仓从各自账本重放，真实、纸面、交易所模拟分开标记，币种分别汇总。关联成交时校验计划、策略版本和分仓，保存关系并显示可复制的确认回执，原始成交仍可追溯。 [导入确认](../../src/server/portfolio/delivery-preview-workspace.ts#L244) · [持仓投影](../../src/server/portfolio/account-workspace-service.ts#L81) · [关联校验](../../src/server/portfolio/account-workspace-service.ts#L576) · [回执](../../src/components/portfolio/account-workspace.tsx#L729)

**需要定口径的是真实持仓合计。** 券商和手工账本可分别筛选，两者都算真实账户。同一实际成交在两处登记时，全来源合计可能重复。若要展示去重后的真实仓位，需要先明确两本账重叠时以哪边为准。 [页面提示](../../src/components/portfolio/account-workspace.tsx#L186) · [筛选与合计](../../src/server/portfolio/account-workspace-service.ts#L498)

## 05 情报

**新闻分析和财联社复盘各走一条链。** 新闻分析把选定原文冻结为任务输入，首次有内容存档时同步绑定任务。读者点「查看分析结果」才切换，取消前已经保存的内容可单独查看。财联社复盘从报告版本固定当日样本，盘后用本地未复权行情观察样本日开盘到各期限收盘的涨跌。样本需在交易日开盘前固定，行情不足时保留待观察或缺失状态。导出会核对报告身份，回执记下本次发起下载的标题、版本和文件名。 [档案写入](../../src/server/news/news-analysis.ts#L203) · [结果入口](../../src/components/news/news-panel.tsx#L327) · [固定样本](../../src/server/news/cls-review-service.ts#L72) · [价格观察](../../src/server/news/cls-outcomes.ts#L19) · [导出回执](../../src/components/news/cls-review-workspace.tsx#L179)

**需要定口径的是情报用到哪一步。** 新闻分析结果可供阅读，持仓及计划可按原文匹配，财联社样本则由报告内容和既定规则产生。若希望主题进入扫描或纸面策略，需要明确哪种新闻证据可转为可检验的信号。启用财联社调度后，晨报符合条件时可以自动固定样本。 [持仓与计划匹配](../../src/server/news/intel-service.ts#L42) · [样本来源](../../src/server/news/cls-candidates.ts#L38) · [样本调度](../../src/server/news/cls-review-scheduler.ts#L47)

## 06 系统

**开了提醒后，查它有没有发出。** 后台扫描先产出事件，投递服务按运行模式、订阅和渠道判断出站资格。投递时再次核对当前授权，认领出站记录，发出后写回状态，失败进入对应的重试或结束状态。任务中心查看计算进度和产物，通知记录用来追查投递，两者各有状态。 [运行时调度](../../src/server/runtime.ts#L19) · [事件入队](../../src/server/infra/notifications.ts#L43) · [投递过程](../../src/server/infra/notifications.ts#L650)

**需要定口径的是提醒控制放在哪。** 启用订阅只是一个条件。真实投递还需要策略实验室切到 `live`，该操作要求至少有一个已晋级且仍符合资格的策略。若期望系统页能解释「已启用但未发」，关键是把当前模式、订阅和渠道状态放到同一次排查里。 [模式准入](../../src/server/api/routers/strategy-lab.ts#L59) · [投递授权](../../src/server/infra/delivery-authorization.ts#L17)

## 07 共用工程底座

**从桌面启动，到显示原生缠论。** Electron 启动只监听本机的 Node 服务，窗口通过 Next.js／tRPC 请求数据。行情适配层读原始文件并复用派生缓存，SQLite 保存业务事实及部分可追溯快照。图表先出 K 线，再把快照交给专用子进程串行调用 CZSC DLL，缠论失败有独立提示。 [桌面启动](../../electron/main.ts#L32) · [行情读取](../../src/server/market/bar-store/read-bars.ts#L273) · [SQLite 入口](../../src/server/db/index.ts#L10) · [缠论 worker](../../src/server/strategies/chan/czsc.ts#L38)

**需要定口径的是后台跟随谁的生命周期。** 当前桌面代码在最后一个窗口关闭时退出应用，并终止本机服务进程。由该服务承担的扫描和通知也随之停止。若期望用户关窗后继续监控，这涉及桌面应用的关闭语义。 [窗口关闭与进程回收](../../electron/main.ts#L180)

## 核对产品方向时的阅读顺序

1. **先定计划入口。** 今日候选、扫描页候选和公式候选送到同类计划表单时，分别允许哪些状态进入。
2. **再定研究出口。** 组合回测什么时候只留任务记录，什么时候能进入同口径比较，哪类前推证据才影响晋级。
3. **最后定事实口径与运行方式。** 两本真实账重叠时如何认定，关闭桌面窗口后是否仍要扫描和推送。
