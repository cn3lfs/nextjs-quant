import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  cleanCell,
  decodeDeliveryBytes,
  parseDeliveryTable,
} from "~/lib/research/evidence/delivery-table";
import {
  classifyCode,
  classifyRow,
  importDeliveryTable,
  mapDeliveryColumns,
  parseDeliveryDate,
  parseDeliveryNumber,
  parseDeliveryTime,
  redactRow,
} from "~/lib/research/evidence/delivery-import";

const fixture = (name: string) =>
  readFileSync(join(process.cwd(), "tests/fixtures/delivery", name));
const runImport = (name: string) =>
  importDeliveryTable(parseDeliveryTable(fixture(name)));

describe("R8 零金额非市场成交", () => {
  const header = "成交日期,证券代码,操作,成交价格,成交数量,成交金额,发生金额";
  it.each(["买入", "卖出"])("无备注的%s保留原始行并明确待核对", (side) => {
    const table = parseDeliveryTable(
      `${header}\n20230412,370409,${side},100,10,0,0`,
    );
    const result = importDeliveryTable(table);
    expect(result.fills).toEqual([]);
    expect(result.cashFlows).toEqual([]);
    expect(result.unresolved).toEqual([
      {
        rowIndex: 1,
        reason:
          "价量为正但成交金额与发生金额均为 0，不是市场成交；业务类型无法确定",
        cells: table.rows[0],
      },
    ]);
  });
  it.each(["备注", "摘要"])("%s可判定中签时仍按现金流处理", (column) => {
    const result = importDeliveryTable(
      parseDeliveryTable(
        column === "备注"
          ? `${header},备注\n20230412,370409,买入,100,10,0,0,道氏发债申购中签(转非流通)`
          : `${header.replace("操作", "摘要")}\n20230412,370409,道氏发债申购中签(转非流通),100,10,0,0`,
      ),
    );
    expect(result.fills).toEqual([]);
    expect(result.unresolved).toEqual([]);
    expect(result.cashFlows).toMatchObject([
      { kind: "subscription", code: "370409", quantity: 10, amount: 0 },
    ]);
  });
  it.each([
    ["100", "10", "1000", "-1000"],
    ["100", "10", "0", "-1000"],
    ["100", "10", "1000", "0"],
    ["100", "10", "", "0"],
    ["100", "10", "0", ""],
    ["100", "-10", "0", "0"],
  ])("其他金额组合保留既有成交路径 %s/%s/%s/%s", (price, qty, amount, net) => {
    const result = importDeliveryTable(
      parseDeliveryTable(
        `${header}\n20230412,600000,买入,${price},${qty},${amount},${net}`,
      ),
    );
    expect(result.fills).toHaveLength(1);
    expect(result.unresolved).toEqual([]);
    expect(result.cashFlows).toEqual([]);
  });
  it("既有分红和配号 fixture 保持分流，正数量配号仍是现金流", () => {
    const table = parseDeliveryTable(fixture("ths-history.txt"));
    const result = importDeliveryTable(table);
    expect(
      result.cashFlows.filter((row) => row.kind === "dividend"),
    ).toMatchObject([{ quantity: 0, amount: 62 }]);
    const allocations = result.cashFlows.filter(
      (row) =>
        row.kind === "subscription" &&
        ["301272", "301456", "371015", "370793"].includes(row.code!),
    );
    expect(allocations).toHaveLength(4);
    expect(allocations.map((row) => row.amount)).toEqual([0, 0, 0, 0]);
    const allocationRow = [...table.rows[allocations[0]!.rowIndex - 1]!];
    allocationRow[result.mapping.columns.price!] = "100";
    allocationRow[result.mapping.columns.quantity!] = "10";
    const positive = importDeliveryTable({ ...table, rows: [allocationRow] });
    expect(positive.fills).toEqual([]);
    expect(positive.unresolved).toEqual([]);
    expect(positive.cashFlows).toMatchObject([
      { kind: "subscription", quantity: 10, amount: 0 },
    ]);
  });
});

