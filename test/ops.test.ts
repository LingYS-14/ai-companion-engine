import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { opsCall } from "../src/qq/ops.js";

const made: string[] = [];
const timers: NodeJS.Timeout[] = [];

function tmpRoot(): string {
  const root = join(process.cwd(), `.tmp-ops-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
  mkdirSync(root, { recursive: true });
  made.push(root);
  return root;
}

afterEach(() => {
  for (const t of timers.splice(0)) clearInterval(t);
  for (const root of made.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** 假桥：看到 q/in 里的请求就写一份 q/out 应答，并删掉请求（与真桥行为一致）。 */
function fakeBridge(root: string, respond: (cmd: Record<string, unknown>) => Record<string, unknown>): void {
  const dirIn = join(root, "q", "in");
  const dirOut = join(root, "q", "out");
  mkdirSync(dirIn, { recursive: true });
  mkdirSync(dirOut, { recursive: true });
  const timer = setInterval(() => {
    for (const f of readdirSync(dirIn).filter((x) => x.endsWith(".json"))) {
      const cmd = JSON.parse(readFileSync(join(dirIn, f), "utf8")) as Record<string, unknown>;
      writeFileSync(join(dirOut, f), JSON.stringify(respond(cmd)), "utf8");
      rmSync(join(dirIn, f), { force: true });
    }
  }, 10);
  timers.push(timer);
  timer.unref?.();
}

describe("opsCall（与宿主输入桥的文件队列）", () => {
  it("写请求、拿到应答的 result", async () => {
    const root = tmpRoot();
    fakeBridge(root, (cmd) => ({ ok: true, result: { op: cmd["op"], value: 42 } }));
    const r = await opsCall(root, { op: "cursor" }, 2_000);
    expect(r.ok).toBe(true);
    expect(r.result?.["op"]).toBe("cursor");
    expect(r.result?.["value"]).toBe(42);
    expect(r.ms).toBeGreaterThanOrEqual(0);
  });

  it("桥报错时把 error 带回来", async () => {
    const root = tmpRoot();
    fakeBridge(root, () => ({ ok: false, error: "no such op" }));
    const r = await opsCall(root, { op: "nope" }, 2_000);
    expect(r.ok).toBe(false);
    expect(r.error).toBe("no such op");
  });

  it("桥不应答时超时并清掉请求文件", async () => {
    const root = tmpRoot();
    mkdirSync(join(root, "q", "in"), { recursive: true });
    mkdirSync(join(root, "q", "out"), { recursive: true });
    const r = await opsCall(root, { op: "cursor" }, 120);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("timeout");
    expect(readdirSync(join(root, "q", "in"))).toHaveLength(0);
  });
});
