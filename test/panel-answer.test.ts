/**
 * F299：面板当场回一句（批次 4 交互半 / 审计 P1-9）。
 *
 * 这一层测两件事：
 * 1. 大脑侧 `answerPanelRequest`——只有收件箱里真有这条才写回执；写的是人侧回执
 *    （不是她的状态），缺省话术与 later 的重问时间都对。
 * 2. 工具侧 `createAnswerHandler`——只收 POST、形状/动作白名单、过大请求被拦；
 *    以及装配点确实把它挂在面板旁边，前端确实调这个端点（锁测试）。
 */

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  ANSWER_PATH,
  createAnswerHandler,
  parsePanelAnswerBody,
} from "../src/plugin/web/handlers.js";
import { answerPanelRequest } from "../src/orchestrator/intent/panel-answer.js";
import {
  buildDshAsk,
  dshInboxPath,
  dshReplyDir,
  parseDshReply,
  serializeDshAsk,
} from "../src/orchestrator/intent/dsh-bridge.js";
import { guardianInboxPath, guardianReplyDir } from "../src/orchestrator/intent/persist.js";
import { guardianReplyFileName, serializeGuardianRequest, type GuardianRequest } from "../src/orchestrator/intent/guardian.js";

const NOW = 1_793_600_000_000;
const CHAR = "assistant";

function tempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "panel-answer-"));
  mkdirSync(join(dir, "data"), { recursive: true });
  return dir;
}

function dshInboxLine(id: string): string {
  const ask = buildDshAsk({
    intentionId: id,
    atMs: NOW - 60_000,
    kind: "help",
    text: "卡在工具选择上，想请你看一眼",
    tried: ["试过 knowledge.read"],
  });
  return serializeDshAsk(ask) + "\n";
}

function guardianRequest(): GuardianRequest {
  return {
    requestId: "grd-itn-1-29566080",
    at: "2026-11-01T03:00:00Z",
    intentionId: "itn-1",
    what: "卡在权限上",
    tried: ["试过 desktop.screen"],
    need: "permission",
    ask: "能帮我确认一下桌面权限吗",
    timeoutMs: 2 * 60 * 60_000,
  };
}

describe("answerPanelRequest（大脑侧）", () => {
  it("DSH：收件箱里有时写回执，并说明她会记住什么", () => {
    const root = tempRoot();
    const ask = buildDshAsk({
      intentionId: "ask-1",
      atMs: NOW - 60_000,
      kind: "help",
      text: "想请你看看这条",
      tried: [],
    });
    writeFileSync(dshInboxPath(join(root, "data"), CHAR), dshInboxLine("ask-1"), "utf8");

    const out = answerPanelRequest({
      dataDir: join(root, "data"),
      characterId: CHAR,
      nowMs: NOW,
      request: { target: "dsh", id: ask.id, action: "answer", note: "我看过了，用 knowledge.read。" },
    });

    expect(out.ok).toBe(true);
    expect(out.detail).toContain("回执已写");
    const raw = readFileSync(join(dshReplyDir(join(root, "data")), `${ask.id}.json`), "utf8");
    const reply = parseDshReply(JSON.parse(raw));
    expect(reply?.verdict).toBe("answered");
    expect(reply?.answer).toBe("我看过了，用 knowledge.read。");
  });

  it("DSH：收件箱里没有这条就不写（避免她对不上号）", () => {
    const root = tempRoot();
    const out = answerPanelRequest({
      dataDir: join(root, "data"),
      characterId: CHAR,
      nowMs: NOW,
      request: { target: "dsh", id: "dsh-不存在", action: "answer" },
    });
    expect(out.ok).toBe(false);
    expect(out.detail).toContain("没有这条请求");
  });

  it("DSH：decline / later 用默认话术，later 不用人填", () => {
    const root = tempRoot();
    writeFileSync(dshInboxPath(join(root, "data"), CHAR), dshInboxLine("ask-2"), "utf8");
    const ask = buildDshAsk({ intentionId: "ask-2", atMs: NOW - 60_000, kind: "observe", text: "看看这个", tried: [] });
    const later = answerPanelRequest({
      dataDir: join(root, "data"),
      characterId: CHAR,
      nowMs: NOW,
      request: { target: "dsh", id: ask.id, action: "later" },
    });
    expect(later.ok).toBe(true);
    const reply = parseDshReply(
      JSON.parse(readFileSync(join(dshReplyDir(join(root, "data")), `${ask.id}.json`), "utf8")),
    );
    expect(reply?.verdict).toBe("later");
    expect(reply?.answer ?? "").not.toBe("");
  });

  it("监护人：help 写成 owner 的回执（文件名按哈希规则，不用 requestId 直拼）", () => {
    const root = tempRoot();
    const req = guardianRequest();
    mkdirSync(join(root, "data"), { recursive: true });
    const inbox = guardianInboxPath(root, CHAR);
    writeFileSync(inbox, serializeGuardianRequest(req) + "\n", "utf8");

    const out = answerPanelRequest({
      dataDir: join(root, "data"),
      characterId: CHAR,
      nowMs: NOW,
      request: { target: "guardian", id: req.requestId, action: "later", note: "一小时后再问我" },
    });

    expect(out.ok).toBe(true);
    const dir = guardianReplyDir(root);
    const name = `${guardianReplyFileName(req.requestId)}.json`;
    const reply = JSON.parse(readFileSync(join(dir, name), "utf8")) as {
      verdict: string;
      from: string;
      note: string;
      retryAfterMs?: number;
    };
    expect(reply.verdict).toBe("later");
    expect(reply.from).toBe("owner");
    expect(reply.note).toBe("一小时后再问我");
    expect(reply.retryAfterMs).toBe(2 * 60 * 60_000);
  });

  it("监护人：收件箱里没有这条就拒绝", () => {
    const root = tempRoot();
    const out = answerPanelRequest({
      dataDir: join(root, "data"),
      characterId: CHAR,
      nowMs: NOW,
      request: { target: "guardian", id: "grd-不存在", action: "answer" },
    });
    expect(out.ok).toBe(false);
  });

  it("非法输入：空 id / 未知通道 / 坏时间都拒绝且不抛", () => {
    const root = tempRoot();
    const base = { dataDir: join(root, "data"), characterId: CHAR, nowMs: NOW };
    expect(answerPanelRequest({ ...base, request: { target: "dsh", id: "  ", action: "answer" } }).ok).toBe(false);
    expect(
      answerPanelRequest({ ...base, request: { target: "nope" as never, id: "x", action: "answer" } }).ok,
    ).toBe(false);
    expect(
      answerPanelRequest({ ...base, nowMs: Number.NaN, request: { target: "dsh", id: "x", action: "answer" } }).ok,
    ).toBe(false);
  });
});

