/**
 * 「一个回合」的远程执行端（插件进程用，F272）。
 *
 * 为什么需要它：插件里的窗口/OneBot 桥在接待一条消息时会先 `turn()` 推状态。
 * 若让桥直接调本进程的 `rt.turn(...)`，插件就成了**第二个写者**——和审计
 * P0-4 要消灭的东西一模一样。所以装配点把桥的 `turn` 依赖换成这里的函数：
 * 投给自主进程的写通道，由唯一写者执行，结果再拿回来。
 *
 * 边界：
 * - 通道不可用 / 拒绝 → **抛错，不回退本进程写**（桥会记成 engine-failed，
 *   那是真话：「她现在没在自主进程那边」）。
 * - 成功后由调用方注入的 `reload()` 刷新本进程的只读视图（否则插件面板/工具
 *   读到的还是投递前那份状态）。
 * - 返回值曾是 JSON 往返过的 `TurnText`；可选字段为 undefined 时可能消失，
 *   这与「同一份数据」不冲突（桥只用字段值，不依赖 key 存在）。
 */
import type { TurnOptions, TurnRequest, TurnText } from "../ports/index.js";
import { callWriteChannel, type CallWriteChannelInput } from "./write-client.js";

/** 与 `callWriteChannel` 同形，但只要求本模块用到的字段——测试可以给假的 */
export interface ChannelTurnCallInput extends Pick<CallWriteChannelInput, "dataDir" | "characterId" | "op" | "payload"> {
  readonly timeoutMs?: number;
}

export interface ChannelTurnResult {
  readonly ok: boolean;
  readonly result?: unknown;
  readonly error?: string;
}

export interface ChannelTurnDeps {
  /** 数据根（与 daemon 同一个，`data/write-channel-<id>.json` 在它下面） */
  readonly dataDir: string;
  readonly characterId: string;
  /** 投递函数；缺省=真写通道客户端（测试给假的） */
  readonly call?: (input: ChannelTurnCallInput) => Promise<ChannelTurnResult>;
  /** 投递成功后刷新本进程只读视图；失败时不会被调用 */
  readonly reload: () => void;
}

/** 造一个「投给唯一写者」的 turn 函数，给 QQ 桥当 `deps.turn`。 */
export function makeChannelTurn(deps: ChannelTurnDeps): (req: TurnRequest, opts?: TurnOptions) => Promise<TurnText> {
  const call = deps.call ?? callWriteChannel;
  return async (req, opts) => {
    const result = await call({
      dataDir: deps.dataDir,
      characterId: deps.characterId,
      op: "turn",
      payload: { args: req, ...(opts === undefined ? {} : { opts }) },
    });
    if (!result.ok) {
      throw new Error(`写通道拒绝了这一回合：${result.error ?? "未知原因"}`);
    }
    deps.reload();
    return result.result as TurnText;
  };
}
