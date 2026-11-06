/**
 * 她这一拍能感知到的「外面的事实」（装配层，F291）。
 *
 * 原来 `scripts/autonomy/main.mjs` 里并排躺着 `lastContactMinutes` / `probeInputActivity` /
 * `readSituationSignals` 三个局部函数：读 QQ 状态、读 DSH 在场信号、退到操作系统键鼠事实、
 * 拼成 `SituationSignals`。它们是**只读的装配逻辑**，但写在入口里既不能单测，也让入口继续变厚。
 *
 * 边界（重要）：
 * - 这里只收集事实，不下判断。"他在不在 / 该不该说"由大脑侧的 situation 与意向引擎决定。
 * - 探针失败返回 null：不知道就当不知道，绝不拿"没测到"冒充"他不在"（F247 的教训）。
 * - 输入探针可注入：测试不该真的去起 PowerShell；线上由入口用默认实现。
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { lastContactMinutesFrom, lastContactMs } from "../autonomy/contact.js";
import { parseInputActivity, presenceFromActivity } from "../autonomy/input-activity.js";
import type { InputActivity, PresenceSignal } from "../autonomy/input-activity.js";
import { presenceOf } from "../orchestrator/intent/situation-note.js";
import { localPartsOf } from "./main-config.js";

export interface SituationSignals {
  readonly nowMs: number;
  readonly localHour: number;
  readonly sinceLastContactMin: number;
  readonly lastProactiveAtMs: number | null;
  /** F246：距上一次主动开口多少分钟（没有记录给 null，不按 0 算） */
  readonly minutesSinceLastProactive: number | null;
  readonly proactiveSinceLastContact: number;
  /**
   * 只算「他发来的消息」的时间（onebotLastEventAt），不含她自己的回复时间。
   *
   * 为什么单独记：`lastContactMs` 取 `max(onebotLastEventAt, lastReplyAt)`，而 lastReplyAt
   * 是她回出一条消息时写的（onebot-bridge 的 recordInbound）——她刚回过一句，接触时间
   * 就变成"刚刚"，把它当「他上一次说话」会说出假事实（监督者 2026-11-01 复核 blocking）。
   * 没有他的消息记录时给 null：不知道就不猜。
   */
  readonly lastPeerEventAtMs: number | null;
  /** F246/P1：距他上一次发来消息多少分钟（peer-only；无记录给 null，不按 0 算） */
  readonly sinceLastPeerMsgMin: number | null;
  /** 他上一次发来消息之后，她主动开口过几次（没被回应的次数；同一文件口径，peer-only） */
  readonly proactiveSinceLastPeerEvent: number;
  readonly presence: PresenceSignal | null;
  /** F247：原始键鼠事实（只进日志，不进提示词；进提示词的是判断后的 presence） */
  readonly inputActivity: InputActivity | null;
}

export interface SituationSignalDeps {
  readonly dataDir: string;
  readonly characterId: string;
  /** 仓库/运行时根：输入探针脚本在 <repo>/tools/presence/activity.ps1 */
  readonly repo: string;
  readonly nowMs: number;
  /** 时区偏移（分钟，东八区=480）：本地小时要按北京时间算，入口传同一个值给所有地方 */
  readonly tzOffsetMinutes: number;
  /** 键鼠探针；默认起 PowerShell。测试注入，避免真去开进程。 */
  readonly probeInput?: () => InputActivity | null;
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

/**
 * A1：真实来往时间。优先读 QQ 状态文件（收/回消息都会写），读不到才退回心跳文件。
 * 心跳每 5 分钟被重写，拿它算"上次聊天多久前"永远是 0–5 分钟（审计 P0-2）。
 */
export function lastContactMinutes(deps: Pick<SituationSignalDeps, "dataDir" | "characterId" | "nowMs">): number {
  const raw = readJson(join(deps.dataDir, `qq-${deps.characterId}.json`));
  const minutes = raw === null ? null : lastContactMinutesFrom(raw, deps.nowMs);
  if (minutes !== null) return minutes;
  const state = readJson(join(deps.dataDir, `state-${deps.characterId}.json`));
  const at =
    state !== null && typeof state === "object" && !Array.isArray(state)
      ? (state as Record<string, unknown>)["updatedAt"]
      : undefined;
  if (typeof at !== "number" || !Number.isFinite(at)) return 0;
  return Math.max(0, Math.floor((deps.nowMs - at) / 60_000));
}

/** F247：操作系统事实「最后一次键鼠输入」。失败/超时返回 null（不知道，不猜）。 */
export function probeInputActivity(repo: string): InputActivity | null {
  try {
    const raw = execFileSync(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(repo, "tools", "presence", "activity.ps1")],
      { encoding: "utf8", timeout: 8000, windowsHide: true },
    );
    return parseInputActivity(JSON.parse(String(raw).trim()));
  } catch {
    return null;
  }
}

