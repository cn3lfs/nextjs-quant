"""板块机会/风险/验证信号分析（脚本调 DeepSeek，精简重点）。

确定性编排（筛板块/分批/重试/组装报告）由脚本负责，分析判断交给大模型。
用法: python analyze.py <news.json> <classified.json> [--out <报告路径>]
  news.json: cls-news query_news.py 输出（含 content）
  classified.json: news-industry-classifier 产出（industries: {行业:[{id,title,time}]}）
  --out: 可选，报告输出路径（默认 <news>_analysis.md）
产出: 报告 .md + <news>_analysis.json（结构化）
依赖:
  - 环境变量 DEEPSEEK_API_KEY
  - westock-data skill（腾讯自选股数据接口）+ Node.js >= 18：
    行情数据（板块近30日价格、板块估值分位、上证基准、大盘情绪指标）全部走它，
    路径默认 ~/.agent-skills/skills/westock-data/scripts/index.js，可用 WESTOCK_DATA_JS 覆盖。
"""
import json
import os
import subprocess
import sys
import time
import urllib.request
import urllib.error

sys.stdout.reconfigure(encoding='utf-8')

API_URL = 'https://api.deepseek.com/chat/completions'
MODEL = 'deepseek-chat'
TOP_N = 7          # 重点板块数上限
MIN_COUNT = 3      # 板块最少新闻数才深度分析（<3 太薄不深挖）
RETRY = 2
BACKDROP = {'宏观', '市场情绪面', '国际市场'}   # 作背景，不作板块

API_KEY = os.environ.get('DEEPSEEK_API_KEY', '')
if not API_KEY:
    print('ERROR: 环境变量 DEEPSEEK_API_KEY 未设置')
    sys.exit(1)


def call(system, user, timeout=120):
    payload = {
        'model': MODEL,
        'messages': [
            {'role': 'system', 'content': system},
            {'role': 'user', 'content': user},
        ],
        'temperature': 0,
        'response_format': {'type': 'json_object'},
    }
    data = json.dumps(payload, ensure_ascii=False).encode('utf-8')
    req = urllib.request.Request(
        API_URL, data=data, method='POST',
        headers={'Authorization': f'Bearer {API_KEY}', 'Content-Type': 'application/json'},
    )
    for attempt in range(RETRY + 1):
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                body = json.loads(r.read().decode('utf-8'))
            return json.loads(body['choices'][0]['message']['content'])
        except (urllib.error.URLError, KeyError, ValueError, TimeoutError) as e:
            print(f'  [重试 {attempt + 1}] {type(e).__name__}: {e}')
            time.sleep(2)
    return None


# 时间标注规则（多个 prompt 共用）。
# 涨跌幅/点位/成交额都是**时点数据**：盘中快照与收盘值可以差出几个百分点，
# 同一天的"跌超21%"出现在 10:30 还是 15:00 收盘，交易含义完全不同。
# 不标时间的涨跌幅既无法复核、也无法判断是否已被后续行情推翻。
TIME_RULE = """时间标注（硬性要求）：输入里每条新闻前的 [YYYY-MM-DD HH:MM] 是该条新闻的发布时点。
- 每条要点以 `[MM-DD HH:MM]` 开头，时间取所引新闻的时点；一条要点只合并同一时点的新闻，跨时点的拆成多条。
- **凡写到涨跌幅、股价、指数点位、成交额、资金流这类时点数据（如"涨5%"、"跌超21%"、"成交额1.6万亿"），该数字必须能对应到时间**：默认由要点开头的时间戳承担；若某个数字来自与开头不同的时点，在该数字后紧跟 `（MM-DD HH:MM）`。
- **禁止出现不带时间的涨跌幅**（如只写"存储板块大跌"、"某股涨停"而不给时点）。宁可少写一条，也不要给无法定位到时点的行情数字。"""

SECTOR_SYS = """你是A股板块分析师。基于给定某板块的一组新闻，先逐条提炼原始新闻要点，再产出结构化分析。
要求：严格基于新闻事实，不编造；**新闻要点要保留具体公司名/标的/数据/事件，覆盖该板块主要新闻**，是后续判断的事实依据；验证信号必须可跟踪、可证伪（给出具体观察对象）。
""" + TIME_RULE + """
只输出 JSON，结构：
{
 "新闻要点": ["逐条提炼该板块原始新闻的关键信息，以 `[MM-DD HH:MM]` 开头，每条保留公司名/标的/具体数据/事件，覆盖主要新闻（条数随新闻量，一般3-10条）"],
 "核心逻辑": "1-2句，这个板块当下为什么值得关注",
 "机会": ["具体受益方向/子环节，1-3条"],
 "风险": ["证伪点/隐患，1-3条"],
 "验证信号": {
   "催化日历": ["即将发生的可验证事件，尽量带日期/时点（如财报/政策/会议）"],
   "基本面": ["可跟踪的价格/业绩/订单/产能等硬数据信号"],
   "资金情绪": ["龙头股行为/成交/北向等情绪面信号"]
 },
 "方向": "偏多/偏空/观望",
 "信心": "高/中/低"
}"""

MACRO_SYS = """你是A股策略分析师。基于给定的宏观与国际市场新闻，提炼 2-3 条决定当前A股风险偏好的主线（货币/地缘/政策等外部因素），并给风险偏好判断。
""" + TIME_RULE + """
（主线的「要点」是概括句，不必以时间戳开头；但只要写进了涨跌幅/点位/汇率这类时点数字，就必须在该数字后紧跟 `（MM-DD HH:MM）`。）
只输出 JSON：{"宏观主线":[{"主线":"","要点":"1句","对A股":"顺风/逆风/中性"}],"风险偏好":"1句话总判断"}"""

SENTIMENT_SYS = """你是A股情绪分析师。基于给定的A股盘面/资金/情绪新闻，以及随附的【盘面硬数据】，判断当前市场情绪温度。
硬数据是交易所口径的实测值，优先级高于新闻里的转述——两者冲突时以硬数据为准，并在要点里点出这个冲突。
要点必须引用具体数字（涨跌家数、涨停数、成交额及其相对均值的位置、新高新低对比），不要写"成交活跃"这类无数字的空话。
""" + TIME_RULE + """
- 本节要点同时用到新闻与【盘面硬数据】两类来源，**每条要点必须标明数字的时点与来源，且只标一次**：
  取自新闻的以 `[MM-DD HH:MM]` 开头；取自硬数据的以 `[硬数据·实时]` 或 `[硬数据·YYYY-MM-DD 收盘]` 开头（照搬该行括号里的口径标注）。
  开头已标过的，句中与句尾**不要再重复**同一个时间或来源；只有当句中某个数字的时点与开头不同时，才在该数字后补 `（MM-DD HH:MM）`。
- 点出新闻与硬数据冲突时，**两边的时点都要给出**——很多"冲突"其实是盘中快照对收盘值的时点差，不标时间就会把时点差误判成数据错误。
只输出 JSON：{"情绪温度":"火热/偏热/中性/偏冷","要点":["3-5条关键情绪信号，每条带具体数字"],"一句话判断":"1句","硬数据解读":"1-2句：涨跌家数/涨停/成交额/新高新低这几项合起来说明什么"}"""

CROSS_SYS = """基于各板块的核心逻辑，提炼1-3条跨板块共性主线（一条产业/资金/政策逻辑贯穿多个板块）。
只输出 JSON：{"跨板块主线":[{"主线":"","涉及板块":[],"逻辑":"1句"}]}"""

VAL_SYS = """你是A股估值分析师。基于给定各板块申万一级行业指数的实测估值（PE-TTM / PB-LF / 股息率-TTM 及各自的历史分位）与该板块的消息面方向，逐板块给一句「估值读法」，再给一段估值维度总结论。
判读口径（必须遵守）：
- 分位是该指标在历史区间中的百分位。PE/PB 分位越高越贵；**股息率分位越高反而越便宜**（价格低才推高股息率），不要搞反。
- PB 分位 <10% 或股息率分位 >90% = 历史低估区间、防御性强；PB 分位 >85% 或 PE 分位 >90% = 历史高估区间、容错低。
- PE 为负（行业整体亏损）时不要用 PE 判贵贱，改用 PB 与股息率，并点明"盈利尚未修复，估值空间在修复而非盈利"。
- 分位标为「不可得」= 本次未取到该项历史分位（不是 0%、也不是历史最低估）。此时只就 PE/PB/股息率的绝对水平点评，**禁止臆测或复述分位高低**。
- 读法要给出**投资含义**（贵/便宜意味着什么、风险在哪一侧），不要只复述数字。
- 估值结论要把估值维度与消息面方向对照：**低估值+消息偏多=风险收益比好；高估值+消息偏多=上涨已被定价、回撤风险优先于上涨空间**。
严格基于给定数据，不编造数字。所有输出为陈述句。
只输出 JSON：
{
 "分板块": [{"板块":"","读法":"1句，带投资含义，25字以内"}],
 "估值结论": "3-4句：哪些板块处于低估值高股息象限、哪些估值分位偏高、与消息面方向对照后的取舍"
}"""

