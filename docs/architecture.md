# 模块地图

面向第一次接手的人：先看流向，再按需要打开文件。这里描述 2026-09-10 工作区实际实现，不把计划当代码；范围裁定见 [roadmap](roadmap.md)，不可改动的语义见 [invariants](invariants.md)。关键路径均为相对仓库根的真实文件。

## 总体结构与数据流

Next.js/React 页面通过 tRPC 调用 TypeScript 服务；SQLite 保存设置、快照、任务、报告与账本。Electron 只负责窗口/托盘、打包 Node 服务的启动退出。`src/components/workbench.tsx` 组合页面，`src/components/workbench/` 放拆分后的视图和状态；服务路由入口是 [api/root.ts](../src/server/api/root.ts)，调度入口是 [runtime.ts](../src/server/runtime.ts)。

```text
通达信本地目录（只读）
 ├─ vipdoc/{sh,sz,bj}/lday/*.day ─┐
 ├─ vipdoc/{sh,sz,bj}/fzline/*.lc5 ├→ tdx.ts → Bar[] / Snapshot(hash,来源,周期,不复权)
 ├─ T0002/hq_cache/*.tnf ─────────┘             │
 │                      └→ securities.ts → 证券主档/搜索名称
 └─ T0002/hq_cache/gbbq → tdx-gbbq.ts → 除权证据 ───────────────┐
                                             │               │
 快照 → indicators.ts → chart-data → chart.tsx                │
   ├→ czsc.ts → IPC串行队列 → czsc-worker → koffi → CZSC64.dll │
   ├→ breakout-batch → 尾窗否决 → 完整历史 → breakout.ts       │
   └→ 公式解析/静态门禁 → jobs/worker → formula-screening      │
                                             │               │
 策略 → monitor（订阅/基线/新鲜度）→ 信号 → 分级 → outbox → 四渠道
                    └→ LLM证据校验 → 追加解读（不决定交易）
 全市场每日两策略 → signal-ledger worker → 信号台账 → T+N回填 ←┘
 手工成交 + 可选信号关联 → trade-ledger → 持仓/成本/可卖/除权审计
 用户确认 → mock-trading TS适配器 → 同花顺模拟盘 → 显式差异对账
```

两条信号路线刻意分开：monitor 面向订阅投递，signal-ledger 面向全市场观察。台账不直接给四渠道发消息；分级审计可以关联台账。公式选股产出候选表，不自动接成第三个监控策略。

## 数据层：行情文件、快照、尾窗与缓存

- **职责**：解析本地二进制、扫描 A 股覆盖、生成可复核快照，向调用者提供完整历史或明确的尾窗。
- **关键文件**：[tdx.ts](../src/server/tdx.ts)、[domain.ts](../src/lib/domain.ts)、[tail-cache-codec.ts](../src/server/tail-cache-codec.ts)、[screen-cache.ts](../src/server/screen-cache.ts)、[metrics-cache.ts](../src/server/metrics-cache.ts)、[data-health.ts](../src/server/data-health.ts)。
- **输入输出**：配置的 tdxRoot + symbol + day/5m → Bar[]/Snapshot/Coverage。day/lc5 均为 32 字节记录；日线 OHLC 整数除 100，5 分钟 OHLC float32，分钟时间解包并处理 32 年回绕；volume 为股、amount 为元。拒绝截断、非法价时、重复/倒序。快照保留 source、adjustment、hash 和数据根等元信息。
- **依赖**：Node 文件系统、domain schema、hash；上层筛选依赖完成时点和日历健康检查。`readTailSnapshot` 缓存以文件签名、周期、窗口等区分，受时间/容量限制；`screen-cache` 缓存序列化结果，`metrics-cache` 为有界内存缓存。
- **不变量**：不写源目录；源文件变化不能混成一次可信读数；尾窗不能改变递推最终确认语义。通达信需要用户更新，扫描成功不等于最新行情，普通公式基准日也不等于官方当前交易日证明。

## 数据层：TNF 名称、证券主档与 GBBQ

