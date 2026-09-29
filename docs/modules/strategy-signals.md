# 策略与信号

## 策略监控与通知投递 /signals（2026-09-29）

页面入口为 signals-view → MonitorWorkspace；模块草稿不再复用行情/筛选页参数。monitor-workspace-query 提供摘要、三类20+1历史、精确kind/id详情和单项完整导出，schema位于 lib/strategy-facts/monitor-workspace。monitor-workspace-actions 提供保存、启停及人工确认；原后台全量读取与规则执行入口保持独立。

runtime直接读取所有enabled订阅，不使用默认限制200条的通用list函数；按updated_at/id降序处理。1000订阅基线回归保护完整性，UI分页不能影响后台输入。仍逐条处理、保留单宿主DLL及现有运行版本检查。

摘要覆盖全记录，今日按北京时间创建日期；“今日平台接受”是今日创建且当前sent的投递记录，不是收件人已读。失败数包含旧失败，人工成功不抹去它；暂停证券按订阅证券实例计数，包含已停用订阅。列表按createdAt/id降序，游标绑定规范筛选；监控编辑保留createdAt以稳定历史排序。用户主动刷新/状态变化后成员可变，不承诺跨请求事务快照。

信号多渠道计数取直接signalId与summarySignalIds的投递ID并集去重；详情仅列已存决策，不从无投递推断未授权或策略过滤。正文、完整结构和错误按需读取，分段阅读与完整JSON导出分开。渠道详情只投影脱敏目标与配置版本，不复制原始凭证字段。旧人工记录无sourceDeliveryId时明确提示来源缺失。

保存使用配置token：包括revision和配置，不包括lastCheck/states等后台检查。事务内拒绝过期编辑；保存或实际启停切换重置基线，重复设置同状态不重建。新订阅默认暂停。草稿按记录独立、按revision处理晚到保存结果；会话仅存草稿/筛选/分页，正文不持久化。新建成功后再次新建使用新草稿。冲突重新读取保留输入，并给出服务端配置供核对。

人工重发确认固定deliveryId/requestId/渠道目标版本，事务内核对原状态及渠道，唯一记录ID由requestId派生；同确认重试返回同一记录，新确认可生成另一条。新记录保留原正文并标人工来源、10分钟期限，原失败不改写。旧retryDelivery也经过渠道/状态检查，但其旧字符串输入没有跨独立调用的requestId保证。自动通知授权、版本、限额和父信号语义不变；前端隐藏不控制后台调度。

渠道每次完成保存生成revision，确认版本涵盖该revision及公开目标字段，因此同一渠道更换Webhook凭证也使旧确认失效。新人工记录保存confirmedChannelVersion；delivery-authorization在领取以及异步读取凭证后的发送前再次检查。版本改变则取消旧确认，不自动转发到新目标；凭证本身仍只在vault，未加入版本响应或导出。旧无版本人工记录保留原兼容行为，不伪造追溯字段。

可见摘要15秒、订阅10秒、信号第一页10秒；仅有活跃投递时当前投递列表4秒，已完成详情不轮询，pending/sending详情4秒。useTaskVisible结合焦点、document.visibilityState和PanelCache可见性；隐藏/离页关闭模块读取，写入回调也遵守实时可见性。全局侧栏离页仅需要摘要，总览仅取今日信号元数据。详情卸载gcTime=0；导出缓存及时reset并释放Blob URL。

迁移v12增加4个监控元数据索引：历史投影、信号历史、直接信号关联、汇总成员覆盖查询。它不改业务payload；旧exe不能打开v12数据库，部署需同步新版本，不降版本绕过检查。默认生产库未参与验证。

维护测试：tests/strategy-signals/monitoring/monitor-workspace*.test.ts、monitor-revision/monitor-tick/m4-monitor、通知策略和delivery-subscription；浏览器验证为 tests/signals-workspace-browser.mjs、signals-recovery-browser.mjs、signals-refresh-browser.mjs、signals-lifecycle-browser.mjs、signals-memory-browser.mjs。完整遍历和性能分别见 signals-completeness.ts、signals-query-perf.ts、signals-perf-browser.mjs。脚本仅用于quant-signals隔离fixture，业务变更在finally恢复；实际结果与限制以Documents专项交付说明为准。


窄窗详情切换与共享 PageGrid 的 1240px 断点保持一致；1440px 并排，1024/390px 选中详情时隐藏列表，返回恢复位置和焦点，避免详情沉到长列表下方。修改共享断点时需同步复验三个宽度。

