# 成长 CANSLIM strict-PIT 五标的对照诊断（2026-11-23）

> 流程诊断与 PIT 信号漏斗对照，不是策略业绩；不做收益排名，不构成可交易结论。研究口径沿用[回测研究假设](2026-11-22-backtest-assumptions.md)，前置数据审计见[成长财务 PIT 审计](2026-11-22-growth-pit-audit.md)。

## 1. 适配路径与严格 PIT 口径

- 策略键：`research-canslim-pit`（PIT 策略键 `PIT_STRATEGY_KEYS`，不改动现有 94 个 catalog key 与纯价格代理 `research-growth`；生产默认 `prepareLabBacktest` 仍拒绝 `external`）。
- 严格对照设计：
  - **价格触发与退出完全对齐**：`research-canslim-pit` 与 `research-growth` 共用完全相同的 `canslim-high-98`（收盘上穿 52 周高点 98%，预热 300 根）价格入场条件，并直接复用 `study-rule` (`research-growth`, `exit`)，保证任意共同入场笔在完全相同的交易日平仓。
  - **strict PIT 财报门控（[canslim-pit-series.ts](../../src/server/financial/canslim-pit-series.ts)）**：
    - 仅接受满足 `announcementDate > reportDate` 且 `availableFrom > announcementDate` 的本地通达信财务快照，在交易日 `d` 仅可见 `availableFrom <= d` 的报告（**公告日当天严格不可见**，首次可见为公告后首个交易日）；
    - 按 `sourceFinancialValue` 映射 `FN311`（单季基本 EPS）、`FN230`（单季营收）、`FN232`（单季归母净利润）、`FN1`（年报基本 EPS）、`FN6`（年报普通 ROE，不混用 `FN281` 加权 ROE）、`FN7`（年报每股经营现金流）；缺值与未认证 `source-zero` 保持 `missing`，上年同期基数 `<= 0` 记 `conflict`（绝不除以负基数或借用旧季度回退）；
    - 采用 O'Neil CANSLIM 核心 C+A 三项硬门控（复用 `canslimEarnings`）：`C1` 单季 EPS 同比 ≥ 25%（≥6 分）、`A1` 3–5 年连续正年报 EPS CAGR ≥ 25%（≥6 分）、`A2` 最新年报普通 ROE ≥ 17%（≥5 分）。

## 2. 财务 PIT 信号漏斗对照（窗口内统计）

| 标的       | strict 报告数 | 报告期范围                | 合格交易日 | 缺失日 | 负基数/冲突日 | 纯价格触发（`research-growth`） | PIT 过滤后信号（`research-canslim-pit`） | 财务包占位/问题数 |
| :--------- | ------------: | :------------------------ | ---------: | -----: | ------------: | ------------------------------: | ---------------------------------------: | ----------------: |
| `sh600519` |            95 | `2001-12-31 ~ 2026-09-30` |        358 |  1,239 |             0 |                             163 |                                       15 |                27 |
| `sz000001` |           114 | `1994-06-30 ~ 2026-09-30` |        449 |  3,764 |            33 |                             122 |                                        0 |                27 |
| `sh601318` |            84 | `2003-12-31 ~ 2026-09-30` |          0 |      0 |           193 |                              78 |                                        0 |                27 |
| `sz000333` |            54 | `2013-06-30 ~ 2026-09-30` |          0 |    300 |             0 |                              88 |                                        0 |                27 |
| `sz300750` |            36 | `2015-12-31 ~ 2026-09-30` |        378 |     21 |           410 |                              40 |                                        1 |                29 |

- 组合窗口（`2018-06-11 ~ 2026-11-20`）：`research-growth` 共产生 306 个信号 / 237 笔成交（`strict`），加入 strict PIT C+A 门控后收口为 2 个信号 / 2 笔成交（全部来自 `sz300750` 高增长期）。
- 该漏斗与基本面直觉一致：成熟蓝筹（`sh601318`、`sz000333`、`sz000001` 近十年）极少同时满足“单季 EPS ≥ 25% + 3–5 年年报 EPS CAGR ≥ 25% + ROE ≥ 17%”，也再次印证纯价格代理 `research-growth` 不能当作真实 CANSLIM。

## 3. 五标的 × 三执行档诊断汇总（51/51 ok，0 P0）