describe("createAnswerHandler（工具侧协议）", () => {
  function fakeRes(): { res: { writeHead: (s: number, h: Record<string, string>) => void; end: (b: string) => void }; status: () => number; body: () => string } {
    let status = 0;
    let body = "";
    return {
      res: {
        writeHead: (s: number) => {
          status = s;
        },
        end: (b: string) => {
          body = b;
        },
      },
      status: () => status,
      body: () => body,
    };
  }

  interface FakeReq {
    readonly method: string;
    on: (event: string, listener: (arg?: unknown) => void) => FakeReq;
    fire: (chunks: string[]) => void;
  }

  function fakeReq(method: string): FakeReq {
    const listeners: Record<string, ((arg?: unknown) => void)[]> = {};
    const req: FakeReq = {
      method,
      on: (event, listener) => {
        (listeners[event] ??= []).push(listener);
        return req;
      },
      fire: (chunks) => {
        for (const chunk of chunks) for (const listener of listeners["data"] ?? []) listener(new TextEncoder().encode(chunk));
        for (const listener of listeners["end"] ?? []) listener();
      },
    };
    return req;
  }

  it("POST + 合法 JSON 调业务回调并回 200", () => {
    const calls: unknown[] = [];
    const handler = createAnswerHandler({
      answer: (body) => {
        calls.push(body);
        return { ok: true, detail: "回执已写" };
      },
    });
    const { res, status, body } = fakeRes();
    const req = fakeReq("POST");
    handler(req as never, res as never);
    req.fire([JSON.stringify({ target: "dsh", id: "dsh-a-1", action: "answer", note: "好" })]);
    expect(status()).toBe(200);
    expect(body()).toContain("回执已写");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ target: "dsh", action: "answer" });
  });

  it("非 POST → 405；坏 JSON / 坏动作 → 400", () => {
    const handler = createAnswerHandler({ answer: () => ({ ok: true, detail: "" }) });
    const get = fakeRes();
    handler({ method: "GET" } as never, get.res as never);
    expect(get.status()).toBe(405);

    const badJson = fakeRes();
    const badJsonReq = fakeReq("POST");
    handler(badJsonReq as never, badJson.res as never);
    badJsonReq.fire(["{不是 json"]);
    expect(badJson.status()).toBe(400);

    const badAction = fakeRes();
    const badActionReq = fakeReq("POST");
    handler(badActionReq as never, badAction.res as never);
    badActionReq.fire([JSON.stringify({ target: "dsh", id: "x", action: "maybe" })]);
    expect(badAction.status()).toBe(400);
  });

  it("parsePanelAnswerBody 只认两种通道、三种动作", () => {
    expect(parsePanelAnswerBody({ target: "dsh", id: "a", action: "answer" })).toMatchObject({ target: "dsh" });
    expect(parsePanelAnswerBody({ target: "bili", id: "a", action: "answer" })).toHaveProperty("error");
    expect(parsePanelAnswerBody({ target: "dsh", id: "a", action: "delete" })).toHaveProperty("error");
    expect(parsePanelAnswerBody({ target: "dsh", id: "", action: "answer" })).toHaveProperty("error");
  });
});

describe("接线锁（F299）", () => {
  const read = (path: string): string => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

  it("装配点注册回信端点，并注入大脑侧实现", () => {
    const index = read("src/plugin/index.ts");
    expect(index).toContain("registerAnswerRoute(");
    expect(index).toContain("answerPanelRequest(");
    expect(index).toContain("ANSWER_PATH");
  });

  it("面板前端调同一个端点（不是另写一条路子）", () => {
    // P4-4 P1：面板前端改成同源工作台静态页（lib/soul/soul.js），端点仍是同一条
    const client = read("lib/soul/soul.js");
    expect(client).toContain('"/plugins/ai-companion-engine/answer"');
    expect(client).toContain('method: "POST"');
    expect(ANSWER_PATH).toBe("/plugins/ai-companion-engine/answer");
  });
});