FLOW_SYS = """你是A股资金流分析师。基于给定各板块申万一级行业指数的实测主力资金净流入（最新交易日 / 近5日 / 近10日 / 近20日累计，单位亿元），以及该一级行业下**二级细分行业**的资金流明细与该板块的消息面方向，逐板块给一句「资金读法」，再给一段资金维度总结论。
判读口径（必须遵守）：
- 主力净流入为正=主力资金净买入，为负=净卖出。看**趋势与背离**，不要只看单日：单日与5日/20日方向相反时，以长周期为主、单日作为拐点线索并注明"仅1日，待确认"。
- **二级细分是本节的重点**：一级是加总值，会把内部分化抹平。必须点出一级内部是「普涨式流入/普跌式流出」还是「结构性分化」（少数二级吸金、其余失血），并指名具体二级行业。
- 消息面偏多但主力持续净流出 = 资金不认这个消息（利好不涨的资金版），风险优先；消息面偏空但主力净流入 = 逆势承接，留意超跌反弹。二者都要明说。
- **「最新日」是当日盘中滚动累计值**（截至抓取时刻的进度，输入里已给出该时刻），不是日终值：同一天上午与下午拉到的数可以差出一两百亿、甚至正负相反。因此**禁止只凭最新日下"资金已停止流出/已回流"这类结论**；要用它时必须连同时刻一起说（如"截至14:44当日累计+196亿"），并以近5日/近20日为主判据。
- 二级数据缺失的板块（申万个别二级腾讯源未编制指数）只就一级数值点评，禁止臆测细分结构。
严格基于给定数据，不编造数字。所有输出为陈述句。
只输出 JSON：
{
 "分板块": [{"板块":"","读法":"1句，点明方向+内部结构（指名二级），30字以内"}],
 "资金结论": "3-4句：哪些板块在被主力持续买入/抛弃、内部结构分化在哪些细分、与消息面方向对照后的取舍"
}"""

GAP_SYS = """你是预期差交易分析师（方法论：预期差交易讲义 v2）。核心：消息本身不是交易依据，价格对消息的反应才是；规则双向对称——利好不涨即利空，利空不跌即利多，向下的背离保本金，向上的背离给利润，两个方向等权重。
三维度判定标准（v2 量化版）：
- 消息定性：公告前已大涨的利好默认按"兑现/已定价"处理，不当新增利好看；已大跌的利空默认按"释放"处理。
- 价格裁决：**价格档（涨/跌/钝化）与量能档（放量/缩量/正常）已由脚本按规则算好并随输入给出（涨=近5日超额≥+3%，跌=≤-3%，之间=钝化；放量=量能比>1.2，缩量=<0.8），直接采用，不得自行重判**。钝化本身是信息：利好钝化偏空看，利空钝化偏多看；钝化时象限定位需注明"钝化"并降一档谨慎处理。
- 量能佐证：涨+放量=真承接，涨+缩量=反抽存疑；跌+放量=真出货，跌+缩量=惜售存疑。量能存疑时在补充说明中注明并降档。
- 消息×价格档→象限映射（必须严格执行）：偏多×涨→1或2；偏多×钝化→按3的方向谨慎处理并注明钝化；偏多×跌→3或4；偏空×跌→5或6；偏空×钝化→按7的方向观察并注明钝化；偏空×涨→7或8；消息面为观望/中性时以价格档主判定并注明"消息面中性，按价格主导"。1/2、3/4、5/6、7/8 之间由扩散度定小/大。
- **本报告的分析对象是「板块」而非单只个股**：象限 1/3/5/7 的「扩散小」在这里表示「只处理该板块的持仓，不牵连其他板块与总仓位」，应对措辞一律用「该板块」，不要写「该股」「这只股」。
- 扩散度：多板块同向共振或情绪极端=市场级；单一板块内普涨普跌=板块级；仅个别标的=个股级。判定顺序自上而下：先排除市场级，再板块级，最后个股级。
- **象限编号与扩散度必须自洽（硬约束，违反即为错误输出）**：奇数号 1/3/5/7 只能搭配「扩散小」，偶数号 2/4/6/8 只能搭配「扩散大」。定位顺序固定：先定扩散度，再在对应的一组编号里选——扩散小只能从 1/3/5/7 里选，扩散大只能从 2/4/6/8 里选。写出「第6象限（利空+跌+扩散小）」「第4象限（利好+跌+扩散小）」这类编号与扩散度自相矛盾的定位是错误。
  特别注意 5 与 6 的区别：**只有这一个板块在跌、其他板块未同步下跌 → 扩散小 → 第5象限**；第6象限是全市场系统性风险，必须有多板块共振下跌或指数大跌才成立，单一板块自己跌绝不能定位成 6（那会把"回避这个板块"错误升级成"总仓位≤30%、杠杆清零"）。同理 3 与 4：单板块利好不涨是 3，多板块利好齐跌才是 4。
八象限（编号必须严格按此表，扩散度只有小/大两档）。每格给「机制｜仓位档｜动作｜禁令」，**你输出的"应对"必须落在该格的仓位档与动作范围内，不得自行发明仓位数字**：
1=利好+涨+扩散小（个股正常兑现）｜机制：只有做过功课的资金在买，未扩散｜仓位档：维持现档｜动作：低位（回撤>15%后的突破）加至标准仓，高位持有不追+移动止盈（跌破20日线或回撤8%减半）｜禁令：不在高位把"同向"当加仓理由。
2=利好+涨+扩散大（板块主升浪）｜机制：板块级认知修正，增量资金买全产业链｜仓位档：偏高档70%~90%｜动作：顺势持有+向龙头集中，每日核对过热清单（天量/封板率下降/龙头放量滞涨/指数巨震），命中≥2条预备降档｜禁令：不追浪尾补涨股，不无退出预案持有。
3=利好+跌+扩散小（个股利好出尽）｜机制：想买的早买完，公告成了获利盘的出货窗口｜仓位档：维持现档、只动该股｜动作：该股减半/清仓，其余持仓不动，并写死回补条件（缩量企稳+重新放量收复公告日高点）｜禁令：不用"业绩好"补仓摊低成本，反弹2%不算回补信号。
4=利好+跌+扩散大（板块兑现退潮）｜机制：景气成共识没有对手盘+机构借公告出货，是钱的问题｜仓位档：降至防守档≤30%~50%｜动作：先降仓再研究，可留龙头观察仓，等企稳+缩量+重新放量突破再谈基本面｜禁令：不抄底不补仓，不把降仓做成换股，不"降一半赌反弹"。
5=利空+跌+扩散小（个股风险释放）｜机制：止损盘与规避资金撤离，跌不出承接｜仓位档：维持现档、只动该股｜动作：回避；一次性利空可评估去留，持续性利空直接止损离场｜禁令：不提前接飞刀，等7的信号。
6=利空+跌+扩散大（系统性风险）｜机制：抛售来自仓位管理而非基本面，对利好免疫｜仓位档：总仓位≤30%、杠杆清零｜动作：大幅降仓保本金，记录最抗跌与最先放量反弹的板块｜禁令：不做横向腾挪（相关性趋近1），不急于抄底摊平。
7=利空+涨+扩散小（个股利空出尽）｜机制：坏消息砸不动价格＝浮动抛压枯竭｜仓位档：单笔≤10%试探｜动作：小仓试探并把止损写死在利空公告日低点，盈利且缩量回踩不破再加至半仓｜禁令：信号一出不重仓，无深跌背景（回撤>30%）不套用本格。
8=利空+涨+扩散大（空头衰竭）｜机制：场外配置需求压倒利空引发的减仓需求｜仓位档：逐步回标准档50%→70%｜动作：买"利空当日最抗跌、反弹最先创新高"的板块龙头，分批建仓首笔≤30%目标仓位｜禁令：不买"跌得最多的"，不一次性满仓。
关键纪律：
- 价格与消息背离永远信价格；个股背离换股，板块/市场级背离调总仓位——换股解决不了钱的问题；
- 第4象限盘面公式：高位放量滞涨+利好密集兑现+板块普跌=出货特征，不是"错杀"；先降仓再研究；
- 每个板块判断必须给证伪条件——什么价格行为出现说明该判断错了。**证伪条件必须在给定时间窗口内有现实概率发生，否则等于没有证伪条件**：
  · **时间窗口一律用「3个交易日内」**，不要写 2 日或其他天数，保持各板块口径统一、便于横向对比与到期核对；
  · 只能用输入里标注【够得着】（距现价 ≤5%）的锚点作为价位参照，例如"3个交易日内放量站上5日均线（+1.8%）"；
  · **严禁使用"收复前高/回到30日高点"这类远端价位**——深度回撤板块（如回撤 -24%）三天内根本到不了，这种条件永不触发；
  · 输入里的"距30日高点回撤"只是位置描述，不是可用锚点；
  · 若该板块所有价位锚点都标【太远】，改用非价位型证伪条件：近5日超额由负转正、放量且收盘价连续3日不创新低、量能比回到1.2以上等；
  · 证伪条件里要写明锚点名称与百分比距离，让读者知道还差多少，例如"3个交易日内放量突破近5日高点（+2.4%）则判断错误，可回补"；
- 重新入场/回补只认价格信号：企稳（3个交易日不再创新低）+缩量+重新放量突破；"跌够了/估值便宜"不是信号；
- 象限迁移预判：2的终点常是3/4（持有主升浪时预案先行）；4遇宏观触发源会升级为6（降仓抢在升级前）；6的尾声看利空钝化（转7/8，防守半场结束的信号在这里找）。
输入：市场基准表现、各板块近30个交易日价格表现（区间涨跌幅/近5日涨跌幅/近5日超额/距高点回撤/量能比）、**每个板块的短周期锚点（现价到近5日高点/近10日高点/5日均线/近5日低点的百分比距离，已标注【够得着】或【太远】）**、各板块消息面方向与核心逻辑、市场情绪温度。
任务：逐板块做象限定位（钝化/量能存疑需注明并降档）并给补充说明、应对、证伪条件；判定扩散度层级；给总体结论、象限迁移预判与操作纪律。严格基于给定数据，不编造价格。所有输出必须是最终结论的陈述句——禁止疑问句、禁止在输出中展示犹豫或自我修正过程。
只输出 JSON：
{
 "扩散度判定": "1-2句：个股级还是板块/市场级，依据（多少板块同向、情绪温度）",
 "总体结论": "2-3句：价格维度对消息面判断的修正结论",
 "分板块": [{"板块":"","象限定位":"如：第4象限（利好+跌+扩散大）；钝化时如：第3象限（利好+钝化+扩散小，降档处理）","补充说明":"2-3句：超额是涨/跌/钝化、量能判读、预期是否已被定价、最值得注意的信号","应对":"1-2句，必须包含三要素：①该象限的仓位档（照抄八象限表的档位，如「降至防守档≤30%~50%」「维持现档」「单笔≤10%试探」，不得自行发明数字）②一个具体动作（加/减/持/试探，及针对什么标的）③该格的一条禁令（如「不抄底不补仓」）。禁止只写「持有」「观望」这类没有仓位信息的空话","证伪条件":"1句：什么价格行为出现说明该判断错了及对应动作"}],
 "象限迁移预判": "1-2句：当前格局最可能向哪个象限演化、盯什么信号确认",
 "操作纪律": ["2-4条，含仓位层级与回补条件"]
}"""

