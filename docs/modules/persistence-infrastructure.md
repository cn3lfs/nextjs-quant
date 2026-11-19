# 持久化与基础设施

## 职责与非职责

`src/server/db/` 管 SQLite 连接、schema、增量迁移与通用 records 能力与具名业务类型仓储；领域服务拥有业务编排。`src/server/infra/` 管设置、任务锁、通知授权/outbox、LLM 进程接入等横切机制；凭证由根 `vault.ts` 使用 Windows DPAPI。业务查询放具名仓储，不扩充任意 kind/任意返回类型的通用 helper。

## 入口与消费者

- 数据库入口：[src/server/db/index.ts](../../src/server/db/index.ts)，迁移：[migrations.ts](../../src/server/db/migrations.ts)，schema：[schema.ts](../../src/server/db/schema.ts)。
- `dataDirectory()` 优先读 `QUANT_DATA_DIR`，否则位于 Windows 本地应用数据；应用启动 DB 时会执行版本检查和迁移。
- 任务、监控、图表、RPS、账本、新闻复盘、账户成交和研究查询的仓储统一位于 `src/server/db/`，调用者直接导入，不保留旧路径转发。外部源库、限额诊断日志及跨域事务编排的保留调用逐条登记于 delivery.json。
- infra 消费者由 runtime、tRPC API、scheduler、CLI/模型和各 store 调用。

## 契约与依赖

SQLite schema/user_version 与迁移不可静默改写；生产数据目录不可用于开发测试，所有可能打开 DB 的命令需隔离 `QUANT_DATA_DIR`。事务、WAL、write receipts、并发所有权和重启恢复属于持久化契约。凭证、认证信息不得出现在输出日志。

## 状态、副作用与验证

写入 `quant.sqlite`、任务/通知记录、领域专表和凭证文件保护区；infra 也协调进程内共享队列/lease。代表测试：[core](../../tests/persistence-infrastructure/core.test.ts)、[integration](../../tests/persistence-infrastructure/integration.test.ts)、[jobs](../../tests/persistence-infrastructure/jobs.test.ts)、[signal-ledger](../../tests/strategy-signals/signals/signal-ledger.test.ts)。测试初始化只在未设置时提供隔离目录，见 [setup-data-dir.ts](../../tests/setup-data-dir.ts)。

## 维护指南

领域持久状态由 db 中对应类型仓储管理，跨域事务由所属用例确定范围；只有机制确为横切时才加入 infra。表变更写增量迁移并说明恢复方式，正式交付时配套更新桌面版本；不能降低 `user_version` 或清理用户数据来绕过兼容问题。
