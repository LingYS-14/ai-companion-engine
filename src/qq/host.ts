/**
 * QQ 桥的宿主侧实现：真的读 inbox、真的调 `qqbus.sh`、真的调宿主 LLM。
 *
 * 这一层刻意保持很薄——所有判断都在 `bridge.ts` / `filter.ts` / `prompt.ts` 里，
 * 这里只负责"接上真实世界"，因此它不写测试（写了也只是测 `child_process`）。
 *
 * 两条纪律：
 * - 时间一律来自注入的 `Clock`，这里不直接读系统时钟（CI 的 writers 闸会拦）。
 * - 发送走 `qqbus.sh send`（它负责租约与输入锁），不自己点窗口；
 *   QQ 通道是全局的，绕过总线会和别的会话抢输入框。
 */

import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { Clock } from "../ports/index.js";
import type { QQDeps, QQSendResult } from "./bridge.js";
import { makeClipboardSetter } from "./clipboard.js";
import { opsCall } from "./ops.js";
import { sendNow, type ClipKind, type SendDeps } from "./send.js";
import { emptyQQState, type InboxMessage, type QQOptions, type QQStateRecord } from "./types.js";

export interface LLMChunk {
  readonly type: string;
  readonly text?: string;
  /** block-end 时带完整块：部分适配器只在这里给最终文本，不保证 text-delta */
  readonly block?: { readonly type: string; readonly text?: string };
}

/** 一条 user 消息的 content 是**块数组**，不是裸字符串（实测：传字符串会得到 0 字符） */
export interface LLMTextBlock {
  readonly type: "text";
  readonly text: string;
}

/** 宿主附件服务最小面：把图片字节变成 durable 引用（模型只认引用，不认路径）。 */
export interface AttachmentsLike {
  saveImages(inputs: readonly {
    readonly data: Uint8Array;
    readonly mediaType: string;
    readonly name?: string;
  }[]): Promise<readonly unknown[]>;
}

export interface LLMImageBlock {
  readonly type: "image";
  readonly attachment: unknown;
}

export interface LLMServiceLike {
  stream(options: {
    readonly provider: string;
    readonly model: string;
    readonly system?: string;
    readonly messages: readonly {
      readonly role: "user" | "assistant";
      readonly content: readonly (LLMTextBlock | LLMImageBlock)[];
    }[];
    readonly maxTokens?: number;
    readonly temperature?: number;
    readonly sessionId?: string;
    readonly purpose?: string;
    readonly signal?: AbortSignal;
  }): AsyncIterable<LLMChunk>;
}

export interface DefaultModelLike {
  currentSelection(): { readonly provider: string; readonly model: string };
}

export interface HostQQOptions {
  /** `qq-ops` */
  readonly root: string;
  /** 状态文件目录（插件 dataDir） */
  readonly dataDir: string;
  readonly characterId: string;
  readonly clock: Clock;
  readonly qq: QQOptions;
  /** 宿主 LLM（可选：拿不到时桥仍然能跑 dry-run） */
  readonly llm?: LLMServiceLike;
  readonly defaultModel?: DefaultModelLike;
  /**
   * 宿主附件服务（可选：没有时图片降级为文字提示，不影响文字对话）。
   * 允许传 getter：插件 apply 往往早于服务就绪，晚一点取才不会永远拿不到。
   */
  readonly attachments?: AttachmentsLike | (() => AttachmentsLike | undefined);
  readonly log?: (line: string) => void;
  /** QQ 主窗口句柄（默认取 QQ_HWND 环境变量，再退回 460836） */
  readonly hwnd?: number;
  /** 剪贴板辅助脚本；默认是本包 `scripts/clipset.ps1` */
  readonly clipsetScript?: string;
  /** 文本临时文件目录（默认 `<dataDir>/tmp`） */
  readonly tmpDir?: string;
}

/** 按魔数判断媒体类型；认不出就当不是图片（QQ 的表情包混杂，别硬塞给模型）。 */
export function sniffImageMediaType(data: Uint8Array): string | null {
  const b = data;
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  const ascii = (at: number, len: number) => String.fromCharCode(...Array.from(b.subarray(at, at + len)));
  if (b.length >= 12 && ascii(0, 4) === "RIFF" && ascii(8, 4) === "WEBP") return "image/webp";
  if (b.length >= 6 && ascii(0, 3) === "GIF") return "image/gif";
  return null;
}

