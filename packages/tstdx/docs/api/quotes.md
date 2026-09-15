# 标准行情接口

下面的方法都挂在 `createTdxClient()` 返回的客户端上，全部返回 Promise。

**公共约定：**

- `symbol`：`sh` / `sz` / `bj` 加六位数字，例如 `"sh600519"`。
- `date`：整数 `YYYYMMDD`，例如 `20260914`。
- `start`：分页偏移，`0` 表示从**最新一页**开始往回数。
- `count`：单页条数，上限 `PAGE_LIMIT = 800`。

```ts
import { createTdxClient } from "tstdx";

const client = createTdxClient();
```

## 01. 查询实时行情（五档盘口）

可以一次获取**多**只证券。

**参数说明：**

- `symbols`：证券数组，例如 `["sh600519", "sz300750"]`。单次协议上限 `QUOTES_BATCH_LIMIT = 80`，超过会自动分批。

**返回值：** `TdxQuote[]`

**调用方法：**

```ts
const quotes = await client.securityQuotes(["sh600519", "sz300750"]);
console.log(quotes[0].price, quotes[0].bids, quotes[0].asks);
```

指数没有可交易盘口，`bids` 与 `asks` 返回空数组。价格精度：股票与指数按两位小数；ETF 等其他证券先读取本源证券目录的 `decimalPoint`，目录缓存只在客户端存活期内复用，所以首次请求可能多一次目录查询。

