# 字段与单位

这一页是本包最重要的参考：**哪些字段的口径已经核验过、哪些没有**。协议里有不少语义未确认或已被复用的槽位，误用它们不会报错，只会安静地给出错误的数字。

判定等级：

- ✅ **已核验** — 与本地专业财务包或第三方实现逐项比对过，注明依据。
- ⚠️ **未核验** — 按兼容实现的惯例解码，能用但没有独立证据。
- ❌ **不可用** — 实测语义被复用或错位，不要使用。

## K 线周期

`KlineName` 的取值与协议编号：

| 名称      | 协议值 | 说明             |
| --------- | ------ | ---------------- |
| `5m`      | 0      | 5 分钟           |
| `15m`     | 1      | 15 分钟          |
| `30m`     | 2      | 30 分钟          |
| `60m`     | 3      | 60 分钟          |
| `day`     | 4      | 日线             |
| `week`    | 5      | 周线             |
| `month`   | 6      | 月线             |
| `1m`      | 7      | 1 分钟           |
| `1m-alt`  | 8      | 1 分钟的协议别名 |
| `day-alt` | 9      | 日线的协议别名   |
| `quarter` | 10     | 季线             |
| `year`    | 11     | 年线             |

```ts
import { KLINE, type KlineName } from "tstdx";
```

## 常量

| 常量                 | 值                        | 含义                 |
| -------------------- | ------------------------- | -------------------- |
| `PAGE_LIMIT`         | `800`                     | K 线与逐笔的单页上限 |
| `QUOTES_BATCH_LIMIT` | `80`                      | 五档单次请求上限     |
| `PORT`               | `7709`                    | 默认端口             |
| `MARKET`             | `{ sz: 0, sh: 1, bj: 2 }` | 市场编号             |

## 五档行情 `TdxQuote`

| 字段            | 类型             | 单位/口径                                    | 等级 |
| --------------- | ---------------- | -------------------------------------------- | ---- |
| `symbol`        | `string`         | 完整证券代码                                 | ✅   |
| `price`         | `number`         | 最新价，元                                   | ✅   |
| `preClose`      | `number`         | 昨收，元                                     | ✅   |
| `open`          | `number`         | 今开，元                                     | ✅   |
| `high` / `low`  | `number`         | 最高/最低，元                                | ✅   |
| `bids` / `asks` | `TdxLevel[]`     | 五档买/卖，`{ price, volume }`；指数为空数组 | ✅   |
| `quoteTime`     | `string \| null` | `HH:MM:SS.mmm`，该证券自身的更新时刻         | ⚠️   |
| `quoteTimeRaw`  | `number?`        | 原始时间编码，未知编码时保留                 | ⚠️   |
| `volume`        | `number`         | 成交量，**源单位未核验**                     | ⚠️   |
| `currentVolume` | `number`         | 最新一笔成交量，**源单位未核验**             | ⚠️   |
| `amount`        | `number`         | 成交额，**源单位未核验**                     | ⚠️   |
| `innerVolume`   | `number`         | 内盘，**源单位未核验**                       | ⚠️   |
| `outerVolume`   | `number`         | 外盘，**源单位未核验**                       | ⚠️   |
| `riseSpeed`     | `number`         | 涨速，百分数                                 | ⚠️   |

**价格精度**：股票与指数按两位小数解码；ETF 等其他证券先读取本源证券目录的 `decimalPoint`。目录缓存只在客户端存活期内复用，首次请求可能多一次目录查询。低层 `parseQuotes` 保留默认两位参数，**直接调用时必须自己传正确精度**。

**关于时间**：`quoteTime` 只有时分秒，**没有日期**，不能据此断定这条快照属于今天。未知编码会返回 `null`。

**关于量与额**：分时、K 线与报价的量额**不保证同一单位**。没有独立证据前不要换算成手或股，也不要用 `amount / volume` 当均价。同一条记录内部的比值（委比、外盘占比）不受影响，可以放心用。

## K 线 `TdxBar`

| 字段                              | 类型      | 单位/口径                         | 等级 |
| --------------------------------- | --------- | --------------------------------- | ---- |
| `date`                            | `string`  | 日线为 `YYYY-MM-DD`，分钟线含时间 | ✅   |
| `open` / `high` / `low` / `close` | `number`  | 元，未复权                        | ✅   |
| `volume`                          | `number`  | 成交量                            | ⚠️   |
| `amount`                          | `number`  | 成交额                            | ⚠️   |
| `upCount` / `downCount`           | `number?` | 仅指数 K 线：当期涨跌家数         | ⚠️   |

