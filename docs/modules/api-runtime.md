# API 与后台运行时

## 职责与非职责

tRPC API 验证输入并调用用例，client/server adapter 负责传输；jobs 提供通用生命周期/队列，领域 worker 执行长任务；`runtime.ts` 汇总应用启动后的定时调度、恢复和通知 drain。领域计算和持久化归领域服务/store，API root 不应成为实现层。

## 入口与消费者

- tRPC procedure 按域位于 `src/server/api/routers/`；[src/server/api/root.ts](../../src/server/api/root.ts) 只合并平面子路由并导出 `AppRouter` / caller，context/序列化在 `src/server/api/trpc.ts`。
- HTTP handler：[src/app/api/trpc/[trpc]/route.ts](../../src/app/api/trpc/%5Btrpc%5D/route.ts)；健康入口 `src/app/api/health/route.ts`。
- 浏览器 caller：[src/trpc/react.tsx](../../src/trpc/react.tsx)；RSC caller：[src/trpc/server.ts](../../src/trpc/server.ts)。
- 通用 jobs 在 `src/server/jobs/`；`src/server/runtime.ts` 负责启动、恢复及周期调度。领域用例放在 owner 域：行情快照为 `src/server/market/snapshot.ts`，回测任务为 `src/server/backtest/backtest-job.ts`，选股任务为 `src/server/screening/screen-job.ts`。专用 workers 跟随业务域；`scripts/build-runtime.mjs` 显式列出 bundle 入口。

## 契约与依赖

合并后的 root router 导出 186 个顶层 procedure。`mergeTRPCRouters` 平面合并，保持名称、输入输出 schema、错误语义、授权检查位置与客户端推断；禁止将域 router 嵌套导致 wire path 改名。运行依赖方向为 transport → API/domain use case → store/data-source；runtime 只做生命周期组装。

## 状态、副作用与验证

调 API 可能创建 SQLite 任务、启动 worker、访问文件/网络、调用 DLL 或排队通知。worker 的取消、进度、错误、重启恢复和实际构建路径均为运行契约。代表验证：[api-router-contract](../../tests/api-runtime/api-router-contract.test.ts)、[server-layout](../../tests/engineering-validation/server-layout.test.ts)、[jobs](../../tests/persistence-infrastructure/jobs.test.ts)、[worker-pool](../../tests/engineering-validation/worker-pool.test.ts)、[intraday-worker](../../tests/strategy-signals/intraday/intraday-worker.test.ts)。改动 API/runtime 后须相关测试、typecheck、全量 test/build，并重建/检查受影响 worker。

## 维护指南

新 procedure 放所属域 router，不加回组合根；域 router 仅连接 schema 与用例。新增 worker 要同时更新构建清单、runtime 消费路径和专属生命周期测试；不要把 transport 结构复制进服务层。
