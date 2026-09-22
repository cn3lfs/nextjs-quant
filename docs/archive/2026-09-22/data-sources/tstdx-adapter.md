# tstdx adapter

最新为 `tstdx-adapter-2`：ETF 分时/成交/五档按证券目录精度解码，指数盘口清空，未知报价时间返回 null 并保留原始编码；指数分时量不冒充股/手。10 个品种日/周/5 分钟 30 组通过，详情及未确认字段见[执行记录](../../../2026-09-15/02-data-source-execution.md)。握手及 adapter 基线已提交 `eb53365`；本轮精度修复尚未提交。

2026-09-15 更新：第三条握手末字节修复后，43 个客户端主站日 K/五档恢复，应用十个日 K 样本通过；见[握手修复与对照证据](../../../2026-09-15/01-tstdx-handshake-fix.md)。下文早期失败结果保留其时点。

前置独立包改动已提交为 `40b8ba2`。本阶段按用户要求实现与 westock-data 相近的终端适配层；独立 tstdx 包仍不依赖终端。

## 接口与接入

`src/server/data-sources/tstdx/tstdx-adapter.ts` 提供：

- `tstdxKlines({symbols, period, limit?, adjustment?, start?, end?}, signal?)`：最多 80 个证券、20000 根，图表全部七个周期；按输入顺序返回 `ok / unsupported / unavailable / invalid`。含版本、真实来源、请求参数/开始结束时间/错误、单位说明及逐项历史边界。
- `requireTstdxRows(result)`：要求整批成功的消费者可使用；有失败即抛错，不静默漏掉证券。
- `tstdxSearch({keyword, type?, limit?, markets?}, signal?)`：股票、ETF、指数、板块查询；默认沪深，可显式北交所。行情目录按完整市场证券列表查询，无跨提供商回退。暂未提供债券/期货/外汇搜索，不猜测类别。
- `tstdxMinutes({symbol, date?}, signal?)`：当日/历史分时点序列，独立于 OHLC。历史日期是请求日期；当日协议无源日期，返回 `date=null` 和未核验标记，不把请求时间冒充数据日期。

原 `pytdxChartHistory` 已改为调用 adapter，UI 选择 tstdx 即沿此路径读取；保留持久设置 key `pytdx`、来源 `tdx-7709` 及既有自动优先级。其他原始协议 API 保留，未把搜索或分时伪装成图表 K 线。证券搜索 helper 可独立调用，未新增搜索页面或改变现有本地目录搜索。

```ts
import { tstdxKlines, tstdxSearch, tstdxMinutes } from "./tstdx-adapter";
const result = await tstdxKlines({
  symbols: ["sh600000", "sz300750"],
  period: "day",
  limit: 2000,
});
const names = await tstdxSearch({ keyword: "300750", markets: ["sz"] });
const points = await tstdxMinutes({ symbol: "sz300750", date: "2026-09-14" });
```

每次调用使用自己的客户端并释放；采用终端当前环境变量/持久节点设置。取消会关闭自己持有的连接并停止后续证券请求，不关闭其他调用的客户端。

## 与腾讯的边界差异

- tstdx 股票、指数分别使用对应协议，通达信数字板块指数走指数协议。腾讯 `pt` 板块代码返回 unsupported，不猜测跨源映射。
- 板块搜索来自成分文件，返回 `type=sector-members-only`，code 是文件名加板块名的目录标识，不是可用于 K 线的证券代码。
- 复权只支持 A 股日线，沿独立包每股除权事件算法；前复权锚定查询截止日的历史末端、后复权锚定历史起点。先读取前置历史再截取区间，量额不改；终端策略原有简化复权不变。其他品种/周期的复权明确 unsupported。
- 缺正文/空结果返回 unavailable；已收到的非法 OHLC、日期、重复或无进展分页返回 invalid。分页截断不能冒充完整历史；limit 截取后不宣称历史耗尽。
- amount/volume 未独立核验单位，不做股/手倍数猜测。这里只保证适配契约，不宣称公开 TCP 接口恢复可用。

## 验证

- 定向 31 项通过：五个股票市场、指数/板块/ETF 路由、七周期、非法参数、OHLC、日期、分页重复、复权、部分失败、取消、搜索与分时边界。已用空数据、坏 OHLC、重复分页和取消输入证明检查会失败。
- 实网 2026-09-14：宁德历史分时 240 点，末价 337.11；搜索取得宁德时代、159915 ETF、创业板指，以及“芯片”相关 6 个板块目录项。
- 同次 10 个 K 线样本（沪/深/创/科/北、两指数、两 ETF、通达信板块）全部因上游无正文返回 unavailable；腾讯 pt 样本 unsupported。实网可用性断言保持失败，未绕开。
- 原始实测输出保留临时目录 `quant-tstdx-adapter-20260914.json`，不写生产数据库。

复现：

```powershell
$env:QUANT_DATA_DIR = Join-Path $env:TEMP 'quant-tstdx-adapter-check'
$env:QUANT_TSTDX_ADAPTER = '1'
$env:QUANT_TSTDX_ADAPTER_REPORT = Join-Path $env:TEMP 'tstdx-adapter.json'
pnpm exec vitest run tests/tstdx-adapter-live.test.ts
```

真实 UI 操作未复验；图表接入由受影响集成测试与应用构建验证，不能替代手动切源验收。无依赖新增、推送或桌面打包；本阶段 adapter 尚未提交。

### 最终检查（2026-09-15 凌晨）

- 最终代码全量回归：2240 通过、23 跳过、0 失败；其中实网测试默认跳过，显式实网失败结果仍见上。
- `pnpm typecheck`、`pnpm build`（含 runtime 重建）、全项目格式检查及 diff 检查通过。构建使用隔离 QUANT_DATA_DIR。
- 前一轮运行期间尚有测试适配修改，旧模拟接口及日期断言曾失败；最终定向与全量重跑已通过。此前盘后下载脚本 MarketOnly 失败本次凌晨未复现，未修改该脚本或宣称修复时间相关行为。