# 申万2021一级行业指数代码；腾讯板块代码 = 'pt01' + 该代码（如 电子 801080 -> pt01801080）
SW_CODES = {
    '农林牧渔': '801010', '基础化工': '801030', '钢铁': '801040', '有色金属': '801050',
    '电子': '801080', '家用电器': '801110', '食品饮料': '801120', '纺织服饰': '801130',
    '轻工制造': '801140', '医药生物': '801150', '公用事业': '801160', '交通运输': '801170',
    '房地产': '801180', '商贸零售': '801200', '社会服务': '801210', '综合': '801230',
    '建筑材料': '801710', '建筑装饰': '801720', '电力设备': '801730', '国防军工': '801740',
    '计算机': '801750', '传媒': '801760', '通信': '801770', '银行': '801780',
    '非银金融': '801790', '汽车': '801880', '机械设备': '801890', '煤炭': '801950',
    '石油石化': '801960', '环保': '801970', '美容护理': '801980',
}


WESTOCK_JS = os.environ.get(
    'WESTOCK_DATA_JS',
    os.path.expanduser('~/.agent-skills/skills/westock-data/scripts/index.js'),
)
WD_RETRIES = 2      # 失败重试次数
WD_TIMEOUT = 60     # 单次调用超时（秒）
PRICE_BARS = 32     # 拉取的日线根数（算近30日表现留 1-2 根余量）


def wd(*args):
    """调 westock-data CLI 并返回解析后的 JSON（--raw）；失败返回 None。

    腾讯源支持逗号批量，所有板块一次拿完；直连走代理正常，无需切换代理环境变量。
    """
    cmd = ['node', WESTOCK_JS, *args, '--raw']
    last = None
    for i in range(WD_RETRIES + 1):
        if i:
            time.sleep(i)
        try:
            p = subprocess.run(cmd, capture_output=True, timeout=WD_TIMEOUT)
            if p.returncode != 0:
                last = (p.stderr or p.stdout).decode('utf-8', 'replace').strip()[:200]
                continue
            data = json.loads(p.stdout.decode('utf-8'))
            # CLI 对上游业务错误仍以 0 退出，只在 body 里给 {success:false,error:{...}}，
            # 不识别的话调用方会拿着错误对象当数据用
            if isinstance(data, dict) and data.get('success') is False:
                last = str((data.get('error') or {}).get('message') or '接口返回 success=false')[:200]
                continue
            return data
        except (subprocess.TimeoutExpired, json.JSONDecodeError, OSError) as e:
            last = f'{type(e).__name__}: {e}'
    print(f"  [行情] westock-data {' '.join(args)} 失败: {last}")
    return None


def load_stock_map():
    """加载个股→申万行业映射；数据缺失返回 (None, None)，报告降级为不标注个股。"""
    try:
        sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
        from stock_industry import load_map
        return load_map()
    except Exception as e:
        print(f'  [个股标注] 加载失败，跳过: {type(e).__name__}: {e}')
        return None, None


def sector_stock_index(sectors, industries, id2c, smap, snames):
    """为每个重点板块提取「新闻里出现且确实属于该板块」的个股。

    只保留 l1 == 板块名 的命中：盘面播报类新闻（午评/竞价看龙头）会罗列
    大量跨行业个股，不过滤会把它们错误挂到当前板块下。
    """
    from stock_industry import extract
    out = {}
    for name, _ in sectors:
        seen = {}
        for it in industries.get(name, []):
            text = (it.get('title') or '') + ' ' + id2c.get(it.get('id'), '')
            for s in extract(text, smap, snames):
                if s['l1'] == name:
                    seen[s['name']] = s['code']
        if seen:
            out[name] = seen
    return out


def fetch_prices(names):
    """腾讯源一次批量拉取各板块申万一级行业指数近30个交易日表现；失败返回 None。

    腾讯日线当日盘中/盘后即有当天这根，无需像 T+1 源那样再拉实时快照回补最新交易日。
    """
    pairs = [(n, 'pt01' + SW_CODES[n]) for n in names if n in SW_CODES]
    for n in names:
        if n not in SW_CODES:
            print(f'  [预期差] {n} 无对应申万一级指数代码，跳过')
    if not pairs:
        return None
    rows = wd('kline', ','.join(c for _, c in pairs), '--period', 'day', '--limit', str(PRICE_BARS))
    if not rows:
        return None
    by_code = {}
    for r in rows:
        by_code.setdefault(r.get('symbol'), []).append(r)
    out = {}
    for name, code in pairs:
        bars = by_code.get(code)
        if not bars:
            print(f'  [预期差] {name}({code}) 无价格数据，跳过')
            continue
        # 腾讯批量返回按代码分组、组内日期倒序，统一转成升序
        bars = sorted(bars, key=lambda x: x['date'])[-31:]
        c = [float(b['last']) for b in bars]
        d = [str(b['date']) for b in bars]
        v = [float(b.get('volume') or 0) for b in bars]
        if len(c) < 6:
            print(f'  [预期差] {name} 日线不足 6 根（{len(c)}），跳过')
            continue
        now = c[-1]
        rec = {
            '区间': f'{d[0]}~{d[-1]}',
            '数据截止': d[-1],
            '近30日涨跌%': round((c[-1] / c[0] - 1) * 100, 1),
            '近5日涨跌%': round((c[-1] / c[-6] - 1) * 100, 1),
            '距30日高点回撤%': round((c[-1] / max(c) - 1) * 100, 1),
            # 短周期证伪锚点：现价到各价位还差多少（正=需上涨，负=需下跌）。
            # 2-3 个交易日内够得着的锚点才能当证伪条件，「30日高点」是远端参照、不可用。
            '距近5日高点%': round((max(c[-5:]) / now - 1) * 100, 1),
            '距近10日高点%': round((max(c[-10:]) / now - 1) * 100, 1),
            '距5日均线%': round((sum(c[-5:]) / 5 / now - 1) * 100, 1),
            '距近5日低点%': round((min(c[-5:]) / now - 1) * 100, 1),
        }
        if len(v) > 5 and sum(v[:-5]) > 0:
            rec['量能比'] = round((sum(v[-5:]) / 5) / (sum(v[:-5]) / len(v[:-5])), 2)
        out[name] = rec
    return out or None


def fetch_valuations(names):
    """腾讯源一次批量拉取各板块申万一级行业指数估值（PE/PB/股息率 + 历史分位）；失败返回 None。

    与价格（fetch_prices）互补：价格看「涨没涨」，估值看「贵不贵」——
    同为偏多的板块，低估值高股息的风险收益比明显好于高估值分位的。
    """
    pairs = [(n, 'pt01' + SW_CODES[n]) for n in names if n in SW_CODES]
    if not pairs:
        return None
    rows = wd('sector', 'valuation', ','.join(c for _, c in pairs))
    if not rows:
        # 只认腾讯源，不再降级到问财：问财对措辞/行业个数敏感且返回随机退化
        # （同一条 query 这次回指数、下次回 40 行个股），拿它顶数比缺数据更危险。
        # 报告侧会把「本次不可得 + 原因」写出来，不让这一维度静默消失。
        print(f'  [估值] 腾讯源估值返回 0 条（该路由 2026-09 起间歇性故障），本次估值维度缺失')
        return None
    by_code = {r.get('code'): r for r in rows}
    out = {}
    for name, code in pairs:
        r = by_code.get(code)
        if not r:
            print(f'  [估值] {name}({code}) 无估值数据，跳过')
            continue
        end = str(r.get('EndDate') or '')
        out[name] = {
            '数据截止': f'{end[:4]}-{end[4:6]}-{end[6:]}' if len(end) == 8 else end,
            'PE': r.get('PeTTM'), 'PE分位': r.get('PeTTMPct'),
            'PB': r.get('PbLF'), 'PB分位': r.get('PbLFPct'),
            '股息率': r.get('DivTTM'), '股息率分位': r.get('DivTTMPct'),
        }
    return out or None


def val_num(x):
    """估值数值格式化；PE 为负时标注亏损，避免负 PE 被误读成"很便宜"。"""
    if x is None:
        return '-'
    return f'{x:.2f}' if x >= 0 else f'亏损({x:.2f})'


def val_pct(x):
    """分位格式化：取不到历史分位（源未返回）时显式写「不可得」。

    不能留 None，更不能退化成 0——0% 分位是「历史最低估」的强信号，
    把「查不到」渲染成 0% 会让模型得出完全相反的结论。
    """
    return '不可得' if x is None else f'{x}%'


SW_SECTOR_CODES = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                               '..', 'references', 'sw-sector-codes.json')
FLOW_DAYS = 34      # 资金流回看自然日（覆盖 20 个交易日 + 节假日余量）
# 单次批量查询的板块代码数。区间查询返回「代码×交易日」行，批量过大（40+）会触发
# 上游超时、整批丢失；20 个代码 × ~22 个交易日 ≈ 480 行，实测稳定。
FLOW_BATCH = 20
FLOW_SUB_TOP = 3    # 每个一级行业展示的二级细分条数（流入/流出各取）
FLOW_RETRY_ROUNDS = 3   # 缺失代码的补拉轮数（末轮逐个单拉，只补一级）