describe("R5b 经济身份与编号证据", () => {
  it.each(["0", "0.0", "0.00", "000", "000.000"])(
    "零值编号 %s 等同缺失",
    (id) => {
      const result = importDeliveryTable(
        parseDeliveryTable(
          [
            "成交日期,证券代码,操作,成交价格,成交数量,发生金额,成交编号,合同编号",
            `20250110,300398,股息红利扣税,0,0,-21,${id},${id}`,
            `20250110,300398,股息红利扣税,0,0,-3.60,${id},${id}`,
            `20250110,300398,买入,10,100,-1000,${id},${id}`,
          ].join("\n"),
        ),
      );
      expect(result.unresolved).toEqual([]);
      expect(result.cashFlows.map((row) => row.amount)).toEqual([-21, -3.6]);
      expect(
        new Set(result.cashFlows.map((row) => row.fingerprintSource)).size,
      ).toBe(2);
      for (const row of [...result.fills, ...result.cashFlows]) {
        expect(row.dealId).toBeNull();
        expect(row.orderId).toBeNull();
      }
    },
  );

  it("真实前导零编号原样保留且不参与指纹，重复经济身份按出现次序区分", () => {
    const parse = (id: string) =>
      importDeliveryTable(
        parseDeliveryTable(
          [
            "成交日期,证券代码,操作,成交价格,成交数量,发生金额,成交编号,合同编号",
            `20250110,300398,买入,10,100,-1000,${id},${id}`,
            `20250110,300398,买入,10,100,-1000,${id},${id}`,
            `20250110,300398,股息红利扣税,0,0,-21,${id},${id}`,
            `20250110,300398,股息红利扣税,0,0,21,${id},${id}`,
          ].join("\n"),
        ),
      );
    const result = parse("0105000019041204"),
      missing = parse("");
    for (const row of [...result.fills, ...result.cashFlows]) {
      expect(row.dealId).toBe("0105000019041204");
      expect(row.orderId).toBe("0105000019041204");
    }
    expect(result.fills.map((r) => r.fingerprintSource)).toEqual(
      missing.fills.map((r) => r.fingerprintSource),
    );
    expect(result.cashFlows.map((r) => r.fingerprintSource)).toEqual(
      missing.cashFlows.map((r) => r.fingerprintSource),
    );
    expect(new Set(result.fills.map((r) => r.fingerprintSource)).size).toBe(2);
    expect(new Set(result.cashFlows.map((r) => r.fingerprintSource)).size).toBe(
      2,
    );
  });
});

describe("编码识别", () => {
  it("按 BOM 识别 UTF-8 与 UTF-16", () => {
    const text = "成交日期,证券代码\n";
    expect(
      decodeDeliveryBytes(
        new Uint8Array([0xef, 0xbb, 0xbf, ...Buffer.from(text, "utf8")]),
      ),
    ).toEqual({ text, encoding: "utf-8-bom" });
    expect(
      decodeDeliveryBytes(
        new Uint8Array([0xff, 0xfe, ...Buffer.from(text, "utf16le")]),
      ),
    ).toEqual({ text, encoding: "utf-16le" });
  });
  it("无 BOM 时优先 UTF-8，非法 UTF-8 才回退 GB18030", () => {
    expect(decodeDeliveryBytes(Buffer.from("成交日期", "utf8"))).toEqual({
      text: "成交日期",
      encoding: "utf-8",
    });
    // 0xB0 0xA1 是 GBK 的「啊」，同时是非法 UTF-8 序列。
    expect(decodeDeliveryBytes(new Uint8Array([0xb0, 0xa1]))).toEqual({
      text: "啊",
      encoding: "gb18030",
    });
  });
  it("两种编码都解不出时明确报错", () => {
    expect(() =>
      decodeDeliveryBytes(new Uint8Array([0xff, 0x00, 0x80])),
    ).toThrow(/编码无法识别/);
  });
});

describe("单元格清洗", () => {
  it("剥离 Excel 防截断写法与全角空格", () => {
    expect(cleanCell('="600519"')).toBe("600519");
    expect(cleanCell('"000001"')).toBe("000001");
    expect(cleanCell("'000001")).toBe("000001");
    expect(cleanCell("　贵州茅台 ")).toBe("贵州茅台");
  });
});

describe("表格解析", () => {
  it("跳过前导标题行定位表头（HTML）", () => {
    const table = parseDeliveryTable(fixture("ths-statement.html"));
    expect(table.format).toBe("html");
    expect(table.preamble[0]).toContain("历史成交查询");
    expect(table.header[0]).toBe("成交日期");
    expect(table.rows).toHaveLength(4);
    expect(table.rows[0]![2]).toBe("600519");
  });
  it("识别逗号分隔与千分位引号字段", () => {
    const table = parseDeliveryTable(fixture("eastmoney-statement.csv"));
    expect(table.format).toBe("csv");
    expect(table.header).toContain("业务名称");
    expect(table.rows).toHaveLength(8);
    expect(table.rows[0]![9]).toBe("200,000.00");
  });
  it("识别制表符分隔", () => {
    const table = parseDeliveryTable(fixture("tdx-statement.txt"));
    expect(table.format).toBe("tsv");
    expect(table.rows).toHaveLength(3);
  });
  it("丢弃重复表头与汇总行并记录原因", () => {
    const table = parseDeliveryTable(
      [
        "成交日期,证券代码,操作,成交价格,成交数量",
        "2026-01-05,600519,证券买入,1500,100",
        "成交日期,证券代码,操作,成交价格,成交数量",
        "合计,,,,",
      ].join("\n"),
    );
    expect(table.rows).toHaveLength(1);
    expect(table.dropped.map((row) => row.reason)).toEqual([
      "重复表头",
      "有效单元格过少",
    ]);
  });
  it("找不到表头时报错而不是把数据当表头", () => {
    expect(() => parseDeliveryTable("1,2,3\n4,5,6")).toThrow(
      /未找到交割单表头/,
    );
  });
});

