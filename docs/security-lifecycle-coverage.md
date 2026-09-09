# 上市资料覆盖与缺名入口

2026-09-09，接续 `security-lifecycle-verification.md`，不是模块 A 全项验收。

## 当前改动

- `security-lifecycle-2` 校验并保存源 `index_name`，上市字段要求“新股上市日期”、退市字段要求“退市@退市日期”，且唯一 DATE 列和有效日期检查保留。相同列名、不同指标含义不能直接采纳；新版主动核验不复用 v1 缓存。
- `securityProfile` 返回 `{root, profile, lifecycle}`，日期资料不再依赖名称主档存在。页面在名称待补全时仍显示日期核验按钮和已有日期证据。
- 空响应明确报告“同花顺问财未返回该证券的上市资料”，不把空表解释为未上市/未退市。
- 问财请求支持显式 `retry` 请求头，本次两次改写探测均使用此标记并重新生成 trace；没有在生产中增加无效的自动重试。

## 真实来源与限制

| 查询证券 | 问财上市日期 | 退市日期 | 结果 |
|---|---|---|---|
| SH600519 | 2001-08-27 | 缺失 | 上海地点及完整身份通过 |
| SZ000001 | 1991-04-03 | 缺失 | 深圳地点及完整身份通过 |
| BJ920748 | 2023-08-16 | 缺失 | 北京地点及完整身份通过 |
| SH600005 | 未取得 | 未取得 | 空表，未写入日期 |

原始问句与返回见 `output/lifecycle-000001.SZ.json`、`lifecycle-920748.BJ.json`、`lifecycle-600005.SH.json`。退市样本去掉 A股条件、改为明确退市查询仍为空，见 `lifecycle-delisted-retry.json` 和 `lifecycle-delisted-explicit.json`，已停止继续重试。这些结果不足以证明空表原因；没有据此认定当前行情或历史退市状态。

相关字段脱敏后形成 `tests/fixtures/security-lifecycle-live.json`，用于离线重放。观察时间与历史可知时间依然分开；三个正常样本通过不等于覆盖所有证券及全部日期语义。

## 验证

- 144 文件 686 测试、类型检查、runtime/生产构建、桌面准备和冒烟通过；桌面临时库 `quant-desktop-JOKcAO`，源文件不变。
- 新增真实三地及空表重放、不同源指标语义拒绝、缺名日期可达、v1 缓存刷新和 retry trace 测试。
- 隔离库 `quant-lifecycle-missing-ui-vEMDCx`：只复制一份行情文件，无 TNF 名称主档，日期从真实响应重放，保留原始查询时间；自动分析关闭。
- 页面 `output/playwright/lifecycle-missing-cached.txt`、`lifecycle-missing-evidence.txt`：名称待补全、日期存在、核验入口可用、源指标名称及指纹可展开。
- `output/security-lifecycle-missing-http-verification.json`：profile 为 null，lifecycle 独立可达，重复核验记录不变，报告/投递共 0。

没有新增模型调用、真实通知或 EXE 打包。真实退市记录、历史证券池和交易状态继续处理。
