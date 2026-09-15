# 扩展接口

在标准行情之外的查询与封装。市场参数是 `"sh" | "sz" | "bj"`，分页偏移从 0 开始。

```ts
import { createTdxClient } from "tstdx";

const client = createTdxClient();
```

## 证券列表

### 01. 查询证券数量

**参数说明：**

- `market`：`"sh" | "sz" | "bj"`

**调用方法：**

```ts
const count = await client.securityCount("sh");
```

### 02. 查询证券列表（单页）

**参数说明：**

- `market`
- `start`：偏移，默认 `0`

**返回值：** `TdxSecurity[]`，含 `symbol`、`name`、`decimalPoint`、`preClose` 等

**调用方法：**

```ts
const page = await client.securityList("sh", 0);
```

### 03. 查询完整证券列表

**参数说明：**

- `market`

**调用方法：**

```ts
const all = await client.stocks("sh");
```

内部按页取满 `securityCount` 为止，并校验总数、代码身份与分页重复；页数不足或出现重复会**抛错**。

### 04. 沪深 A 股列表

**参数说明：**

- `options.withIndustry`：是否附带行业代码，默认 `false`

**调用方法：**

```ts
const a = await client.allStocks();
const withIndustry = await client.allStocks({ withIndustry: true });
```

> 默认只承诺**沪深 A 股**。北交所需要单独调 `stocks("bj")`。"股票数量"、"全市场证券数量"、"板块成分条数"是三种不同口径，不要混用。

## 板块与文件

### 05. 文件元信息与分片

**参数说明：**

- `blockMeta(filename)`：返回大小与 MD5
- `fileChunk(filename, start, length = 30000)`：返回原始 `Buffer`

**调用方法：**

```ts
const meta = await client.blockMeta("block_gn.dat");
const chunk = await client.fileChunk("block_gn.dat", 0, 30000);
```

### 06. 完整报告文件

**参数说明：**

- `filename`
- `maxBytes`：默认最大 8 MiB

**调用方法：**

```ts
const bytes = await client.reportFile("tdxhy.cfg");
```

分片拼接完成后会与 `blockMeta` 的 MD5 比对，不符则抛错。

### 07. 板块分组与成分

**参数说明：**

- `filename`：默认 `"block_gn.dat"`，另支持 `block_zs.dat`、`block_fg.dat`

**调用方法：**

```ts
const groups = await client.blockInfo("block_gn.dat"); // 分组结构
const flat = await client.blockMembers("block_gn.dat"); // 扁平成分
```

### 08. 行业映射

**参数说明：** 无

**调用方法：**

```ts
const map = await client.industryMap();
console.log(map.get("sh600519"));
```

返回按**完整证券代码**索引的 `Map`。

## 区间与批量

### 09. 区间 K 线

见[标准行情接口 03](./quotes.md#03-获取-k-线数据闭区间)。

### 10. 批量取 K 线

**参数说明：**

- `symbols`：证券数组
- `period`（`barsBatch`）或固定日线（`kBatch`）
- `begin`、`end`
- `parallel`：并发数，默认 `4`

**返回值：** `BatchResult<TdxBar[]>[]`，**保留输入顺序**

```ts
type BatchResult<T> =
  | { symbol: string; status: "data" | "empty"; data: T }
  | { symbol: string; status: "error"; error: string };
```

**调用方法：**

```ts
const rows = await client.kBatch(["sh600519", "sz300750"], 20260101, 20260915);
for (const row of rows) {
  if (row.status === "error") console.warn(row.symbol, row.error);
  else console.log(row.symbol, row.data.length);
}

const minutes = await client.barsBatch(
  ["sh600519", "sz300750"],
  "5m",
  20260901,
  20260915,
  8,
);
```

单只失败不会让整批失败，错误逐项返回。批量使用独立连接，并保留调用方指定的节点、端口、超时与重试设置。

## 复权

### 11. 复权 K 线

**参数说明：**

- `symbol`
- `mode`：`"qfq"`（前复权）或 `"hfq"`（后复权）
- `begin`、`end`

**返回值：** `TdxAdjustedBar[]`，在 `TdxBar` 基础上附 `adjustment` 与 `adjustmentFactor`

**调用方法：**

```ts
const qfq = await client.kAdjusted("sh600519", "qfq", 20260101, 20260915);
const hfq = await client.kAdjusted("sh600519", "hfq", 20260101, 20260915);
```

**口径：**

- 只使用**查询截止日之前**的历史与除权事件。前复权锚定返回历史的**末日**，后复权锚定**首日**。
- 这**不是**随未来除权自动改写的"最新前复权"。换一个 `end` 会得到不同的因子。
- 现金分红、送转、配股按每股字段计算；跨停牌的多个事件依次处理。
- 原始成交量与成交额**保持不变**，只调整价格。

纯函数版本 `adjustBars` 可以脱离 TCP 使用。

## 资金流

### 12. 逐笔资金流分类

**参数说明：**

- `symbol`：仅支持 A 股成交量口径，其他证券抛错
- `lotSize`：一手股数，默认 `100`

**调用方法：**

```ts
const flow = await client.fundFlow("sh600519");
```

**口径：**

- 按单笔成交金额分档，主力阈值**严格大于** 100 万 / 20 万 / 4 万元。
- 方向 `2` 单列为中性；其他未知方向单列，不强行归入买卖。
- 会用五档的总成交量校验逐笔覆盖度；覆盖不完整时抛错，**不伪造零资金流**。

### 13. 历史资金流

**参数说明：**

- `symbol`、`start`（默认 0）、`count`（默认 3）

**调用方法：**

```ts
const raw = await client.historyFundFlowPage("sh600519", 0, 3); // category 22 原始
const safe = await client.historyFundFlow("sh600519", 0, 3); // 带逐笔回退
```

`historyFundFlow` 在原始接口不可用时回退到逐笔分类，并在结果里保留 `source` 与 `fallbackReason`，便于区分数据来源。

## 可脱离 TCP 的纯函数

这些函数直接从包入口导出，不需要客户端：

| 函数                                             | 说明                                                       |
| ------------------------------------------------ | ---------------------------------------------------------- |
| `adjustBars(bars, events, mode)`                 | 按除权事件计算复权因子与复权价；`mode` 为 `"qfq" \| "hfq"` |
| `computePriceLimits(symbol, preClose, options?)` | 按本地规则表计算涨跌停参考价                               |
| `classifyFundFlow(transactions, lotSize?)`       | 对逐笔成交做大小与方向分类                                 |
| `assertVolumeCoverage(...)`                      | 校验逐笔覆盖度是否够得上参照成交量                         |
| `marketStatistics(quote)`                        | 从一条五档记录派生涨跌平统计；**输入必须是 `sh880005`**    |
| `isAStock(symbol)` / `isIndexSymbol(symbol)`     | 代码归类判断                                               |

```ts
import { adjustBars, computePriceLimits, classifyFundFlow } from "tstdx";
```

它们没有 IO，适合直接写单元测试。
