# 组合与交易账本

## 职责与非职责

portfolio 持有用户导入/录入的成交、现金流和组合复盘；trade ledger 与 signal ledger 是不同事实域。研究回测不写入真实账本；同花顺模拟盘动作只经显式用户请求，不能由信号触发。

## 入口与消费者

- 页面：`src/app/trade-ledger/page.tsx`、`trade-review/page.tsx`、`signal-ledger/page.tsx`；组件在 `src/components/portfolio/` 与相关工作台组件。
- 服务：`src/server/portfolio/` 包含交割单导入、持仓、风险、成本/执行质量、交易复盘和 discipline；存储依赖 `DeliveryStore`、账本 store 与 `src/server/db/`。
- API：`delivery*`、`tradeReview*`、`discipline*`、`signal-ledger*` 和现金/执行质量 procedure 目前装配在 root router。
- 影响账本的公司行动读取来自行情/数据源层；同花顺模拟盘适配器是显式外部边界。

## 契约与依赖

成交/现金流水及导入批次是事实；信号关联是可选来源说明。复权、成本、可卖数量、红利和费用不得通过 UI 复制行或默认值丢失。账号、文件 hash、导入/撤销、分页和导出是可观察契约。portfolio 可读 market/calendar 与纯计算，不反向依赖页面状态。

## 状态、副作用与验证

SQLite 表包括 `trade_ledger`、`trade_adjustments`、`trade_fills`、`cash_flows`、`import_batches` 等；模拟盘会产生第三方请求，仅在用户明确动作中发生。代表测试：[p1-trade-ledger](../../tests/portfolio-ledger/p1-trade-ledger.test.ts)、[delivery-store](../../tests/research-backtest/delivery-store.test.ts)、[trade-review-service](../../tests/portfolio-ledger/trade-review-service.test.ts)、[cash-adjusted-signals](../../tests/portfolio-ledger/cash-adjusted-signals.test.ts)。

## 维护指南

### 交割单导入与批次工作区

`DeliveryWorkspace` 管理导入与历史批次两个视图。导入配置、冻结预览、实际收据分步展示；`delivery-preview-workspace.ts` 保留有界短期会话，确认时重读文件 hash 并在事务内复验账户版本。确认响应丢失后按账户和文件 hash 查询既有收据，不依赖源文件仍存在；没有找到收据不能自动重试入库。会话过期需要重新预览。

`delivery-workspace-query.ts` 提供 UI 专用摘要、详情、证据分页、完整导出和撤销影响复验。摘要用 SQL 投影，保留旧 `DeliveryStore.batches()` 给计算消费者；不能把列表页作为完整账本。实际拥有成交/现金流与文件识别数分开。分页绑定账户版本，撤销后保留 offset，末页清空退到有效页；显式刷新同时更新打开的详情。撤销不把首次拥有的重复记录转移到后来批次。

`delivery-file-page.ts` 对目录稳定排序和分页，只 stat 当前页，最多四个并发。批次与预览证据按需读取，原列名和映射用中文呈现；历史未记录字段保持缺失。可见性控制读取，窄窗详情替代列表，返回恢复焦点。持久化草稿仅包含配置及待核对提交身份，不包含 token 或原始证据。

D0–D3工程验收完成：全量回归、最终生产导入/导出/撤销、响应恢复、分页恢复、混合数据性能、冷服务、内存及生命周期已验证。完整测量与合成数据边界见 Documents 中 delivery-import-delivery，失败轮次见 delivery-import-progress。

### 本地交易账本工作区

`/trade-ledger` 页面只装配客户端 `TradeLedgerPanel`，不再等待整个 `tradeDashboard`。`trade-workspace-query.ts` 负责交易元数据、匹配统计、版本绑定游标、单条原始证据、完整筛选导出、信号选择与除权证据；`trade-workspace-service.ts` 负责全账本持仓与按需信号比较。列表分页不能成为持仓/补录校验输入，历史查询不读取日线或全量信号正文。