字段与单位见[字段与单位](./fields.md#五档行情-tdxquote)。

## 02. 获取 K 线数据（单页）

**参数说明：**

- `symbol`：证券代码
- `period`：周期名，见[K 线周期](./fields.md#k-线周期)
- `start`：偏移，`0` 为最新页
- `count`：条数，默认 `800`

**调用方法：**

```ts
// 股票
const bars = await client.barPage("sh600519", "day", 0, 800);

// 指数（记录尾部多出当期涨跌家数）
const index = await client.indexBarPage("sh000001", "day", 0, 800);

// 自动按代码选择股票/指数协议
const auto = await client.bars("sh000001", "day", 0, 800);
```

> 开盘价在**页内**逐条累加还原，所以整页要一起用，不能跨页拼接后再截断。

K 线**不做复权**，缺失数据不填造。

## 03. 获取 K 线数据（闭区间）

自动完成分页、去重、按时间升序。

**参数说明：**

- `symbol`、`period`
- `begin`、`end`：闭区间，整数 `YYYYMMDD`
- `options`：`{ kind?: "stock" | "index" | "auto"; maxPages?: number; pageSize?: number }`

**调用方法：**

```ts
const bars = await client.barsRange("sh600519", "day", 20260101, 20260915);

// 指数
const index = await client.indexBarsRange(
  "sh000001",
  "day",
  20260101,
  20260915,
);

// 日线区间的别名
const daily = await client.k("sh600519", 20260101, 20260915);
```

## 04. 查询分时行情

**参数说明：**

- `symbol`：证券代码

**调用方法：**

```ts
const points = await client.minutes("sh600519");
```

盘中只返回到当前时刻；盘后可能仍返回整日数据。全天 240 条。

## 05. 历史分时行情

**参数说明：**

- `symbol`：证券代码
- `date`：整数 `YYYYMMDD`

**调用方法：**

```ts
const points = await client.historyMinutes("sz300750", 20260914);
```

> 分时是 `{ price, volume }` 序列，**不是 OHLC 蜡烛**。不要用它冒充日线或分钟 K 线。指数分时的量额字段尤其不能当成股数。

## 06. 查询分笔成交（当日）

**参数说明：**

- `symbol`、`start`、`count`（默认 800）

**调用方法：**

```ts
const page = await client.transactionPage("sh600519", 0, 800);
```

> 分页方向已在真实服务器上实测：`start` 是**从最新一笔往回数**的偏移，`start=0` 是当前最新成交，`start` 越大越早。
>
> 价格在**页内**差分累加，按页取、按页用，不要跨页拼接后再截断。

## 07. 查询历史分笔

**参数说明：**

- `symbol`、`date`、`start`、`count`（默认 800）

**调用方法：**

```ts
const page = await client.historyTransactionPage("sh600519", 20260914, 0, 800);
```

历史逐笔没有成交笔数字段（`orders` 为 `null`）。

## 08. 取完整逐笔

**参数说明：**

- `symbol`
- `date`：省略则取当日，传入则取历史某日

**调用方法：**

```ts
const today = await client.transactionsAll("sh600519");
const past = await client.transactionsAll("sh600519", 20260914);
```

逐笔只有分钟级时间。分页边界上若出现无法区分的相同记录会**抛错**，本包不擅自去重。

## 09. 除权除息信息

**参数说明：**

- `symbol`：证券代码

**调用方法：**

```ts
const events = await client.xdxr("sh600519");
```

返回协议原始事件，**不与本地文件或其他数据源自动合并**。分红按每股口径（协议按每 10 股给出，包内已除以 10），股本一律换算成股（协议按万股给出）。

字段见[字段与单位](./fields.md#除权除息-tdxxdxr)。

## 10. 公司信息目录（F10 栏目）

**参数说明：**

- `symbol`：证券代码

**返回值：** `TdxCompanyCategory[]`，每项含 `name`、`filename`、`start`、`length`

**调用方法：**

```ts
const categories = await client.companyInfoCategories("sh600519");
```

## 11. 公司信息详情（F10 正文）

**参数说明：**

- `symbol`：证券代码
- `filename`、`start`、`length`：取自上一步的栏目条目

**返回值：** 完整 GBK 解码后的字符串

**调用方法：**

```ts
const first = categories.find((c) => c.length > 0)!;
const text = await client.companyInfoContent(
  "sh600519",
  first.filename,
  first.start,
  first.length,
);
```

内部按 65535 字节分片请求，**所有分片拼接完成后才做 GBK 解码**，不会在多字节边界截断中文。请求字节数与返回不符时抛错。

一次取全部栏目：

```ts
const everything = await client.f10("sh600519"); // 逐个栏目请求，较慢
```

> F10 内容与更新时点由节点决定，不同节点长度可能不同（实测同一只股票在两个节点上分别是 12796 与 7961 字符）。只作阅读参考，不要当作财报依据。

## 12. 读取财务快照

**参数说明：**

- `symbol`：证券代码

**调用方法：**

```ts
const finance = await client.finance("sh600519");
console.log(finance.totalShares, finance.netProfit, finance.bookValuePerShare);
```

**关键口径（必读）：**

- 金额字段单位是**元**（协议原值为千元，包内已 ×1000）。
- 总股本与流通股本单位是**股**（协议按万股给出，包内已 ×10000）。
- 股东户数是**户**，每股净资产是**元/股**，均不换算。
- 股本结构子项（国家股、发起人股、法人股、B 股、H 股、职工股）**语义已被复用或错位**，保留协议原值不换算，不得当作股本使用。
- `updatedDate` 是**快照更新日，不是报告期**，据此年化没有依据。

完整依据见[字段与单位](./fields.md#财务快照-tdxfinance)。需要明确报告期请改用[本地财务包](./affair.md)。

## 13. 全市场涨跌统计

**参数说明：** 无

**调用方法：**

```ts
const stat = await client.marketStat();
console.log(stat.up, stat.down, stat.neutral, stat.total, stat.unclassified);
```

**返回值：**

| 字段                      | 说明                                        |
| ------------------------- | ------------------------------------------- |
| `up` / `down` / `neutral` | 上涨 / 下跌 / 平盘家数                      |
| `total`                   | 总数                                        |
| `unclassified`            | `total - up - down - neutral` 的余数        |
| `unclassifiedMeaning`     | 固定为 `"residual-not-confirmed-suspended"` |
| `amount` / `volume`       | 统计证券自身的成交额与成交量                |
| `quoteTime`               | 快照时刻，可能为 `null`                     |

内部读取统计专用证券 `sh880005` 的五档记录，把 `price / preClose / low / high` 四个槽位解释为涨/跌/平/总家数。家数不是安全整数、为负，或者三项之和超过总数时**抛错**。

> `unclassified` 是**余数**，字段名与 `unclassifiedMeaning` 都明说了它"未经确认是否为停牌"。不要把它当成停牌家数，也不要摊到其他三项里。

纯函数版本 `marketStatistics(quote)` 可以脱离 TCP 使用，但**输入必须是 `sh880005` 的五档记录**，传别的证券会抛"市场统计证券身份不符"。

## 14. 涨跌停参考价

**参数说明：**

- `symbol`：证券代码
- `preClose`：昨收价
- `options`：`{ ruleDate?: number; name?: string; listedDays?: number }`

**调用方法：**

```ts
const limits = await client.priceLimits("sh600519", 1272.75);
const st = await client.priceLimits("sh600519", 10, {
  ruleDate: 20260601,
  name: "ST贵州",
});
```

> 这是**本地规则参考值，不是交易所下发价格**。规则表覆盖 2023-04-10 起的常规 A 股板块与首次上市窗口；更早日期返回 `unsupported`。缺少上市天数时会查询 K 线确认。重新上市、退市整理等特殊状态未建模。

纯函数版本 `computePriceLimits` 可以脱离 TCP 使用。