const DEFAULT_CLIPSET = fileURLToPath(new URL("../../scripts/clipset.ps1", import.meta.url));
/** 探针默认用环境变量 ACE_PYTHON，找不到就交给 PATH 解析（Windows 上通常是 python.exe）。 */
const DEFAULT_PYTHON = process.env["ACE_PYTHON"] ?? "python";
const DB_PROBE = fileURLToPath(new URL("../../scripts/dbprobe.py", import.meta.url));

/**
 * 只读内存探针：证明宿主进程有没有资格读 QQ 的地址空间、以及 SQLCipher 的 salt 是否在内存里。
 * 不改任何东西，也不碰 QQ 目录。
 */
export function makeDbProbe(opts: { readonly python?: string; readonly script?: string } = {}): () => Promise<string> {
  return () =>
    new Promise<string>((resolve) => {
      execFile(
        opts.python ?? DEFAULT_PYTHON,
        [opts.script ?? DB_PROBE],
        { timeout: 180_000, maxBuffer: 8 * 1024 * 1024, windowsHide: true, env: { ...process.env, PYTHONIOENCODING: "utf-8" } },
        (error, stdout, stderr) => {
          const tail = String(stderr ?? "").trim();
          if (error !== null && error !== undefined && stdout.trim() === "") {
            resolve(`探针没跑起来：${error.message}${tail === "" ? "" : `
${tail}`}`);
            return;
          }
          resolve(`${String(stdout ?? "").trim()}${tail === "" ? "" : `
[stderr]
${tail}`}`);
        },
      );
    });
}
/**
 * 在宿主进程里跑一个本仓库的 python 脚本（只读实验用）。
 *
 * 为什么要从宿主跑：沙箱里的工具进程被降到了 Low 完整性，**往里写不了**（VirtualAllocEx /
 * CreateRemoteThread 都是写升权，被强制策略拦掉），所以注入类实验必须由 Medium 的宿主来发。
 * 这只给"研究脚本"用，不是通用后门：调用方必须已经确认过脚本路径在本仓库 `scripts/` 下。
 */
export function makeScriptRunner(
  opts: { readonly python?: string; readonly root?: string } = {},
): (script: string, args?: readonly string[]) => Promise<string> {
  const root = opts.root ?? fileURLToPath(new URL("../..", import.meta.url));
  return (script, args = []) =>
    new Promise<string>((resolve) => {
      const full = join(root, script);
      if (!full.startsWith(join(root, "scripts")) || !full.endsWith(".py")) {
        resolve(`拒绝执行：${script} 不在 scripts/ 下的 .py 脚本`);
        return;
      }
      execFile(
        opts.python ?? DEFAULT_PYTHON,
        [full, ...args],
        {
          timeout: 240_000,
          maxBuffer: 16 * 1024 * 1024,
          windowsHide: true,
          cwd: root,
          env: { ...process.env, PYTHONPATH: join(root, ".pydeps"), PYTHONIOENCODING: "utf-8" },
        },
        (error, stdout, stderr) => {
          const tail = String(stderr ?? "").trim();
          if (error !== null && error !== undefined && String(stdout ?? "").trim() === "") {
            resolve(`脚本没跑起来：${error.message}${tail === "" ? "" : "\n" + tail}`);
            return;
          }
          resolve(`${String(stdout ?? "").trim()}${tail === "" ? "" : "\n[stderr]\n" + tail}`);
        },
      );
    });
}

const FALLBACK_HWND = 460836;

const STATE_VERSION = 1;

function statePath(dataDir: string, characterId: string): string {
  return join(dataDir, `qq-${characterId}.json`);
}

export function loadQQState(dataDir: string, characterId: string): QQStateRecord {
  const path = statePath(dataDir, characterId);
  if (!existsSync(path)) return emptyQQState();
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<QQStateRecord> & { version?: number };
    const cursor = typeof parsed.cursorEpochNs === "number" ? parsed.cursorEpochNs : 0;
    const replied = Array.isArray(parsed.repliedIds) ? parsed.repliedIds.filter((x): x is string => typeof x === "string") : [];
    const times = Array.isArray(parsed.replyTimes) ? parsed.replyTimes.filter((x): x is number => typeof x === "number") : [];
    const last = typeof parsed.lastReplyAt === "number" ? parsed.lastReplyAt : null;
    // OneBot 通道新增的可选字段：旧存档里没有就不写，保持「老存档照常读」的承诺
    const lastEvent = typeof parsed.onebotLastEventAt === "number" ? parsed.onebotLastEventAt : null;
    // 主动开口的记账（P0-F）：不读这两个字段，进程重启后「今天说过几句 / 最后一拍」会清零，
    // 日志里有 84 条主动开口、QQ 状态里却只记 1 条。数组逐项过滤，坏值不污染计数。
    const proactiveAt = Array.isArray(parsed.proactiveAt)
      ? parsed.proactiveAt.filter((x): x is number => typeof x === "number")
      : [];
    const lastProactiveAt = typeof parsed.lastProactiveAt === "number" ? parsed.lastProactiveAt : null;
    return {
      cursorEpochNs: cursor,
      repliedIds: replied,
      replyTimes: times,
      lastReplyAt: last,
      // 旧存档按空数组读（与 types.ts 的注释一致），永远给数组而不是省略字段
      proactiveAt,
      ...(lastProactiveAt === null ? {} : { lastProactiveAt }),
      ...(lastEvent === null ? {} : { onebotLastEventAt: lastEvent }),
    };
  } catch {
    return emptyQQState();
  }
}

