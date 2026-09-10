/** api-spec.md vs Q0 observed 2026-09-10. Never infer unknown market codes. */
export const mockContract = [
  {
    documented: "result[].gddm",
    observed: "result[].gdzh",
    difference: "股东账号字段更名；两种契约均显式接受，同现时须一致",
  },
  {
    documented: "result[].scdm: 1/2",
    observed: "result[].scdm: 9/8/2/1/:",
    difference: "1=深圳、2=上海仅依据文档；9/8/: 市场代码含义未确认，原样保留",
  },
  {
    documented: "result[].wfjg（示例）",
    observed: "result[].mflg",
    difference: "辅助标记不同；不用于交易判断，不推断等价",
  },
  {
    documented: "委托 result 对象含 userid/gdh/scdm",
    observed: "result/list 数组含 entrust_no",
    difference: "成功码仅证明受理，不证明成交；本次无市场映射证据",
  },
  {
    documented: "持仓 /pt_web_qy_stock；data[]",
    observed: "stock_query.py /pt_web_qry_stock；实测 result[]",
    difference: "文档路径少 r 导致接口不存在；采用技能脚本路径，不自动回退重试",
  },
  {
    documented: "持仓 gpsl=总数量",
    observed: "gpsl=0、djsl=100、kysl=0；成交100股，市值对应100股",
    difference:
      "实测总数量=gpsl+djsl，可卖仍只用kysl；djsl缺失拒绝解析，不把当日冻结股算作可卖",
  },
  {
    documented: "资金参数 usid；result.list[].dje",
    observed: "stock_query.py 参数 usrid；实测 list[].djje",
    difference:
      "两套响应显式适配；保留zjye与kyje原义，余额与可用资金不相等时不覆盖",
  },
  {
    documented: "成交参数 usrid；ret.code / ret.item[].cjg/cje",
    observed:
      "stock_query.py 参数 usrname（资金账号）；实测 errorcode / result[].cjjg/cjje/cjsl",
    difference:
      "按实测字段读取价格、金额和数量；错误对象或缺字段仍拒绝，保留原始响应",
  },
] as const;
export const mockMarketLabel = (code: string) =>
  code === "1"
    ? "深圳（文档）"
    : code === "2"
      ? "上海（文档）"
      : "市场代码含义未确认";
