import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { REVIEW_TTL_MS, clearReview, pendingReview, raiseReview, releaseReviewIfRecovered } from "../src/autonomy/review.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function file(): string {
  const dir = mkdtempSync(join(tmpdir(), "ase-review-"));
  dirs.push(dir);
  return join(dir, "autonomy-review.json");
}
const NOW = 1_800_000_000_000;
const ticket = { at: NOW, reason: "调用过快：3 次/小时", calls: 3, maxCalls: 2 };

describe("人工审核队列", () => {
  it("没有文件时是空的；落一条之后能读回同样的内容", () => {
    const path = file();
    expect(pendingReview(path, NOW)).toBeNull();
    expect(raiseReview(path, ticket, NOW)).toEqual(ticket);
    expect(pendingReview(path, NOW)).toMatchObject(ticket);
    expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject(ticket);
  });

  it("已有待审记录时不覆盖（保留最早那条）", () => {
    const path = file();
    raiseReview(path, ticket, NOW);
    expect(raiseReview(path, { ...ticket, reason: "后来的", calls: 9 }, NOW)).toBeNull();
    expect(pendingReview(path, NOW)?.reason).toBe(ticket.reason);
  });

  it("清掉之后恢复空，并且可以再落新的一条", () => {
    const path = file();
    raiseReview(path, ticket, NOW);
    expect(clearReview(path)).toBe(true);
    expect(pendingReview(path, NOW)).toBeNull();
    expect(clearReview(path)).toBe(false);
    expect(raiseReview(path, { ...ticket, calls: 1 }, NOW)).not.toBeNull();
  });

  it("损坏的 JSON 视为没有审核（不把她永久卡死）", () => {
    const path = file();
    writeFileSync(path, "{ 这不是 json", "utf8");
    expect(pendingReview(path, NOW)).toBeNull();
    expect(raiseReview(path, ticket, NOW)).toEqual(ticket);
  });
});

describe("审核票据自动过期", () => {
  it("过期的票据视为已清（文件也被删掉），新票据可以再立", () => {
    const path = file();
    raiseReview(path, ticket, NOW);
    // 未到期仍然有效
    expect(pendingReview(path, NOW + REVIEW_TTL_MS - 1)?.reason).toBe(ticket.reason);
    // 到期后：过期且文件被删
    expect(pendingReview(path, NOW + REVIEW_TTL_MS + 1)).toBeNull();
    expect(existsSync(path)).toBe(false);
    // 过期后可以重新立票（否则一旦过期就再也报不上警了）
    const again = { at: NOW + REVIEW_TTL_MS + 1_000, reason: "又超速", calls: 8, maxCalls: 6 };
    expect(raiseReview(path, again, again.at)?.reason).toBe("又超速");
  });
});

describe("窗口恢复后自动解除", () => {
  it("回落到上限以内就删票据", () => {
    const path = file();
    raiseReview(path, { at: NOW, reason: "hourly calls=13 > cap=12", calls: 13, maxCalls: 12 }, NOW);
    expect(pendingReview(path, NOW)).not.toBeNull();
    expect(releaseReviewIfRecovered(path, 3, 12, NOW)).toBe(true);
    expect(pendingReview(path, NOW)).toBeNull();
  });

  it("还没回落就继续挂着", () => {
    const path = file();
    raiseReview(path, { at: NOW, reason: "hourly calls=13 > cap=12", calls: 13, maxCalls: 12 }, NOW);
    expect(releaseReviewIfRecovered(path, 13, 12, NOW)).toBe(false);
    expect(pendingReview(path, NOW)).not.toBeNull();
  });
});
