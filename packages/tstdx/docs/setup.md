# 安装与开发

## 安装

### 在同一个 pnpm workspace 内

```jsonc
// package.json
{ "dependencies": { "tstdx": "workspace:*" } }
```

```powershell
pnpm install
```

### 通过本地 tarball

```powershell
pnpm --dir packages/tstdx pack --pack-destination C:\temp
pnpm add file:C:\temp\tstdx-0.1.0.tgz
```

`prepack` 会先跑构建，所以 tarball 里一定带最新的 `dist`。

### 发布到注册表

当前 `package.json` 标记了 `"private": true`，这是**刻意的防误发**。要发布需要：

1. 去掉 `private`
2. 确认 `files` 字段（当前是 `dist`、`src`、`README.md`；要带文档就加上 `docs`）
3. 确认 `version`
4. 取得发布授权后执行 `pnpm publish`

## 运行环境

- Node.js >= 22
- ESM only（`"type": "module"`），不提供 CommonJS 产物
- 运行依赖只有 `iconv-lite`

## 独立开发

把 `packages/tstdx` 整个目录复制出去就是一个完整项目，不需要外层仓库：

```powershell
pnpm install
pnpm build      # tsc -p tsconfig.json，产出 dist/*.js 与 dist/*.d.ts
pnpm typecheck  # tsc --noEmit
pnpm test       # vitest run
```

`dist/` 是生成产物，不提交。

## 测试

### 离线测试（默认）

```powershell
pnpm test
```

只使用固定样本与**本地假 TCP 服务器**，不访问公网，也不需要任何量化终端数据库。

| 文件                | 覆盖                             |
| ------------------- | -------------------------------- |
| `wire.test.ts`      | 行情帧的构造与解析、整包长度锁定 |
| `catalog.test.ts`   | 证券列表、F10、板块、文件分片    |
| `queries.test.ts`   | 扩展查询的分页、批量、回退逻辑   |
| `transport.test.ts` | 握手、收帧、解压、坏包处理       |
| `pool.test.ts`      | 连接池的建连顺序与失效切换       |
| `precision.test.ts` | 价格精度目录与 ETF 小数位        |
| `financial.test.ts` | 本地财务包与清单解析、损坏输入   |

新增解析器时**必须同时提供固定字节 fixture 与非法输入用例**。

### 实网验收（显式开启）

```powershell
$env:TSTDX_LIVE = '1'
$env:TSTDX_LIVE_HOSTS = '180.153.18.170,124.71.187.122,115.238.56.198'
$env:TSTDX_LIVE_REPORT = Join-Path $env:TEMP 'tstdx-live.json'
pnpm exec vitest run --config vitest.config.ts tests/full-live.test.ts
```

未设置 `TSTDX_LIVE=1` 时该用例自动跳过。样本日期固定为 2026-09-14；**上游返回空回包会让可用性断言失败**，这是设计如此——它要把"接口实现了"和"公网当前可用"分开。

`TSTDX_LIVE_REPORT` 指向的 JSON 会记录每个节点每个接口的状态与耗时，便于对比不同时间点的可用性。

### 三库对照探针

`tests/probes/` 下是显式执行的对照工具，用来把本包与 Python / Rust 实现在同一输入上做逐点比较：

- `xmtdx-all.py`、`xmtdx-helpers.py` — 对照 [xmtdx](https://pypi.org/project/xmtdx/)
- `rustdx-all.py`、`rustdx-all.rs` — 对照 [rustdx-complete](https://crates.io/crates/rustdx-complete)

这些脚本需要自行安装对应语言环境，不在 `pnpm test` 里运行。详见该目录的 `README.md`。

## 包结构

```
packages/tstdx/
├─ src/
│  ├─ index.ts           # 包入口，重新导出下列模块
│  ├─ client.ts          # createTdxClient、TdxSession、pingAll/probeHosts/fromBestHost
│  ├─ wire.ts            # 行情帧编解码（另有 tstdx/wire 子路径导出）
│  ├─ catalog-wire.ts    # 证券列表、F10、板块、文件、历史资金流的编解码
│  ├─ queries.ts         # 扩展查询组合层（列表、区间、批量、复权、资金流）
│  ├─ analytics.ts       # 纯函数：复权、涨跌停、资金流分类、市场统计
│  ├─ financial.ts       # 本地 gpcw 财务包解析
│  └─ connection-pool.ts # 通用连接池
├─ tests/
└─ docs/
```

## 导出入口

```ts
// 主入口：客户端 + 全部类型 + 纯函数 + 财务包解析
import { createTdxClient, adjustBars, parseFinancialReport } from "tstdx";

// 子路径：只要行情帧编解码
import { buildQuotesRequest, parseQuotes } from "tstdx/wire";
```

`ConnectionPool` 也从主入口导出，用于自建连接管理。

## 与宿主应用的边界

本包**不做**这些事，由使用方负责：

- 读环境变量、读数据库、读配置文件
- 决定节点优先级与持久化
- 落盘、缓存、调度、重试策略（除了 `requestRetries` 这层）
- 下载本地财务包或行情文件

在本仓库里，节点来源与环境变量优先级保留在 `src/server/tdx-quotes.ts`，通过 `hosts` 函数传入。