describe("列映射", () => {
  it("按别名映射并报告重复列与未映射列", () => {
    const mapping = mapDeliveryColumns([
      "序号",
      "成交日期",
      "证券代码",
      "证券代码",
      "自定义列",
    ]);
    expect(mapping.columns.tradeDate).toBe(1);
    expect(mapping.columns.code).toBe(2);
    expect(mapping.duplicates).toEqual([
      { field: "code", header: "证券代码", index: 3 },
    ]);
    expect(mapping.unmapped.map((column) => column.header)).toEqual([
      "序号",
      "自定义列",
    ]);
  });
  it("「手续费」按佣金处理但给出口径告警", () => {
    expect(mapDeliveryColumns(["手续费"]).warnings[0]).toMatch(/费用合计/);
    expect(mapDeliveryColumns(["佣金"]).warnings).toHaveLength(0);
  });
  it("缺必要列时报错并列出已识别列", () => {
    expect(() =>
      importDeliveryTable(
        parseDeliveryTable(
          "成交日期,证券代码,证券名称,操作\n2026-01-05,600519,贵州茅台,证券买入",
        ),
      ),
    ).toThrow(/缺少必要列/);
  });
  it("既无摘要也无买卖方向时拒绝导入", () => {
    expect(() =>
      importDeliveryTable(
        parseDeliveryTable(
          "成交日期,证券代码,成交价格,成交数量\n2026-01-05,600519,1500,100",
        ),
      ),
    ).toThrow(/无法判定买卖/);
  });
});

describe("业务类型判定", () => {
  it("长词优先于其包含的短词", () => {
    expect(classifyRow("担保品买入", "")).toBe("buy");
    expect(classifyRow("融券卖出", "")).toBe("sell");
    expect(classifyRow("利息税", "")).toBe("fee");
    expect(classifyRow("利息归本", "")).toBe("interest");
  });
  it("覆盖资金与新股业务名称", () => {
    expect(classifyRow("银行转存", "")).toBe("transferIn");
    expect(classifyRow("银行转取", "")).toBe("transferOut");
    expect(classifyRow("红利入账", "")).toBe("dividend");
    expect(classifyRow("股息入账", "")).toBe("dividend");
    expect(classifyRow("新股申购", "")).toBe("subscription");
    expect(classifyRow("配号", "")).toBe("subscription");
  });
  it("无摘要时才使用买卖标志列的 1/2", () => {
    expect(classifyRow("", "1")).toBe("buy");
    expect(classifyRow("", "2")).toBe("sell");
    expect(classifyRow("", "买入")).toBe("buy");
  });
  it("未知业务不猜测", () => {
    expect(classifyRow("场外协议过户", "")).toBeNull();
    expect(classifyRow("", "")).toBeNull();
  });
});

