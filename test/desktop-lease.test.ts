import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runDesktop, type DesktopDeps } from "../src/desktop/desktop.js";
import {
  authorizeLease,
  createLease,
  leaseStatus,
  parseLease,
  readLease,
  writeLease,
} from "../src/desktop/lease.js";

const NOW = Date.UTC(2026, 9, 31, 1, 0, 0);

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "soul-desktop-"));
}

function deps(dir: string, exec: DesktopDeps["exec"]): DesktopDeps {
  return {
    powershellExe: "powershell",
    scriptPath: join(dir, "desktop.ps1"),
    outDir: join(dir, "screens"),
    now: () => NOW,
    leasePath: join(dir, "desktop-lease.json"),
    auditPath: join(dir, "desktop-actions.ndjson"),
    ...(exec === undefined ? {} : { exec }),
  };
}

const okPayload = async () => ({ code: 0, stdout: JSON.stringify({ ok: true, clicked: true }), stderr: "" });

describe("desktop lease：纯规则", () => {
  it("createLease 夹住 minutes 与 maxActions，并记录授权人", () => {
    const lease = createLease({ now: NOW, minutes: 999, maxActions: 999, grantedBy: "  用户  " });
    expect(lease.version).toBe(1);
    expect(lease.expiresAt).toBe(NOW + 120 * 60_000);
    expect(lease.maxActions).toBe(50);
    expect(lease.grantedBy).toBe("用户");
    expect(lease.allow).toEqual({ click: true, type: true, key: true });
  });

  it("parseLease 对坏形状一律 null（fail-closed）", () => {
    expect(parseLease(null)).toBeNull();
    expect(parseLease({})).toBeNull();
    expect(parseLease({ version: 2, grantedAt: 1, expiresAt: 2, grantedBy: "x", allow: {}, maxActions: 1, used: 0 })).toBeNull();
    const good = createLease({ now: NOW, minutes: 5, maxActions: 3, grantedBy: "用户" });
    expect(parseLease(good)).toEqual(good);
    // used 超过 maxActions = 坏文件
    expect(parseLease({ ...good, used: 4 })).toBeNull();
    // allow 里缺字段 → 该动作视为不允许，但文件本身合法
    expect(parseLease({ ...good, allow: { click: true } })?.allow).toEqual({ click: true, type: false, key: false });
  });

  it("leaseStatus 的四种状态", () => {
    expect(leaseStatus(null, NOW).state).toBe("none");
    const lease = createLease({ now: NOW, minutes: 1, maxActions: 1, grantedBy: "用户" });
    expect(leaseStatus(lease, NOW).state).toBe("active");
    expect(leaseStatus(lease, NOW + 60_000).state).toBe("expired");
    expect(leaseStatus({ ...lease, used: 1 }, NOW).state).toBe("exhausted");
  });

  it("authorizeLease：没有/过期/用完/动作未授权都拒绝，通过时消耗一次", () => {
    expect(authorizeLease(null, NOW, "click").ok).toBe(false);
    const one = createLease({ now: NOW, minutes: 5, maxActions: 1, grantedBy: "用户" });
    expect(authorizeLease(one, NOW + 5 * 60_000, "click").ok).toBe(false); // 过期
    const decided = authorizeLease(one, NOW, "click");
    expect(decided.ok).toBe(true);
    expect(decided.lease?.used).toBe(1);
    expect(authorizeLease(decided.lease ?? null, NOW, "click").ok).toBe(false); // 用完了
    const typedOff = createLease({ now: NOW, minutes: 5, maxActions: 3, grantedBy: "用户", allow: { type: false } });
    expect(authorizeLease(typedOff, NOW, "type").ok).toBe(false);
    expect(authorizeLease(typedOff, NOW, "key").ok).toBe(true);
  });

  it("writeLease/readLease 往返，文件坏掉时 readLease 返回 null", () => {
    const dir = tempDir();
    const path = join(dir, "desktop-lease.json");
    const lease = createLease({ now: NOW, minutes: 5, maxActions: 2, grantedBy: "用户" });
    expect(writeLease(path, lease)).toBe(true);
    expect(readLease(path)).toEqual(lease);
    writeFileSync(path, "{not json", "utf8");
    expect(readLease(path)).toBeNull();
  });
});