export function readSituationSignals(deps: SituationSignalDeps): SituationSignals {
  const raw = readJson(join(deps.dataDir, `qq-${deps.characterId}.json`));
  const boxed = raw !== null && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
  const lastContact = boxed === null ? null : lastContactMs(boxed);
  let proactiveSinceLastContact = 0;
  if (boxed !== null && Array.isArray(boxed["proactiveAt"])) {
    for (const at of boxed["proactiveAt"] as readonly unknown[]) {
      if (typeof at === "number" && Number.isFinite(at) && at > (lastContact ?? 0)) proactiveSinceLastContact += 1;
    }
  }
  // peer-only：只数他发来的消息时间（不含她的回复），见接口注释。
  const lastPeerEventAtMs =
    boxed !== null && typeof boxed["onebotLastEventAt"] === "number" && Number.isFinite(boxed["onebotLastEventAt"])
      ? (boxed["onebotLastEventAt"] as number)
      : null;
  let proactiveSinceLastPeerEvent = 0;
  if (boxed !== null && Array.isArray(boxed["proactiveAt"])) {
    for (const at of boxed["proactiveAt"] as readonly unknown[]) {
      if (typeof at === "number" && Number.isFinite(at) && at > (lastPeerEventAtMs ?? 0)) proactiveSinceLastPeerEvent += 1;
    }
  }
  let presence: PresenceSignal | null = null;
  const presenceRaw = readJson(join(deps.dataDir, `presence-${deps.characterId}.json`));
  if (presenceRaw !== null) {
    try {
      presence = presenceOf(presenceRaw, deps.nowMs);
    } catch {
      presence = null; // DSH 写过但形状不对：不知道就当不知道
    }
  }
  // F247：DSH 侧的手工信号优先（那是"人这一侧"的判断）；没有新鲜信号时，
  // 退回到操作系统事实（键鼠输入），它比"他多久没说话"更接近"他在不在"。
  const probe = deps.probeInput ?? (() => probeInputActivity(deps.repo));
  const inputActivity = probe();
  if (presence === null && inputActivity !== null) presence = presenceFromActivity(inputActivity, deps.nowMs);
  const lastProactiveAtMs =
    boxed !== null && Number.isFinite(boxed["lastProactiveAt"]) ? (boxed["lastProactiveAt"] as number) : null;
  return {
    nowMs: deps.nowMs,
    // 本地小时必须与入口/health 同一口径（F238 的教训：各算各的就是两套账）。
    localHour: localPartsOf(deps.nowMs, deps.tzOffsetMinutes).localHour,
    sinceLastContactMin: lastContactMinutes(deps),
    lastProactiveAtMs,
    minutesSinceLastProactive:
      lastProactiveAtMs === null ? null : Math.max(0, Math.floor((deps.nowMs - lastProactiveAtMs) / 60_000)),
    proactiveSinceLastContact,
    lastPeerEventAtMs,
    sinceLastPeerMsgMin:
      lastPeerEventAtMs === null ? null : Math.max(0, Math.floor((deps.nowMs - lastPeerEventAtMs) / 60_000)),
    proactiveSinceLastPeerEvent,
    presence,
    inputActivity,
  };
}
