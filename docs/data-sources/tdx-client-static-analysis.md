# 通达信客户端静态分析

静态分析方法、客户端版本/哈希、关键地址、真实文件交叉核验与未知项统一保存在 [tstdx包内记录](../../packages/tstdx/docs/research/client-static-analysis.md)。

客户端专用协议、文件格式、源字段模型和原生编解码归 `tstdx`；应用负责财务计算、查询/筛选、证据档案及界面。API与边界见 [tstdx本地客户端数据](../../packages/tstdx/docs/api/local.md)。