describe("desktop lease：runDesktop 的执行边界", () => {
  it("没有租约时输入动作被拒，且一次执行器都不碰", async () => {
    const dir = tempDir();
    let called = 0;
    const exec = async () => {
      called += 1;
      return { code: 0, stdout: JSON.stringify({ ok: true }), stderr: "" };
    };
    const result = await runDesktop({ action: "click", x: 10, y: 10 }, deps(dir, exec), { allowInput: true });
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("租约");
    expect(called).toBe(0);
    // 被拒也要留审计
    const audit = readFileSync(join(dir, "desktop-actions.ndjson"), "utf8").trim().split("\n");
    expect(JSON.parse(audit[0] as string)).toMatchObject({ action: "click", ok: false });
  });

  it("有效租约 → 动作执行、次数被消耗并写回、审计记下授权人", async () => {
    const dir = tempDir();
    const d = deps(dir, okPayload);
    writeLease(d.leasePath as string, createLease({ now: NOW, minutes: 5, maxActions: 2, grantedBy: "用户" }));

    const first = await runDesktop({ action: "click", x: 10, y: 10 }, d, { allowInput: true });
    expect(first.ok).toBe(true);
    expect(readLease(d.leasePath as string)?.used).toBe(1);

    const second = await runDesktop({ action: "key", keys: "CTRL+S" }, d, { allowInput: true });
    expect(second.ok).toBe(true);
    expect(readLease(d.leasePath as string)?.used).toBe(2);

    const third = await runDesktop({ action: "type", text: "hi" }, d, { allowInput: true });
    expect(third.ok).toBe(false);
    expect(third.detail).toContain("用完");

    const rows = readFileSync(d.auditPath as string, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(rows.at(-3)).toMatchObject({ action: "click", ok: true, lease: { grantedBy: "用户", used: 1, maxActions: 2 } });
    expect(rows.at(-1)).toMatchObject({ action: "type", ok: false });
  });

  it("执行失败不消耗次数（失败不该扣掉一次授权）", async () => {
    const dir = tempDir();
    const failing = async () => ({ code: 1, stdout: "", stderr: "boom" });
    const d = deps(dir, failing);
    writeLease(d.leasePath as string, createLease({ now: NOW, minutes: 5, maxActions: 2, grantedBy: "用户" }));
    const result = await runDesktop({ action: "click", x: 10, y: 10 }, d, { allowInput: true });
    expect(result.ok).toBe(false);
    expect(readLease(d.leasePath as string)?.used).toBe(0);
  });

  it("只读动作（screen/windows）不需要租约，也被审计", async () => {
    const dir = tempDir();
    const d = deps(dir, async () => ({ code: 0, stdout: JSON.stringify({ ok: true, count: 2, windows: [] }), stderr: "" }));
    const result = await runDesktop({ action: "windows" }, d, { allowInput: false });
    expect(result.ok).toBe(true);
    const rows = readFileSync(d.auditPath as string, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(rows[0]).toMatchObject({ action: "windows", ok: true });
    expect(existsSync(d.leasePath as string)).toBe(false); // 没有为只读动作造租约
  });

  it("租约关闭某类动作时，只拒那一类", async () => {
    const dir = tempDir();
    const d = deps(dir, okPayload);
    writeLease(
      d.leasePath as string,
      createLease({ now: NOW, minutes: 5, maxActions: 3, grantedBy: "用户", allow: { click: true, type: false } }),
    );
    expect((await runDesktop({ action: "type", text: "hi" }, d, { allowInput: true })).ok).toBe(false);
    expect((await runDesktop({ action: "click", x: 1, y: 1 }, d, { allowInput: true })).ok).toBe(true);
  });
});