`tradePositionState` 保留完整持仓计算及派生除权归档；兼容 `tradeDashboard` 仍供旧消费者使用。缺行情的总市值和缺依据的浮盈保持未知，已知市值另列。未新增长期持仓缓存或数据库迁移，显式刷新重新读取事实。只追加交易的游标版本依赖 count/max(rowid)/max(id)，不是任意外部 SQL 改写的检测器。

草稿/冻结提交/保存事实的纯状态在 `trade-workspace-draft.ts`。同提交重试保留 ID，提交后的新输入换 ID，旧响应不清空新草稿；会话恢复校验版本，pending 恢复为 unknown。新草稿取当前北京时间，已有草稿不随跨日变化。详情、持仓动作和模拟盘分别在独立组件；模拟盘默认关闭、预览确认沿用既有服务契约，响应未知须先查成交/对账。

只在可见视图发起查询，不轮询本地静态事实；详情 `gcTime: 0`，正文不进持久缓存；全量导出冻结条件与版本。范围内回归见 `tests/portfolio-ledger/trade-workspace-*.test.ts`，生产浏览器/性能/恢复/生命周期/大正文检查见 `tests/trade-workspace-*.mjs`。当前验收进度以 `docs/next-plan.md` 为准。

### 交割单复盘

复盘读取先按证券/日期建立行情、事件与交易日索引，RPS 仅解码成交日期。API 的同账户分页、排序及兄弟面板复用一次计算中的 Promise；缓存按数据库连接隔离，键含账户三表事实、设置和日历身份，导入/撤销及内容变化立即失效，失败移除，60 秒到期且最多 4 个账户。构建前后验证输入，避免变化期间发布过时结果。外部行情/RPS/板块文件变化最多延迟 60 秒反映；调用方不得修改共享快照。缓存回归见 `trade-review-api.test.ts`，浏览器基准见 `tests/trade-review-perf-browser.mjs`。

### 现金对账与差异追溯

`cash-workspace.ts` 为既有现金结果提供只读展示投影：摘要与20日期页同响应，日期/状态过滤不改变重放输入；来源、逐行证据、期初和诊断单独分页。旧现金算法、旧query/export接口及NAV结果保留。`cash-reconciliation-workspace.ts` 对账户三表全部字段与原始payload逐行哈希，缓存中只保留摘要值；SQLite连接内/外变化计数只避免重复读取，不代替内容身份。最终版本还绑定日历及现金计算结果，详情/导出携带期望版本，失效要求刷新，不保留无界历史快照。

现金界面按已选账户独立挂载，位于其它复盘结果之前，避免兄弟图表加载引起位置跳动。同账户更新保留筛选，服务端夹紧页码同步到客户端；加载时保留上次页并禁用其操作，不能把旧页当新筛选结果。1440分栏、1024/390详情替换列表；日期→来源→行证据逐层返回并恢复焦点，已有交割单批次视图提供返回现金入口。缺失、冲突、日末相等与完整性限制分别呈现。

所有cashWorkspace接口只读；完整导出不受列表筛选影响，含账户、版本、证据hash和完整结果。查询按可见性启用，详情/导出gcTime=0且不持久化；卸载后迟到导出不触发下载或新账户成功反馈。测试入口为 `tests/portfolio-ledger/cash-workspace*.test.ts` 和 `tests/cash-workspace-*.mjs/ts`，合成压力数据与日志只放TEMP；当前验收状态见next-plan，不能把合成结果称为实源对账或账户业绩。

Q0—Q3工程验收完成：最终构建1_x6zbkvfdeGvU8260ZE0，全量11738项及package7项通过，三宽度/失败/撤销恢复、完整证据、性能及隔离数据清理已验证。同fixture响应1.52MB→3.36KB、DOM20432→314；冷账户最大2.499秒、筛选1.923秒峰值和原生窗口隐藏未验证的限制保留。完整测量边界与证据见Documents现金专项delivery，不用受控visibility事件声称操作系统后台策略已验证。

新持仓字段要贯穿导入/更新、store、服务端计算、UI 和导出；保留来源与审计信息。任何 DB schema 改动需独立迁移、隔离验证并报告打包应用需更新；无授权不调用真实/模拟交易外部动作。
