# L19 全样本完整高度与口径收口（实际调用）

只精修L19全样本分析c6fe71cc921946359760f53ea65a1d8f，返回1张完整新screen。数字与表内容保持。两项布局缺陷必须按具体结构修正：
1 原HTML body h-full/overflow-hidden、主区h-full overflow-y-auto导致截图仅截1024视口、底部分层与统计完全缺失。请把body改min-height:1800px;height:auto;overflow:visible；主内容main height:auto;overflow:visible；外层不要固定h-screen/h-full/overflow-hidden裁切。画板高至少1800 CSS px，服务截图完整到统计口径底部。不缩字号，不把底部藏在局部滚动区域。
2 顶栏占了左品牌格、观+观澜落在第二行。采用“aside固定left0 top0 width216px，最上56px品牌观+观澜；header固定top0 left216px right0 height56px，标题信号台账/唯一设计示例/搜索页面；main margin-left216px padding-top80px fluid/min-width0”。品牌位于真正左上，标题在主区，不重叠、不加另一个品牌。六组和追踪4入口保持。
只作以下精确文案纠正：

- 聚合副标题改“两方向合并，各期限分别统计”，不写合并多期限。
- 折叠排除项目“含除权/停牌”改“含除权”；其他—待读取不补0。
- “分层收益与单调性指标由于组数不足均标为—”改“分层样本不足，收益与单调性均为—”。
- 去重规则逐字“按证券×观察日×策略去重，保留字典序最小ID。”，ID不是去重键第四项。
- t边界只“t值未修正持有期重叠及截面相关。”
  保留聚合3/1/2与+2/−1/0、方向分组2/1/1、IC0/2及所有—、Spearman与标准差ddof1、实际分层3/请求5、三期限持有期衰减表、排除完整折叠入口、刷新唯一主蓝。不要重造健康/版本/PASS/哈希/规范词，不新增导出/回测/交易按钮。关键是整图必须真正可见底部内容。
