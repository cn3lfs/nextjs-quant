# trading-strategy-core

纯 TypeScript 策略基础包，承载策略服务会复用、但不需要数据库、文件系统、环境变量、Next.js、数据源或 DLL 的能力。

当前公开模块：`bars`、`completed-bars`、`indicators`、`money`。

`packages/trading-strategies` 仍是九方向代表策略目录和证据元数据包，不与本包合并；真正的运行编排继续位于 `src/server/strategies`。
