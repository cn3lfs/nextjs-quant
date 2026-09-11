# 本地名称格式固定样本

tdx-infoharbor-names.bin为手工构造的GB18030格式fixture，不包含真实文件第三列的关联人信息。
000001、600519用于验证中文解码与沪深映射；920001“样本证券”为合成名称，仅测试北京代码映射；510300验证非A股不混入名录。
格式依据本机infoharbor_ex.code及研究过的xbfighting/tdx2db reader.py，未复制第三方实现。

tdx-code-changes.bin为按本机addedcode_bj.cfg格式构造的两记录样本。证券名称与代码用于验证解析；日期是测试输入，不作为上市或换码日期的外部证据。