describe("字段解析", () => {
  it("日期支持四种写法并拒绝非法日期", () => {
    expect(parseDeliveryDate("20260105")).toBe("2026-01-05");
    expect(parseDeliveryDate("2026-1-5")).toBe("2026-01-05");
    expect(parseDeliveryDate("2026/01/05")).toBe("2026-01-05");
    expect(parseDeliveryDate("2026年1月5日")).toBe("2026-01-05");
    expect(parseDeliveryDate("2026-02-30")).toBeNull();
    expect(parseDeliveryDate("")).toBeNull();
  });
  it("时间支持柜台的紧凑写法", () => {
    expect(parseDeliveryTime("110351")).toBe("11:03:51");
    expect(parseDeliveryTime("11:03:51")).toBe("11:03:51");
    // 三、四位是 HHMM：补到六位会把 1103 读成 00:11:03 并打乱当日成交顺序。
    expect(parseDeliveryTime("1103")).toBe("11:03:00");
    expect(parseDeliveryTime("11:03")).toBe("11:03:00");
    expect(parseDeliveryTime("935")).toBe("09:35:00");
    expect(parseDeliveryTime("93501")).toBe("09:35:01");
    expect(parseDeliveryTime("996199")).toBeNull();
  });
  it("金额支持千分位、括号负数与全角负号", () => {
    expect(parseDeliveryNumber("200,000.00")).toBe(200000);
    expect(parseDeliveryNumber("(1,102.00)")).toBe(-1102);
    expect(parseDeliveryNumber("−50")).toBe(-50);
    expect(parseDeliveryNumber("¥1.5")).toBe(1.5);
    expect(parseDeliveryNumber("--")).toBeNull();
    expect(parseDeliveryNumber("abc")).toBeNull();
  });
  it("按代码前缀判定市场与品种", () => {
    expect(classifyCode("600519")).toMatchObject({
      market: "sh",
      instrument: "stock",
    });
    expect(classifyCode("000001")).toMatchObject({
      market: "sz",
      instrument: "stock",
    });
    expect(classifyCode("688981")).toMatchObject({
      market: "sh",
      instrument: "stock",
    });
    expect(classifyCode("430047")).toMatchObject({
      market: "bj",
      instrument: "stock",
    });
    expect(classifyCode("113050")).toMatchObject({
      market: "sh",
      instrument: "convertible",
    });
    expect(classifyCode("123456")).toMatchObject({
      market: "sz",
      instrument: "convertible",
    });
    expect(classifyCode("159915")).toMatchObject({
      market: "sz",
      instrument: "fund",
    });
    expect(classifyCode("204001")).toMatchObject({
      market: "sh",
      instrument: "reverseRepo",
    });
    expect(classifyCode("787001")).toMatchObject({
      market: null,
      instrument: "other",
    });
  });
});

describe("同花顺样本", () => {
  const result = runImport("ths-statement.html");
  it("成交与红利分流，费用与发生金额自洽", () => {
    expect(
      result.fills.map((fill) => [fill.kind, fill.symbol, fill.quantity]),
    ).toEqual([
      ["buy", "sh600519", 100],
      ["sell", "sh600519", 100],
      ["buy", "sz000001", 2000],
    ]);
    expect(result.cashFlows).toHaveLength(1);
    expect(result.cashFlows[0]).toMatchObject({
      kind: "dividend",
      amount: 238,
    });
    expect(result.fills.flatMap((fill) => fill.anomalies)).toEqual([]);
  });
  it("费用合计取分项之和", () => {
    expect(result.fills[1]!.fees).toMatchObject({
      commission: 43.68,
      stampTax: 156,
      transferFee: 1.04,
    });
    expect(result.fills[1]!.fees.total).toBeCloseTo(200.72, 2);
    expect(result.fills[1]!.netAmount).toBe(155799.28);
  });
  it("指纹只用经济身份，成交编号仅作证据保留", () => {
    // 交割单没有成交编号列而成交明细有；指纹若依赖编号，同一笔在两种导出里
    // 得到不同指纹，跨文件导入就会把成交存两遍。
    expect(result.fills[0]!.dealId).toBe("D20260105001");
    expect(result.fills[0]!.fingerprintSource).not.toContain("D20260105001");
    expect(runImport("ths-statement.html").fills[0]!.fingerprintSource).toBe(
      result.fills[0]!.fingerprintSource,
    );
  });
});

describe("东方财富样本", () => {
  const result = runImport("eastmoney-statement.csv");
  it("资金流水按类型定号", () => {
    expect(result.cashFlows.map((flow) => [flow.kind, flow.amount])).toEqual([
      ["transferIn", 200000],
      ["interest", 12.35],
      ["subscription", -12800],
      ["subscription", 0],
      ["transferOut", -50000],
    ]);
  });
  it("无费用列时费用为 null，不按零填充", () => {
    expect(result.fills[0]!.fees.total).toBeNull();
    expect(result.fills[0]!.anomalies).toEqual([]);
  });
  it("非股票品种保留成交但标注排除", () => {
    const convertible = result.fills.at(-1)!;
    expect(convertible).toMatchObject({
      symbol: "sz123456",
      instrument: "convertible",
    });
    expect(result.diagnostics.join()).not.toContain("不参与个股分析");
  });
});