## 职责与非职责

策略域按流派运行研究或确定性规则；监控域比较订阅策略与基线、判断新鲜度并产生订阅信号；全市场 signal ledger 形成每日观察样本。它们不拥有原始行情解析或账本成交事实，也不自动下单。两条信号路线保持分离：监控可走已授权通知 outbox，signal ledger 只记录与回填。

## 入口与消费者

Workbench 的监控连接表单通过 `src/components/signals/notification-policy-fields.tsx` 配置通知策略；字段组件由 strategy-signals 持有，工作台负责连接状态组装。

- UI：策略/信号页面，`src/components/signals/`、`src/components/intraday/`。
- 服务：`src/server/strategies/{breakout,chan,canslim,wyckoff,value,...}/`、`src/server/monitoring/`。
- API：`breakout`、`czsc`、`chanAnalyze/History/Report`、`canslimAnalyze/History/Report`、`wyckoff*`、`monitors`、`signals`、`intraday*`、`signal-ledger*` 等 procedure 目前位于总 router。
- 包边界：`packages/trading-strategy-core` 仅放无 IO 核心；`packages/trading-strategies` 放九方向代表与证据元数据。完整运行编排仍在 server。

## 契约与依赖

策略输入明确证券、日期、周期、规则版本和数据来源；缺少必要证据时保留“数据不足”。method ID、preset ID、代表策略 ID 不可互换。CZSC 需经单一宿主进程的串行队列访问 DLL。策略依赖行情与纯规则；监控/ledger 依赖 strategy、jobs 和各自 store；通知只由显式启用订阅授权。

## 状态、副作用与验证

写入订阅配置、信号、观测、结果和 outbox；可能调用 CZSC worker、数据源和授权通知渠道。代表测试：[czsc](../../tests/strategy-signals/methods/chan/czsc.test.ts)、[breakout](../../tests/strategy-signals/methods/breakout/breakout.test.ts)、[m4-monitor](../../tests/strategy-signals/monitoring/m4-monitor.test.ts)、[signal-ledger-worker](../../tests/strategy-signals/signals/signal-ledger-worker.test.ts)、[intraday-worker](../../tests/strategy-signals/intraday/intraday-worker.test.ts)。不得从回测/台账规则正确推断策略盈利；关键约束见 [invariants](../invariants.md)。

**性能**：CZSC worker 只解码并经 IPC 回传调用方需要的表：逐根 `bars` 表仅研究模式（均线差诊断）需要（`projectCzsc(..., bars)`，`analyzeCzsc` 按 research 传入），递归/事件表仅在对应 flag 置位时读取。监控与全市场信号台账每只证券调用一次，此前每次都把全历史逐根表序列化过 IPC；隔离库全市场台账 354 s → 100 s，输出逐表一致。

## 维护指南

方法/预设变更需同步 strategy catalog、来源证据和固定样本；调整通知必须保留显式订阅与零外发测试；不得并发打开 DLL，也不得把模型解释接为执行信号。

## 盘中预选 `/intraday`（2026-09-28）

入口：[IntradayControls](../../src/components/intraday/intraday-controls.tsx) 负责生效设置与草稿、手动检查反馈；[IntradayHistoryPanel](../../src/components/intraday/intraday-history-panel.tsx) 负责筛选、分页、批次与按需证据。页面读取既有观测，不触发工作台初始行情快照；离开至行情等消费者时仍执行原有首次加载。

读取契约在 [intraday-history](../../src/lib/strategy-facts/intraday-history.ts)；服务端 [intraday-history](../../src/server/monitoring/intraday-history.ts) 直接投影元数据，观测按 updated_at/id、批次按 startedAt/id 稳定游标分页，游标绑定筛选。API 分为 intradaySummary、intradayStorage、intradayHistory、intradayRuns、intradayRunDetail 和既有完整 intradayExport；旧 intradayStatus 为兼容保留，当前页面不再消费。

统计覆盖当前筛选全部观测，候选要求 signals 非空；无尝试为未核对，仅失败尝试为待重试，有有效 signalKeys 数组为已核对。详情按各 signal.key 显示成立/撤销，数据不足不等于撤销。完整 JSON 导出保持 schemaVersion=1；原始证据按需展开、分段显示，不持久缓存。批次逐证券原因每20条分组展示，完整配置和证券池依据仍可展开核对。