> 开盘价在**页内**逐条累加还原。整页一起用，不要跨页拼接后再截断。

## 复权 K 线 `TdxAdjustedBar`

在 `TdxBar` 基础上追加：

| 字段               | 类型             | 说明              |
| ------------------ | ---------------- | ----------------- |
| `adjustment`       | `"qfq" \| "hfq"` | 复权方向          |
| `adjustmentFactor` | `number`         | 该 bar 的复权因子 |

成交量与成交额**保持原值不变**，只有价格被调整。

## 分时 `TdxMinute`

```ts
type TdxMinute = { price: number; volume: number };
```

全天 240 条，盘中只到当前时刻。**不是 OHLC 蜡烛。** 指数分时的量字段尤其不能当成股数。

## 逐笔 `TdxTransaction`

| 字段        | 类型             | 说明                                    | 等级 |
| ----------- | ---------------- | --------------------------------------- | ---- |
| `time`      | `string`         | 只到分钟，协议没有更细的时间            | ✅   |
| `price`     | `number`         | 元                                      | ✅   |
| `volume`    | `number`         | 成交量                                  | ⚠️   |
| `direction` | `number`         | `0` 买、`1` 卖、`2` 中性、`8` 集合竞价  | ⚠️   |
| `orders`    | `number \| null` | 成交笔数；历史逐笔没有该字段，为 `null` | ✅   |

> 实测历史逐笔中出现过 `direction` 为 `5` 的记录，以及 15:00 之后的成交。本包**保留原值**，不擅自解释为普通盘中买卖。
>
> 价格在**页内**差分累加，按页取、按页用。

## 除权除息 `TdxXdxr`

| 字段                                      | 类型      | 单位/口径                                     | 等级 |
| ----------------------------------------- | --------- | --------------------------------------------- | ---- |
| `date`                                    | `string`  | `YYYY-MM-DD`                                  | ✅   |
| `category`                                | `number`  | 事件类型编号，见 `XDXR_CATEGORIES`            | ✅   |
| `name`                                    | `string`  | 事件类型名                                    | ✅   |
| `dividend`                                | `number?` | 每股现金分红，元（协议按每 10 股，已除以 10） | ✅   |
| `rightsPrice`                             | `number?` | 配股价，元                                    | ⚠️   |
| `bonusRatio`                              | `number?` | 送转比例                                      | ⚠️   |
| `rightsRatio`                             | `number?` | 配股比例                                      | ⚠️   |
| `shrinkRatio`                             | `number?` | 缩股比例（category 11/12）                    | ⚠️   |
| `strikePrice` / `warrantShares`           | `number?` | 权证相关（category 13/14）                    | ⚠️   |
| `floatSharesBefore` / `totalSharesBefore` | `number?` | 变动前股本，股（协议按万股，已 ×10000）       | ✅   |
| `floatSharesAfter` / `totalSharesAfter`   | `number?` | 变动后股本，股                                | ✅   |

返回协议原始事件，**不与本地文件或其他数据源自动合并**。

## 财务快照 `TdxFinance`

**这是全包最容易用错的类型，务必读完本节。**

换算倍率于 2026-09-15 与本地专业财务包 `gpcw*.dat` 交叉核对，样本 sh600519 / sz000002 / sz300750 / sz000001。

### ✅ 已核验

| 字段                | 单位       | 依据                                                            |
| ------------------- | ---------- | --------------------------------------------------------------- |
| 20 个金额字段       | **元**     | 协议原值是**千元**，包内 ×1000。四只标的全部吻合到 float32 精度 |
| `totalShares`       | **股**     | 协议按万股，包内 ×10000                                         |
| `floatShares`       | **股**     | 同上                                                            |
| `shareholders`      | **户**     | 不换算                                                          |
| `bookValuePerShare` | **元/股**  | 归母口径，不换算                                                |
| `ipoDate`           | `YYYYMMDD` | 上市日期                                                        |

20 个金额字段：`totalAssets`、`currentAssets`、`fixedAssets`、`intangibleAssets`、`inventory`、`receivables`、`currentLiabilities`、`longTermLiabilities`、`capitalReserve`、`netAssets`、`mainRevenue`、`mainProfit`、`operatingProfit`、`investmentIncome`、`totalProfit`、`afterTaxProfit`、`netProfit`、`undistributedProfit`、`operatingCashFlow`、`totalCashFlow`。

> **历史提醒**：本包早期按"万元 ×10000"换算，会让所有金额**放大 10 倍**。升级到修正后的版本时，任何缓存下来的金额都要重算。