describe("通达信样本", () => {
  const result = runImport("tdx-statement.txt");
  it("用数字买卖标志判定方向", () => {
    expect(result.fills.map((fill) => fill.kind)).toEqual([
      "buy",
      "sell",
      "buy",
    ]);
    expect(result.unresolved).toEqual([]);
  });
  it("手续费列触发口径告警", () => {
    expect(result.diagnostics.join()).toMatch(/手续费/);
  });
  it("指纹不含合同编号，不同成交仍彼此区分", () => {
    expect(result.fills[0]!.orderId).toBe("WT100001");
    expect(result.fills[0]!.fingerprintSource).not.toContain("WT100001");
    expect(result.fills[0]!.fingerprintSource).not.toBe(
      result.fills[2]!.fingerprintSource,
    );
  });
});

describe("异常与不可解析行", () => {
  const build = (rows: string[]) =>
    importDeliveryTable(
      parseDeliveryTable(
        [
          "成交日期,证券代码,操作,成交价格,成交数量,成交金额,发生金额,佣金,印花税,过户费,费用合计",
          ...rows,
        ].join("\n"),
      ),
    );
  it("成交金额与价格×数量不符时标注但不丢弃", () => {
    const fill = build(["2026-01-05,600519,证券买入,1500,100,149000,,,,,"])
      .fills[0]!;
    expect(fill.amount).toBe(149000);
    expect(fill.anomalies[0]).toMatch(/与 价格×数量/);
  });
  it("可转债按张或按手都接受，两者都不符才标注", () => {
    // 沪市可转债「成交数量」是手（1 手 = 10 张），深市是张；两市同在一份交割单里。
    expect(
      build(["2022-09-14,113502,证券卖出,127.45,1,1274.5,,,,,"]).fills[0]!
        .anomalies,
    ).toEqual([]);
    expect(
      build(["2023-04-25,123190,证券卖出,116,10,1160,,,,,"]).fills[0]!
        .anomalies,
    ).toEqual([]);
    expect(
      build(["2022-09-14,113502,证券卖出,127.45,1,5000,,,,,"]).fills[0]!
        .anomalies[0],
    ).toMatch(/按张或按手/);
  });
  it("费用合计与分项之和不符时标注", () => {
    expect(
      build(["2026-01-05,600519,证券买入,1500,100,150000,,42,0,3,99"]).fills[0]!
        .anomalies[0],
    ).toMatch(/费用合计/);
  });
  it("发生金额与买卖方向符号矛盾时标注", () => {
    const anomalies = build([
      "2026-01-05,600519,证券买入,1500,100,150000,150045,42,0,3,45",
    ]).fills[0]!.anomalies;
    expect(anomalies.join()).toMatch(/符号与买入方向矛盾/);
  });
  it("日期、业务类型、价量非法的行进入待核对而不是被丢弃", () => {
    const result = build([
      "无效日期,600519,证券买入,1500,100,150000,,,,,",
      "2026-01-06,600519,场外协议过户,1500,100,150000,,,,,",
      "2026-01-07,600519,证券买入,0,100,0,,,,,",
      "2026-01-08,60051,证券买入,1500,100,150000,,,,,",
    ]);
    expect(result.fills).toHaveLength(0);
    expect(result.unresolved.map((row) => row.reason)).toEqual([
      "日期无法解析",
      "未知业务类型「场外协议过户」",
      "成交价格或数量缺失/非法",
      "证券代码非六位",
    ]);
  });
});

describe("指纹跨导出稳定", () => {
  const header =
    "成交日期,证券代码,操作,成交价格,成交数量,成交金额,发生金额,合同编号";
  const rows = {
    a: "2026-01-05,600519,证券买入,1500,100,150000,-150000,WT1",
    b: "2026-01-06,000001,证券卖出,11.2,2000,22400,22400,WT2",
    c: "2026-01-07,600036,证券买入,38.5,500,19250,-19250,WT3",
  };
  const sources = (...lines: string[]) =>
    importDeliveryTable(
      parseDeliveryTable([header, ...lines].join("\n")),
    ).fills.map((fill) => fill.fingerprintSource);
  it("同一笔成交在不同区间的导出里行号不同，指纹必须相同", () => {
    // 按月导出、区间重叠是常态：若指纹含行号，重叠部分会被当成新成交重复入库，
    // 持仓与盈亏直接翻倍。
    const [, second] = sources(rows.a, rows.b);
    const [first] = sources(rows.b, rows.c);
    expect(first).toBe(second);
  });
  it("同日同价同量的多笔成交仍按出现次序彼此区分", () => {
    const [first, second] = sources(rows.a, rows.a);
    expect(first).not.toBe(second);
    expect(sources(rows.a, rows.a)).toEqual([first, second]);
  });
  it("资金流水指纹同样不含行号", () => {
    const cash = (...lines: string[]) =>
      importDeliveryTable(
        parseDeliveryTable(
          ["成交日期,证券代码,操作,成交价格,成交数量,发生金额", ...lines].join(
            "\n",
          ),
        ),
      ).cashFlows.map((flow) => flow.fingerprintSource);
    const transfer = "2026-01-05,,银行转存,0,0,200000";
    const dividend = "2026-01-09,600519,红利入账,0,0,238";
    expect(cash(dividend, transfer)[1]).toBe(cash(transfer)[0]);
  });
});