- **职责**：TNF 为本地证券名称源，主档整合本地覆盖与核实过的外部别名；GBBQ 提供公司行动事件及复权工具。
- **关键文件**：[tdx.ts](../src/server/tdx.ts) 的 parseNames/securityNames、[securities.ts](../src/server/securities.ts)、[security-search.ts](../src/server/security-search.ts)、[security-identity.ts](../src/server/security-identity.ts)、[tdx-gbbq.ts](../src/server/tdx-gbbq.ts)。
- **输入输出**：TNF 为 50 字节头+360 字节记录，以 gb18030 解码代码/名称；主档输出 symbol/name/来源/别名及周期覆盖。GBBQ 解密记录→按证券分组的事件；`adjustmentFactors`/`applyAdjustment` 接受行情与事件，提供显式 none/forward/backward 换算，量不调整。主路径仍不复权，信号台账用事件三态，持仓账本用成本审计。
- **依赖**：SQLite records 保存目录及身份核验；身份核验路径使用受限 westock-data Node 搜索与通达信 lookup，主档优先本地名称。GBBQ 从 `T0002/hq_cache/gbbq` 读，读取前后核验文件状态。
- **不变量**：身份冲突不能自动补主档；名称核实不等于停复牌核实；复权能力存在不代表默认策略已经复权。覆盖期由全文件最大有效事件日期认定，不用 mtime 冒充无事件证明。

## 指标层

