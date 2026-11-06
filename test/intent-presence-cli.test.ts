import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildPresence, presencePath } from "../tools/intent/presence.mjs";

const ROOT = resolve(import.meta.dirname, "..");
const SCRIPT = join(ROOT, "tools", "intent", "presence.mjs");

function run(args: string[]): { stdout: string; status: number } {
  try {
    const stdout = execFileSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8" });
    return { stdout, status: 0 };
  } catch (err) {
    const e = err as { status?: number; stdout?: string };
    return { stdout: String(e.stdout ?? ""), status: e.status ?? -1 };
  }
}

const dirs: string[] = [];
function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "presence-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("presence 心跳（P0-B DSH→她 方向一）", () => {
  it("默认写 active + 30 分钟 TTL，内容是 JSON 不是半截文件", () => {
    const dir = tmp();
    const { status } = run(["--data", dir, "--now", "1793434429938"]);
    expect(status).toBe(0);
    const raw = readFileSync(presencePath(dir, "assistant"), "utf8");
    expect(JSON.parse(raw)).toEqual({ atMs: 1793434429938, active: true, ttlMs: 30 * 60_000 });
  });

  it("--inactive 写「已离开」，TTL 收紧到 2 分钟", () => {
    const dir = tmp();
    expect(run(["--data", dir, "--inactive"]).status).toBe(0);
    const rec = JSON.parse(readFileSync(presencePath(dir, "assistant"), "utf8"));
    expect(rec.active).toBe(false);
    expect(rec.ttlMs).toBe(2 * 60_000);
  });

  it("--ttl 自定义分钟数、--character 决定文件名", () => {
    const dir = tmp();
    expect(run(["--data", dir, "--ttl", "45", "--character", "testco"]).status).toBe(0);
    const rec = JSON.parse(readFileSync(presencePath(dir, "testco"), "utf8"));
    expect(rec.ttlMs).toBe(45 * 60_000);
  });

  it("非法 TTL 参数 exit 1（不写坏文件）", () => {
    expect(run(["--ttl", "0"]).status).toBe(1);
  });

  it("--help exit 0 并说明她怎么读这个文件", () => {
    const { status, stdout } = run(["--help"]);
    expect(status).toBe(0);
    expect(stdout).toContain("presence-");
  });

  it("buildPresence 是纯函数：非法 nowMs/TTL 抛 RangeError，不改入参", () => {
    expect(() => buildPresence({ nowMs: Number.NaN, ttlMinutes: 30 })).toThrow(RangeError);
    expect(() => buildPresence({ nowMs: 1, ttlMinutes: 0 })).toThrow(RangeError);
    const rec = buildPresence({ nowMs: 1000.9, ttlMinutes: 1 });
    expect(rec).toEqual({ atMs: 1000, active: true, ttlMs: 60_000 });
  });
});