describe("资金方向属于经济身份", () => {
  const header =
    "成交日期,证券代码,操作,成交价格,成交数量,成交金额,发生金额,合同编号";
  // 国债逆回购的融出与购回在交割单里都记为「卖出」，日期、代码、价格、数量全同，
  // 只有资金方向相反。不同导出对同日两笔的排序可能相反，若身份里没有方向，
  // 出现次序会把两笔对调，跨文件导入就会判成金额矛盾。
  const lend = "2026-04-09,204001,证券卖出,1.37,8,8000,-8000.08,WT1";
  const redeem = "2026-04-09,204001,证券卖出,1.37,8,8000,8000.30,WT2";
  const prints = (...lines: string[]) =>
    importDeliveryTable(
      parseDeliveryTable([header, ...lines].join("\n")),
    ).fills.map((fill) => fill.fingerprintSource);
  it("资金方向相反的两笔得到不同指纹", () => {
    const [a, b] = prints(lend, redeem);
    expect(a).not.toBe(b);
  });
  it("两份导出的同日顺序相反时，同一笔仍得到相同指纹", () => {
    const forward = prints(lend, redeem);
    const reversed = prints(redeem, lend);
    expect(forward[0]).toBe(reversed[1]);
    expect(forward[1]).toBe(reversed[0]);
  });
});

describe("账号脱敏", () => {
  it("识别到账号列后原始行按列替换", () => {
    const table = parseDeliveryTable(
      "成交日期,资金账号,证券代码,操作,成交价格,成交数量\n2026-01-05,12345678,600519,证券买入,1500,100",
    );
    const mapping = mapDeliveryColumns(table.header);
    expect(redactRow(table.rows[0]!, mapping)).toEqual([
      "2026-01-05",
      "***",
      "600519",
      "证券买入",
      "1500",
      "100",
    ]);
    expect(importDeliveryTable(table).diagnostics.join()).toMatch(/脱敏/);
  });
  it("资金账号与股东代码同时存在时两列都脱敏", () => {
    const table = parseDeliveryTable(
      "成交日期,资金账号,股东代码,证券代码,操作,成交价格,成交数量\n2026-01-05,12345678,A987654,600519,证券买入,1500,100",
    );
    const redacted = redactRow(
      table.rows[0]!,
      mapDeliveryColumns(table.header),
    );
    expect(redacted.slice(1, 3)).toEqual(["***", "***"]);
    expect(redacted.join()).not.toMatch(/12345678|A987654/);
  });
});

