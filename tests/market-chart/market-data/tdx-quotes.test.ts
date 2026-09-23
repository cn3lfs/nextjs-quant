import "../../../packages/tstdx/tests/transport.test";
import { afterEach, describe, expect, it } from "vitest";
import {
  configuredHosts,
  parseHosts,
  TDX_HOSTS,
} from "../../../src/server/data-sources/tdx/tdx-quotes";

describe("服务器配置", () => {
  const original = process.env.TDX_HOSTS;
  afterEach(() => {
    if (original === undefined) delete process.env.TDX_HOSTS;
    else process.env.TDX_HOSTS = original;
  });
  it("逗号分隔、去空白、忽略空项", () => {
    expect(parseHosts(" 1.2.3.4 , example.com ,, 5.6.7.8 ")).toEqual([
      "1.2.3.4",
      "example.com",
      "5.6.7.8",
    ]);
    expect(parseHosts("")).toEqual([]);
    expect(parseHosts(undefined)).toEqual([]);
  });
  it("拒绝含非法字符的地址，不把它传给 socket", () => {
    for (const bad of ["1.2.3.4;rm -rf /", "host name", "a/b", "x\0y"])
      expect(() => parseHosts(bad)).toThrow("非法字符");
  });
  it("环境变量优先于内置列表", () => {
    process.env.TDX_HOSTS = "10.0.0.1,10.0.0.2";
    expect(configuredHosts()).toEqual(["10.0.0.1", "10.0.0.2"]);
  });
  it("环境变量为空时不覆盖内置列表", () => {
    process.env.TDX_HOSTS = "  ,  ";
    expect(configuredHosts()).toEqual(TDX_HOSTS);
  });
});