- **职责**：纯函数计算 MA/EMA/MACD/KDJ/RSI/BOLL 和公式共享序列基元。
- **关键文件**：[indicators.ts](../src/lib/indicators.ts)，图表消费入口 [chart-data.ts](../src/lib/chart-data.ts)。
- **输入输出**：readonly Bar[] + 参数 → 同长度指标数组（number/null）；序列基元接收 number/null 数组。
- **依赖**：domain 的 Bar 类型，无 IO/远程服务；具体认定公式见 [invariants §2](invariants.md#2-通达信认定公式与预热)。
- **不变量**：唯一共享实现、完整历史递推、窗口不足 null、状态不因缺口重置、内部不舍入。

## 图表层

- **职责**：K 线/指标/缠论与双突破证据展示，周月聚合、视图设置和四种画线工具。
- **关键文件**：[chart.tsx](../src/components/chart.tsx) 管图表实例、pane、事件及绘制；[chart-data.ts](../src/lib/chart-data.ts) 做指标/结构适配；[chart-drawings.ts](../src/lib/chart-drawings.ts) 做画线几何；[chart-view.ts](../src/lib/chart-view.ts) 定义参数与视图 schema；[chart-view-store.ts](../src/server/chart-view-store.ts) 持久化；[chart-bars.ts](../src/server/chart-bars.ts)、[weekly-bars.ts](../src/server/weekly-bars.ts)、[monthly-bars.ts](../src/server/monthly-bars.ts) 聚合。
- **输入输出**：快照、ChartPeriod、策略结果、已核对成本、保存的视图 → 图形与 legend；用户保存→chart_views 表（标的×周期）。工具为趋势线、水平线、矩形、斐波那契。
- **依赖**：lightweight-charts、共享 indicators、交易日历、P1 成本；week/month 从日线快照聚合，不扩展底层策略 Period。
- **不变量**：先全量计算再按 180 根展开显示；null 不补零连线；周/月策略结构明确不可用，5m 缠论图不等于 5m 通知开放。无仓或成本未知不画成本线。主图对数不改变副图线性与斐波那契价格回撤。

## 缠论计算层

- **职责**：封装现有原生缠论引擎，组装端点、中枢、买卖点、质量与背驰证据；不移植核心算法。
- **关键文件**：[vendor/czsc/README.md](../vendor/czsc/README.md)、`vendor/czsc/CZSC64.dll`、[czsc.ts](../src/server/czsc.ts)、[czsc-input.ts](../src/server/czsc-input.ts)、[czsc-worker.ts](../src/server/czsc-worker.ts)、[czsc-structures.ts](../src/server/czsc-structures.ts)、[czsc-signal-analysis.ts](../src/server/czsc-signal-analysis.ts)。
- **输入输出**：有序行情→Float32Array H/L/C/V→注册表 Func40/Func30 投影→CzscResult，含配置、来源 commit、DLL hash；运行副本在 runtime/czsc。
- **依赖**：koffi、专用 Node 子进程 IPC、vendor 二进制、runtime 构建；台账线程的 DLL 请求由主进程转交相同队列。
- **不变量**：宿主进程内单一串行所有者，整任务原子排队，库对象保持存活，float32 容差；golden 与二进制同源。对外捆绑许可由用户决定，不能把已有 exe 当成许可已确认。

## 双突破

- **职责**：确定性地识别趋势线+关键价位+放量三要素，给五项评分和结构止损/两个目标。
- **关键文件**：[breakout.ts](../src/server/breakout.ts)、[breakout-batch.ts](../src/server/breakout-batch.ts)、[vcp.ts](../src/server/vcp.ts)、[breakout-method.json](../src/lib/breakout-method.json)。
- **输入输出**：已完成不复权日线→每时点 long/short 的 是/否/数据不足、x/5、结构依据及 1:X；批量输入股票池→候选、读取错误、hash/耗时等。
- **依赖**：vcpFacts 已确认摆动、indicators、固定方法 hash；批量层读 62 根尾窗做否决，候选用全历史复核，缓存文件清单未变的单次结果。
- **不变量**：尾窗不确认信号；短历史/缺指标/缺目标不能凑数；评分不覆盖三核心条件；仅日线，向下信号不是自动做空指令。

## 通达信公式选股

- **职责**：本地受限公式语言的解析、静态安全检查、序列求值、保存与全市场任务。
- **关键文件**：[tdx-formula-syntax.ts](../src/lib/tdx-formula-syntax.ts)、[tdx-formula-check.ts](../src/lib/tdx-formula-check.ts)、[tdx-formula.ts](../src/lib/tdx-formula.ts)、[formula-screen.ts](../src/lib/formula-screen.ts)、[formula-screen-service.ts](../src/server/formula-screen-service.ts)、[formula-screening.ts](../src/server/formula-screening.ts)。
- **输入输出**：命名公式、参数→AST/问题（函数及行号）→整列输出；筛选要求单输出，最新完成日非零为候选。保存公式版本、参数、行情快照，结果进入既有候选分页/JSON 导出；过旧证券从最终基准日结果隔离。
- **依赖**：共享指标基元、本地全历史日线、jobs/worker、SQLite records。候选表均线/量列是描述列，不能误读为额外公式条件；缺候选表指标历史也会列入隔离。
- **不变量**：31 项未来函数全语句硬拒绝；未知函数不替代；60 函数不算行情别名；错误使任务失败、取消丢弃迟到结果。无 JS eval，无远程财务函数支持。

## 信号与四渠道推送

- **职责**：周期监控、基线/新鲜度门禁、策略事件、分级静默及可靠投递；规则通知成功后可追加 LLM 解读。
- **关键文件**：[runtime.ts](../src/server/runtime.ts)、[monitor-strategy.ts](../src/server/monitor-strategy.ts)、[monitor-run.ts](../src/server/monitor-run.ts)、[monitor-calendar.ts](../src/server/monitor-calendar.ts)、[notification-policy.ts](../src/lib/notification-policy.ts)、[notification-policy-store.ts](../src/server/notification-policy-store.ts)、[notifications.ts](../src/server/notifications.ts)、[delivery-authorization.ts](../src/server/delivery-authorization.ts)、[lease.ts](../src/server/lease.ts)。
- **输入输出**：启用的订阅+新完成行情→规则事件→立即/汇总/仅台账策略→每渠道 outbox 状态→飞书、企业微信、Telegram、Discord。monitor 每 60 秒 tick，投递轮询每 3 秒；调度租约控制共享库的活跃调度者。
- **依赖**：策略引擎、交易日历/证券状态、SQLite、vault、官方渠道 HTTP 适配；AI 追加依赖研究编排。
- **不变量**：无订阅不投递；日线两策略 15:05 后才监控；重新检查配置修订、静默、限额与授权。网络结果不确定可能重试重复，“平台接受”不等于已读。自动测试真实第三方投递 0。

## 信号台账与持仓账本（两种事实）

- **职责**：信号台账记录市场观察及向前收益；持仓账本记录用户实际填入的成交、成本/可卖与除权审计。
- **关键文件**：信号侧 [signal-ledger.ts](../src/lib/signal-ledger.ts)、[signal-ledger-client.ts](../src/server/signal-ledger-client.ts)、[signal-ledger-worker.ts](../src/server/signal-ledger-worker.ts)、[signal-ledger-job.ts](../src/server/signal-ledger-job.ts)、[signal-ledger-engine.ts](../src/server/signal-ledger-engine.ts)、[signal-ledger-store.ts](../src/server/signal-ledger-store.ts)；成交侧 [trade-ledger.ts](../src/lib/trade-ledger.ts)、[trade-ledger-service.ts](../src/server/trade-ledger-service.ts)、[trade-ledger-store.ts](../src/server/trade-ledger-store.ts)。
- **输入输出**：全市场当日两策略+日历+GBBQ→不可变观察、T+5/10/20 结果、分组事实；手工成交/限价依据/可选信号 ID→持仓、移动加权成本、T+1、浮盈、成本调整轨迹。
- **依赖**：增量 SQLite 表、完整行情、GBBQ、同一 CZSC 投影所有者；N1 为常驻 worker 线程，主线程转发 DLL，支持进度和取消。P1 成本复用既有实验参数。
- **不变量**：落库不依赖订阅、不做历史回放；信号收益不是成交绩效。含除权/未知收益空，P1 依据不足成本空；后续修订不覆盖已结算信号结果，对账不覆盖本地交易。

## 模拟盘

- **职责**：可选的同花顺模拟账户开户、查询、用户确认委托与差异对账。
- **关键文件**：[mock-trading-contract.ts](../src/lib/mock-trading-contract.ts)、[mock-trading.ts](../src/server/mock-trading.ts)、[mock-trading-service.ts](../src/server/mock-trading-service.ts)、[vault.ts](../src/server/vault.ts)。
- **输入输出**：显式操作/一次性确认→`http://trade.10jqka.com.cn:8088`→已校验响应、脱敏诊断、与本地持仓差异。最近 20 次诊断含原始脱敏文本与证据 envelope，文档及实测契约同时可查。
- **依赖**：undici、Zod、Windows DPAPI、手工账本/交易日历；技能只读契约，TS 执行请求。
- **不变量**：默认零请求；身份不写业务库；未知结果不重试；接受委托不自动写成交；9/8/: 含义未确认；不用模拟盘对账结果暗中覆盖任一侧。Q0 买入已核实，T+1 卖出未完成，见 [实操记录](review/q0-mock-trading-log.md)。

## LLM 研究编排

- **职责**：把确定性结果与可追溯证据交给模型解释，保存报告与历史；不是策略引擎或交易执行层。
- **关键文件**：[research.ts](../src/server/research.ts)、[local-llm.ts](../src/server/local-llm.ts)、[research-skills.ts](../src/server/research-skills.ts)、[quick-research.ts](../src/server/quick-research.ts)、[evidence.ts](../src/server/evidence.ts)、[market-data.ts](../src/server/market-data.ts)、[jobs.ts](../src/server/jobs.ts)、[research-history.ts](../src/server/research-history.ts)。
- **输入输出**：快照/规则/技能文件 hash/来源与时点明确的证据→受限提示→Zod 与引用校验后的报告；失败/取消作为任务状态保留，规则通知不被撤回。
- **依赖**：Codex/Claude 本机 CLI 或 DeepSeek API、优先级并发槽、证据缓存、SQLite；CLI 不随桌面包分发，登录仍由 CLI 管理。具体连接前提保留在 [根 README](../README.md)。
- **不变量**：模型输出不执行，证据 ID 必须存在，历史与当前证据不能混淆；技能安装不等于对应模块实现完整。以下冻结研究方向可沿现有路径使用，但不继续投入。

## 冻结模块（范围以 roadmap §2 为准）

- 回测、滚动检验、现金分红回测与成本实验：**已冻结**。
- CANSLIM：**已冻结**。
- 威科夫：**已冻结**。
- 基本面、价值、估值、财务：**已冻结**。
- 市场情绪、TMT：**已冻结**。
- 新闻行业链：**已冻结**。
- 旧缠论 LLM 解读链路的合并改造：**已冻结**。
- 其余未接入技能、性能优化、组合/风控/归因、多品种扩展：**已冻结**。

## 核实边界

本图核对了上述入口、导入关系、schema 与关键分支；没有对冻结模块追加验收。DLL 源码版本依据仓库 vendor 清单与 golden fixture，未重编译外部 C++。第三方线上当前状态、实际生产库版本、最新 exe 是否重打包、用户人工签收均未在本次文档任务中核实。
