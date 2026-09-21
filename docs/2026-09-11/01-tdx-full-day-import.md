# 完整日线包检查与导入

用于日线初始化、缺文件补齐和明确选择的同日期修复。源ZIP和通达信目录只读，导入结果保存到应用数据目录。当前只支持Windows，真实供应商ZIP布局仍待验收。

先检查所选证券覆盖、日期和文件hash，再导入。同一批所选证券缺失时整批不发布。一个批次最多6000只，解压日线总量上限256MB；超过时拆分证券清单。

开发验证必须设置独立目录，例如：

```powershell
$env:QUANT_DATA_DIR = Join-Path $env:TEMP ('quant-full-import-' + [guid]::NewGuid().ToString('N'))
pnpm runtime:build
node runtime/workflow-runner.cjs --inspect-full-day 'C:\Users\jm\Downloads\hsjday.zip' 'sh600519,sz000001,sh000001'
node runtime/workflow-runner.cjs --import-full-day 'C:\Users\jm\Downloads\hsjday.zip' 'sh600519,sz000001,sh000001'
```

检查输出缺失证券时退出2；导入失败退出1。导入成功返回不可变快照ID。隔离目录中的导入不会出现在正式桌面应用中，不要误认为已更新生产数据。

默认选择规则：本地文件可读且日期相同或更新时优先本地；本地缺失、不可读或完整包日期更新时选择缓存。需要修复同日期价格时，检查来源与价格后显式指定：

```powershell
node runtime/workflow-runner.cjs --import-full-day 'C:\Users\jm\Downloads\hsjday.zip' 'sh600519' --repair-same-date
```

该选择只影响本次所选证券；本地推进到更晚日期后重新优先本地。再次不带修复参数导入可恢复默认选择，旧研究和导入快照不会改写。完整包行情可继续叠加已发布日增量；不会补造缺失交易日。

目前完整包自动下载受网站校验页影响，需先取得真实ZIP。此功能不下载分钟线、不证明完整包覆盖全部历史证券，也不替代客户端分钟更新验收。