`strict` 18/18 `ok`、`clamp` 18/18 `ok`、`cap-0.5-clip`（单标的）15/15 `ok`，0 `blocked`、0 `failed`。下表列示单标的 `research-growth` vs `research-canslim-pit` 过程指标对比（`base` 成本，初始资金 1,000,000）：

| 策略                   | 标的                                 | 档位                                | signals | fills | 成交额（元） | 费用（元） | 拒绝 | 平仓 | `capacityClipped` |
| :--------------------- | :----------------------------------- | :---------------------------------- | ------: | ----: | -----------: | ---------: | ---: | ---: | ----------------: |
| `research-growth`      | `sh600519`                           | `strict`                            |     273 |   206 |  429,340,906 | 352,954.99 |   26 |  103 |                 0 |
| `research-growth`      | `sh600519`                           | `clamp`                             |     263 |   216 |  304,645,829 | 250,195.61 |    2 |  108 |                 0 |
| `research-growth`      | `sh600519`                           | `cap-0.5-clip`                      |     296 |   232 |  313,579,482 | 257,796.46 |   24 |  101 |                55 |
| `research-canslim-pit` | `sh600519`                           | `strict`                            |      24 |    18 |   19,297,663 |  15,819.85 |    3 |    9 |                 0 |
| `research-canslim-pit` | `sh600519`                           | `clamp`                             |      23 |    20 |   19,273,411 |  15,728.90 |    0 |   10 |                 0 |
| `research-canslim-pit` | `sh600519`                           | `cap-0.5-clip`                      |      24 |    18 |   19,297,663 |  15,819.85 |    3 |    9 |                 0 |
| `research-growth`      | `sz300750`                           | `strict`                            |      66 |    52 |   73,113,244 |  54,710.71 |    2 |   26 |                 0 |
| `research-growth`      | `sz300750`                           | `clamp`                             |      67 |    54 |   75,526,207 |  56,141.69 |    0 |   27 |                 0 |
| `research-growth`      | `sz300750`                           | `cap-0.5-clip`                      |      66 |    52 |   73,113,244 |  54,710.71 |    2 |   26 |                 0 |
| `research-canslim-pit` | `sz300750`                           | `strict` / `clamp` / `cap-0.5-clip` |       2 |     2 |    1,765,000 |     941.01 |    0 |    1 |                 0 |
| `research-canslim-pit` | `sz000001` / `sh601318` / `sz000333` | 三档                                |       0 |     0 |            0 |       0.00 |    0 |    0 |                 0 |

（`research-growth` 其余三标的 `sz000001`/`sh601318`/`sz000333` 在 `strict`/`clamp`/`cap-0.5-clip` 全通过，详见产物目录 `report.md`。）

## 4. 边界披露与复现

- **数据边界**：本地通达信财务包为每报告期单快照，不含首次披露与事后重述/更正版本历史；公告日来自本地 `FN314`，未与交易所公告原文交叉核对；27–29 条财务包问题全部为 2000 年以前的未下载空占位包；仅覆盖 5 只当前存续标的，存在幸存者偏差。
- **产物目录**：`.test-data/backtest-diagnose/2026-11-23-canslim-pit/{strict,clamp,cap-0.5-clip}/run-*`。
- **复现命令**：

```powershell
$out = ".test-data/backtest-diagnose/2026-11-23-canslim-pit"
$data = ".test-data/backtest-diagnose/data"
$syms = "sh600519,sz000001,sh601318,sz000333,sz300750"
$strats = "research-growth,research-canslim-pit"
pnpm exec tsx scripts/backtest-diagnose.ts --tdx-root E:/new_tdx64 --symbols $syms --strategies $strats --controls hold --mode both --start auto --end 2026-11-20 --initial 1000000 --cost base --data-dir $data --out "$out/strict" --execution-profile strict
pnpm exec tsx scripts/backtest-diagnose.ts --tdx-root E:/new_tdx64 --symbols $syms --strategies $strats --controls hold --mode both --start auto --end 2026-11-20 --initial 1000000 --cost base --data-dir $data --out "$out/clamp" --execution-profile clamp
pnpm exec tsx scripts/backtest-diagnose.ts --tdx-root E:/new_tdx64 --symbols $syms --strategies $strats --controls hold --mode per-symbol --start auto --end 2026-11-20 --initial 1000000 --cost base --data-dir $data --out "$out/cap-0.5-clip" --execution-profile strict --max-participation 0.005 --capacity-policy clip
```
