# 快速上手

所有查询都返回 Promise，证券代码统一是 `sh` / `sz` / `bj` 加六位数字，日期参数是整数 `YYYYMMDD`。

## 挑一个能用的服务器

内置节点会随时间失效。上线前先测一遍：

```ts
import { pingAll, probeHosts, fromBestHost } from "tstdx";

// 只测握手速度
console.table(await pingAll());

// 额外测证券数量、五档、日 K，区分"握手成功但没有行情正文"的节点
console.table(await probeHosts());

// 直接拿一个客户端；requireMarketData 才会按业务探测筛选
const client = await fromBestHost({ requireMarketData: true });
```

`pingAll` 只能证明端口和握手可用，**不能证明行情正文可用**。要求数据可用时必须用 `probeHosts` 或 `fromBestHost({ requireMarketData: true })`。

## 实时行情（五档盘口）

```ts
import { createTdxClient } from "tstdx";

const client = createTdxClient();
try {
  const quotes = await client.securityQuotes(["sh600519", "sz300750"]);
  for (const q of quotes)
    console.log(q.symbol, q.price, q.preClose, q.bids, q.asks);
} finally {
  await client.close();
}
```

一次最多 80 只，超过会自动分批。指数没有可交易盘口，`bids` / `asks` 返回空数组。

## K 线数据

```ts
// 单页：start=0 表示从最新一页往回取
const page = await client.barPage("sh600519", "day", 0, 800);

// 闭区间：自动分页、去重、按时间升序
const bars = await client.barsRange("sh600519", "day", 20260101, 20260915);

// 日线区间的别名
const daily = await client.k("sh600519", 20260101, 20260915);

// 指数走指数协议（记录尾部多出涨跌家数）
const index = await client.indexBarsRange(
  "sh000001",
  "day",
  20260101,
  20260915,
);
```

周期取值见[字段与单位](./api/fields.md#k-线周期)。K 线**不自动复权**，缺失的 bar 不补造。

## 复权

```ts
// 前复权锚定区间末日，后复权锚定首日；只使用截止日之前的除权事件
const qfq = await client.kAdjusted("sh600519", "qfq", 20260101, 20260915);
console.log(qfq[0]?.adjustmentFactor, qfq[0]?.close);
```

复权口径与"随未来除权自动改写的最新前复权"不同，详见[扩展接口](./api/extras.md#复权)。

## 分时与逐笔

```ts
// 当日分时；盘中只到当前时刻，全天 240 条
const today = await client.minutes("sh600519");

// 历史某日分时
const past = await client.historyMinutes("sz300750", 20260914);

// 逐笔：单页或完整取完
const page = await client.transactionPage("sh600519", 0, 800);
const all = await client.transactionsAll("sh600519", 20260914);
```

分时是价格/量序列，**不是 OHLC 蜡烛**，不要拿它当分钟 K 线用。

## 除权除息与财务快照

```ts
const events = await client.xdxr("sh600519");
const finance = await client.finance("sh600519");
console.log(finance.totalShares, finance.netProfit, finance.bookValuePerShare);
```

`finance` 的金额单位是**元**（协议原值为千元，包内已 ×1000），股本单位是**股**。`updatedDate` 是快照更新日，**不是报告期**。详见[字段与单位](./api/fields.md#财务快照-tdxfinance)。

## 证券列表与板块

```ts
const count = await client.securityCount("sh");
const all = await client.stocks("sh"); // 完整列表，内部分页
const a = await client.allStocks({ withIndustry: true }); // 沪深 A 股 + 行业代码

const blocks = await client.blockInfo("block_gn.dat"); // 概念板块分组
const members = await client.blockMembers("block_gn.dat"); // 扁平成分
```

## F10 公司资料

```ts
const categories = await client.companyInfoCategories("sh600519");
const first = categories.find((c) => c.length > 0)!;
const text = await client.companyInfoContent(
  "sh600519",
  first.filename,
  first.start,
  first.length,
);

// 或者一次取全部栏目（会逐个请求，较慢）
const everything = await client.f10("sh600519");
```

## 本地财务包（不走网络）

通达信客户端下载到本地的 `gpcw*.dat` 带明确报告期，解析是纯函数：

```ts
import { readFileSync } from "node:fs";
import { parseFinancialReport, parseFinancialFileList } from "tstdx";

const report = parseFinancialReport(
  readFileSync("E:/new_tdx64/vipdoc/cw/gpcw20260630.dat"),
  "gpcw20260630.dat",
);
console.log(report.reportDate, report.recordCount, report.fieldCount);

const record = report.records.find((r) => r.code === "600519");
console.log(record?.values.length); // 584 个 float

// 远程清单文件
const list = parseFinancialFileList(readFileSync("gpcw.txt"));
```

字段下标的含义**必须由调用方按报告版本自行核验**，本包不提供字段名映射。见[本地财务包](./api/affair.md)。

## 批量取数

```ts
// 保留输入顺序，逐项返回 data / empty / error，不会因为一只失败而整批失败
const rows = await client.kBatch(["sh600519", "sz300750"], 20260101, 20260915);
for (const row of rows)
  if (row.status === "error") console.warn(row.symbol, row.error);
  else console.log(row.symbol, row.data.length);
```

批量使用独立连接，并保留调用方指定的节点、端口、超时与重试设置。

## 关闭

```ts
await client.close();
```

`close` 会释放连接池并停止心跳。关闭后仍可继续使用同一个客户端，它会重新建连。