def load_sector_codes():
    """加载「申万一级/二级 → 腾讯板块代码」表；缺失则退化为只用内置一级代码。

    表由 build_sw_sector_codes.py 生成。三级（pt0185xxxx）腾讯源资金流字段恒为 0，
    故不收录、也不要往下游传——把 0 渲染成「零流入」会被读成"无资金动向"。
    """
    try:
        d = json.load(open(SW_SECTOR_CODES, encoding='utf-8'))
        return d.get('一级') or {}, d.get('二级') or {}
    except Exception as e:
        print(f'  [资金流] 板块代码表加载失败（{type(e).__name__}），仅用一级代码: {e}')
        return {}, {}


def fetch_fund_flows(names):
    """腾讯源批量拉取各板块主力资金净流入（一级 + 其下二级细分）；失败返回 None。

    与估值/价格互补：价格看「涨没涨」、估值看「贵不贵」、资金流看「谁在买」。
    **二级细分是关键**——一级是加总值会抹平内部分化，同样是"电子净流出"，
    可能是全面失血，也可能是半导体吸金、消费电子失血的结构性行情，两者操作含义完全相反。

    口径说明：用历史序列（--start/--end）的逐日 MainNetFlow 自行累加算 1/5/10/20 日，
    不用实时快照里的 MainNetFlow5D/10D/20D——后者截止到前一交易日，与当日值错位，
    且快照的当日 MainNetFlow 与历史序列同日数值口径不一致（数量级偏小）。
    """
    l1_codes, l2_codes = load_sector_codes()
    pairs, subs = [], {}
    for n in names:
        code = (l1_codes.get(n) or {}).get('code') or ('pt01' + SW_CODES[n] if n in SW_CODES else None)
        if not code:
            print(f'  [资金流] {n} 无对应申万一级指数代码，跳过')
            continue
        pairs.append((n, code, n, 1))
        for l2, v in l2_codes.items():
            if v.get('一级') == n:
                pairs.append((n, v['code'], l2, 2))
                subs.setdefault(n, []).append(l2)
    if not pairs:
        return None

    end = time.strftime('%Y-%m-%d')
    start = time.strftime('%Y-%m-%d', time.localtime(time.time() - FLOW_DAYS * 86400))

    def pull(codes):
        got = []
        for i in range(0, len(codes), FLOW_BATCH):
            part = wd('fund', 'flow', ','.join(codes[i:i + FLOW_BATCH]), '--start', start, '--end', end)
            if part:
                got.extend(part)
        return got

    # 按一级行业分批（每批 = 该一级 + 其二级，约 5~10 个代码），不是按固定窗口切。
    # 区间查询偶发丢批（上游超时返回空、不报错），批越大丢得越多；按行业切后
    # 一批只影响一个板块，且下面能针对性补拉。
    rows = []
    for n in names:
        grp = [c for nm, c, _, _ in pairs if nm == n]
        if grp:
            rows.extend(pull(grp))
    # 补拉：上游丢批是随机的、且**部分返回时请求本身是成功的**（wd() 的重试救不了，
    # 它只在整批失败时重试）。所以这里按"还缺哪些代码"多轮补，盘中高峰实测一轮不够。
    # 最后一轮逐个单拉（批量=1 成功率最高），只对一级——一级缺失会让整个板块从表里消失。
    for rnd in range(FLOW_RETRY_ROUNDS):
        got_codes = {r.get('code') or r.get('SecuCode') for r in rows}
        miss = [(c, lv) for nm, c, _, lv in pairs if c not in got_codes]
        if not miss:
            break
        last = rnd == FLOW_RETRY_ROUNDS - 1
        todo = [c for c, lv in miss if lv == 1] if last else [c for c, _ in miss]
        if not todo:
            break
        print(f'  [资金流] 第{rnd + 1}轮补拉：{len(todo)} 个代码未返回'
              + ('（逐个单拉）' if last else ''))
        time.sleep(0.5)
        rows.extend(sum((pull([c]) for c in todo), []) if last else pull(todo))
    if not rows:
        # 与估值一致：只认腾讯源，不降级到问财，报告侧写明「本次不可得 + 原因」
        print('  [资金流] 腾讯源 fund flow 返回 0 条，本次资金流维度缺失')
        return None

    by_code = {}
    for r in rows:
        c = r.get('code') or r.get('SecuCode')
        try:
            by_code.setdefault(c, []).append((str(r.get('EndDate')), float(r.get('MainNetFlow') or 0)))
        except (TypeError, ValueError):
            continue

    def series(code):
        s = sorted(by_code.get(code) or [])
        if not s:
            return None
        v = [x[1] / 1e8 for x in s]      # 元 → 亿元
        return {
            '数据截止': s[-1][0],
            # 最新一根是**当日盘中滚动累计**，不是定值：同一天 09:30 拉到 -4.0 亿、
            # 14:44 再拉是 +196 亿。不记下抓取时刻，这个数字事后无法复核也无法比对。
            '抓取时刻': time.strftime('%H:%M'),
            '最新日亿': round(v[-1], 2),
            '近5日亿': round(sum(v[-5:]), 1),
            '近10日亿': round(sum(v[-10:]), 1),
            '近20日亿': round(sum(v[-20:]), 1),
            '交易日数': len(v),
        }

    out = {}
    for name, code, label, level in pairs:
        rec = series(code)
        if not rec:
            if level == 1:
                print(f'  [资金流] {name}({code}) 无资金流数据，跳过')
            continue
        if level == 1:
            out.setdefault(name, {}).update(rec)
        else:
            out.setdefault(name, {}).setdefault('二级', []).append(dict(rec, 名称=label))
    for name, rec in out.items():
        # 二级按近5日净流入排序：头部=正在吸金的细分，尾部=正在失血的细分
        rec['二级'] = sorted(rec.get('二级', []), key=lambda x: -x['近5日亿'])
        rec['二级覆盖'] = len(rec['二级'])
        rec['二级应有'] = len(subs.get(name, []))
        missing = [l2 for l2 in subs.get(name, []) if l2 not in {x['名称'] for x in rec['二级']}]
        if missing:
            # 上游区间查询偶发丢批，同一命令重跑覆盖数会浮动。缺了就写出来——
            # 读者据此知道"这次的细分结构不完整"，而不是误以为缺的那几个二级没动静。
            rec['二级缺失'] = missing
    return {k: v for k, v in out.items() if '最新日亿' in v} or None


def flow_sub_line(rec, top=FLOW_SUB_TOP):
    """把二级细分压成一行「吸金 → 失血」的对照文本；无二级数据时返回说明。"""
    subs = rec.get('二级') or []
    if not subs:
        # 「源里没有」和「这次没拉到」必须分开说：前者是固有边界（申万有 11 个二级
        # 腾讯源未编制指数），后者是上游丢批、重跑可恢复。混为一谈会让读者以为
        # 这个行业永远没有细分数据，从而不再去看。
        if rec.get('二级应有'):
            return (f"**本次未取到**——该行业应有 {rec['二级应有']} 个二级"
                    "（上游区间查询丢批，非源里没有），本次细分结构缺测，重跑可恢复")
        return '该行业二级细分腾讯源未编制指数，无细分数据'
    inflow = [s for s in subs if s['近5日亿'] > 0][:top]
    outflow = [s for s in subs if s['近5日亿'] <= 0][-top:]
    fmt = lambda s: f"{s['名称']} {s['近5日亿']:+.1f}亿"
    parts = []
    if inflow:
        parts.append('流入：' + '、'.join(fmt(s) for s in inflow))
    if outflow:
        parts.append('流出：' + '、'.join(fmt(s) for s in reversed(outflow)))
    line = ' ｜ '.join(parts) if parts else '二级细分近5日净额均为 0'
    if rec.get('二级缺失'):
        line += f"（本次取到 {rec['二级覆盖']}/{rec['二级应有']} 个二级，缺 {'、'.join(rec['二级缺失'])}）"
    return line


def analyze_flows(flows, results):
    """把资金流实测交给模型出「读法」与总结论；失败返回 None（报告降级为只出数字表）。"""
    msg = {name: (r or {}).get('方向', '-') for name, r in results}
    lines = []
    for name, f in flows.items():
        lines.append(
            f"{name}：最新日 {f['最新日亿']:+.2f}亿｜近5日 {f['近5日亿']:+.1f}亿"
            f"｜近10日 {f['近10日亿']:+.1f}亿｜近20日 {f['近20日亿']:+.1f}亿"
            f"｜消息面 {msg.get(name, '-')}\n  二级细分（近5日）：{flow_sub_line(flows[name], top=5)}")
    f0 = next(iter(flows.values()))
    return call(FLOW_SYS, f"各板块主力资金净流入实测（截止 {f0['数据截止']}，"
                f"其中「最新日」为当日截至 {f0['抓取时刻']} 的盘中滚动累计，单位亿元，正=净流入）：\n"
                + "\n".join(lines))


def analyze_valuation(vals, results):
    """把估值实测交给模型出「读法」与总结论；失败返回 None（报告降级为只出数字表）。"""
    msg = {name: (r or {}).get('方向', '-') for name, r in results}
    lines = []
    for name, v in vals.items():
        lines.append(
            f"{name}：PE(TTM) {val_num(v['PE'])}（分位{val_pct(v['PE分位'])}）"
            f"｜PB(LF) {val_num(v['PB'])}（分位{val_pct(v['PB分位'])}）"
            f"｜股息率 {val_num(v['股息率'])}%（分位{val_pct(v['股息率分位'])}）"
            f"｜消息面 {msg.get(name, '-')}")
    return call(VAL_SYS, "各板块估值实测（截止 %s）：\n" % next(iter(vals.values()))['数据截止'] + "\n".join(lines))


