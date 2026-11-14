# WDZ 分类固定输入

从 `docs/data-sources/wdz-blocks/2026-11-07/manifest.json` 对应的原始快照逐字节抽取 41 个概念文件：13 个通达信已识别风格、23 个补充别名、5 个应保留主题。不是全量数据副本，也不用于研究成分输入。

`wdz-block-definitions.test.ts` 核对每个文件的原始长度和 SHA-256、全部 36 个风格排除和 5 个主题保留。完整 2,319 文件的迁出核验由 `scripts/relocate-wdz-snapshot.ps1` 执行，仓库继续保留全量 manifest。新 fixture 必须注明来源并保留原字节，不能用合成内容覆盖这些固定样本。
