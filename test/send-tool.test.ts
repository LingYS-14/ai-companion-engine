import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { buildTools } from "../src/plugin/tools.js";
import type { SoulRuntime } from "../src/plugin/runtime.js";

const TMP_ROOT = process.env["TMP_ROOT"] ?? join(process.cwd(), ".tmp-probe");
mkdirSync(TMP_ROOT, { recursive: true });

function fakeRuntime(): SoulRuntime {
  return {} as SoulRuntime;
}

function tool(name: string, extras: Parameters<typeof buildTools>[1]) {
  const defs = buildTools(fakeRuntime(), extras);
  const found = defs.find((d) => d.name === name);
  if (found === undefined) throw new Error(`no tool ${name}`);
  return found;
}

describe("soul_qq_send 的通道选择", () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = mkdtempSync(join(TMP_ROOT, "sendtool-"));
    file = join(dir, "note.txt");
    writeFileSync(file, "hello", "utf8");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("优先用 sender（窗口通道），即使 qq 是 null", async () => {
    const calls: unknown[] = [];
    const t = tool("soul_qq_send", {
      qq: null,
      sender: async (target) => {
        calls.push(target);
        return { ok: true, detail: "window: sent at 1,2" };
      },
    });
    const out = await t.execute({ kind: "file", path: file });
    expect(out).toContain("ok=true");
    expect(out).toContain("window: sent at 1,2");
    expect(calls).toEqual([{ kind: "file", payload: file }]);
  });

  it("没有 sender 时退回 qq.sendContent", async () => {
    const t = tool("soul_qq_send", {
      qq: {
        status: () => ({ dryRun: false, peer: "x", replied: 0, lastReplyAt: null, repliesLastHour: 0, cursorEpochNs: 0 }),
        poll: async () => ({ acted: false, reason: "idle", detail: "" }),
        sendContent: async () => ({ ok: true, detail: "onebot: sent" }),
        proactive: async () => ({ acted: false, verdict: "calm", detail: "" }),
      } as never,
    });
    const out = await t.execute({ kind: "text", text: "在吗" });
    expect(out).toContain("onebot: sent");
  });

  it("两个通道都没有时明确报未启用", async () => {
    const t = tool("soul_qq_send", { qq: null, sender: null });
    const out = await t.execute({ kind: "text", text: "在吗" });
    expect(out).toContain("未启用");
  });

  it("kind 非法 / 文件不存在时在发之前就拦住", async () => {
    const t = tool("soul_qq_send", { sender: async () => ({ ok: true, detail: "x" }) });
    expect(await t.execute({ kind: "video", path: file })).toContain("kind 只能是");
    expect(await t.execute({ kind: "file", path: join(dir, "nope.txt") })).toContain("找不到文件");
    expect(await t.execute({ kind: "text", text: "   " })).toContain("正文是空的");
  });
});
