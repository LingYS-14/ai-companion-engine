/**
 * 面板里「当场回一句」（F299，批次 4 的交互半 / 审计 P1-9）。
 *
 * 以前的状况：面板只显示「有 N 件在等回音」，真要回还得开终端敲
 * `npm run intent:dsh answer …`。也就是说面板能看见、不能回答——
 * 而「说完没人回」正是用户点名的难点。
 *
 * 边界（为什么写在这里而不是插件里）：
 * - 落盘的是**人侧回执**（`dsh-reply/*.json`、`guardian-reply/*.json`），不是她的状态，
 *   所以不违反单写者纪律（批次 2 管的是 `state-*.json`）。
 * - 插件（工具层）只负责 HTTP 解析与鉴权；写文件需要读收件箱、按 id 配对、缺省话术，
 *   这些是业务判断，住大脑层（这里）。装配点注入一个回调即可。
 * - 收件箱里没有这个 id 就不写回执：避免她收到对不上的回答（同 CLI 的取舍）。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import {
  buildDshReply,
  dshInboxPath,
  dshReplyDir,
  parseDshInbox,
  resolveDshAsk,
  serializeDshReply,
  type DshAsk,
  type DshReply,
} from "./dsh-bridge.js";
import {
  GUARDIAN_TIMEOUT_MS,
  type GuardianReply,
  type GuardianRequest,
  type GuardianVerdict,
} from "./guardian.js";
import {
  guardianInboxPath,
  guardianReplyDir,
  readGuardianRequests,
  writeGuardianReply,
} from "./persist.js";
import { formatUtc } from "./episode.js";

/** 面板上的三个按钮（与两种通道的 verdict 枚举分开，避免 UI 被协议词绑住） */
export type PanelAnswerAction = "answer" | "later" | "decline";

export interface PanelAnswerRequest {
  readonly target: "dsh" | "guardian";
  readonly id: string;
  readonly action: PanelAnswerAction;
  /** 人说的话；空则用每个动作的默认话术 */
  readonly note?: string;
}

export interface PanelAnswerOutcome {
  readonly ok: boolean;
  readonly detail: string;
}

export interface AnswerPanelInput {
  readonly dataDir: string;
  readonly characterId: string;
  readonly nowMs: number;
  readonly request: PanelAnswerRequest;
}

export const MAX_PANEL_NOTE_CHARS = 400;
const DEFAULT_LATER_MS = 2 * 60 * 60_000;

const DEFAULT_NOTES: Record<PanelAnswerAction, string> = {
  answer: "我在，说吧。",
  later: "稍等，我手头还有点事。",
  decline: "这个我暂时帮不了，抱歉。",
};

function noteOf(request: PanelAnswerRequest): string {
  const said = (request.note ?? "").trim();
  const trimmed = said.length > MAX_PANEL_NOTE_CHARS ? said.slice(0, MAX_PANEL_NOTE_CHARS) : said;
  if (request.action === "answer" && trimmed === "") return DEFAULT_NOTES.answer;
  return trimmed === "" ? DEFAULT_NOTES[request.action] : trimmed;
}

function answerDsh(input: AnswerPanelInput): PanelAnswerOutcome {
  const inbox = dshInboxPath(input.dataDir, input.characterId);
  let raw = "";
  try {
    raw = existsSync(inbox) ? readFileSync(inbox, "utf8") : "";
  } catch (err) {
    return { ok: false, detail: `读不到 DSH 收件箱：${String(err)}` };
  }
  const parsed = parseDshInbox(raw);
  const ask: DshAsk | undefined = parsed.asks.find((a) => a.id === input.request.id);
  if (ask === undefined) {
    return { ok: false, detail: "DSH 收件箱里没有这条请求（可能已经回过、或它已经过期被清走）" };
  }
  const verdict: DshReply["verdict"] =
    input.request.action === "answer" ? "answered" : input.request.action === "later" ? "later" : "declined";
  const reply = buildDshReply({
    id: ask.id,
    atMs: input.nowMs,
    by: "owner",
    verdict,
    answer: noteOf(input.request),
  });
  try {
    const dir = dshReplyDir(input.dataDir);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${reply.id}.json`), serializeDshReply(reply), "utf8");
  } catch (err) {
    return { ok: false, detail: `回执写不进去：${String(err)}` };
  }
  const fact = resolveDshAsk(ask, reply, input.nowMs).fact;
  return {
    ok: true,
    detail: fact === null ? "回执已写（她下一次拍会看到）" : `回执已写，她会记住：${fact}`,
  };
}

function answerGuardian(input: AnswerPanelInput): PanelAnswerOutcome {
  const root = resolve(input.dataDir, "..");
  let requests: readonly GuardianRequest[] = [];
  try {
    requests = readGuardianRequests(guardianInboxPath(root, input.characterId)).requests;
  } catch (err) {
    return { ok: false, detail: `读不到监护人收件箱：${String(err)}` };
  }
  const found = requests.find((r) => r.requestId === input.request.id);
  if (found === undefined) {
    return { ok: false, detail: "监护人收件箱里没有这条请求（可能已经回过）" };
  }
  const verdict: GuardianVerdict =
    input.request.action === "answer" ? "help" : input.request.action === "later" ? "later" : "decline";
  const reply: GuardianReply = {
    requestId: found.requestId,
    at: formatUtc(input.nowMs),
    from: "owner",
    verdict,
    note: noteOf(input.request),
    ...(verdict === "later" ? { retryAfterMs: DEFAULT_LATER_MS } : {}),
  };
  try {
    writeGuardianReply(guardianReplyDir(root), reply);
  } catch (err) {
    return { ok: false, detail: `回执写不进去：${String(err)}` };
  }
  const timeoutMs = found.timeoutMs > 0 ? found.timeoutMs : GUARDIAN_TIMEOUT_MS;
  const fact =
    verdict === "help" ? `监护人回我了：${reply.note}` : verdict === "decline" ? `监护人帮不了：${reply.note}` : `监护人说稍后：${reply.note}`;
  void timeoutMs;
  return { ok: true, detail: `回执已写，她会记住：${fact}` };
}

/** 面板回一句：校验 → 写人侧回执 → 返回她会记住的那句话（不碰她的状态） */
export function answerPanelRequest(input: AnswerPanelInput): PanelAnswerOutcome {
  const { target, id } = input.request;
  if (id.trim() === "") return { ok: false, detail: "缺少请求 id" };
  if (target !== "dsh" && target !== "guardian") return { ok: false, detail: `不认识的通道：${String(target)}` };
  if (!Number.isFinite(input.nowMs)) return { ok: false, detail: "时间不对（nowMs 必须是有限数）" };
  return target === "dsh" ? answerDsh(input) : answerGuardian(input);
}
