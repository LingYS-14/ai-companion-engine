import { describe, expect, it } from "vitest";

import { readOneBotConn } from "../src/autonomy/onebot-config.js";

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
