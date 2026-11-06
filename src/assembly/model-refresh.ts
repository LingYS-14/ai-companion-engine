/**
 * 模型凭据刷新（装配层，F282）。
 *
 * 她的内部言语（自言自语、洞见、巩固后的睡前一句）需要一个真模型；但 key 可能是她在跑
 * 之后才写好的，也可能被吊销。入口原来每拍都问一次，并写死在 `main()` 里。
 *
 * 这里只保留策略：没有凭据时每拍重查；有凭据时每 30 分钟复核一次（被吊销就诚实退回
 * 降级模板，而不是每拍打一次 401）。真正读写 `portDeps.llm` 的仍是调用方注入。
 */

import type { LlmConfig } from "../autonomy/llm.js";

/** 有凭据时的复核间隔（毫秒）。 */
export const MODEL_RECHECK_MS = 30 * 60_000;

export interface LoadedLlm {
  readonly config: LlmConfig;
  readonly keySource: string;
}

export interface ModelRefreshDeps {
  readonly log: (line: string) => void;
  /** 取当前时钟（注入以便测试） */
  readonly now: () => number;
  /** 读凭据；读不到返回 null；抛错按"这次没读到"处理 */
  readonly loadConfig: (env: NodeJS.ProcessEnv) => Promise<LoadedLlm | null>;
  /** 当前是否已有可用的 llm（null/undefined 表示没有） */
  readonly getLlm: () => LlmConfig | null | undefined;
  /** 装上或清掉 llm（null 表示退回降级模板） */
  readonly setLlm: (llm: LlmConfig | null) => void;
}

/**
 * 造一个 `refreshModel()`：可每拍调用，内部节流。
 */
export function createModelRefresher(
  deps: ModelRefreshDeps,
  env: NodeJS.ProcessEnv = process.env,
): () => Promise<void> {
  let lastKeyCheck = 0;
  return async () => {
    const nowMs = deps.now();
    const current = deps.getLlm();
    const had = current !== null && current !== undefined;
    if (had && nowMs - lastKeyCheck < MODEL_RECHECK_MS) return;
    lastKeyCheck = nowMs;
    let next: LlmConfig | null = null;
    let source: string | null = null;
    try {
      const again = await deps.loadConfig(env);
      if (again !== null) {
        next = again.config;
        source = again.keySource;
      }
    } catch {
      // 读凭据本身失败（例如 PowerShell 超时）：保持现状，下一拍再试。
      return;
    }
    if (!had && next !== null) {
      deps.setLlm(next);
      deps.log(`[autonomy] 检测到凭据（key=${String(source)}）：内部言语切到真模型`);
    } else if (had && next === null) {
      deps.setLlm(null);
      deps.log("[autonomy] 凭据不可用：内部言语退回降级模板");
    }
  };
}