describe("R1b 真实结构合成样本", () => {
  it("历史成交 32 行完整分流，逆回购豁免可见且不产生假警报", () => {
    const table = parseDeliveryTable(fixture("ths-history.txt"));
    const result = importDeliveryTable(table);
    expect(table.format).toBe("tsv");
    expect(table.encoding).toBe("gb18030");
    expect(table.rows).toHaveLength(32);
    expect(table.dropped).toEqual([]);
    expect(result.fills).toHaveLength(21);
    expect(result.cashFlows).toHaveLength(11);
    expect(result.unresolved).toEqual([]);
    expect(
      result.fills.filter((f) => f.instrument === "reverseRepo"),
    ).toHaveLength(6);
    expect(result.fills.flatMap((f) => f.anomalies)).toEqual([]);
    expect(result.diagnostics.join()).toMatch(/6 笔逆回购豁免/);
    expect(result.diagnostics.join()).toContain("成交明细形态");
    expect(
      result.cashFlows
        .filter((f) => f.kind === "dividend")
        .map((f) => f.amount),
    ).toEqual([62]);
    expect(
      result.cashFlows
        .filter((f) => f.kind === "fee")
        .map((f) => f.amount)
        .sort((a, b) => a - b),
    ).toEqual([-15, -12.4, -8.6, -4.2]);
    expect(
      result.cashFlows
        .filter((f) => f.kind === "subscription")
        .map((f) => f.amount),
    ).toEqual([-1000, 0, 0, 0, 0, 0]);
    expect(
      result.fills
        .filter((f) => f.instrument === "convertible")
        .map((f) => f.code)
        .sort(),
    ).toEqual(["113050", "113050", "123120"]);
    const dividendRow = table.rows.find((row) =>
      row.join().includes("0123456789"),
    )!;
    expect(dividendRow).toBeDefined();
    expect(redactRow(dividendRow, result.mapping).join()).not.toContain(
      "0123456789",
    );
    expect(result.mapping.otherFeeColumns).toEqual([13, 18]);
    expect(result.mapping.columns.balanceShares).toBe(8);
  });

  it("银证流水实际为 5 笔转入、3 笔转出，全部定号并脱敏", () => {
    const table = parseDeliveryTable(fixture("ths-bank-flow.txt"));
    const result = importDeliveryTable(table);
    expect(table.format).toBe("tsv");
    expect(table.encoding).toBe("gb18030");
    expect(table.rows).toHaveLength(10);
    expect(table.dropped).toEqual([]);
    expect(result.fills).toEqual([]);
    expect(result.cashFlows).toHaveLength(8);
    expect(result.unresolved).toHaveLength(2);
    expect(result.unresolved.map((r) => r.rowIndex)).toEqual([9, 10]);
    expect(
      result.unresolved.every(
        (r) => r.reason.includes("作废") && r.reason.includes("不计入现金流"),
      ),
    ).toBe(true);
    expect(
      result.unresolved.reduce((sum, r) => sum + Number(r.cells[4]), 0),
    ).toBe(130000);
    expect(
      result.cashFlows
        .filter((f) => f.kind === "transferIn")
        .map((f) => f.amount),
    ).toEqual([50000, 20000, 30000, 10000, 12000]);
    expect(
      result.cashFlows
        .filter((f) => f.kind === "transferOut")
        .map((f) => f.amount),
    ).toEqual([-15000, -25000, -8000]);
    expect(result.diagnostics.join()).toContain("纯资金流水形态");
    expect(
      table.rows.map((row) => redactRow(row, result.mapping).join()).join(),
    ).not.toContain("88888888");
  });

  it("备注优先，税费及中签扣款优先于较短关键词，未知不猜", () => {
    expect(classifyRow("卖出", "", "股息入账:测试")).toBe("dividend");
    expect(
      classifyRow("买入", "", "300398｜股息红利扣税，4665股息红利扣税"),
    ).toBe("fee");
    expect(classifyRow("买入", "", "股息红利税差异化处理资金下账")).toBe("fee");
    expect(
      classifyRow("买入", "", "新股中签资金扣款，1483新股中签资金扣款"),
    ).toBe("subscription");
    expect(classifyRow("其他", "", "起始配号:123")).toBe("subscription");
    expect(classifyRow("买入", "", "道氏发债,申购中签(转非流通)")).toBe(
      "subscription",
    );
    expect(
      classifyRow("卖出", "", "融券回购购回日:20260410,预计利息:0.90"),
    ).toBe("sell");
    expect(classifyRow("其他", "", "场外协议过户")).toBeNull();
  });

  it("非零杂费列全部累加且费用异常仍可证伪", () => {
    const table = parseDeliveryTable(
      "日期,证券代码,操作,成交价格,成交数量,成交金额,发生金额,佣金,其他杂费,结算费,杂费,费用合计\n20260105,600000,买入,10,100,1000,-1011,5,1,2,3,11",
    );
    const result = importDeliveryTable(table);
    expect(result.mapping.otherFeeColumns).toEqual([8, 9, 10]);
    expect(result.mapping.duplicates).toEqual([]);
    expect(result.fills[0]!.fees).toMatchObject({ otherFee: 6, total: 11 });
    expect(result.fills[0]!.anomalies).toEqual([]);
    table.rows[0]![1] = "204001";
    table.rows[0]![11] = "99";
    const repo = importDeliveryTable(table).fills[0]!;
    expect(repo.anomalies).toHaveLength(1);
    expect(repo.anomalies[0]).toMatch(/费用合计.*分项之和/);
  });

  it("自由文本中的多种账号标签均脱敏，证券代码保留", () => {
    const mapping = mapDeliveryColumns(["备注"]);
    const row = [
      "股东账号：0123456789 资金账号: ABC123 股东代码：A123 账号:987 帐号：B456 证券代码：300772",
    ];
    expect(redactRow(row, mapping)).toEqual([
      "股东账号：*** 资金账号：*** 股东代码：*** 账号：*** 帐号：*** 证券代码：300772",
    ]);
    expect(row[0]).toContain("0123456789");
  });

  it("资金模式未知、买卖、缺金额及非法日期保留待核对，绝不产生 fills", () => {
    const result = importDeliveryTable(
      parseDeliveryTable(
        "日期,转账类别,变动资金\n20260105,场外协议过户,10\n20260105,买入,10\n20260105,银行转存,坏值\n坏日期,银行转取,10",
      ),
    );
    expect(result.fills).toEqual([]);
    expect(result.cashFlows).toEqual([]);
    expect(result.unresolved).toHaveLength(4);
  });

  it("只有一个价量列或缺日期仍拒绝，诊断列明已识别列", () => {
    for (const header of [
      "日期,操作,成交价格,发生金额",
      "日期,操作,成交数量,发生金额",
      "证券代码,操作,发生金额",
    ]) {
      expect(() =>
        importDeliveryTable(
          parseDeliveryTable(header + "\n20260105,银行转存,10,10"),
        ),
      ).toThrow(/缺少必要列.*已识别列/);
    }
  });
});