export function saveQQState(dataDir: string, characterId: string, state: QQStateRecord): void {
  mkdirSync(dataDir, { recursive: true });
  const path = statePath(dataDir, characterId);
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify({ version: STATE_VERSION, ...state }, null, 2), "utf8");
  renameSync(tmp, path);
}

/** 文件名 `<epoch_ns>_<id>.json`；解析不出来就跳过，不让一条坏文件卡住整轮 */
export function parseInboxFile(name: string, raw: string): InboxMessage | null {
  const match = /^(\d{15,})_/.exec(name);
  if (match === null) return null;
  try {
    const parsed = JSON.parse(raw) as { id?: unknown; at?: unknown; sender?: unknown; text?: unknown };
    const id = typeof parsed.id === "string" ? parsed.id : "";
    const text = typeof parsed.text === "string" ? parsed.text : "";
    if (id === "" || text === "") return null;
    return {
      id,
      epochNs: Number(match[1]),
      at: typeof parsed.at === "string" ? parsed.at : "",
      sender: typeof parsed.sender === "string" ? parsed.sender : "",
      text,
    };
  } catch {
    return null;
  }
}

export function readInbox(root: string): readonly InboxMessage[] {
  const dir = join(root, "bus", "inbox");
  if (!existsSync(dir)) return [];
  const out: InboxMessage[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".json")) continue;
    try {
      const msg = parseInboxFile(name, readFileSync(join(dir, name), "utf8"));
      if (msg !== null) out.push(msg);
    } catch {
      // 单条读失败无所谓：下一轮还会再看到它
    }
  }
  return out.sort((a, b) => a.epochNs - b.epochNs);
}

/**
 * 宿主进程的 PATH 里通常没有 bash（实测：execFile("bash", …) 直接 ENOENT → exit 1、输出空，
 * 看起来像"租约没拿到"，其实是没找到解释器）。这里先按候选路径解析一次再复用。
 */
const BASH_CANDIDATES = [
  process.env["ACE_BASH"],
  "bash",
  "C:/Program Files/Git/bin/bash.exe",
  "C:/Program Files/Git/usr/bin/bash.exe",
] as const;

let bashBin: string | undefined;

function resolveBash(): string | undefined {
  if (bashBin !== undefined) return bashBin;
  for (const candidate of BASH_CANDIDATES) {
    if (candidate !== undefined && existsSync(candidate)) {
      bashBin = candidate;
      return bashBin;
    }
  }
  return undefined;
}

function runScript(
  root: string,
  script: "qqbus.sh" | "qq.sh" | "act.sh",
  args: readonly string[],
  timeoutMs = 30_000,
): Promise<{ code: number; out: string }> {
  const binary = resolveBash() ?? "bash";
  // 光找到 bash 还不够：它的 coreutils（sed/mkdir/date）在 usr/bin 下，
  // 而脚本里的 `#!/usr/bin/env bash` 也要能找到 bash。两者都靠 PATH 传进去。
  const binDir = binary.replace(/[\/][^\/]+$/, "");
  const path = `${binDir};${process.env["PATH"] ?? ""}`;
  const env = { ...process.env, PATH: path };
  return new Promise((resolve) => {
    execFile(
      binary,
      [script, ...args],
      { cwd: root, timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024, env },
      (err, stdout, stderr) => {
        const out = `${String(stdout)}${String(stderr)}`.trim();
        if (err !== null) {
          const code = typeof err.code === "number" ? err.code : 1;
          const why = out !== "" ? out : `spawn ${binary} ${script} 失败：${err.message}`;
          resolve({ code, out: why });
          return;
        }
        resolve({ code: 0, out });
      },
    );
  });
}

