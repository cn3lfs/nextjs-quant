# 客户端与连接

## 创建客户端

```ts
import { createTdxClient } from "tstdx";

const client = createTdxClient();
```

### 参数说明

`createTdxClient(options?: TdxClientOptions)`

| 选项              | 类型                                    | 默认        | 说明                                               |
| ----------------- | --------------------------------------- | ----------- | -------------------------------------------------- |
| `hosts`           | `readonly string[] \| (() => string[])` | `TDX_HOSTS` | 节点列表。传函数可在每次重新建连时读取最新配置     |
| `port`            | `number`                                | `7709`      | 服务端口                                           |
| `timeoutMs`       | `number`                                | `3000`      | 单节点建连与单次请求超时                           |
| `connectBudgetMs` | `number`                                | `15000`     | 整轮建连的总预算，用完仍未连上则失败               |
| `requestRetries`  | `0 \| 1 \| 2 \| 3`                      | `0`         | 同一次请求的有限重试次数；换节点重试，不是简单重发 |

### 调用方法

```ts
import { createTdxClient } from "tstdx";

// 固定节点
const a = createTdxClient({ hosts: ["180.153.18.170"], port: 7709 });

// 节点来自外部配置，重新建连时实时读取
const b = createTdxClient({
  hosts: () => readHostsFromConfig(),
  timeoutMs: 5000,
  requestRetries: 1,
});
```

本包**不读取环境变量、不读数据库、不写配置文件**。节点的持久化和优先级由调用方负责。

## 连接行为

- 每个客户端拥有独立连接池，互不共享。
- 建连时按 `hosts` 顺序依次尝试；某节点失败则顺延到下一个。
- 同一连接上的请求**串行执行**，不会交错。
- 收到坏包时废弃该连接，并把下一次请求的起点移到下一个节点。
- 部分查询（证券列表分页、F10 分片）会强制使用不可复用的连接，避免分页状态串味。

## 生命周期方法

| 方法                                   | 参数                                    | 说明                                                 |
| -------------------------------------- | --------------------------------------- | ---------------------------------------------------- |
| `close()`                              | 无                                      | 释放连接池并停止心跳；关闭后仍可继续使用，会重新建连 |
| `heartbeat()`                          | 无                                      | 发一次证券数量查询作为协议级探活                     |
| `reconnect()`                          | 无                                      | 先关闭连接池再执行一次 `heartbeat`                   |
| `retry(operation, attempts = 2)`       | `() => Promise<T>`、`1..4`              | 有界重试；每次失败之间关闭连接池                     |
| `startHeartbeat(intervalMs, onError?)` | `intervalMs = 60000`、`(error) => void` | 定时保活；返回停止函数。回调抛错不会中断定时器       |
| `stopHeartbeat()`                      | 无                                      | 停止保活；`close()` 会自动调用                       |

### 调用方法

```ts
const stop = client.startHeartbeat(60000, (error) => console.warn(error));
// ...
stop(); // 或 client.stopHeartbeat()

// 对一段可能因连接问题失败的操作做有界重试
const bars = await client.retry(
  () => client.k("sh600519", 20260101, 20260915),
  3,
);
```

长连接保活是可选的：不开启也能工作，只是每次请求可能需要重新建连。

## 节点测速与探测

三个模块级函数，都不需要先创建客户端。

### 01. pingAll — 只测握手

```ts
import { pingAll } from "tstdx";

const rows = await pingAll(["180.153.18.170", "124.71.187.122"], {
  port: 7709,
  timeoutMs: 3000,
  parallel: 4,
});
```

返回按「可连接优先、耗时升序」排序的数组：

```ts
{ host: string; connected: boolean; elapsedMs: number; error?: string }[]
```

握手成功**不代表行情正文可用**。公共节点经常出现握手正常但 K 线/五档返回空正文。

### 02. probeHosts — 附带业务探测

```ts
import { probeHosts } from "tstdx";

const rows = await probeHosts(undefined, {
  timeoutMs: 3000,
  parallel: 4,
  sampleSymbol: "sh600000",
});
```

在握手之外再跑证券数量、五档、日 K 三项，每项独立给出状态：

```ts
type TdxProbeStatus = "ok" | "empty" | "error" | "not-run";
type TdxProbeCheck = {
  status: TdxProbeStatus;
  elapsedMs: number;
  error?: string;
};
type TdxHostProbe = {
  host: string;
  elapsedMs: number;
  handshake: TdxProbeCheck;
  securityCount: TdxProbeCheck;
  quotes: TdxProbeCheck;
  bars: TdxProbeCheck;
  usable: boolean;
};
```

`empty` 与 `error` 是两种不同的失败：前者连上了但正文为空，后者是协议或网络错误。`usable` 要求四项全部 `ok`。

`connect` 选项可以注入自定义连接器，用于离线测试。

### 03. fromBestHost — 直接拿客户端

```ts
import { fromBestHost } from "tstdx";

// 默认只按握手测速排序
const fast = await fromBestHost();

// 按业务探测筛选，没有可用节点会抛错
const usable = await fromBestHost({ requireMarketData: true, parallel: 8 });
```

参数是 `TdxClientOptions`（去掉 `hosts` 的函数形式）再加 `hosts?`、`parallel?`、`sampleSymbol?`、`requireMarketData?`。

## 内置节点

```ts
import { TDX_HOSTS, PORT, parseHosts } from "tstdx";
```

- `TDX_HOSTS`：内置公共节点列表，**会随时间失效**，不要当作稳定基础设施。
- `PORT`：`7709`。
- `parseHosts(raw)`：把逗号分隔字符串或数组规范化成节点数组，去空白、忽略空项，遇到含非法字符的地址会抛错（不会把它传给 socket）。

## 底层入口

需要自己管理连接时可以绕过客户端：

```ts
import { TdxSession, createQuotesPool, ConnectionPool } from "tstdx";

const session = await TdxSession.connect("180.153.18.170", 7709, 3000);
try {
  const body = await session.request(someRequestBuffer);
} finally {
  await session.close();
}
```

`TdxSession.connect` 完成三帧握手后才返回。`request` 接收完整请求帧、返回解压后的响应正文。请求帧的构造见[底层编解码](./wire.md)。