describe("R4b 交割单费用与流水状态", () => {
  it("真实结构双佣金与两种余额分别映射，零数量无摘要分红保留待核对", () => {
    const table = parseDeliveryTable(fixture("ths-settlement.txt"));
    const r = importDeliveryTable(table);
    expect(table.encoding).toBe("gb18030");
    expect(table.format).toBe("tsv");
    expect(table.rows).toHaveLength(11);
    expect(r.fills).toHaveLength(10);
    expect(r.fills.filter((f) => f.instrument === "reverseRepo")).toHaveLength(
      2,
    );
    expect(r.mapping.feeColumns.commission).toEqual([9, 15]);
    expect(r.mapping.columns.balanceShares).toBe(7);
    expect(r.mapping.columns.balanceCash).toBe(12);
    expect(r.fills.map((f) => f.fees.commission)).toEqual([
      0.1, 0.1, 0.47, 0.49, 0.71, 0.65, 0.75, 0.79, 0.8, 0.77,
    ]);
    expect(r.fills.at(-1)).toMatchObject({
      balanceShares: 1000,
      balanceCash: 1879.15,
    });
    expect(r.fills.flatMap((f) => f.anomalies)).toEqual([]);
    expect(r.unresolved).toHaveLength(1);
    expect(r.unresolved[0]).toMatchObject({
      rowIndex: 1,
      reason: "成交价格或数量缺失/非法",
    });
    expect(Number(r.unresolved[0]!.cells[12])).toBe(10779.5);
  });
  it("所有费用分项累加，合计取首个非空且冲突告警", () => {
    const table = parseDeliveryTable(
      "日期,证券代码,操作,成交价格,成交数量,佣金,佣金,印花税,印花税,过户费,过户费,其他费,结算费,费用合计,费用合计,费用合计\n20260105,600000,买入,10,1,1,2,3,4,5,6,7,8,,36,36",
    );
    const r = importDeliveryTable(table);
    expect(r.mapping.feeColumns).toEqual({
      commission: [5, 6],
      stampTax: [7, 8],
      transferFee: [9, 10],
      otherFee: [11, 12],
      feeTotal: [13, 14, 15],
    });
    expect(r.fills[0]!.fees).toEqual({
      commission: 3,
      stampTax: 7,
      transferFee: 11,
      otherFee: 15,
      total: 36,
    });
    expect(r.fills[0]!.anomalies).toEqual([]);
    table.rows[0]![15] = "37";
    expect(importDeliveryTable(table).fills[0]!.anomalies.join()).toContain(
      "重复费用合计列值不一致",
    );
    table.rows[0]![5] = "坏值";
    expect(importDeliveryTable(table).fills[0]!.fees.commission).toBeNull();
  });
  it("失败状态词可见，未知状态不猜，缺状态有诊断", () => {
    const r = importDeliveryTable(
      parseDeliveryTable(
        "日期,转账类别,发生金额,状态\n20260105,银行转存,10,作废\n20260105,银行转存,20,出入金失败\n20260105,银行转取,30,E1111-余额不足\n20260105,银行转存,40,处理中\n20260105,银行转存,50,成功",
      ),
    );
    expect(r.unresolved.map((r) => r.rowIndex)).toEqual([1, 2, 3]);
    expect(r.cashFlows.map((f) => f.amount)).toEqual([40, 50]);
    const missing = importDeliveryTable(
      parseDeliveryTable("日期,转账类别,发生金额\n20260105,银行转存,10"),
    );
    expect(missing.cashFlows[0]!.amount).toBe(10);
    expect(missing.diagnostics.join()).toContain(
      "未找到状态列，无法排除失败流水",
    );
  });
});
