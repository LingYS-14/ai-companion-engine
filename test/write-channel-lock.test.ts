/**
 * 配置锁（批次 2b）：单写者 A 的接线不许被静默回退。
 *
 * 这些断言读源码而不是跑进程：它们防的是"以后有人图省事把插件改回自己 save()"。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname ?? __dirname, "..");
const read = (rel: string): string => readFileSync(join(ROOT, rel), "utf8");

describe("写通道接线锁（批次 2b）", () => {
  it("宿主插件把 channel 传给 buildTools（且带 dataDir/characterId）", () => {
    const src = read("src/plugin/index.ts");
    expect(src).toContain("channel: { dataDir: conf.dataDir, characterId: conf.characterId }");
    expect(src).toContain("buildTools(runtime, {");
  });

  it("工具层：六个写操作都走 applyWrite，没有裸调用（除 fallback 闭包外）", () => {
    const src = read("src/plugin/tools.ts");
    for (const op of ["turn", "remember", "advance", "reset", "consolidate", "insight", "archive"]) {
      expect(src).toContain(`applyWrite("${op}"`);
    }
    // 工具层必须 import 客户端，且客户端只投递不落盘
    expect(src).toContain('from "./write-client.js"');
    const client = read("src/plugin/write-client.ts");
    expect(client).not.toContain("writeFileSync");
    expect(client).not.toContain(".save(");
  });

  it("自主进程：起写通道、写通道文件、退出时删文件", () => {
    // F286 起这两件事搬进装配层模块；入口只调 startWriteChannel / handle.close()。
    const src = read("scripts/autonomy/main.mjs");
    expect(src).toContain("startWriteChannel(");
    expect(src).toContain("writeChannel.close()");
    const wiring = read("src/assembly/write-channel-wiring.ts");
    expect(wiring).toContain("startWriteServer(");
    expect(wiring).toContain("writeChannelFile(channelPath");
    expect(wiring).toContain("rmSync(channelPath, { force: true })");
    // 七个 handler 都在（现在在装配层的 handlers 对象里）
    for (const op of ["turn", "remember", "advance", "reset", "consolidate", "insight", "archive"]) {
      expect(wiring).toMatch(new RegExp(`^\\s{6}${op}:`, "m"));
    }
    // 一律 127.0.0.1（服务端实现里写死，客户端也只连本机）
    expect(read("src/autonomy/write-server.ts")).toContain('"127.0.0.1"');
    expect(read("src/plugin/write-client.ts")).toContain('host: "127.0.0.1"');
  });

  it("插件不再自己 save：runtime 里 stateWriter=secondary 时 save 会被拒绝（已有单测兜底）", () => {
    const src = read("src/plugin/index.ts");
    expect(src).toContain('stateWriter: "secondary"');
    // 插件里不该出现 stateWriter: "primary"
    expect(src).not.toContain('stateWriter: "primary"');
  });
});
