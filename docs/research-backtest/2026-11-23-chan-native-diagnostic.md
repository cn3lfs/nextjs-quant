# 原生缠论五标的回测诊断（2026-11-23）

> 流程诊断，不是策略业绩；不做收益排名，不构成可交易结论。研究口径沿用[回测研究假设](2026-11-22-backtest-assumptions.md)。

## 1. 适配路径与冻结身份

- 策略键：`research-chan`（原生键 `NATIVE_STRATEGY_KEYS`，不进入 `study-rule` / 94 个通用 catalog key，不改变生产默认 `prepareLabBacktest` 拒绝 `chan-third-buy` 的行为）。
- 规则定义：复用 `StrategyObjectInput` 原生 `entry: { kind: "chan-third-buy", firstIndex }`、`exit: { maxBars: 5 }` 与 `instrument.external.chan: FrozenChanObservation[]` 走统一 `runPortfolio` 撮合与 12 项账本/费用/因果价诊断。
- 顺序不变量：先完成 `sh000001` 基准日历过滤（删除 `sz000001` 日历外周末 bar）与因果 GBBQ 价格证明刷新，再逐前缀串行调用本机 `CZSC64.dll` 捕获；支持隔离目录只读缓存（校验 `barsDigest`、首尾 `prefixHash`、`createNativeStudyRule` 与非符号链接常规文件）；CLI 退出前通过 `closeCzsc()` 关闭单例 `czsc-worker`。
- 原生 DLL 身份（五标的、三档完全一致）：
  - `dllHash`：`257ecbfce519ab8790d637386bf56b2860e5678f8854f86b4d4a3e82efb00cae`
  - `apiVersion`：`22`，`buildCommit`：`27de58024474`，`config / anchor`：`0 / 1`
  - `configId`：`stroke.rule=strict;stroke.endpoint=extreme;stroke.gap=none;segment.method=feature;segment.startBreak=keep;center.strokeFormation=entry;signals.publication=standard`
  - 信号价基：`gbbq-first-raw-anchor-1`（成交价一律为未复权原价）

## 2. 捕获规模与耗时

| 标的       | 窗口（自动起点 ~ 结束日） | 起点 / 基线               | 前缀数 | 首次 DLL 耗时 | 缓存读取耗时 | 审计 / 待确认 |
| :--------- | :------------------------ | :------------------------ | -----: | ------------: | -----------: | ------------: |
| `sh600519` | `2002-04-05 ~ 2026-11-20` | `2001-08-27 / 2002-04-04` |  5,908 |        104.8s |     42–131ms |      52 / 317 |
| `sz000001` | `1991-10-22 ~ 2026-11-20` | `1991-04-03 / 1991-10-21` |  8,341 |        217.2s |     96–206ms |      56 / 364 |
| `sh601318` | `2007-09-24 ~ 2026-11-20` | `2007-03-01 / 2007-09-21` |  4,590 |         73.5s |      40–56ms |      36 / 206 |
| `sz000333` | `2014-04-25 ~ 2026-11-20` | `2013-09-18 / 2014-04-24` |  2,999 |         36.8s |      25–26ms |      28 / 189 |
| `sz300750` | `2019-01-04 ~ 2026-11-20` | `2018-06-11 / 2019-01-03` |  1,911 |         19.3s |      17–23ms |       18 / 97 |

## 3. 五标的 × 三执行档诊断结果（30/30 ok，0 P0）

每档含 5 个 `research-chan` + 5 个 `hold` 对照单元，三档共 30/30 `ok`、0 `blocked`、0 `failed`。下表列示 `research-chan` 单元的核心过程指标（`base` 历史印花税成本、初始资金 1,000,000）：

