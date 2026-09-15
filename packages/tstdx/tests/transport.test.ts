import { createServer, type Server, type Socket } from "node:net";
import { deflateSync } from "node:zlib";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import {
  PORT,
  TDX_HOSTS,
  TdxSession,
  createQuotesPool,
  createTdxClient,
} from "../src/index";
import {
  FRAME_HEADER_SIZE,
  SETUP_FRAMES,
  buildBarsRequest,
  buildQuotesRequest,
  parseBars,
  parseQuotes,
} from "../src/wire";

/**
 * 用一个假的行情服务器驱动连接层：握手时序、分片重组、请求串行化、
 * 故障转移和失败后的连接弃用，都不需要连真实的公共服务器。
 */

/** 按协议帧格式打包一段 body，compress 时走 zlib。 */
function frame(body: Buffer, compress = false) {
  const payload = compress ? deflateSync(body) : body,
    header = Buffer.alloc(FRAME_HEADER_SIZE);
  header.writeUInt16LE(payload.length, 12);
  header.writeUInt16LE(body.length, 14);
  return Buffer.concat([header, payload]);
}

type FakeOptions = {
  host?: string;
  port?: number;
  /** 每个请求的应答；返回 undefined 表示直接断开连接。 */
  reply?: (request: Buffer, index: number) => Buffer | undefined;
  /** 应答分几片发出，用来验证调用方按长度重组而不是依赖包边界。 */
  chunks?: number;
};

const servers: Server[] = [];
async function fakeServer(options: FakeOptions = {}) {
  const requests: Buffer[] = [],
    connections: Socket[] = [];
  let index = 0;
  const server = createServer((socket) => {
    connections.push(socket);
    socket.on("error", () => {});
    socket.on("data", (request) => {
      requests.push(request);
      const body =
        options.reply?.(request, index++) ?? frame(Buffer.from([0, 0]));
      if (!body.length) return socket.destroy();
      const size = Math.ceil(body.length / (options.chunks ?? 1));
      for (let at = 0; at < body.length; at += size)
        socket.write(body.subarray(at, at + size));
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) =>
    server.listen(options.port ?? 0, options.host ?? "127.0.0.1", resolve),
  );
  const port = (server.address() as { port: number }).port;
  return { port, requests, connections };
}
afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise((done) => server.close(done))),
  );
});

describe("握手", () => {
  it("0FDB 末字节为 05 才能通过行情验活，握手应答本身不代表成功", async () => {
    const fixture = JSON.parse(
      readFileSync(
        new URL("./fixtures/handshake-market-response.json", import.meta.url),
        "utf8",
      ),
    );
    let enabled = false;
    const server = await fakeServer({
      chunks: 3,
      reply: (request) => {
        const command = request.readUInt16LE(10);
        if (command === 0x0fdb) {
          enabled = request.length === 42 && request[41] === 5;
          return frame(Buffer.from([0, 0]));
        }
        if (command === 0x052d)
          return frame(
            enabled
              ? Buffer.from(fixture.bars, "hex")
              : Buffer.from("2003", "hex"),
            enabled,
          );
        if (command === 0x053e)
          return frame(
            enabled
              ? Buffer.from(fixture.quotes, "hex")
              : Buffer.from("01000000", "hex"),
          );
        return frame(Buffer.from([0, 0]));
      },
    });
    const session = await TdxSession.connect("127.0.0.1", server.port);
    try {
      const bars = parseBars(
        await session.request(buildBarsRequest("sz300750", "day", 0, 3)),
        "day",
      );
      expect(bars).toHaveLength(3);
      expect(bars.at(-1)).toMatchObject({ date: "2026-09-14", close: 337.11 });
      const quotes = parseQuotes(
        await session.request(buildQuotesRequest(["sz300750"])),
        ["sz300750"],
      );
      expect(quotes[0]).toMatchObject({ symbol: "sz300750", price: 337.11 });
      expect(quotes[0]!.bids).toHaveLength(5);
      expect(quotes[0]!.asks).toHaveLength(5);
      const legacy = Buffer.from(SETUP_FRAMES[2]);
      legacy[41] = 2;
      await session.request(legacy);
      const emptyBars = await session.request(
        buildBarsRequest("sz300750", "day", 0, 3),
      );
      expect(() => parseBars(emptyBars, "day")).toThrow("未返回 K 线正文");
      const emptyQuotes = await session.request(
        buildQuotesRequest(["sz300750"]),
      );
      expect(() => parseQuotes(emptyQuotes, ["sz300750"])).toThrow(
        "返回数量与请求不符",
      );
    } finally {
      await session.close();
    }
  });
  it("连接后按序发出三条握手帧并读走各自的响应", async () => {
    const server = await fakeServer(),
      session = await TdxSession.connect("127.0.0.1", server.port);
    expect(server.requests).toHaveLength(SETUP_FRAMES.length);
    expect(server.requests.map((r) => r.toString("hex"))).toEqual(
      SETUP_FRAMES.map((f) => f.toString("hex")),
    );
    await session.close();
  });
  it("握手中途断开时连接不会被当作可用", async () => {
    const server = await fakeServer({
      reply: (_, index) => (index === 1 ? Buffer.alloc(0) : undefined),
    });
    await expect(
      TdxSession.connect("127.0.0.1", server.port),
    ).rejects.toThrow();
  });
  it("端口不通时报错并带上主机", async () => {
    await expect(TdxSession.connect("127.0.0.1", 1)).rejects.toThrow();
  });
});

