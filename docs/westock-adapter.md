# westock-data 适配边界

2026-09-15 更新：adapter 版本 2，原始 CLI 与应用分别复测，矩阵 21 项通过、3 项明确不支持。`pt` 板块已可在行情搜索框输入完整代码查看日/周图，分钟限制保留；交易、研究证券池与身份门禁未放宽。真实点击验收已进行，取代下文早期“浏览器不可用”的现状描述。量额存在指数尺度和源端取整差异，保留未知单位，不做跨源拼接；详情见[执行记录](data-source-execution.md)。

实现见 [westock-adapter.ts](../src/server/westock-adapter.ts)。依据本地最新版 `westock-data/SKILL.md`、`references/commands.md`、路由文档及当前 CLI 帮助，适配项目实际使用的境内行情和搜索。财务、宏观等其他技能维度不强转成行情数据。

## 调用与约束

```typescript
const result = await westockKlines({
  symbols: ["sh000001", "pt01801081", "sh510300"],
  period: "day",
  limit: 3,
  adjustment: "none",
}, signal);
```

- 支持带市场前缀的沪深北代码及板块 `pt` 代码；1–80个唯一代码。周期复用项目枚举，分钟转换为CLI的 `m5` 等写法。最多2000根，超出时明确记录截断说明。
- 默认不复权；日/周可显式前复权或后复权。分钟线按当前CLI帮助要求限定近28天、显式起止日及不复权。校验日期、未来区间、数量、返回证券、OHLC、重复时间和范围。
- 每个证券独立返回 `ok / unsupported / unavailable / invalid`。已证实的北交所、指数、板块分钟限制提前返回 `unsupported`；其他请求失败保留错误。日/周支持不能推导分钟支持。
- 单次批量逐个核对；遗漏时仅一次同源补查。服务失败、非法行情不反复重试，不静默跨源。不补造缺失数据。取消传入执行器并在补查前检查。
- 保留请求参数、起止时刻、版本、来源、复权、延迟提示及补查说明。成交量单位未独立核验，禁止与本地量直接拼接。
- `westockSearch` 使用 raw JSON，显式查询类型并校验代码/名称。身份模块继续核对市场和资产类型；行业模块继续限定申万一级，避免近似搜索误命中。

## 分层及使用方

`westock-data.ts`负责受限Node子进程、raw输出、结构化错误、超时及取消；`westock-bars.ts`负责行情解析；adapter负责命令参数、能力约束和批量完整性。应用子进程的bfq兼容仅作用于指定腾讯代理请求，不改写用户本地skill文件。

图表免费源、行业价格、CANSLIM指数和证券身份已接入。研究使用方通过 `requireWestockRows` 拒绝部分失败；图表单源失败向上传递。adapter版本参与相关证据指纹，图表来源说明保留版本。

板块代码在adapter和行业专用路径可用；通用行情页现有symbolSchema仍不接收pt代码。实时批量报价仍是独立链路，延迟K线不能替代实时行情。本轮没有将上述边界宣称为完整UI覆盖。

实网矩阵、复现命令及进一步要求见[数据源验收要求](data-source-requirements.md)。原始CLI混合请求遗漏ETF的问题由adapter补查兜底，保留原始缺陷事实。

## 独立原始 skill 对照（2026-09-14）

下面命令直接运行本地skill，不经过项目adapter或preload：

```powershell
$westockCli = 'C:\Users\jm\.agent-skills\skills\westock-data\scripts\index.js'
node $westockCli kline sz300750 --period day --limit 3
node $westockCli kline sz300750 --period day --limit 3 --fq bfq
node $westockCli kline sh000001,pt01801081,sh510300 --period day --limit 3 --raw
node $westockCli kline sh510300 --period day --limit 3 --raw
node $westockCli kline bj920002 --period m5 --start 2026-09-14 --end 2026-09-14 --limit 3 --raw
```

本次依次为：成功、SKILL_006_2、遗漏ETF、成功、KLINE_001。以上错误调用仍退出0，必须解析返回内容。默认参数成功与显式bfq失败并不矛盾。异常独立于本项目复现，只能定位到skill/上游链路，不能仅凭输出区分两者内部责任。项目自身的身份类型过窄及未检查批量完整性另外修复。

## 工程验证

相关8个文件54项测试通过；实网2项通过；typecheck、隔离数据目录下build（含runtime重建）、改动文件Prettier与diff检查通过。全量2158通过、17跳过、1失败：未改动的workflow-scripts测试在20:00后固定期待MarketOnly=True，与脚本按当前时间切换False冲突。本次未修改该无关逻辑，未提交、打包或使用生产库。真实浏览器控制不可用，未声称完成点击验收。
