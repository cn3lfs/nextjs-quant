# 底层编解码

`tstdx/wire` 导出协议帧的构造与解析函数。客户端只是这些函数加上连接管理的组合；需要自己控制连接、做协议实验或写离线测试时可以直接用它们。

```ts
import {
  buildQuotesRequest,
  parseQuotes,
  buildBarsRequest,
  parseBars,
} from "tstdx/wire";
```

包入口 `tstdx` 也重新导出了这些符号，两条路径等价。

## 用法

`build*` 返回完整请求帧的 `Buffer`；`parse*` 接收**解压后的响应正文**（不含帧头）。`TdxSession.request` 负责发送、收帧、解压。

```ts
import { TdxSession } from "tstdx";
import { buildQuotesRequest, parseQuotes } from "tstdx/wire";

const session = await TdxSession.connect("180.153.18.170", 7709, 3000);
try {
  const body = await session.request(buildQuotesRequest(["sh600519"]));
  const quotes = parseQuotes(body, ["sh600519"], new Map([["sh600519", 2]]));
  console.log(quotes[0].price);
} finally {
  await session.close();
}
```

## 行情

| 构造                                                          | 解析                                            | 说明                            |
| ------------------------------------------------------------- | ----------------------------------------------- | ------------------------------- |
| `buildQuotesRequest(symbols)`                                 | `parseQuotes(body, expected, decimals?)`        | 五档，单次上限 80 只            |
| `buildBarsRequest(symbol, kline, start, count)`               | `parseBars(body, kline, index?)`                | K 线；`index=true` 解析涨跌家数 |
| `buildMinuteRequest(symbol)`                                  | `parseMinutes(body, symbol, history, decimals)` | 当日分时                        |
| `buildHistoryMinuteRequest(symbol, date)`                     | 同上（`history=true`）                          | 历史分时                        |
| `buildTransactionsRequest(symbol, start, count)`              | `parseTransactions(body, history, decimals)`    | 当日逐笔                        |
| `buildHistoryTransactionsRequest(symbol, date, start, count)` | 同上（`history=true`）                          | 历史逐笔                        |
| `buildXdxrRequest(symbol)`                                    | `parseXdxr(body, symbol)`                       | 除权除息                        |
| `buildFinanceRequest(symbol)`                                 | `parseFinance(body, symbol)`                    | 财务快照                        |

> **精度参数必须自己传。** `parseQuotes`、`parseMinutes`、`parseTransactions` 的 `decimals` 保留了默认两位小数，只对股票与指数正确。ETF 等证券要先从证券目录取 `decimalPoint` 再传进来，否则价格会错一个数量级。客户端已经帮你做了这件事，直接调低层函数时没有。

## 目录与文件

来自 `catalog-wire`，同样由包入口导出：

| 构造                                                          | 解析                              |
| ------------------------------------------------------------- | --------------------------------- |
| `buildSecurityCountRequest(market)`                           | `parseSecurityCount(body)`        |
| `buildSecurityListRequest(market, start)`                     | `parseSecurityList(body, market)` |
| `buildCompanyCategoryRequest(symbol)`                         | `parseCompanyCategories(body)`    |
| `buildCompanyContentRequest(symbol, filename, start, length)` | `parseCompanyContent(body)`       |
| `buildBlockMetaRequest(name)`                                 | `parseBlockMeta(body)`            |
| `buildFileChunkRequest(filename, start, length)`              | `parseFileChunk(body)`            |
| `buildHistoryFlowRequest(symbol, start, count)`               | `parseHistoryFlow(body)`          |

另有不依赖网络的文件解析：

- `parseBlockFile(body, name?)` — 板块文件 → `TdxBlock[]`
- `parseIndustryFile(body)` — 行业文件

## 工具函数

| 函数                          | 说明                                  |
| ----------------------------- | ------------------------------------- |
| `uint(value, name, max, min)` | 整数范围校验，越界抛出带字段名的错误  |
| `marketId(market)`            | `"sh" \| "sz" \| "bj"` → 协议市场编号 |
| `dateNumber(date)`            | 整数 `YYYYMMDD` → `YYYY-MM-DD`        |
| `decodeGbk(bytes)`            | GBK 解码，用于证券简称与 F10 正文     |

## 帧与握手

| 导出                | 说明                                                           |
| ------------------- | -------------------------------------------------------------- |
| `SETUP_FRAMES`      | 建连后必须**按序发送**的三条握手帧，每条都要读走响应再发下一条 |
| `FRAME_HEADER_SIZE` | `16`                                                           |
| `BARS_REQUEST_SIZE` | `38`                                                           |

> 2026-09-15 在同一节点做过单变量实测：第三条握手帧（`0x0FDB`）末字节必须是 `0x05`。改成 `0x02` 时握手仍有应答，但 K 线与五档**没有正文**。该字段的正式语义未知，本包不引入客户端身份或账户数据。

**请求帧整包长度是敏感的。** 服务器对长度不符的请求既不报错也不回包，只会静默超时——单测验证字段偏移抓不到这类问题。K 线少 6 字节、除权和财务各多 2 字节都是实测超时才发现的。测试里锁死了每种请求的整包长度，改动 `build*` 时不要绕过它。

## 自己拼协议时的注意事项

- **五档、K 线、逐笔的价格是差分或累加编码**，必须整页一起解，跨页拼接后再截断会得到错值。
- **逐笔的 `start` 是从最新一笔往回数**的偏移，不是从开盘往后数。
- 响应正文可能是 zlib 压缩的，`TdxSession.request` 已处理；自己收帧要自己判断。
- 解析函数在长度不足、证券不符、数量不符时**抛错**，不要用 try/catch 吞掉换成空数组。