### ❌ 不可用

`stateShares`、`founderShares`、`legalPersonShares`、`bShares`、`hShares`、`employeeShares`。

这些槽位的语义已被复用或错位，实测证据：

- sh600519 的"法人股"**大于总股本**
- sz000002 的"发起人股"**为负**
- "职工股"槽位的值实际等于**每股收益**（sh600519 为 35.57、sz300750 为 9.51、sz000002 为 -1.25，三只标的验证）

包内对它们**保留协议原值、不做任何换算**，调用方不得当作股本使用。

### ⚠️ 需要特别注意

| 字段                    | 说明                                                                                                     |
| ----------------------- | -------------------------------------------------------------------------------------------------------- |
| `updatedDate`           | **快照更新日，不是报告期。** 实测 20260815 / 20260828 / 20260829 / 20260914 均非季末，据此做年化没有依据 |
| `province` / `industry` | 通达信内部编码，本包不提供名称映射                                                                       |
| `reserved`              | 语义未确认，原值保留                                                                                     |

需要明确报告期，请用[本地财务包](./affair.md)；把协议快照定位到某一期的做法也在那一页。

### 银行股的缺口

协议对银行股不给流动负债：sz000001 的 `currentLiabilities` 与 `longTermLiabilities` 都是 0，sh601398 与 sh600036 只有长期负债。直接相加算资产负债率会得到 0.05% 这类明显错误的值。**流动负债缺失就是明细不全，应当整体留空。**

## 证券条目 `TdxSecurity`

| 字段                         | 类型        | 说明                                          | 等级 |
| ---------------------------- | ----------- | --------------------------------------------- | ---- |
| `symbol`                     | `string`    | 完整代码，如 `sh600519`                       | ✅   |
| `code`                       | `string`    | 六位数字                                      | ✅   |
| `market`                     | `TdxMarket` | `"sh" \| "sz" \| "bj"`                        | ✅   |
| `name`                       | `string`    | GBK 解码后的简称                              | ✅   |
| `decimalPoint`               | `number`    | 价格小数位，五档解码要用                      | ✅   |
| `volumeUnit`                 | `number`    | 成交量单位标记                                | ⚠️   |
| `preClose`                   | `number`    | 昨收，元                                      | ✅   |
| `unknown1` / `unknown2`      | `string`    | 语义未确认，原样保留                          | ⚠️   |
| `industryTdx` / `industrySw` | `string?`   | 仅 `allStocks({ withIndustry: true })` 时附带 | ⚠️   |

## F10 栏目 `TdxCompanyCategory`

```ts
type TdxCompanyCategory = {
  name: string; // 栏目名，如 "最新提示"
  filename: string; // 取正文时用
  start: number; // 起始偏移
  length: number; // 字节数；为 0 表示空栏目
};
```

## 板块 `TdxBlock`

```ts
type TdxBlock = {
  name: string;
  category: number;
  type: number;
  count: number;
  codes: string[]; // 六位数字
};
```

## 资金流 `TdxFundFlow`

在八个分档金额（`superIn`、`largeIn`、`mediumIn`、`smallIn`、`superOut`、`largeOut`、`mediumOut`、`smallOut`）之外还有：

| 字段             | 说明                           |
| ---------------- | ------------------------------ |
| `mainNetInflow`  | 主力净流入                     |
| `totalNetInflow` | 全部净流入                     |
| `neutralAmount`  | 方向为 2 的中性成交金额        |
| `unknownAmount`  | 其他未知方向的金额，单列不摊派 |
| `volume`         | 参与分类的成交量               |
| `records`        | 参与分类的逐笔条数             |
| `lotSize`        | 使用的一手股数                 |
| `source`         | `"transactions"`               |

历史资金流 `TdxHistoricalFlow` 另有 `date`、`source`（`"category22" | "transactions"`）与 `fallbackReason`。

分档阈值**严格大于** 100 万 / 20 万 / 4 万元。覆盖度不足时抛错，不伪造零资金流。

## 失败行为

本包在以下情况一律**抛错**，不返回空值冒充"没有数据"：

- 响应帧头或正文长度不符
- 分页取回的数量与声明的总数不一致
- 分页边界出现无法区分的重复记录
- 文件分片拼接后 MD5 与元信息不符
- 返回的证券代码与请求不符
- float 字段出现非有限数
- F10 请求字节数与返回长度不符

"抛错"和"空数组"是两种不同的事实，不要在调用方把它们合并处理。
