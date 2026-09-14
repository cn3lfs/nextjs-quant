# tstdx

独立的 TypeScript / Node.js 通达信 7709 TCP 行情客户端。仅依赖 `iconv-lite` 编码 F10 的 GBK 中文文件名，不依赖 Next.js、SQLite、量化终端或 vipdoc。本地文件解析不属于本包。

要求 Node.js 22 或更新版本。当前为本地独立包，`private: true` 防止误发布；尚未发布到 npm。

## 使用

```ts
import { createTdxClient, type TdxMinute } from "tstdx";

const client = createTdxClient({ hosts: ["180.153.18.170"], port: 7709 });
try {
  const points: TdxMinute[] = await client.historyMinutes("sz300750", 20260914);
  console.log(points.length, points.at(-1));
} finally {
  await client.close();
}
```

每个 client 独立管理连接，建立连接时依次尝试节点；同连接请求串行执行。`hosts` 也可传 `() => string[]`，在重新建连时读取最新节点。默认内置节点，不自动读取环境变量或数据库；持久设置由使用方负责。

默认端口 7709，池化建连单节点超时最多 3 秒，总建连预算 15 秒。关闭 client 后仍可再次使用并重新建连。坏包会废弃连接，下一次请求从下一节点开始。`requestRetries` 默认 0，可设 1—3 开启同次请求的有限重试；`timeoutMs` 与 `connectBudgetMs` 可配置。批量任务使用独立连接并保留指定节点。

## 数据接口

证券格式为 `sh` / `sz` / `bj` 加六位数字；日期参数是整数 `YYYYMMDD`。

| 方法                     | 参数                               | 返回                         |
| ------------------------ | ---------------------------------- | ---------------------------- |
| `securityQuotes`         | `symbols: string[]`                | 五档报价数组，超过 80 只分批 |
| `barPage`                | `symbol, period, start, count=800` | 股票 K 线                    |
| `indexBarPage`           | `symbol, period, start, count=800` | 指数 K 线，含涨跌家数        |
| `minutes`                | `symbol`                           | 当日分时价格/量序列          |
| `historyMinutes`         | `symbol, date`                     | 指定日期分时价格/量序列      |
| `transactionPage`        | `symbol, start, count=800`         | 当日成交页                   |
| `historyTransactionPage` | `symbol, date, start, count=800`   | 历史成交页                   |
| `xdxr`                   | `symbol`                           | 除权除息、股本事件           |
| `finance`                | `symbol`                           | 最新财务快照                 |
| `close`                  | 无                                 | 释放该客户端连接             |

`period` 支持 `1m / 5m / 15m / 30m / 60m / day / week / month / quarter / year`，另有协议别名 `1m-alt`（8）与 `day-alt`（9）。`start=0` 从最新页开始；缺失数据不填造，不自动复权。分时不是 OHLC K 线，不可用它冒充日线或分钟蜡烛图。

底层入口包括 `TdxSession`、`createQuotesPool` 和 `tstdx/wire` 编解码函数；结果类型从 `tstdx` 导出。协议字段与单位来自兼容实现，仍需按业务口径验收。

## 当前实网边界（2026-09-14）

- 三个节点上历史分时、当日分时、历史成交、除权、财务有数据。
- 历史分时与 xmtdx、rustdx-complete 的价格和量逐点一致。
- K 线与五档失败，当日成交盘后为空；实现了方法不代表公网可用。
- 宁德时代当日/历史分时在午休交界处有两个点不同，Rust 直接接口同样如此；不混合两种序列。
- 财务存在股本/金额字段口径疑点；非空返回不代表财务质量已通过。历史成交方向出现 5、8 等值，保留原值。
- 证券列表、F10、板块文件、资金流、全市场统计和区间/复权封装已实现。沪深完整列表、F10、三类板块和行业文件实网有数据；北交所列表超时，资金流与复权依赖的报价/K 线仍失败。

## 扩展 API

所有查询均返回 Promise。市场参数是 `"sh" | "sz" | "bj"`，分页偏移从 0 开始。