function runQQBus(root: string, args: readonly string[], timeoutMs = 30_000): Promise<{ code: number; out: string }> {
  return runScript(root, "qqbus.sh", args, timeoutMs);
}



/** 出站：先确保租约，再 send；失败把原因带回去，由 bridge 决定是否推进游标 */
export async function sendViaQQBus(root: string, text: string, tag: string, opts_log: (line: string) => void = () => {}): Promise<QQSendResult> {
  void tag; // 不再参与拼装：见下方注释（tag 前缀是对方看到的 "[ase] " 的来源）
  // qqbus 的 claim 成功时打印的是 `OWNER=<名字>`（不是 "CLAIMED"），失败时打印
  // `BUSY owner=… age=…s` 并以退出码 3 结束——这两个都按真实输出判定，不要猜。
  const claim = await runQQBus(root, ["claim", "ase-soul"]);
  let claimOut = claim.out.trim();
  if (/BUSY owner=/m.test(claimOut)) {
    // 旧的会话/手工 wait 可能还挂着别的 owner：桥是这条通道的既定主人，直接夺回。
    const forced = await runQQBus(root, ["claim", "ase-soul", "--force"]);
    claimOut = forced.out.trim();
  }
  if (!/^OWNER=/m.test(claimOut)) {
    const lines = claimOut.split("\n").filter((x) => x.trim() !== "");
    const why = lines.length > 0 ? lines[lines.length - 1] : `exit ${claim.code}`;
    return { ok: false, detail: `租约没拿到：${why}` };
  }
  // 注意：**不要**给 qqbus 传 --tag。`py/qqbus.py` 的 cmd_send 会把 tag 变成
  // "[ase] " 这样的前缀拼在正文前面（`body = "[%s] %s" % (tag, text)`），
  // 于是对方看到的每条消息都以 "[ase]" 开头。这里传裸文本，tag 只留给旧消息的回声识别。
  // 窗口最小化时 rect 返回 -32000（通道拿不到输入框坐标 → "rect invalid"）。
  // `qq.sh readmin` 只是**临时**还原、读完又最小化，所以这里自己还原并保持可见。
  const rect = await runScript(root, "qq.sh", ["rect"], 15_000);
  const rectOut = rect.out.trim();
  if (rectOut.startsWith("-32000") || rect.code !== 0) {
    const hwnd = Number(process.env["QQ_HWND"] ?? "460836");
    const focus = await runScript(root, "act.sh", [JSON.stringify({ op: "focus", hwnd })], 20_000);
    opts_log(`[qq] restore rect=${rectOut || rect.code} focus=${focus.out.slice(0, 120)}`);
    await new Promise((r) => setTimeout(r, 1_200));
  } else {
    opts_log(`[qq] rect ok ${rectOut}`);
  }
  let sent = await runQQBus(root, ["send", text]);
  if (/minimized|rect invalid/i.test(sent.out)) {
    await runScript(root, "qq.sh", ["readmin"], 20_000);
    sent = await runQQBus(root, ["send", text]);
  }
  if (sent.out.includes("SEND-LOCKED")) return { ok: false, detail: "输入框被别的进程占用" };
  if (sent.code !== 0 || !/sent/i.test(sent.out)) {
    return { ok: false, detail: `send 失败：${sent.out.split("\n").slice(-1)[0] ?? "no output"}` };
  }
  return { ok: true, detail: sent.out.split("\n").slice(-1)[0] ?? "sent" };
}

/**
 * 「发一条」的真实世界装配：鼠标键盘走宿主输入桥的文件队列，剪贴板借一次 PowerShell。
 *
 * 与旧的 `sendViaQQBus` 相比，这条路径不再是 3 个 bash 串行（各 300–500ms），
 * 而是「1 次 PowerShell + 4 次进程内文件往返」，并且不再依赖 PATH 里有 coreutils。
 */
function makeSendDeps(opts: HostQQOptions, log: (line: string) => void): SendDeps {
  const hwnd = opts.hwnd ?? Number(process.env["QQ_HWND"] ?? String(FALLBACK_HWND));
  const setClipboard = makeClipboardSetter({
    scriptPath: opts.clipsetScript ?? DEFAULT_CLIPSET,
    tmpDir: opts.tmpDir ?? join(opts.dataDir, "tmp"),
  });
  return {
    call: (cmd) => opsCall(opts.root, cmd),
    setClipboard,
    sleep: (ms) =>
      new Promise((resolve) => {
        setTimeout(resolve, ms);
      }),
    hwnd: () => hwnd,
    log,
  };
}

