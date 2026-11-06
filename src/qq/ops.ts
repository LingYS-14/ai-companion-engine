import { readFileSync, unlinkSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";

/**
 * 与宿主输入桥（`@local/dsh-host-exec10`）的**直接**文件队列通信。
 *
 * 之前所有动作都绕道 `bash qq.sh …`：一次发送要起 3 个 bash（claim/send/rect），
 * 每个 ~300–500ms，还要靠 PATH 里恰好有 coreutils。桥本身就是个 150ms 轮询的
 * 文件队列，何必再包一层 shell。这里直接写 `q/in/<name>.json`、读 `q/out/<name>.json`。
 *
 * 协议（读自 `dsh-host-exec10/index.js`）：
 *   - 请求体是**整个 JSON 对象**，`op` 字段选动作；
 *   - 桥每 150ms 扫一次 `q/in/*.json`，处理完删请求、写 `q/out/<name>.json`；
 *   - 应答形如 `{ "ok": true, "result": … }` 或 `{ "ok": false, "error": "…" }`。
 */
export interface OpsResult {
  readonly ok: boolean;
  readonly result?: Record<string, unknown>;
  readonly error?: string;
  /** 从发出到收到应答的毫秒数（用于性能对照） */
  readonly ms: number;
}

let seq = 0;

export async function opsCall(
  root: string,
  cmd: Record<string, unknown>,
  timeoutMs = 4_000,
): Promise<OpsResult> {
  // 用单调时钟量延迟：这里不该关心墙钟，CI 的 writers 闸也禁止本层读系统时间
  const started = performance.now();
  const dirIn = join(root, "q", "in");
  const dirOut = join(root, "q", "out");
  if (!existsSync(dirIn)) mkdirSync(dirIn, { recursive: true });
  if (!existsSync(dirOut)) mkdirSync(dirOut, { recursive: true });

  seq += 1;
  const name = `ase_${seq}_${Math.floor(Math.random() * 1e9).toString(36)}`;
  const inPath = join(dirIn, `${name}.json`);
  const outPath = join(dirOut, `${name}.json`);
  writeFileSync(inPath, JSON.stringify(cmd), "utf8");

  const deadline = started + timeoutMs;
  // 25ms 一档比桥的 150ms 轮询细，平均多等 ~75ms；仍然远快于再起一个 bash。
  while (performance.now() < deadline) {
    try {
      const raw = readFileSync(outPath, "utf8");
      try {
        unlinkSync(outPath);
      } catch {
        // 桥可能已经删了，忽略
      }
      const parsed = JSON.parse(raw) as { ok?: boolean; result?: Record<string, unknown>; error?: string };
      return {
        ok: parsed.ok === true,
        ...(parsed.result === undefined ? {} : { result: parsed.result }),
        ...(parsed.error === undefined ? {} : { error: parsed.error }),
        ms: Math.round(performance.now() - started),
      };
    } catch {
      // 还没有应答：继续等
    }
    await sleep(25);
  }
  try {
    unlinkSync(inPath);
  } catch {
    // 桥可能已经消费掉了
  }
  return { ok: false, error: `bridge timeout after ${timeoutMs}ms`, ms: Math.round(performance.now() - started) };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