| 方法                                    | 参数与结果                                                                                                         |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `securityCount / securityList / stocks` | `(market)`、`(market, start=0)`、`(market)`；数量、单页、完整列表                                                  |
| `allStocks`                             | `({withIndustry?: boolean})`；沪深 A 股，可附行业代码；北交所另查 `stocks("bj")`                                   |
| `companyInfoCategories`                 | `(symbol)`；F10 栏目及文件、起点、字节数                                                                           |
| `companyInfoContent`                    | `(symbol, filename, start, length)`；完整 GBK 解码文本                                                             |
| `f10`                                   | `(symbol)`；全部栏目与内容                                                                                         |
| `blockMeta / fileChunk`                 | `(filename)`、`(filename, start, length=30000)`；文件元信息/原始 Buffer                                            |
| `reportFile`                            | `(filename, maxBytes?)`；完整 Buffer，默认最大 8 MiB                                                               |
| `blockInfo / blockMembers`              | `(filename="block_gn.dat")`；分组板块/扁平成分，支持 gn、zs、fg                                                    |
| `industryMap`                           | `()`；按完整证券代码索引的 Map                                                                                     |
| `bars`                                  | `(symbol, period, start=0, count=800)`；自动选择股票/指数协议                                                      |
| `barsRange / indexBarsRange`            | `(symbol, period, begin, end, options?)`；闭区间、去重排序、完整分页                                               |
| `k`                                     | `(symbol, begin, end)`；日线区间                                                                                   |
| `barsBatch / kBatch`                    | `(symbols, period, begin, end, parallel=4)` / `(symbols, begin, end, parallel=4)`；保留顺序及逐项 data/empty/error |
| `kAdjusted`                             | `(symbol, "qfq"或"hfq", begin, end)`；附复权因子，原始量额保持                                                     |
| `marketStat`                            | `()`；上涨/下跌/平盘/总数及未分类余数                                                                              |
| `priceLimits`                           | `(symbol, preClose, options?)`；涨跌停参考价；缺上市天数时查询 K 线确认                                            |
| `transactionsAll`                       | `(symbol, date?)`；完整当日/历史逐笔                                                                               |
| `fundFlow`                              | `(symbol, lotSize=100)`；逐笔分类资金流并验证成交量覆盖                                                            |
| `historyFundFlowPage / historyFundFlow` | `(symbol, start=0, count=3)`；category 22 原始查询/带逐笔回退的查询                                                |
| `heartbeat / reconnect / retry`         | `()` / `()` / `(operation, attempts=2)`；协议探活、重连、有界重试                                                  |
| `startHeartbeat / stopHeartbeat`        | `(intervalMs=60000, onError?)` / `()`；保活启停；close 自动停止                                                    |

模块级 `pingAll(hosts?, {port?, timeoutMs?, parallel?})` 返回节点握手状态、耗时与错误；`fromBestHost(options?)` 按测速建立客户端。纯函数 `adjustBars / computePriceLimits / classifyFundFlow / marketStatistics` 可以脱离 TCP 单独使用。

### 数据口径与失败行为

- 复权只使用查询截止日之前的历史与除权事件：前复权锚定返回历史的末日，后复权锚定首日；不是随未来除权自动改写的最新口径。现金分红、送转、配股按每股字段计算，跨停牌多事件依次处理；这与终端策略的简化复权独立，未替换策略算法。
- 涨跌停是本地规则参考值，非交易所下发价格。规则表覆盖 2023-04-10 起的常规 A 股板块和首次上市窗口，主板 ST 2026-07-06 前后分别 5%/10%；更早日期返回 unsupported。默认日期为上海当前日期，历史查询应明确 `ruleDate`、当日名称、上市交易天数。重新上市、退市整理等特殊状态未建模。规则变更需维护本包，不能直接当完整历史交易规则引擎。
- 资金流为成交大小与方向分类，主力阈值严格大于 100 万/20 万/4 万元；股票默认一手 100 股。方向 2 单列中性，其他未知方向单列，缺量/空成交不伪造完整资金流。历史回退保留 source 和 fallbackReason。
- 全列表、F10、文件和成交有边界/完整性检查；坏包、提前截断、重复分页或 MD5 不符抛错。逐笔仅有分钟级时间，分页边界遇到无法区分的相同记录也抛错，不擅自去重。
- 默认列表只承诺沪深 A 股。股票、全市场证券、板块数量与扁平成分条数是不同口径。

## 独立开发

把本目录单独复制为项目即可开发：

```powershell
pnpm install
pnpm build
pnpm test
pnpm typecheck
```

构建产物为 `dist/*.js` 和 `dist/*.d.ts`，不提交生成产物。离线测试只使用固定样本及本地假 TCP 服务器，不访问公网，也不需要量化终端数据库。`tests/probes/` 是显式执行的三库实网比较工具，见该目录说明。

本仓库通过 pnpm workspace 的 `tstdx: workspace:*` 引入。量化终端的节点数据库与环境变量优先级保留在 `src/server/tdx-quotes.ts`，由其传入 `hosts` 函数。

导出包可执行 `pnpm pack --pack-destination <临时目录>`，使用方通过本地 tarball 安装；发布注册表需另行授权。

显式全接口实网验收（固定样本日期 2026-09-14；上游空回包会使可用性断言失败）：

```powershell
$env:TSTDX_LIVE = '1'
$env:TSTDX_LIVE_HOSTS = '180.153.18.170,124.71.187.122,115.238.56.198'
$env:TSTDX_LIVE_REPORT = Join-Path $env:TEMP 'tstdx-live.json'
pnpm exec vitest run --config vitest.config.ts tests/full-live.test.ts
```
