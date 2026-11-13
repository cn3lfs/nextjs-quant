请从初稿c277ecbb5f164770a972dd9b9e4afb76重新做最小精修（其原17项正确），不要采用a7acfb错误稿：a7把导航改成横铺在顶上，且将17项换成了Sortino/恢复日/2.55盈亏比等非本区字段。必须保留初稿正确的17字段子树，只修CSS布局/覆盖优先/日期/品牌。生成新完整screen与全部截图。
直接在原HTML head末追加以下覆盖CSS（不要将其显示为业务文本），保障216侧栏仍在左，不得堆在页面上方：
html{height:auto!important;overflow:visible!important}body{display:grid!important;grid-template-columns:216px minmax(0,1fr)!important;grid-template-rows:56px auto!important;min-height:2600px!important;height:auto!important;overflow:visible!important}aside{position:relative!important;top:auto!important;left:auto!important;width:216px!important;height:auto!important;grid-column:1!important;grid-row:1 / span 2!important;align-self:stretch!important}header{position:relative!important;left:auto!important;right:auto!important;top:auto!important;grid-column:2!important;grid-row:1!important;height:56px!important}main{grid-column:2!important;grid-row:2!important;margin:0!important;padding:24px!important;width:100%!important;min-width:0!important;height:auto!important;overflow:visible!important;align-self:start!important}
在初稿上删除3张收益/年化/回撤大卡，只保紧凑覆盖卡8观察/5可得/3缺失/0零。左上只观+观澜，删除量化工作台L21，删左下帮助/偏好footer。主表8窗日期各行完整ISO，不半截折行，样本数/3.02/2.00与标记保持。17项用普通3列KV，不搞hero，逐字必须恰好以下17项及值：
累计收益 = 3.02%
年化收益 = 347.97%
夏普（wbt，rf=0） = 11.9799
最大回撤 = 0.99%
卡玛 = 351.4465
日胜率 = 80.00%
日盈亏比 = 1.0075
日赢面 = 0.6060
年化波动率 = 12.62%
下行波动率 = 0.00%
非零覆盖率 = 100.00%
盈亏平衡点 = 60.00%
新高间隔 = 1个收益观察
新高占比 = 80.00%
回撤风险 = 0.0784
回归年化收益 = 101.81%
长度调整平均回撤 = 0.0008
禁止出现该17项以外的Sortino/自动波动率/最大回撤形成日/修复日/回撤2交易日/平均回撤深度/-0.55%/盈亏比2.55；最大回撤本区正幅度0.99%，不是-0.99%。不要把日胜率80%改60%（4/5非负）；年化波动12.62%不是0.1238。指标代码对应dailyPerformance，不是旧NAV风险报告。
自然周100%盈利1/可得1/共2，月季年—盈利0/可得0/共1，不能加平均收益+1.50%（未提供）。日胜率>=0与自然周期日收益和>0分开。单利附加只累计3.00%/回撤绝对值0.0099。空收益与失败短句/重新读取无猜测原因。输入/切换可编辑，唯一主查看复盘，其他不变。正文14/辅助13/控件32主40。
截图至少5200px高（2倍），从顶栏/左侧品牌到末3附加状态完整可见，不能只给首1024CSSpx，也不能为了完整把侧栏横铺或改正确数值。