def fetch_benchmark(asof=None):
    """拉市场基准（上证指数）表现，用于计算板块超额收益；失败返回 None（降级为绝对涨跌）。

    asof 为板块价格的数据截止日：基准序列先截断到该日再计算，避免两边终点日期错配。
    同源同口径，正常情况下两者截止日一致。
    """
    rows = wd('kline', 'sh000001', '--period', 'day', '--limit', str(PRICE_BARS + 8))
    if not rows:
        return None
    bars = sorted(rows, key=lambda x: x['date'])
    if asof:
        bars = [b for b in bars if str(b['date']) <= asof]
    bars = bars[-31:]
    if len(bars) < 6:
        return None
    c = [float(b['last']) for b in bars]
    return {
        '数据截止': str(bars[-1]['date']),
        '近30日涨跌%': round((c[-1] / c[0] - 1) * 100, 1),
        '近5日涨跌%': round((c[-1] / c[-6] - 1) * 100, 1),
    }


def _dist_label(x):
    """涨跌分档加方向前缀：'涨停'/'跌停'/'平' 保持原样，其余按 flag 补『涨』『跌』。"""
    sec = str(x.get('section') or '')
    if sec in ('涨停', '跌停', '平'):
        return sec
    return {1: '涨', -1: '跌'}.get(x.get('flag'), '') + sec


def fetch_market_pulse():
    """拉大盘情绪硬数据，供第二节「市场情绪温度」使用；失败的分项置 None。

    - changedist：全市场涨跌家数/涨停跌停/11 档涨跌分布，**当日实时口径**
    - market-overview trade：三大指数收盘 + 两市成交额及其 5/10/20/60 日均值比
    - market-overview updown：涨跌停数、多周期新高新低家数（市场宽度）
    两者数据日期可能差一天（分布是实时的，总览是收盘统计），各自带 date 如实标注。
    """
    pulse = {}
    dist = wd('changedist')
    if isinstance(dist, dict):
        pulse['分布'] = {
            '上涨家数': dist.get('upCount'), '下跌家数': dist.get('downCount'),
            '平盘家数': dist.get('flatCount'), '涨停家数': dist.get('upLimitCount'),
            '跌停家数': dist.get('downLimitCount'), '上涨占比%': dist.get('upRatio'),
            # 分档的区间名涨跌两侧重名（如 '0~2%' 涨跌各一档），必须靠 flag 补方向前缀才不会误读
            '分档': [{'区间': _dist_label(x), '家数': x.get('count')}
                     for x in (dist.get('detail') or [])],
        }
    blocks = wd('market-overview', '--type', 'trade,updown')
    if not isinstance(blocks, list):
        if blocks is not None:
            print('  [情绪] market-overview 返回结构异常，跳过成交与宽度')
        blocks = []
    for blk in blocks:
        if not isinstance(blk, dict):
            continue
        typ = (blk.get('info') or {}).get('type')
        sch, row = blk.get('schema') or {}, blk.get('row')
        if not isinstance(row, dict):
            print(f'  [情绪] market-overview {typ} 无数据，跳过')
            continue
        named = {sch.get(k, k): v for k, v in row.items()}
        if typ == 'trade':
            pulse['成交'] = {'日期': blk.get('date'), **{
                k: named[k] for k in (
                    '两市成交额(亿)', '当日两市成交额/5日均值(%)', '当日两市成交额/10日均值(%)',
                    '当日两市成交额/20日均值(%)', '当日两市成交额/60日均值(%)',
                    '涨跌幅(上证指数)', '涨跌幅(深证成指)', '涨跌幅(创业板指)',
                    '收盘(上证指数)') if k in named}}
        elif typ == 'updown':
            pulse['宽度'] = {'日期': blk.get('date'), **{
                k: named[k] for k in (
                    'A股上涨股票数', 'A股下跌股票数', 'A股涨停股票数', 'A股跌停股票数', 'A股涨跌比',
                    'A股创20日新高个股数', 'A股创20日新低个股数',
                    'A股创60日新高个股数', 'A股创60日新低个股数') if k in named}}

    # 同估值：不降级到问财。缺哪一项就在报告里明写「本次未取到 + 原因」，
    # 由 pulse_lines 如实标注缺失，不换口径顶数。
    for key, label in (('成交', 'trade'), ('宽度', 'updown')):
        if key not in pulse:
            print(f'  [情绪] market-overview {label} 返回空，{key}维度本次缺失')
    return pulse or None


def pulse_lines(pulse):
    """把盘面硬数据摊平成给模型看的文本行。"""
    if not pulse:
        return []
    out = ['【盘面硬数据】（交易所口径实测值，优先于新闻转述）']
    d = pulse.get('分布')
    if d:
        out.append(f"- 全市场涨跌（实时）：上涨 {d['上涨家数']} / 下跌 {d['下跌家数']} / 平盘 {d['平盘家数']}，"
                   f"上涨占比 {d['上涨占比%']}%，涨停 {d['涨停家数']} 家、跌停 {d['跌停家数']} 家")
        if d.get('分档'):
            out.append('  · 涨跌幅分档：' + '、'.join(f"{x['区间']} {x['家数']}家" for x in d['分档']))
    t = pulse.get('成交')
    if t:
        out.append(f"- 成交与指数（{t.get('日期','-')} 收盘）：两市成交额 {t.get('两市成交额(亿)','-')} 亿，"
                   f"为5日均值的 {t.get('当日两市成交额/5日均值(%)','-')}%、"
                   f"20日均值的 {t.get('当日两市成交额/20日均值(%)','-')}%、"
                   f"60日均值的 {t.get('当日两市成交额/60日均值(%)','-')}%")
        out.append(f"  · 指数涨跌：上证 {t.get('涨跌幅(上证指数)','-')}%、"
                   f"深成 {t.get('涨跌幅(深证成指)','-')}%、创业板 {t.get('涨跌幅(创业板指)','-')}%")
    else:
        out.append("- 成交与指数：**本次未取到**——腾讯源 market-overview trade 返回空"
                   "（该路由 2026-09 起间歇性故障），成交额与指数收盘统计这一维度缺失")
    w = pulse.get('宽度')
    if w:
        out.append(f"- 市场宽度（{w.get('日期','-')}）：涨跌比 {w.get('A股涨跌比','-')}，"
                   f"创20日新高 {w.get('A股创20日新高个股数','-')} 家 vs 新低 {w.get('A股创20日新低个股数','-')} 家，"
                   f"创60日新高 {w.get('A股创60日新高个股数','-')} 家 vs 新低 {w.get('A股创60日新低个股数','-')} 家")
    else:
        out.append("- 市场宽度：**本次未取到**——腾讯源 market-overview updown 返回空"
                   "（该路由 2026-09 起间歇性故障），新高新低家数这一维度缺失")
    return out



def price_label(p, bench):
    """确定性计算价格档（涨/跌/钝化，±3%阈值）与量能档（放量/缩量/正常）。"""
    excess = p['近5日涨跌%'] - bench['近5日涨跌%'] if bench else p['近5日涨跌%']
    grade = '涨' if excess >= 3 else ('跌' if excess <= -3 else '钝化')
    vol = None
    if '量能比' in p:
        vol = '放量' if p['量能比'] > 1.2 else ('缩量' if p['量能比'] < 0.8 else '正常')
    return excess, grade, vol


def check_quadrant(text):
    """校验「象限定位」里的编号与扩散度是否自洽；不一致返回提示语，一致返回 ''。

    象限号与仓位档是硬绑定的（6=总仓位≤30%杠杆清零、4=降至防守档），编号错一位
    就会把"回避这一个板块"升级成"清空全仓"。模型偶发写出「第6象限（…扩散小）」
    这种自相矛盾的定位，此处不改写模型判断，只在报告里显式标红，让读者知道该行不可信。
    """
    import re
    m = re.search(r'第\s*([1-8])\s*象限', text or '')
    if not m:
        return ''
    n = int(m.group(1))
    small, big = '扩散小' in text, '扩散大' in text
    if small and n % 2 == 0:
        return f'⚠️ 编号与扩散度矛盾：第{n}象限按定义是「扩散大」，但此处判为扩散小——应为第{n - 1}象限，请按第{n - 1}象限的仓位档执行（本行"应对"可能沿用了第{n}象限的过重仓位动作）'
    if big and n % 2 == 1:
        return f'⚠️ 编号与扩散度矛盾：第{n}象限按定义是「扩散小」，但此处判为扩散大——应为第{n + 1}象限，请按第{n + 1}象限的仓位档执行'
    return ''


def analyze_gap(prices, bench, results, senti):
    lines = []
    if bench:
        lines.append(f"市场基准（上证指数）：近30日{bench['近30日涨跌%']:+.1f}%，近5日{bench['近5日涨跌%']:+.1f}%")
    else:
        lines.append('市场基准不可用：价格裁决用板块绝对涨跌近似（±3%阈值不变）')
    lines.append('各板块近30个交易日价格表现（申万一级行业指数；价格档/量能档已按规则算好，直接采用）：')
    for name, p in prices.items():
        excess, grade, vol = price_label(p, bench)
        seg = (f"- {name}：区间{p['区间']}，近30日{p['近30日涨跌%']:+.1f}%，近5日{p['近5日涨跌%']:+.1f}%，"
               f"距30日高点回撤{p['距30日高点回撤%']:.1f}%，近5日超额{excess:+.1f}%，**价格档：{grade}**")
        if vol:
            seg += f"，量能比{p['量能比']:.2f}（**量能档：{vol}**）"
        lines.append(seg)
        if '距近5日高点%' in p:
            anchors = [('近5日高点', p['距近5日高点%']), ('近10日高点', p['距近10日高点%']),
                       ('5日均线', p['距5日均线%']), ('近5日低点', p['距近5日低点%'])]
            reach = '、'.join(f"{k} {v:+.1f}%{'【够得着】' if abs(v) <= 5 else '【太远】'}"
                             for k, v in anchors)
            lines.append(f"    · 该板块短周期锚点（现价到各价位的距离）：{reach}")
    lines.append('')
    lines.append('各板块消息面（新闻分析结论）：')
    for name, r in results:
        if r:
            lines.append(f"- {name}：方向{r.get('方向','-')}；核心逻辑：{r.get('核心逻辑','')}")
    if senti:
        lines.append('')
        lines.append(f"市场情绪温度：{senti.get('情绪温度','-')} —— {senti.get('一句话判断','')}")
    return call(GAP_SYS, '\n'.join(lines))