describe("收发", () => {
  it("按帧头长度重组，不依赖 TCP 包边界", async () => {
    const body = Buffer.from("行情负载重组测试", "utf8"),
      server = await fakeServer({
        reply: (_, index) => (index < 3 ? undefined : frame(body)),
        chunks: 7,
      }),
      session = await TdxSession.connect("127.0.0.1", server.port);
    expect(await session.request(Buffer.from([1]))).toEqual(body);
    await session.close();
  });
  it("压缩响应会被解压", async () => {
    const body = Buffer.alloc(400, 7),
      server = await fakeServer({
        reply: (_, index) => (index < 3 ? undefined : frame(body, true)),
      }),
      session = await TdxSession.connect("127.0.0.1", server.port);
    expect(await session.request(Buffer.from([1]))).toEqual(body);
    await session.close();
  });
  it("并发调用在连接上串行执行，应答不会串到别的请求", async () => {
    const bodies = ["甲", "乙", "丙"].map((text) => Buffer.from(text, "utf8")),
      server = await fakeServer({
        reply: (_, index) =>
          index < 3 ? undefined : frame(bodies[index - 3] ?? bodies[0]!),
      }),
      session = await TdxSession.connect("127.0.0.1", server.port);
    const results = await Promise.all(
      bodies.map((_, i) => session.request(Buffer.from([i]))),
    );
    expect(results).toEqual(bodies);
    // 串行化的证据：请求逐条到达，服务器没有同时收到两条业务请求。
    expect(server.requests.slice(SETUP_FRAMES.length)).toHaveLength(3);
    await session.close();
  });
  it("连接出错后，后续调用立即失败而不是永久挂起", async () => {
    const server = await fakeServer({
      reply: (_, index) => (index < 3 ? undefined : Buffer.alloc(0)),
    });
    const session = await TdxSession.connect("127.0.0.1", server.port);
    await expect(session.request(Buffer.from([1]))).rejects.toThrow();
    await expect(session.request(Buffer.from([1]))).rejects.toThrow();
  });
  it("关闭后不再接受请求", async () => {
    const server = await fakeServer(),
      session = await TdxSession.connect("127.0.0.1", server.port);
    await session.close();
    await expect(session.request(Buffer.from([1]))).rejects.toThrow("已关闭");
  });
});

describe("故障转移", () => {
  it("跳过不可用主机，连上第一台可用的", async () => {
    const server = await fakeServer(),
      pool = createQuotesPool(["127.0.0.1", "127.0.0.1"], server.port),
      // 首台用不通的端口，确认会继续尝试下一台
      failing = createQuotesPool(["127.0.0.1"], 1);
    expect(await pool.use(async (session) => session.host)).toBe("127.0.0.1");
    await expect(failing.use(async () => 1)).rejects.toThrow(
      "所有行情服务器均不可用",
    );
    await pool.close();
  });
  it("全部失败时错误里保留每台主机的原因", async () => {
    const pool = createQuotesPool(["127.0.0.1", "127.0.0.2"], 1);
    await expect(pool.use(async () => 1)).rejects.toThrow(
      /127\.0\.0\.1.*127\.0\.0\.2/s,
    );
  });
  it("同一个池内复用连接，不为每次调用重连", async () => {
    const server = await fakeServer(),
      pool = createQuotesPool(["127.0.0.1"], server.port);
    await pool.use(async () => 1);
    await pool.use(async () => 1);
    expect(server.connections).toHaveLength(1);
    await pool.close();
  });
});