后端调度与页面可见性独立。页面运行中以5秒刷新摘要/活跃列表，空闲摘要30秒，历史列表不固定轮询，容量60秒；隐藏/失焦停止页面读取，恢复补刷。保存采用提交时参数快照，保存响应不丢弃提交后输入；未保存修改必须先保存或放弃才能检查窗口。手动检查不突破5分钟窗口，错过只登记，15:05后检查收盘。

[数据读取](../../src/server/monitoring/intraday-data.ts) 仅使用截止时点前可用的上一交易日收盘 RPS 观测或该交易日正式 RPS，拒绝把当日/过旧/未来发布的数据标为上一日。数据不足和引擎版本变化继续保留原因；不改策略公式、串行 DLL 边界或通知授权。

第11次[迁移](../../src/server/db/migrations.ts) 增加两个局部表达式覆盖索引。索引与读取投影表达式须同步维护；kind 首列使 SQLite 能选择覆盖路径，确认关联键显式 TEXT 避免关联全扫描。原始证据不重写，写入配额仍事务内精确检查。升级后的库不能由旧 exe 打开，不得降低 user_version；本次没有打包或替换 release。

验证入口：`tests/strategy-signals/intraday/`、迁移集成与 API 契约测试；生产浏览器脚本 `tests/intraday-preselection-browser.mjs`、`intraday-preselection-acceptance.mjs`；测量脚本 `intraday-preselection-perf.ts`、`intraday-preselection-http-perf.mjs`、`intraday-preselection-perf-browser.mjs`。脚本仅使用隔离 QUANT_DATA_DIR，数据库写入 fixture 在 finally 恢复；SQL基准使用内存库。`tests/intraday-browser.mjs` 是分时图测试，与本模块区分。最终数字与验证范围见 Documents 中本模块交付说明，fixture 不代表实源执行效果。

## 信号台账 `/signal-ledger`（2026-09-28）

入口 `src/app/signal-ledger/page.tsx` 渲染 `SignalLedgerWorkspace`；UI 查询由 `src/server/monitoring/signal-ledger-query.ts` 提供，schema 位于 `src/lib/strategy-facts/signal-ledger-query.ts`，tRPC 装配在 monitoring router。摘要、20条列表、单条详情、每日任务、通知决策与全样本分析分别读取。后台回填继续使用 store.rows 的完整集合，禁止把 UI 分页应用到后台输入。

列表按观察日期降序、证券和 ID 升序，游标绑定规范筛选；任务按日期、决策按创建时间及 ID 分页。总数和状态统计在同一事务内覆盖全部匹配信号，不受当前页影响。期限状态分为未固定、已固定有效、已固定留空；0%是有效结果。pendingSignals 按仍有未固定期限的信号去重。最近30交易日快捷范围依赖实际已知日历，不足时禁用。

全样本分析独立于列表筛选，复用 aggregateLedger 和 signalInformation；前者按策略/质量/期限，后者按策略/方向/期限，保持既有统计口径。SignalInformationView 同时接受紧凑 computed 结果和固定样本 rows，页面不重复装载原始证据。回填改变 outcome 而信号数不变也必须重新计算，不使用记录数作为缓存版本。

运行中轻量摘要3秒、闲置30秒，列表无固定轮询；useTaskVisible 控制页面可见性，后台任务不依赖 UI。任务状态变化使列表、分析、打开的详情及历史查询失效。取消仅经 actions.ts 的权威入口，事务内返回 requested/already-requested/finished/not-found；取消请求不代表工作线程已终止。

URL保存筛选和选中信号，sessionStorage只保存分页栈、返回位置；重证据详情不进入持久缓存。ArchiveEvidence/ArchiveText 分段显示，导出保留完整信号、outcomes、关联通知决策与版本。任务错误20条分组显示。详情关联先缩小候选再复用 ledgerDecisions 全部谓词，不改变投递策略，也不把决策记录当成发送成功。

验证入口为 `tests/strategy-signals/signals/signal-ledger-query.test.ts`、既有 ledger/information/worker 测试，以及 `tests/signal-ledger-browser.mjs`、`signal-ledger-refresh-browser.mjs`、`signal-ledger-memory-browser.mjs`。SQL、HTTP、浏览器性能脚本与 query-plan 脚本均在 tests/；仅使用隔离目录，fixture 修改 finally 恢复。本模块没有新增迁移或索引。最终验收状态以 next-plan 与 Documents 中专项交付说明为准。