def enrich(items, id2c):
    return [{'time': it.get('time', ''), 'title': it.get('title') or '', 'summary': id2c.get(it.get('id'), '')} for it in items]


def newslines(news):
    return "\n".join(f"[{n['time']}] {n['title']} {n['summary']}".strip() for n in news)


def analyze_macro(backdrop):
    return call(MACRO_SYS, "宏观/国际新闻：\n" + newslines(backdrop))


def analyze_sentiment(senti_news, pulse=None):
    """情绪分析：新闻 + 盘面硬数据。两者都缺才返回 None。"""
    parts = []
    if senti_news:
        parts.append("A股盘面情绪新闻：" + chr(10) + newslines(senti_news))
    hard = pulse_lines(pulse)
    if hard:
        parts.append(chr(10).join(hard))
    if not parts:
        return None
    return call(SENTIMENT_SYS, (chr(10) * 2).join(parts))


def parse_args():
    argv = sys.argv[1:]
    out = None
    if '--out' in argv:
        i = argv.index('--out')
        out = argv[i + 1]
        argv = argv[:i] + argv[i + 2:]
    if len(argv) < 2:
        print('用法: python analyze.py <news.json> <classified.json> [--out <报告路径>]')
        sys.exit(1)
    return argv[0], argv[1], out


