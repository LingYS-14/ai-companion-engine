import { describe, expect, it } from "vitest";

import { readOneBotConn, readQqProactiveConfig } from "../src/autonomy/onebot-config.js";

const YAML = [
  "        qq:",
  "          enabled: false",
  "          onebot:",
  "            enabled: true",
  '            baseUrl: "http://127.0.0.1:3000"   # 本机 SnowLuma',
  "            wsUrl: \"ws://127.0.0.1:3001\"",
  "            token: \"tok-abc\"",
  "            wsToken: 'ws-tok'",
  "            peer: 10000001",
  "            dryRun: false",
  "        trace: true",
].join("\n");

describe("readOneBotConn：从插件配置里取连接参数", () => {
  it("读出 baseUrl/token/peer，wsToken 保留、owner 缺省 host、peerName 缺省「用户」", () => {
    expect(readOneBotConn(YAML)).toEqual({
      baseUrl: "http://127.0.0.1:3000",
      token: "tok-abc",
      wsUrl: "ws://127.0.0.1:3001",
      wsToken: "ws-tok",
      owner: "host",
      peer: 10000001,
      dryRun: false,
      peerName: "用户",
    });
  });

  it("task-157：peerName 可配（qq.onebot.peerName），空白值回落缺省", () => {
    const withPeer = (value: string): string => YAML.replace("        trace: true", `            peerName: ${value}\n        trace: true`);
    expect(readOneBotConn(withPeer("用户"))?.peerName).toBe("用户");
    expect(readOneBotConn(withPeer('""'))?.peerName).toBe("用户");
    expect(readOneBotConn(withPeer("   "))?.peerName).toBe("用户");
  });

  it("dryRun: true 透传", () => {
    const out = readOneBotConn(YAML.replace("dryRun: false", "dryRun: true"));
    expect(out?.dryRun).toBe(true);
  });

  it("没有 onebot 段 / 缺 peer / token 为空 → null（不猜）", () => {
    expect(readOneBotConn("qq:\n  enabled: false")).toBeNull();
    expect(readOneBotConn(YAML.replace("            peer: 10000001\n", ""))).toBeNull();
    expect(readOneBotConn(YAML.replace('token: "tok-abc"', 'token: ""'))).toBeNull();
  });

  it("字段在更外层缩进就停下来（不会把下面的 trace 当 onebot 的键）", () => {
    const out = readOneBotConn(YAML);
    expect(out).not.toBeNull();
  });
});

describe("OneBotConn：桥归属与 WS 参数", () => {
  const base = `qq:
  onebot:
    enabled: true
    baseUrl: http://127.0.0.1:3000
    token: t
    peer: 10000001
    dryRun: false
`;

  it("缺省 owner=host，wsUrl/wsToken 有默认值", () => {
    const conn = readOneBotConn(base);
    expect(conn?.owner).toBe("host");
    expect(conn?.wsUrl).toBe("ws://127.0.0.1:3001");
    expect(conn?.wsToken).toBe("t");
  });

  it("owner=autonomy 与单独 wsToken 都能读出来", () => {
    const conn = readOneBotConn(base + "    owner: autonomy\n    wsToken: w\n    wsUrl: ws://127.0.0.1:3999\n");
    expect(conn?.owner).toBe("autonomy");
    expect(conn?.wsToken).toBe("w");
    expect(conn?.wsUrl).toBe("ws://127.0.0.1:3999");
  });
});

describe("readQqProactiveConfig：主动开口节奏从插件配置读", () => {
  const BLOCK = [
    "        qq:",
    "          enabled: false",
    "          proactive:",
    "            # 常驻进程消费：20 分钟看一次，2 小时才真开口",
    "            enabled: true",
    "            minGapMin: 120   # ≥2h",
    '            maxPerDay: "3"',
    "            checkEveryMin: 20",
    "          onebot:",
    "            enabled: true",
    "            baseUrl: http://127.0.0.1:3000",
  ].join("\n");

  it("读出四个键，注释与引号都能处理", () => {
    expect(readQqProactiveConfig(BLOCK)).toEqual({
      enabled: true,
      minGapMin: 120,
      maxPerDay: 3,
      checkEveryMin: 20,
    });
  });

  it("缺字段留 undefined，不替调用方补默认值", () => {
    const yaml = ["qq:", "  proactive:", "    enabled: false"].join("\n");
    expect(readQqProactiveConfig(yaml)).toEqual({
      enabled: false,
      minGapMin: undefined,
      maxPerDay: undefined,
      checkEveryMin: undefined,
    });
  });

  it("没有 qq 段或没有 proactive 段 → null", () => {
    expect(readQqProactiveConfig("trace: true")).toBeNull();
    expect(readQqProactiveConfig("qq:\n  enabled: false\n  onebot:\n    enabled: true")).toBeNull();
  });

  it("不会被 onebot 段里的同名键误抓：只读 proactive 的缩进块", () => {
    const yaml = [
      "qq:",
      "  onebot:",
      "    maxPerDay: 99",
      "  proactive:",
      "    maxPerDay: 2",
      "  enabled: true",
    ].join("\n");
    expect(readQqProactiveConfig(yaml)?.maxPerDay).toBe(2);
  });

  it("非法数字 / 非布尔值按没配处理", () => {
    const yaml = ["qq:", "  proactive:", "    enabled: yes", "    minGapMin: -5", "    maxPerDay: abc", "    checkEveryMin: 1.5"].join("\n");
    expect(readQqProactiveConfig(yaml)).toEqual({
      enabled: undefined,
      minGapMin: undefined,
      maxPerDay: undefined,
      checkEveryMin: 1.5,
    });
  });
});
