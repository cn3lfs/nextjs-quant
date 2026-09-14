import { deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import fixture from "./fixtures/tdx-wire.json";
import minuteFixture from "./fixtures/tdx-minutes.json";
import {
  FRAME_HEADER_SIZE,
  buildBarsRequest,
  buildHistoryMinuteRequest,
  buildHistoryTransactionsRequest,
  buildFinanceRequest,
  buildMinuteRequest,
  buildQuotesRequest,
  buildTransactionsRequest,
  buildXdxrRequest,
  inflateBody,
  parseBars,
  parseFinance,
  parseFrameHeader,
  parseMinutes,
  parseQuotes,
  parseTransactions,
  parseXdxr,
  readAmount,
  readVarint,
  splitSymbol,
} from "../src/wire";

/**
 * 夹具字节由公开兼容实现（pytdx 系）构造并解析，期望值即其输出，
 * 用于锁定本仓库解码结果与之逐字段一致。行情响应无账号或授权信息。
 */
const hex = (value: string) => Buffer.from(value, "hex");
const quotesBody = hex(fixture.quotesBody),
  quotes = ["sh600000", "sz000001"];

describe("变长整数", () => {
  it("与参考实现在全部夹具向量上一致", () => {
    for (const [encoded, value] of fixture.varint) {
      const buffer = hex(encoded as string);
      expect(readVarint(buffer, 0)).toEqual([value, buffer.length]);
    }
  });
  it("解码超过 32 位的值时不发生位运算溢出", () => {
    const [value] = readVarint(hex("80808080808001"), 0);
    expect(value).toBe(2 ** 41);
    expect(Number.isSafeInteger(value)).toBe(true);
  });
  it("截断和越界都报错而不是返回半个值", () => {
    expect(() => readVarint(hex("80"), 0)).toThrow("被截断");
    expect(() => readVarint(hex("01"), 5)).toThrow("越界");
  });
});

describe("成交额", () => {
  it("与参考实现在全部夹具向量上一致", () => {
    for (const [raw, value] of fixture.amount) {
      const buffer = Buffer.alloc(4);
      buffer.writeUInt32LE(raw as number);
      expect(readAmount(buffer, 0)).toEqual([value, 4]);
    }
  });
  it("拒绝符号位置位的值，而不是返回 1e49 量级的坏数", () => {
    const buffer = Buffer.alloc(4);
    buffer.writeUInt32LE(0x91b7584a);
    expect(() => readAmount(buffer, 0)).toThrow("成交额字段为负");
  });
  it("字段越界时报错", () => {
    expect(() => readAmount(Buffer.alloc(3), 0)).toThrow("越界");
  });
});

describe("响应帧", () => {
  it("未压缩时原样返回，压缩时解压", () => {
    const payload = Buffer.from("行情负载", "utf8"),
      packed = deflateSync(payload);
    expect(
      inflateBody(
        { zipSize: payload.length, unzipSize: payload.length },
        payload,
      ),
    ).toEqual(payload);
    expect(
      inflateBody(
        { zipSize: packed.length, unzipSize: payload.length },
        packed,
      ),
    ).toEqual(payload);
  });
  it("长度与帧头不符时报错", () => {
    const header = Buffer.alloc(FRAME_HEADER_SIZE);
    header.writeUInt16LE(40, 12);
    header.writeUInt16LE(40, 14);
    expect(parseFrameHeader(header)).toEqual({ zipSize: 40, unzipSize: 40 });
    expect(() =>
      inflateBody({ zipSize: 40, unzipSize: 40 }, Buffer.alloc(8)),
    ).toThrow("长度与帧头不符");
    expect(() =>
      inflateBody({ zipSize: 8, unzipSize: 99 }, deflateSync(Buffer.alloc(8))),
    ).toThrow();
    expect(() => parseFrameHeader(Buffer.alloc(4))).toThrow("帧头不完整");
  });
});

describe("五档行情", () => {
  it("逐字段匹配参考实现的解析结果", () => {
    expect(parseQuotes(quotesBody, quotes)).toEqual(fixture.quotes);
  });
  it("请求包含市场号与 6 位代码，且按上限校验", () => {
    const request = buildQuotesRequest(["sh600000", "sz000001"]);
    expect(request.readUInt16LE(0)).toBe(0x010c);
    expect(request.readUInt16LE(20)).toBe(2);
    expect(request.readUInt8(22)).toBe(1);
    expect(request.toString("ascii", 23, 29)).toBe("600000");
    expect(request.readUInt8(29)).toBe(0);
    expect(() => buildQuotesRequest([])).toThrow("不能为空");
    expect(() => buildQuotesRequest(["sh600000", "sh600000"])).toThrow("重复");
    expect(() =>
      buildQuotesRequest(
        Array.from({ length: 81 }, (_, i) => `sh${String(600000 + i)}`),
      ),
    ).toThrow("最多 80 只");
    expect(() => buildQuotesRequest(["600000"])).toThrow();
  });
  it("返回数量或证券与请求不符时报错", () => {
    expect(() => parseQuotes(quotesBody, ["sh600000"])).toThrow(
      "数量与请求不符",
    );
    expect(() => parseQuotes(quotesBody, ["sh600001", "sz000001"])).toThrow(
      "证券与请求不符",
    );
  });
  it("截断的响应报错而不是返回半条记录", () => {
    for (const cut of [4, 20, 100, quotesBody.length - 1])
      expect(() => parseQuotes(quotesBody.subarray(0, cut), quotes)).toThrow();
    expect(() => parseQuotes(Buffer.alloc(2), quotes)).toThrow("过短");
  });
  it("拒绝未知市场编号", () => {
    const corrupted = Buffer.from(quotesBody);
    corrupted.writeUInt8(9, 4);
    expect(() => parseQuotes(corrupted, quotes)).toThrow("未知市场编号");
  });
});

describe("逐笔成交", () => {
  it("当日与历史都逐字段匹配参考实现", () => {
    expect(parseTransactions(hex(fixture.transactionsBody), false)).toEqual(
      fixture.transactions,
    );
    expect(
      parseTransactions(hex(fixture.historyTransactionsBody), true),
    ).toEqual(fixture.historyTransactions);
  });
  it("价格在页内差分累加", () => {
    const parsed = parseTransactions(hex(fixture.transactionsBody), false);
    expect(parsed.map((record) => record.price)).toEqual([0.05, 0.03, 0.1]);
  });
  it("当日带成交笔数，历史为 null", () => {
    expect(
      parseTransactions(hex(fixture.transactionsBody), false)[0]!.orders,
    ).toBe(3);
    expect(
      parseTransactions(hex(fixture.historyTransactionsBody), true)[0]!.orders,
    ).toBeNull();
  });
  it("两种布局不可互换：协议没有自校验，用错只会静默得到别的数据", () => {
    // 历史逐笔在计数后多 4 字节填充，且没有成交笔数字段。按当日布局解析同一段
    // 字节不会报错，只会得到错位结果 —— 调用方必须自己选对布局。
    expect(
      parseTransactions(hex(fixture.historyTransactionsBody), false),
    ).not.toEqual(fixture.historyTransactions);
  });
  it("请求按 start/count/日期校验", () => {
    const request = buildTransactionsRequest("sz000001", 0, 800);
    expect(request.readUInt16LE(12)).toBe(0);
    expect(request.toString("ascii", 14, 20)).toBe("000001");
    expect(request.readUInt16LE(22)).toBe(800);
    expect(
      buildHistoryTransactionsRequest("sh600000", 20260904, 0).readUInt32LE(12),
    ).toBe(20260904);
    expect(() => buildTransactionsRequest("sh600000", -1)).toThrow("start");
    expect(() => buildTransactionsRequest("sh600000", 0, 801)).toThrow("count");
    expect(() => buildTransactionsRequest("sh600000", 0, 0)).toThrow("count");
    expect(() =>
      buildHistoryTransactionsRequest("sh600000", 20261340, 0),
    ).toThrow("YYYYMMDD");
  });
  it("截断的响应报错", () => {
    const body = hex(fixture.transactionsBody);
    expect(() =>
      parseTransactions(body.subarray(0, body.length - 2), false),
    ).toThrow();
    expect(() => parseTransactions(Buffer.alloc(1), false)).toThrow("过短");
  });
});

describe("K 线", () => {
  it("日线、分钟线、指数线都逐字段匹配参考实现", () => {
    expect(parseBars(hex(fixture.dayBarsBody), "day")).toEqual(fixture.dayBars);
    expect(parseBars(hex(fixture.minuteBarsBody), "5m")).toEqual(
      fixture.minuteBars,
    );
    expect(parseBars(hex(fixture.indexBarsBody), "day", true)).toEqual(
      fixture.indexBars,
    );
  });
  it("开盘价以上一条收盘为基准逐条累加", () => {
    const bars = parseBars(hex(fixture.dayBarsBody), "day");
    expect(bars.map((bar) => bar.open)).toEqual([10.75, 10.9, 10.82]);
    expect(bars[1]!.open).toBeCloseTo(bars[0]!.close + 0.03, 10);
  });
  it("用错周期会被日期校验拦住，而不是返回 3772-91-57 这种日期", () => {
    expect(() => parseBars(hex(fixture.minuteBarsBody), "day")).toThrow(
      "K 线记录非法",
    );
  });
  it("指数涨跌家数只在指数线上解析", () => {
    const bars = parseBars(hex(fixture.indexBarsBody), "day", true);
    expect(bars[0]).toMatchObject({ upCount: 1200, downCount: 800 });
    expect(parseBars(hex(fixture.dayBarsBody), "day")[0]).not.toHaveProperty(
      "upCount",
    );
  });
  it("请求写入周期、分页与代码", () => {
    const request = buildBarsRequest("sh600000", "day", 0, 800);
    // 长度是硬要求：少一个字节服务器就静默不回包，实测超时才发现。
    expect(request).toHaveLength(38);
    expect(request.readUInt16LE(12)).toBe(1);
    expect(request.toString("ascii", 14, 20)).toBe("600000");
    expect(request.readUInt16LE(20)).toBe(4);
    expect(request.readUInt16LE(26)).toBe(800);
    expect(buildBarsRequest("sz000001", "60m", 0).readUInt16LE(20)).toBe(3);
    expect(() => buildBarsRequest("sh600000", "day", 0, 801)).toThrow("count");
  });
  it("非法日期与时间倒序的记录会被拒绝", () => {
    const invalid = Buffer.from(hex(fixture.dayBarsBody));
    invalid.writeUInt32LE(20261340, 2); // 首条记录的日期字段
    expect(() => parseBars(invalid, "day")).toThrow("K 线记录非法");
    const reversed = Buffer.from(hex(fixture.dayBarsBody));
    reversed.writeUInt32LE(20261231, 2); // 首条晚于后续各条
    expect(() => parseBars(reversed, "day")).toThrow("重复或倒序");
    const truncated = hex(fixture.dayBarsBody);
    expect(() =>
      parseBars(truncated.subarray(0, truncated.length - 3), "day"),
    ).toThrow();
    expect(() => parseBars(Buffer.alloc(1), "day")).toThrow("过短");
  });
});

describe("分时", () => {
  const today = Buffer.from(minuteFixture.todayBase64, "base64"),
    history = Buffer.from(minuteFixture.historyBase64, "base64");
  it("当日分时（2026 新布局）与独立实现逐点一致", () => {
    expect(parseMinutes(today, "sh600000", false)).toEqual(minuteFixture.today);
  });
  it("历史分时（旧布局）与独立实现逐点一致", () => {
    expect(parseMinutes(history, "sh600000", true)).toEqual(
      minuteFixture.history,
    );
  });
  it("解出的价格区间与当日日线的最高最低吻合", () => {
    // 真实抓包：sh600000 当日日线 L9.21 H9.29，分时区间必须落在其中。
    const prices = parseMinutes(today, "sh600000", false).map((m) => m.price);
    expect(Math.min(...prices)).toBe(9.21);
    expect(Math.max(...prices)).toBe(9.29);
    expect(prices).toHaveLength(today.readUInt16LE(0));
  });
  it("新布局靠头部回显的代码识别，认错证券就不会走定位分支", () => {
    // 代码对不上时按旧布局解析，头部的盘口快照会让结果失去合理性而报错。
    expect(() => parseMinutes(today, "sz000001", false)).toThrow(
      "分时响应与已知布局不符",
    );
  });
  it("把新布局当历史布局解析会报错而不是返回垃圾", () => {
    expect(() => parseMinutes(today, "sh600000", true)).toThrow(
      "分时响应与已知布局不符",
    );
  });
  it("点数为 0 时返回空，不去猜数据块位置", () => {
    const empty = Buffer.alloc(16);
    expect(parseMinutes(empty, "sh600000", false)).toEqual([]);
  });
  it("响应放不下声明的点数时报错", () => {
    const truncated = Buffer.from(today.subarray(0, 200));
    expect(() => parseMinutes(truncated, "sh600000", false)).toThrow(
      /放不下|无法在响应中唯一定位/,
    );
    expect(() => parseMinutes(Buffer.alloc(2), "sh600000", false)).toThrow(
      "过短",
    );
  });
  it("尾部被改动导致数据块无法对齐时报错", () => {
    const corrupted = Buffer.from(today);
    corrupted.writeUInt8(0xff, corrupted.length - 1);
    expect(() => parseMinutes(corrupted, "sh600000", false)).toThrow(
      "无法在响应中唯一定位",
    );
  });
  it("请求写入代码与日期", () => {
    expect(buildMinuteRequest("sh600000").toString("ascii", 14, 20)).toBe(
      "600000",
    );
    expect(buildMinuteRequest("sh600000").readUInt16LE(12)).toBe(1);
    expect(
      buildHistoryMinuteRequest("sz000001", 20260904).readUInt32LE(12),
    ).toBe(20260904);
    expect(() => buildHistoryMinuteRequest("sz000001", 20261340)).toThrow(
      "YYYYMMDD",
    );
  });
});

describe("除权除息", () => {
  it("三种事件布局都逐字段匹配参考实现", () => {
    expect(parseXdxr(hex(fixture.xdxrBody), "sh600000")).toEqual(fixture.xdxr);
  });
  it("分红按每股口径给出，股本按股给出", () => {
    const [dividend, shares] = parseXdxr(hex(fixture.xdxrBody), "sh600000");
    expect(dividend).toMatchObject({ dividend: 0.35, bonusRatio: 0.2 });
    expect(shares!.floatSharesBefore).toBe(491794320000);
  });
  it("返回证券与请求不符时报错", () => {
    expect(() => parseXdxr(hex(fixture.xdxrBody), "sz000001")).toThrow(
      "证券与请求不符",
    );
    expect(() => parseXdxr(Buffer.alloc(4), "sh600000")).toThrow("过短");
  });
});

describe("财务数据", () => {
  it("逐字段匹配参考实现", () => {
    expect(parseFinance(hex(fixture.financeBody), "sh600000")).toEqual(
      fixture.finance,
    );
  });
  it("股本与金额换算成股和元，股东户数与每股净资产不换算", () => {
    const finance = parseFinance(hex(fixture.financeBody), "sh600000");
    expect(finance.floatShares).toBe(123450000);
    expect(finance.shareholders).toBeCloseTo(18, 5);
    expect(finance.bookValuePerShare).toBeCloseTo(43.5, 5);
    expect(finance.ipoDate).toBe(19991110);
  });
  it("证券不符或响应不完整时报错", () => {
    expect(() => parseFinance(hex(fixture.financeBody), "sz000001")).toThrow(
      "证券与请求不符",
    );
    const body = hex(fixture.financeBody);
    expect(() =>
      parseFinance(body.subarray(0, body.length - 8), "sh600000"),
    ).toThrow("不完整");
  });
});

it("每种请求的整包长度都被锁死", () => {
  // 服务器对长度不符的请求既不报错也不回包，只会静默超时；单测只验字段偏移
  // 是抓不到的，K 线少 6 字节、除权和财务各多 2 字节都是实测超时才发现的。
  expect(buildQuotesRequest(["sh600000"])).toHaveLength(29);
  expect(buildQuotesRequest(["sh600000", "sz000001"])).toHaveLength(36);
  expect(buildTransactionsRequest("sh600000", 0)).toHaveLength(24);
  expect(buildHistoryTransactionsRequest("sh600000", 20260904, 0)).toHaveLength(
    28,
  );
  expect(buildBarsRequest("sh600000", "day", 0)).toHaveLength(38);
  expect(buildMinuteRequest("sh600000")).toHaveLength(24);
  expect(buildHistoryMinuteRequest("sh600000", 20260904)).toHaveLength(23);
  expect(buildXdxrRequest("sh600000")).toHaveLength(21);
  expect(buildFinanceRequest("sh600000")).toHaveLength(21);
});

it("符号拆分覆盖三个市场", () => {
  expect(splitSymbol("sh600000")).toEqual({ market: 1, code: "600000" });
  expect(splitSymbol("sz000001")).toEqual({ market: 0, code: "000001" });
  expect(splitSymbol("bj430047")).toEqual({ market: 2, code: "430047" });
  expect(() => splitSymbol("us600000")).toThrow();
});
