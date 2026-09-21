# tstdx 行情能力补齐（2026-09-14）

按用户授权，在独立包 `packages/tstdx` 中补齐此前三库对照表的行情 TCP 能力。现有 9 个数据方法保留，新增 26 个数据查询/封装，共 35 个；另有连接、测速、心跳和纯计算工具。量化终端继续引用 workspace 包，新增能力可直接 `import { createTdxClient } from "tstdx"` 使用。

参照版本：[xmtdx 0.2.1](https://pypi.org/project/xmtdx/) 与 [rustdx-complete 1.11.0](https://crates.io/crates/rustdx-complete)。这不是 Python/Rust 方法名逐字兼容层；JavaScript 统一 Promise，不额外制造阻塞式同步客户端。范围沿用此前 TCP 对照，不包含指标库、日历、缓存、CLI 东方财富下载或 vipdoc 解析；另提供独立的历史财务包 Buffer 解析，不读本地路径。

## 对应关系

| xmtdx 方法                   | tstdx 实现                                      |
| ---------------------------- | ----------------------------------------------- |
| get_security_count           | securityCount                                   |
| get_security_list            | securityList                                    |
| get_security_list_all        | allStocks；完整市场证券另用 stocks              |
| get_market_stat              | marketStat                                      |
| get_security_quotes          | securityQuotes                                  |
| get_price_limits             | priceLimits / computePriceLimits                |
| get_security_bars            | barPage                                         |
| get_index_bars               | indexBarPage                                    |
| get_bars                     | bars                                            |
| get_bars_range               | barsRange                                       |
| get_minute_time_data         | minutes，保留直接协议口径，不优先替换为历史分时 |
| get_history_minute_time_data | historyMinutes                                  |
| get_transaction_data         | transactionPage                                 |
| get_history_transaction_data | historyTransactionPage                          |
| get_fund_flow                | fundFlow                                        |
| get_history_fund_flow        | historyFundFlow；直接入口 historyFundFlowPage   |
| get_xdxr_info                | xdxr                                            |
| get_finance_info             | finance                                         |
| get_company_info_category    | companyInfoCategories                           |
| get_company_info_content     | companyInfoContent                              |
| get_block_info               | blockInfo                                       |
| get_report_file              | reportFile                                      |
| mootdx `Affair.files`        | `parseFinancialFileList`                        |
| mootdx `Affair.parse`        | `parseFinancialReport`                          |

Rust 的 `stocks / bars_range / index_bars_range / k / bars_batch / k_batch / k_adjusted / f10 / BlockInfoMeta / BlockInfoChunk / block` 分别对应 `stocks / barsRange / indexBarsRange / k / barsBatch / kBatch / kAdjusted / f10 / blockMeta / fileChunk / blockMembers`。`industryMap` 和 `transactionsAll` 供完整下载与资金流封装使用。

连接能力采用 `heartbeat / reconnect / retry / startHeartbeat / stopHeartbeat / close`，测速/节点选择采用 `pingAll / fromBestHost`。测速统一完成三次协议握手后标记可连接，比仅端口探活更强；不会把握手成功当作行情内容有效。批量使用独立 worker，保留调用者的节点、端口、超时和重试设置。

## 完整性与口径

- 实际 xmtdx 历史资金流命令是 38 字节，源码注释曾写 40；固定请求样本核对后按实际发包实现。
- GBK 中文 F10 文件名采用已有依赖 `iconv-lite@0.7.3` 编码，解码在字节分片完整拼接后进行；不会在多字节边界截断中文。
- 列表校验总数、代码身份与分页重复；报告文件限制大小/分片数，板块校验 MD5；F10 校验请求字节数，短包抛错。
- K 线区间排序、去重、检测冲突与分页无进展；复权包含现金、送转、配股，停牌跨多个事件时依次更新参考价。前复权锚点为查询截止日的末根历史，避免引入截止日之后的事件；后复权锚定最早历史。量额不改，未改变终端原有策略复权。
- 资金流验证逐笔覆盖参照成交量，未知方向单列；历史 category 22 失败可尝试真实历史逐笔，保留回退原因。依赖也失败则报错，不把缺数据变成零。
- 涨跌停本地计算保留上市天数、名称及规则日期；上市天数缺失且 K 线不可用时抛错。仅常规 A 股规则参考，特殊重新上市/退市整理未建模；不替代完整历史交易规则引擎。2026-07-06 规则生效日期见[深交所交易规则](https://docs.static.szse.cn/www/lawrules/rule/allrules/bussiness/W020260424690713155663.pdf)；更早制度见包 README 限定。

## 实网验收

每个节点执行 55 个调用样本，含所有数据方法、市场/文件变体、连接控制和批量逐项状态。指定日期 20260914，股票 sh600000、分时 sz300750，指数 sh000001；不接其他提供商回退。

基准节点 180.153.18.170、124.71.187.122、115.238.56.198，共 165 个调用样本：96 个非空/控制成功、51 个异常、12 个空、6 个批量失败对象（12 个子结果均失败）。每节点分布均为 32/17/4/2，不能把此比例当作行情成功率。新增可用项目包括沪深首批及完整证券列表、沪深 A 股过滤、F10、三类板块、行业文件、完整历史逐笔。

180.153.18.170 的完整历史逐笔为 4406 条。三个节点行业文件均为 150332 字节，SHA-256 一致。观察到节点差异：124.71.187.122 的 F10 栏目正文 12796 字符，115.238.56.198 为 7961；历史逐笔分别 4262/4412 条。这些数字是该节点分页返回至空页的长度，并非跨节点全市场成交完整性认证；不得悄悄合并成一条权威序列。

仍不可用：北交所列表超时；K 线缺正文、五档返回零只，连带区间/复权/市场统计/资金流失败；category 22 为 2 字节短包；当日逐笔和 gpcw.txt/base_info.zip 盘后为空。可用性测试仍失败，不能宣称所有接口已实网可用，也不能据此确认官方改了哪部分协议。

额外尝试 180.153.18.171/172 的套件超过 240 秒预算，未完成的套件不计入基准结果。探针已改为每个调用完成后落盘，避免整体超时时丢失前面的证据。

## 验证与复现

- 固定请求/响应、非法输入、GBK、截断、MD5、分页、复权、资金流以及真实假 TCP 故障注入均为持久测试。
- 根测试入口 `tests/tstdx-package.test.ts` 引入新增包测试，终端全量回归不会遗漏这些用例。
- 实网复现见 [包 README](../../packages/tstdx/README.md)，原始输出只放临时目录 `quant-tstdx-complete-{primary,reference}-20260914.json`。
- 本次不发布 npm，不提交、推送或打包桌面程序，不修改用户维护的 MCP 入口。

### 最终检查

- 独立包离线测试 92 通过；终端受影响的定向回归 92 通过。
- 全量 2216 通过、22 跳过、1 失败。唯一失败仍为此前已有的 `tests/workflow-scripts.test.ts:155`：当前盘后下载模式为 MarketOnly=False，测试固定预期 True；未修改无关脚本。
- `pnpm typecheck` 通过；`pnpm build` 通过并重建 runtime worker，QUANT_DATA_DIR 使用临时隔离目录。
- 全项目格式检查、diff 检查、离线 frozen-lockfile 安装通过。
- 新 tarball 在仓库外临时消费者通过离线安装，原生 Node 导入成功，实际取得宁德历史分时 240 点（末价 337.11）、沪市证券数 27892、F10 正文 7961 字符。包依赖被正常安装，未借用量化终端的 import 路径。
- 真实可用性门禁保持失败，失败原因见上；完整历史保留深度、盘中连续稳定性与财务字段语义不因这些测试而自动通过。
