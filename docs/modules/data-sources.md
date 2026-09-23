# 数据源适配

## 职责与非职责

适配器负责将本地文件或供应商协议转换成有单位、日期、来源与失败语义的应用输入。它不决定策略、筛选或研究结论。内部跨供应商来源选择/能力组合归 market 或业务服务；协议实现留在 provider 子目录或独立 package。

## 入口与消费者

- `src/server/data-sources/` 按 `tdx/`、`cls/`、`hithink/`、`gf/`、`mx/`、`tstdx/` 等来源分组；实际目录以仓库为准。
- `packages/tstdx/` 是纯 TypeScript/Node 协议 package，本身不读通达信磁盘路径；工作台适配在 server data-sources。
- `src/components/data-sources/mx-data-query.tsx` 是供应商查询面板，目前没有活跃 route consumer；挂接页面前需确认调用额度与结果展示语义。
- `vendor/czsc/` 提供受版本/hash约束的 DLL，CZSC worker 经专用队列调用，不属于通用行情 adapter。
- 消费者为 market、screening、research、strategies、news；这些领域通过具名适配接口取数。

## 契约与依赖

每个响应应定义单位、交易日期、证券范围、覆盖和失败/空结果语义；未经验证的字段明确标注，坏包不得伪装成空数据。本地 TDX 与 Blocks 是只读来源；供应商层不依赖策略、回测或研究编排。密钥经仓库外 DPAPI，日志脱敏。

## 状态、副作用与验证

外部适配器可能请求网络；本地解析只读文件。部分查询会由调用方保存原始/脱敏响应、缓存或来源 hash。代表测试：[data-source-acceptance](../../tests/data-sources/data-source-acceptance.test.ts)、[tdx-daily-cache](../../tests/market-chart/market-data/tdx-daily-cache.test.ts)、[tdx-gbbq](../../tests/market-chart/market-data/tdx-gbbq.test.ts)、[tstdx-adapter](../../tests/market-chart/market-data/tstdx-adapter.test.ts)、[mcp-token-file](../../tests/persistence-infrastructure/mcp-token-file.test.ts)。

## 维护指南

新增 provider 需固定成功与非法输入 fixture，记录来源、单位和可用性证据；供应商失败不可被无声 fallback 成可信结果。MCP 根文件受保护，移动或编辑需用户明确交接。