async function sendViaOps(deps: SendDeps, kind: ClipKind, payload: string): Promise<QQSendResult> {
  const outcome = await sendNow(deps, { kind, payload });
  if (!outcome.ok) return { ok: false, detail: outcome.error ?? "发送失败" };
  const at = outcome.point === undefined ? "" : ` at ${outcome.point.x},${outcome.point.y}`;
  return { ok: true, detail: `${kind} sent in ${outcome.ms}ms${at}` };
}

/**
 * 宿主侧能提供的全部 deps。**刻意不含 `dialogue` / `language` / `appraise`**：那三项是大脑实现，
 * 必须由装配点（`plugin/index.ts` / `autonomy/qq-runner.ts`）用端口适配器补上——
 * 宿主是工具层，不许 import 大脑实现去自己造端口。
 */
export type HostQQDeps = Omit<QQDeps, "dialogue" | "language" | "appraise">;

export function makeHostDeps(opts: HostQQOptions): HostQQDeps {
  const log = opts.log ?? ((): void => {});
  const sendDeps = makeSendDeps(opts, log);
  return {
    now: () => opts.clock.now(),
    localHour: () => opts.clock.localHour(),
    // 让通道去抓一次新消息：`wait 1 6` = 最多盯 6 秒，有新消息就落 inbox 并退出 0。
    // 这是 BUS.md 规定的**唯一**入站写者；桥当那个写者，别的会话就不要同时 wait。
    wake: async () => {
      await runQQBus(opts.root, ["wait", "1", "6"], 20_000);
    },
    readInbox: () => readInbox(opts.root),
    saveState: (state) => {
      saveQQState(opts.dataDir, opts.characterId, state);
    },
    send: (text) => sendViaOps(sendDeps, "text", text),
    sendContent: (target) => sendViaOps(sendDeps, target.kind, target.payload),
    readImage: async (path) => {
      try {
        const data = await readFile(path);
        const mediaType = sniffImageMediaType(data);
        if (mediaType === null) return null;
        return { data, mediaType, name: basename(path) };
      } catch {
        return null;
      }
    },
    generate: async ({ system, prompt, images }) => {
      if (opts.llm === undefined) throw new Error("宿主没有 llm 服务，无法生成台词");
      const selection = opts.defaultModel?.currentSelection();
      const provider = selection?.provider;
      const model = selection?.model;
      if (provider === undefined || model === undefined) throw new Error("拿不到默认模型（agentDefaultModel）");
      // 图片走宿主附件服务：模型看到的是 durable 引用，不是本地路径。
      let imageBlocks: LLMImageBlock[] = [];
      const attachments = typeof opts.attachments === "function" ? opts.attachments() : opts.attachments;
      if (images !== undefined && images.length > 0 && attachments === undefined) {
        log("[qq] 读到图片但宿主没有 attachments 服务，降级为纯文字");
      }
      if (images !== undefined && images.length > 0 && attachments !== undefined) {
        try {
          const refs = await attachments.saveImages(
            images.map((img) => ({
              data: img.data,
              mediaType: img.mediaType,
              ...(img.name === undefined ? {} : { name: img.name }),
            })),
          );
          imageBlocks = refs.map((attachment) => ({ type: "image" as const, attachment }));
        } catch (error) {
          log(`[qq] 图片附件入库失败，降级为纯文字：${String(error)}`);
        }
      }
      const content: (LLMTextBlock | LLMImageBlock)[] = [{ type: "text", text: prompt }, ...imageBlocks];
      const chunks = opts.llm.stream({
        provider,
        model,
        system,
        messages: [{ role: "user", content }],
        maxTokens: 600,
        temperature: 0.9,
        signal: AbortSignal.timeout(60_000),
      });
      // 两种取法都要留着：适配器可能只发 text-delta，也可能只在 block-end 给整块。
      // 优先用 block-end（它是最终块，不会被增量拼错），没有才退回 delta 拼接。
      let deltas = "";
      const blocks: string[] = [];
      for await (const chunk of chunks) {
        if (chunk.type === "text-delta" && typeof chunk.text === "string") deltas += chunk.text;
        else if (chunk.type === "block-end" && chunk.block?.type === "text") blocks.push(chunk.block.text ?? "");
      }
      const text = blocks.length > 0 ? blocks.join("") : deltas;
      log(
        `[qq] generated ${text.length} chars via ${provider}/${model}` +
          (imageBlocks.length === 0 ? "" : ` (images=${imageBlocks.length})`),
      );
      return text;
    },
  };
}