def main():
    news_path, cls_path, out_override = parse_args()
    news = json.load(open(news_path, encoding='utf-8'))
    cls = json.load(open(cls_path, encoding='utf-8'))

    id2c = {}
    for it in news['items']:
        id2c[it.get('id')] = (it.get('content') or it.get('title') or '').strip()[:150]

    dist = cls['distribution']
    industries = cls['industries']
    sectors = [(k, v) for k, v in dist.items() if k not in BACKDROP and v >= MIN_COUNT]
    sectors = sorted(sectors, key=lambda x: -x[1])[:TOP_N]

    macro_news = enrich(industries.get('宏观', []), id2c) + enrich(industries.get('国际市场', []), id2c)
    senti_news = enrich(industries.get('市场情绪面', []), id2c)
    print(f"宏观背景分析（{len(macro_news)} 条）...")
    macro = analyze_macro(macro_news) if macro_news else None
    print("拉取盘面硬数据（涨跌分布/成交额/市场宽度）...")
    pulse = fetch_market_pulse()
    print(f"市场情绪温度分析（{len(senti_news)} 条新闻 + 硬数据{'有' if pulse else '无'}）...")
    senti = analyze_sentiment(senti_news, pulse)

    # 模型偶发输出英文键（如 direction/confidence），统一归一化为中文键
    key_aliases = {'news_points': '新闻要点', 'core_logic': '核心逻辑', 'opportunities': '机会',
                   'risks': '风险', 'signals': '验证信号', 'direction': '方向', 'confidence': '信心'}
    results = []
    for name, cnt in sectors:
        print(f"分析板块 {name}（{cnt} 条）...")
        r = call(SECTOR_SYS, f"板块：{name}（{cnt}条新闻）\n" + newslines(enrich(industries[name], id2c)))
        if r:
            for en, zh in key_aliases.items():
                if zh not in r and en in r:
                    r[zh] = r[en]
        results.append((name, r))

    print("跨板块主线...")
    cross = call(CROSS_SYS, "各板块核心逻辑：\n" + "\n".join(
        f"{name}：{r.get('核心逻辑', '')}" for name, r in results if r))

    smap, snames = load_stock_map()
    sector_stocks = sector_stock_index(sectors, industries, id2c, smap, snames) if smap else {}
    if sector_stocks:
        print(f"个股标注：{sum(len(v) for v in sector_stocks.values())} 只落到 {len(sector_stocks)} 个板块")

    print("估值实测（拉取板块 PE/PB/股息率及历史分位）...")
    vals = fetch_valuations([name for name, _ in sectors])
    valz = analyze_valuation(vals, results) if vals else None

    print("资金流实测（拉取板块及二级细分主力净流入）...")
    flows = fetch_fund_flows([name for name, _ in sectors])
    flowz = analyze_flows(flows, results) if flows else None

    print("预期差分析（拉取板块近30日价格）...")
    # 腾讯源日线含当日，板块与基准同源同口径，直接按板块截止日对齐基准即可。
    prices = fetch_prices([name for name, _ in sectors])
    if prices:
        asof = next(iter(prices.values()))['数据截止']
        bench = fetch_benchmark(asof)
        if bench and bench['数据截止'] != asof:
            print(f"  [预期差] 警告：基准截止 {bench['数据截止']} 与板块截止 {asof} 不一致")
    else:
        bench = None
    gap = analyze_gap(prices, bench, results, senti) if prices else None

    md = []
    md.append("# 板块机会/风险/验证信号报告")
    md.append("")
    md.append(f"> 数据：{news.get('count', len(news['items']))} 条新闻 ｜ 模型：{MODEL} ｜ 重点板块：{len(sectors)} 个")
    md.append("")
    md.append("## 一、宏观背景与风险偏好")
    md.append("")
    if macro:
        for m in macro.get('宏观主线', []):
            md.append(f"- **{m.get('主线','')}**（对A股：{m.get('对A股','')}）：{m.get('要点','')}")
        md.append("")
        md.append(f"**风险偏好**：{macro.get('风险偏好','')}")
    else:
        md.append("（无宏观/国际新闻）")
    md.append("")
    md.append("## 二、市场情绪温度")
    md.append("")
    if senti:
        md.append(f"**情绪温度：{senti.get('情绪温度','-')}** —— {senti.get('一句话判断','')}")
        for pt in senti.get('要点', []):
            md.append(f"- {pt}")
    else:
        md.append("（无盘面情绪新闻，也未取到盘面硬数据）")
    md.append("")
    if pulse:
        d, t, w = pulse.get('分布'), pulse.get('成交'), pulse.get('宽度')
        md.append("### 盘面硬数据")
        md.append("")
        md.append("> 交易所口径实测值，用于校验上面基于新闻的情绪判断——**新闻说法与硬数据冲突时以硬数据为准**。")
        md.append("")
        md.append("| 指标 | 数值 | 读法 |")
        md.append("|------|------|------|")
        if d:
            up, dn = d.get('上涨家数'), d.get('下跌家数')
            md.append(f"| 涨跌家数（实时） | 涨 {up} / 跌 {dn} / 平 {d.get('平盘家数')} | 上涨占比 {d.get('上涨占比%')}%，过半为多方占优 |")
            md.append(f"| 涨停 / 跌停 | {d.get('涨停家数')} / {d.get('跌停家数')} | 涨停数是赚钱效应最直接的读数 |")
        if t:
            md.append(f"| 两市成交额（{t.get('日期','-')}） | {t.get('两市成交额(亿)','-')} 亿 | 为5日均值 {t.get('当日两市成交额/5日均值(%)','-')}%、20日均值 {t.get('当日两市成交额/20日均值(%)','-')}%、60日均值 {t.get('当日两市成交额/60日均值(%)','-')}%；低于100%即缩量 |")
            md.append(f"| 指数涨跌（{t.get('日期','-')}） | 上证 {t.get('涨跌幅(上证指数)','-')}% ｜ 深成 {t.get('涨跌幅(深证成指)','-')}% ｜ 创业板 {t.get('涨跌幅(创业板指)','-')}% | 创业板弱于上证=资金偏防守 |")
        if w:
            md.append(f"| 市场宽度（{w.get('日期','-')}） | 涨跌比 {w.get('A股涨跌比','-')} | 20日新高 {w.get('A股创20日新高个股数','-')} 家 vs 新低 {w.get('A股创20日新低个股数','-')} 家；60日 {w.get('A股创60日新高个股数','-')} vs {w.get('A股创60日新低个股数','-')}。新低多于新高=普涨表象下结构在走弱 |")
        md.append("")
        # 半挂（分布有、成交/宽度缺）时，表格会缺行——补一句缺测说明，
        # 否则读者只看到少了几行，分不清是缺测还是本来没有。
        miss = [label for key, label in (('成交', '成交额与指数'), ('宽度', '市场宽度'))
                if not pulse.get(key)]
        if miss:
            md.append(f"> **本次未取到**：{'、'.join(miss)}——腾讯源 market-overview 返回空"
                      "（该路由 2026-09 起间歇性故障），该维度缺测，上表相应行已省略。")
            md.append("")
        if d and d.get('分档'):
            md.append("**涨跌幅分档**：" + "｜".join(f"{x['区间']} {x['家数']}家" for x in d['分档']))
            md.append("")
        if senti and senti.get('硬数据解读'):
            md.append(f"**硬数据解读**：{senti['硬数据解读']}")
            md.append("")
        md.append("> 口径说明：涨跌家数与涨跌停为**当日实时**；成交额、指数涨跌、市场宽度取自收盘统计（日期见各行），盘中运行时这几项为上一交易日。数据来源：腾讯自选股。")
        md.append("")
    else:
        # 行情源整体不可用时也要保留这一节：标题 + 缺测原因，别静默消失
        md.append("### 盘面硬数据")
        md.append("")
        md.append("> **本次不可得**——腾讯源 `changedist` / `market-overview` 均返回空"
                  "（该路由 2026-09 起间歇性故障），涨跌分布、成交额、市场宽度均未取到。"
                  "本节的盘面校验本次只能依据新闻转述，**未经硬数据核对**，请开盘后自行核对。")
        md.append("")
    md.append("## 三、重点板块（机会 / 风险 / 验证信号）")
    if vals:
        vread = {x.get('板块'): x.get('读法', '') for x in (valz or {}).get('分板块', [])}
        md.append("")
        md.append("### 板块估值实测")
        md.append("")
        md.append(f"> 实测数据，截止 **{next(iter(vals.values()))['数据截止']}**，来源：腾讯自选股"
                  "（申万一级行业指数 PE/PB/股息率 + 历史分位）。"
                  "分位为该指标在历史区间中的百分位——**PE/PB 分位越高越贵，股息率分位越高反而越便宜**。")
        md.append("")
        md.append("| 板块 | PE(TTM) | PE分位 | PB(LF) | PB分位 | 股息率(TTM,%) | 股息率分位 | 估值读法 |")
        md.append("|------|---------|--------|--------|--------|--------------|-----------|---------|")
        for name, _ in sectors:
            v = vals.get(name)
            if not v:
                continue
            md.append(f"| {name} | {val_num(v['PE'])} | {val_pct(v['PE分位'])} | {val_num(v['PB'])} | {val_pct(v['PB分位'])} "
                      f"| {val_num(v['股息率'])} | {val_pct(v['股息率分位'])} | {vread.get(name, '-')} |")
        md.append("")
        if valz and valz.get('估值结论'):
            md.append(f"**估值维度结论**：{valz['估值结论']}")
            md.append("")
    else:
        # 宁缺勿替：取不到就明写「本次不可得 + 原因」，不让这一维度静默消失
        # （整节消失会让读者以为该维度正常无异常）。
        md.append("")
        md.append("### 板块估值实测")
        md.append("")
        md.append("> **本次不可得**——腾讯源估值接口（`sector valuation`）返回 0 条，"
                  "该路由 2026-09 起间歇性故障，全部板块的 PE/PB/股息率与历史分位均未取到，"
                  "本报告「贵不贵」这一维度缺测。**不得用其他口径或别的日期的数字顶替**，"
                  "下个交易日批次会重新尝试。")

    md.append("")
    md.append("### 板块资金流实测（含二级细分）")
    md.append("")
    if flows:
        fread = {x.get('板块'): x.get('读法', '') for x in (flowz or {}).get('分板块', [])}
        md.append(f"> 实测数据，截止 **{next(iter(flows.values()))['数据截止']}**，来源：腾讯自选股"
                  "（申万行业指数主力资金净流入，逐日累加，单位亿元，正=净流入）。"
                  "**一级是加总值会抹平内部分化，细分结构看二级**——同为「净流出」，"
                  "全面失血与「部分细分吸金、其余失血」的操作含义完全不同。"
                  "申万三级行业腾讯源无资金流数据（字段恒为 0），故本表只到二级。"
                  f"⚠️ **「最新日」列是当日盘中滚动累计值，抓取时刻 {next(iter(flows.values()))['抓取时刻']}**——"
                  "同一天不同时刻拉到的数不一样（实测当日 09:30 为 -4.0 亿、14:44 为 +196 亿），"
                  "它只代表这一时刻的累计进度，**不能当日终值用**；方向判断以近5日/近20日为准。")
        md.append("")
        md.append(f"| 板块 | 最新日（{next(iter(flows.values()))['抓取时刻']}滚动） | 近5日 | 近10日 | 近20日 | 二级细分（近5日，吸金 ↔ 失血） | 资金读法 |")
        md.append("|------|--------|-------|--------|--------|------------------------------|---------|")
        for name, _ in sectors:
            f = flows.get(name)
            if not f:
                continue
            md.append(f"| {name} | {f['最新日亿']:+.2f} | {f['近5日亿']:+.1f} | {f['近10日亿']:+.1f} "
                      f"| {f['近20日亿']:+.1f} | {flow_sub_line(f)} | {fread.get(name, '-')} |")
        md.append("")
        if flowz and flowz.get('资金结论'):
            md.append(f"**资金维度结论**：{flowz['资金结论']}")
            md.append("")
    else:
        # 宁缺勿替：同估值，取不到就明写「本次不可得 + 原因」，不整节删除
        md.append("> **本次不可得**——腾讯源资金流接口（`fund flow`）返回 0 条，"
                  "全部板块的主力资金净流入（一级与二级细分）均未取到，"
                  "本报告「谁在买」这一维度缺测。**不得用其他口径或别的日期的数字顶替**，"
                  "下个交易日批次会重新尝试。")
        md.append("")
    for name, r in results:
        if not r:
            # 模型接口失败时该板块原先会被静默跳过；新闻分析是报告的核心，
            # 宁可留个带原因的占位，标题格式与正常板块一致以便下游解析。
            md.append("")
            md.append(f"### {name}（方向：- ｜ 信心：-）")
            md.append(f"> **本节缺测**——该板块的新闻分析调用失败（模型接口异常或超时），"
                      f"新闻原文见附录「{name}」条目，下个批次会重试。")
            continue
        md.append("")
        md.append(f"### {name}（方向：{r.get('方向','-')} ｜ 信心：{r.get('信心','-')}）")
        pts = r.get('新闻要点', [])
        if pts:
            md.append("- **新闻要点**：")
            for p in pts:
                md.append(f"  - {p}")
        md.append(f"- **核心逻辑**：{r.get('核心逻辑','')}")
        md.append(f"- **机会**：{'；'.join(r.get('机会', []))}")
        md.append(f"- **风险**：{'；'.join(r.get('风险', []))}")
        vs = r.get('验证信号', {}) or {}
        md.append("- **验证信号**：")
        if vs.get('催化日历'):
            md.append(f"  - 催化日历：{'；'.join(vs['催化日历'])}")
        if vs.get('基本面'):
            md.append(f"  - 基本面：{'；'.join(vs['基本面'])}")
        if vs.get('资金情绪'):
            md.append(f"  - 资金情绪：{'；'.join(vs['资金情绪'])}")
        sf = (flows or {}).get(name)
        if sf:
            # 模型给的「资金情绪」是基于新闻的定性观察点；这一行是实测硬数据，二者不可混为一谈
            md.append(f"  - 资金流实测（{sf['数据截止']}，腾讯源）：主力净流入 "
                      f"最新日 {sf['最新日亿']:+.2f}亿（截至 {sf['抓取时刻']} 盘中滚动）"
                      f"｜近5日 {sf['近5日亿']:+.1f}亿｜近20日 {sf['近20日亿']:+.1f}亿"
                      f"；二级细分 {flow_sub_line(sf)}")
        sv = (vals or {}).get(name)
        if sv:
            md.append(f"  - 估值实测（{sv['数据截止']}，腾讯源）：PE(TTM) {val_num(sv['PE'])}（分位{val_pct(sv['PE分位'])}）"
                      f"｜PB {val_num(sv['PB'])}（分位{val_pct(sv['PB分位'])}）"
                      f"｜股息率 {val_num(sv['股息率'])}%（分位{val_pct(sv['股息率分位'])}）")
        if sector_stocks.get(name):
            lst = '、'.join(f'{k}({v})' for k, v in list(sector_stocks[name].items())[:12])
            md.append(f"- **相关个股**：{lst}")
    md.append("")
    md.append("## 四、跨板块主线")
    md.append("")
    if cross:
        for c in cross.get('跨板块主线', []):
            md.append(f"- **{c.get('主线','')}**（{'/'.join(c.get('涉及板块', []))}）：{c.get('逻辑','')}")
    md.append("")

    md.append("## 五、预期差视角补充（消息 × 价格 × 扩散度）")
    md.append("")
    md.append("### 这一节是什么（首次阅读先看这里）")
    md.append("")
    md.append("前面第三节讲的是**消息面**：新闻说某板块有利好。但消息本身不是买卖依据——**利好早就被人知道并买进去了，价格就不会再涨**。")
    md.append("所以本节做一件事：**拿板块的真实价格反应，去检验前面的消息面判断**。三个维度：")
    md.append("")
    md.append("1. **消息**（偏多/偏空）——来自第三节各板块的方向结论。")
    md.append("2. **价格**（涨/跌/钝化）——板块指数近5日跑赢大盘多少（超额）。≥+3% 算涨，≤-3% 算跌，中间算「钝化」（有消息却不动，是最重要的警告信号）。同时看量能比：>1.2 放量（真有资金）、<0.8 缩量（上涨可能只是反抽）。")
    md.append("3. **扩散度**（小/大）——只有个别股票在动（个股级），还是整个板块甚至全市场在动（板块级/市场级）。决定该「换股」还是「调总仓位」。")
    md.append("")
    md.append("三者组合成 **八个象限**。每格给四件事：**市场在说什么**（这个组合背后是谁在买卖）、"
              "**仓位档**（拿多少）、**具体动作**（做什么）、**绝对不做**（最容易犯的错）：")
    md.append("")
    md.append("| 象限 | 市场在说什么（机制） | 仓位档 | 具体动作 | 绝对不做 |")
    md.append("|---|---|---|---|---|")
    md.append("| **1 利好+涨+扩散小**<br>个股正常兑现 | 只有做过功课的资金在买，没扩散开；逻辑按预期走，既无惊喜也无警报 "
              "| 维持现档 | 低位（距60日高点回撤>15%后的突破）加至标准仓；高位持有不追，用移动止盈保护（跌破20日线或回撤8%减半） "
              "| 不在高位把「同向」当加仓理由——同向只支持持有，位置决定能否加；止盈线不随情绪挪 |")
    md.append("| **2 利好+涨+扩散大**<br>板块主升浪 | 市场在重估整个产业的景气，增量资金按图索骥买全产业链；燃料是「还没上车的人」 "
              "| **偏高档 70%~90%** | 顺势持有 + 向龙头集中；每日核对过热清单（成交历史天量／涨停激增但封板率下降／龙头放巨量滞涨／指数单日巨震），命中≥2条即预备降档 "
              "| 不追浪尾补涨股（扩散到杂毛股正是浪尾特征）；不在没写退出预案的情况下持有 |")
    md.append("| **3 利好+跌+扩散小**<br>个股利好出尽 | 想买的早买完了，公告只是「确认已知」；公告日的成交活跃恰好给获利盘最好的出货窗口 "
              "| 维持现档（只动这只股） | 该股减半或清仓，其余持仓不动；**同时写死回补条件**——缩量企稳（量能萎缩至高点1/3以下）+ 重新放量收复公告日高点 "
              "| 不用「业绩这么好」补仓摊低成本；反弹2%不算回补信号；不因这一只错杀其他持仓 |")
    md.append("| **4 利好+跌+扩散大**<br>板块兑现退潮 | 景气已成全市场共识、没有对手盘，机构借业绩公告出货；扩散大说明是**钱的问题**，基本面好的只是跌得慢 "
              "| **降至防守档 ≤30%~50%** | 先降仓再研究：板块仓位压到防守线，可留龙头观察仓；等企稳+缩量+重新放量突破再谈基本面 "
              "| **不抄底、不补仓**；不把降仓做成换股（板块级问题换股解决不了）；不「降一半留一半赌反弹」 |")
    md.append("| **5 利空+跌+扩散小**<br>个股风险释放 | 止损盘与规避资金在撤离，价格找新均衡；特征是「跌不出承接」——反弹无量、阴跌不止 "
              "| 维持现档（只动这只股） | 回避，跌不出机会前不碰；持有者分清利空性质：一次性的（罚款/事故）可评估去留，持续性的（主业恶化/造假）直接止损离场 "
              "| 不提前接飞刀——等象限7信号（利空钝化、缩量、不创新低）再谈 |")
    md.append("| **6 利空+跌+扩散大**<br>系统性风险 | 抛售来自仓位管理而非基本面（赎回、强平、风控降仓），这类卖出不问价格、对利好免疫 "
              "| **总仓位 ≤30%，杠杆清零** | 大幅降仓保本金；精力转去记录哪些板块最抗跌、哪些率先放量反弹——它们通常是下一轮主线 "
              "| 不做「换个更抗跌板块」的横向腾挪（暴跌中相关性趋近1）；不急于抄底摊平；不用「我拿的是好公司」拒绝降仓 |")
    md.append("| **7 利空+涨+扩散小**<br>个股利空出尽 | 坏消息砸不动价格＝想卖的已卖完，最后一批恐慌盘被公告清洗，浮动抛压枯竭 "
              "| **单笔 ≤10% 试探** | 小仓试探，**止损写死在利空公告日低点**；试探仓盈利且缩量回踩不破 → 再加至半仓/标准仓 "
              "| 信号一出就重仓（试探≠确认）；不设证伪位「再等等看」；在没有深跌背景（回撤>30%）的股票上套用本格 |")
    md.append("| **8 利空+涨+扩散大**<br>空头衰竭 | 场外配置需求压倒了利空引发的减仓需求；通常出现在熊末（悲观已充分定价）或牛中（增量资金压倒一切） "
              "| **逐步回标准档 50%→70%** | 买「利空当日最抗跌、反弹最先创新高」的板块与龙头；分批建仓，首笔≤30%目标仓位，回踩不破再补 "
              "| 不买「跌得最多的」（抗跌才是资金偏好的证据，超跌不是）；不一次性满仓 |")
    md.append("")
    md.append("**处理对象由扩散度决定**：扩散小＝只动这一个板块的持仓（调该板块仓位或板块内换股即可解决）；"
              "扩散大＝动**总仓位**（换股解决不了钱的问题）。")
    md.append("")
    md.append("> 口径转换：上表 1/3/5/7 格沿用讲义的个股表述，本报告逐**板块**套用该框架——"
              "这几格里的「该股」在这里读作「该板块的持仓」，「其余持仓不动」读作「其他板块不受牵连」。")
    md.append("")
    md.append("**怎么用**：在下方表格找你关心的板块 → 看它的「象限定位」→ 回上表读该象限的**仓位档／具体动作／绝对不做** → "
              "再到「分板块补充说明」看结合本周实际价格的**应对**和**证伪条件**（出现什么价格行为说明这个判断错了、该怎么改）。")
    md.append("最后的「操作纪律」是把所有板块合起来的总仓位约束。")
    md.append("")
    md.append("**三个提醒**：① 价格数据截止日见下方说明（腾讯源含当日，盘中跑则最新一根是盘中价），**隔夜外围大涨大跌会直接推翻结论**，开盘先核对；")
    md.append("② 本节是仓位管理框架，不构成个股买卖建议；③ 结论必须带证伪条件，判断错了就按证伪条件立刻改，不要死扛。")
    md.append("")
    md.append("### 定位结果")
    md.append("")
    md.append("> 框架：消息 × 价格 × 扩散度 → 八象限定位（讲义 v2）。核心纪律：**利好不涨即利空，利空不跌即利多；个股背离换股，板块背离调仓——向下保本金，向上给利润。**")
    md.append("> 价格裁决：近5日超额 ≥+3% 算涨、≤-3% 算跌、之间算钝化（降档处理）；量能比 >1.2 放量、<0.8 缩量。每个判断附证伪条件。")
    if prices and gap:
        sample = next(iter(prices.values()))
        md.append(f"> 价格数据：申万一级行业指数，区间 {sample['区间']}（近30个交易日），"
                  f"**数据截止 {sample.get('数据截止','-')}**，来源腾讯自选股；"
                  f"该源日线含当日，若在盘中运行则最新一根为盘中价，收盘后运行才等同收盘价。" + (
            f"市场基准（上证指数，已对齐至同一截止日）近5日 {bench['近5日涨跌%']:+.1f}%。"
            if bench else "基准指数不可用，超额列以绝对涨跌近似。"))
        md.append("")
        md.append("| 板块 | 近30日涨跌 | 近5日涨跌 | 近5日超额 | 价格档 | 量能档 | 距30日高点回撤 | 消息面 | 象限定位 |")
        md.append("|------|-----------|----------|----------|--------|--------|---------------|--------|---------|")
        quad = {g.get('板块'): g for g in gap.get('分板块', [])}
        for name, r in results:
            p = prices.get(name)
            if not p:
                continue
            msg = (r or {}).get('方向', '-')
            excess, grade, vol = price_label(p, bench)
            volcell = f"{vol} {p['量能比']:.2f}" if vol else '-'
            md.append(f"| {name} | {p['近30日涨跌%']:+.1f}% | {p['近5日涨跌%']:+.1f}% | {excess:+.1f}% | {grade} | {volcell} | {p['距30日高点回撤%']:.1f}% | {msg} | {quad.get(name, {}).get('象限定位', '-')} |")
        md.append("")
        md.append(f"**扩散度判定**：{gap.get('扩散度判定','')}")
        md.append("")
        md.append(f"**总体结论**：{gap.get('总体结论','')}")
        if gap.get('象限迁移预判'):
            md.append("")
            md.append(f"**象限迁移预判**：{gap['象限迁移预判']}")
        md.append("")
        md.append("**分板块补充说明**：")
        for g in gap.get('分板块', []):
            line = f"- **{g.get('板块','')}**（{g.get('象限定位','')}）：{g.get('补充说明','')} **应对：{g.get('应对','')}**"
            if g.get('证伪条件'):
                line += f" 证伪条件：{g['证伪条件']}"
            warn = check_quadrant(g.get('象限定位', ''))
            if warn:
                print(f"  [预期差] {g.get('板块','')} {warn}")
                line += f"\n  - {warn}"
            md.append(line)
        md.append("")
        md.append("**操作纪律**：")
        for i, rule in enumerate(gap.get('操作纪律', []), 1):
            md.append(f"{i}. {rule}")
    else:
        md.append("")
        md.append("（板块价格数据不可用——westock-data 拉取失败或 Node.js 不可用，本节跳过；修复后重跑补全。）")
    md.append("")

    md.append("## 附录：新闻分类清单（供溯源核对）")
    md.append("")
    md.append("> 每条新闻的行业归属（含宏观/国际市场/非重点板块），按行业新闻量降序；标题为空的电报用内容摘要。")
    for ind, items in sorted(industries.items(), key=lambda x: -len(x[1])):
        md.append("")
        md.append(f"### {ind}（{len(items)}条）")
        for it in items:
            label = (it.get('title') or id2c.get(it.get('id'), '')).strip().replace('\n', ' ')[:80]
            md.append(f"- [{it.get('time','')}] {label}")
    md.append("")

    base, _ext = os.path.splitext(news_path)
    md_path = out_override or (base + '_analysis.md')
    json_path = base + '_analysis.json'
    open(md_path, 'w', encoding='utf-8').write("\n".join(md))
    json.dump({'macro': macro, 'sentiment': senti, 'pulse': pulse,
               'sectors': [{'name': n, 'analysis': r} for n, r in results], 'cross': cross,
               'prices': prices, 'gap': gap, 'valuations': vals, 'valuation_read': valz,
               'fund_flows': flows, 'fund_flow_read': flowz},
              open(json_path, 'w', encoding='utf-8'), ensure_ascii=False, indent=2)

    print(f"\n=== 分析完成：{len(sectors)} 个重点板块 ===")
    print(f"-> {md_path}")


if __name__ == '__main__':
    main()