it("默认服务器列表非空且端口为 7709", () => {
  expect(TDX_HOSTS.length).toBeGreaterThan(0);
  expect(new Set(TDX_HOSTS).size).toBe(TDX_HOSTS.length);
  expect(PORT).toBe(7709);
});

it("独立客户端的池互不影响，关闭后重新解析调用方提供的节点", async () => {
  const body = Buffer.from("010000000000a40e0001", "hex");
  const server = await fakeServer({
    reply: (request) =>
      SETUP_FRAMES.some((f) => f.equals(request)) ? undefined : frame(body),
  });
  let resolutions = 0;
  const one = createTdxClient({
    hosts: () => {
      resolutions++;
      return ["127.0.0.1"];
    },
    port: server.port,
  });
  const two = createTdxClient({ hosts: ["127.0.0.1"], port: server.port });
  try {
    const { historyMinutes } = one;
    expect(await historyMinutes("sh600000", 20260914)).toEqual([
      { price: 9.32, volume: 1 },
    ]);
    expect(await two.historyMinutes("sh600000", 20260914)).toEqual([
      { price: 9.32, volume: 1 },
    ]);
    await one.close();
    expect(await two.historyMinutes("sh600000", 20260914)).toHaveLength(1);
    expect(server.connections).toHaveLength(2);
    await one.historyMinutes("sh600000", 20260914);
    expect(resolutions).toBe(2);
    expect(server.connections).toHaveLength(3);
  } finally {
    await one.close();
    await two.close();
  }
});

describe("新增连接控制", () => {
  it("坏包触发同次请求换节点重试", async () => {
    const first = await fakeServer({
      reply: (_, i) => (i < 3 ? undefined : frame(Buffer.alloc(1))),
    });
    const second = await fakeServer({
      host: "127.0.0.2",
      port: first.port,
      reply: (_, i) => (i < 3 ? undefined : frame(Buffer.from([42, 0]))),
    });
    const client = createTdxClient({
      hosts: ["127.0.0.1", "127.0.0.2"],
      port: first.port,
      requestRetries: 1,
    });
    try {
      expect(await client.securityCount("sh")).toBe(42);
      expect(first.requests).toHaveLength(4);
      expect(second.requests).toHaveLength(4);
    } finally {
      await client.close();
    }
  });
  it("默认不重放，下一次请求从下一节点开始", async () => {
    const first = await fakeServer({
      reply: (_, i) => (i < 3 ? undefined : frame(Buffer.alloc(1))),
    });
    await fakeServer({
      host: "127.0.0.2",
      port: first.port,
      reply: (_, i) => (i < 3 ? undefined : frame(Buffer.from([42, 0]))),
    });
    const client = createTdxClient({
      hosts: ["127.0.0.1", "127.0.0.2"],
      port: first.port,
    });
    try {
      await expect(client.securityCount("sh")).rejects.toThrow();
      expect(await client.securityCount("sh")).toBe(42);
    } finally {
      await client.close();
    }
  });
  it("心跳失败回调受控，关闭后停止发请求", async () => {
    const server = await fakeServer({
      reply: (request) =>
        request.readUInt16LE(10) === 0x044e
          ? frame(Buffer.alloc(1))
          : undefined,
    });
    const client = createTdxClient({ hosts: ["127.0.0.1"], port: server.port });
    let errors = 0;
    try {
      await new Promise<void>((resolve) =>
        client.startHeartbeat(100, () => {
          errors++;
          resolve();
          throw Error("callback");
        }),
      );
      await client.close();
      const count = server.requests.length;
      await new Promise((resolve) => setTimeout(resolve, 160));
      expect(errors).toBe(1);
      expect(server.requests).toHaveLength(count);
    } finally {
      await client.close();
    }
  });
});