| 标的       | 档位           | signals | fills | 成交额（元） | 费用（元） | 拒绝尝试 | 平仓 | `capacityClipped` | 主要拒绝与数据披露                     |
| :--------- | :------------- | ------: | ----: | -----------: | ---------: | -------: | ---: | ----------------: | :------------------------------------- |
| `sh600519` | `strict`       |      26 |    46 |   41,858,621 |  33,845.21 |        7 |   23 |                 0 | 滑点越界×7；跳过 2006 权证             |
| `sh600519` | `clamp`        |      26 |    52 |   44,780,222 |  35,873.14 |        0 |   26 |                 0 | 跳过 2006 权证                         |
| `sh600519` | `cap-0.5-clip` |      26 |    49 |   40,730,946 |  32,885.73 |        9 |   23 |                 8 | 滑点越界×9；早期低成交额笔被裁剪分笔   |
| `sz000001` | `strict`       |      28 |    50 |   33,168,276 |  26,380.29 |        4 |   25 |                 0 | 滑点越界×3、缺限价依据×1；删日历外 bar |
| `sz000001` | `clamp`        |      28 |    54 |   30,790,261 |  24,494.37 |        1 |   27 |                 0 | 缺限价依据×1；删日历外 bar             |
| `sz000001` | `cap-0.5-clip` |      28 |    52 |   30,321,156 |  24,056.35 |        4 |   25 |                 4 | 滑点越界×3、缺限价依据×1；早期笔裁剪   |
| `sh601318` | `strict`       |      17 |    30 |   31,975,573 |  23,968.54 |        3 |   15 |                 0 | 滑点越界×3                             |
| `sh601318` | `clamp`        |      17 |    34 |   34,043,824 |  25,831.79 |        0 |   17 |                 0 | 无拒绝                                 |
| `sh601318` | `cap-0.5-clip` |      17 |    30 |   31,975,573 |  23,968.54 |        3 |   15 |                 0 | 0.5% 容量档未触发裁剪                  |
| `sz000333` | `strict`       |      14 |    24 |   32,952,682 |  25,012.41 |        9 |   12 |                 0 | 缺限价依据×5、滑点越界×4               |
| `sz000333` | `clamp`        |      14 |    28 |   35,706,224 |  26,765.78 |        5 |   14 |                 0 | 缺限价依据×5                           |
| `sz000333` | `cap-0.5-clip` |      14 |    24 |   32,952,682 |  25,012.41 |        9 |   12 |                 0 | 0.5% 容量档未触发裁剪                  |
| `sz300750` | `strict`       |       9 |    18 |   16,923,209 |  12,410.75 |        0 |    9 |                 0 | 无拒绝                                 |
| `sz300750` | `clamp`        |       9 |    18 |   16,923,209 |  12,410.75 |        0 |    9 |                 0 | 无拒绝                                 |
| `sz300750` | `cap-0.5-clip` |       9 |    18 |   16,923,209 |  12,410.75 |        0 |    9 |                 0 | 0.5% 容量档未触发裁剪                  |

## 4. 核查结论与边界

- **无前视与撮合核对**：抽检 `sh600519` 首笔（`signalAt 2002-07-26` → `buy 2002-07-29` → `sell signalAt 2002-08-02` → `sell 2002-08-05`）与末笔（`signalAt 2026-09-08` → `buy 2026-09-09` → `sell signalAt 2026-09-15` → `sell 2026-09-16`），均严格为原生确认后次合法开盘入场、持有 5 交易日后次开盘平仓，12 项诊断与独立账本重放全绿。
- **执行与容量观察**：`sh600519` 与 `sz000001` 在 `cap-0.5-clip` 档分别产生 8 笔与 4 笔 `capacityClipped` 成交（集中于早期成交额较薄阶段），普通买入裁剪不重试、卖出按 pending 逐日重试；`sh601318`/`sz000333`/`sz300750` 在 100 万资金下未触及 0.5% 容量上限。
- **边界**：仅覆盖 5 只当前存续标的日线 `config=0 / anchor=1` 原生三买 + 固定 5 日持有，存在幸存者偏差，历史 ST/IPO 未认证，不代表完整缠论买卖体系或可信业绩。

## 5. 复现命令与产物

- 产物目录：`.test-data/backtest-diagnose/2026-11-23-chan-native/{five-strict,five-clamp,five-cap-0.5-clip}/run-*`（缓存：`.test-data/backtest-diagnose/2026-11-23-chan-native/cache`）。
- 复现命令（三档顺序执行）：

```powershell
$out = ".test-data/backtest-diagnose/2026-11-23-chan-native"
$cache = "$out/cache"
$data = ".test-data/backtest-diagnose/data"
$syms = "sh600519,sz000001,sh601318,sz000333,sz300750"
pnpm exec tsx scripts/backtest-diagnose.ts --tdx-root E:/new_tdx64 --symbols $syms --strategies "research-chan" --controls hold --mode per-symbol --start auto --end 2026-11-20 --initial 1000000 --cost base --data-dir $data --native-cache-dir $cache --out "$out/five-strict" --execution-profile strict
pnpm exec tsx scripts/backtest-diagnose.ts --tdx-root E:/new_tdx64 --symbols $syms --strategies "research-chan" --controls hold --mode per-symbol --start auto --end 2026-11-20 --initial 1000000 --cost base --data-dir $data --native-cache-dir $cache --out "$out/five-clamp" --execution-profile clamp
pnpm exec tsx scripts/backtest-diagnose.ts --tdx-root E:/new_tdx64 --symbols $syms --strategies "research-chan" --controls hold --mode per-symbol --start auto --end 2026-11-20 --initial 1000000 --cost base --data-dir $data --native-cache-dir $cache --out "$out/five-cap-0.5-clip" --execution-profile strict --max-participation 0.005 --capacity-policy clip
```
