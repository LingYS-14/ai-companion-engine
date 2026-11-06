/**
 * 从宿主插件的 `cordis.patch.yml` 里读出 OneBot 连接参数。
 *
 * 为什么读 YAML 而不是另存一份 JSON：连接参数（baseUrl/token/wsToken/peer）已经在
 * 插件配置里维护了，再抄一份就一定会漂。这里只解析 `onebot:` 这一段，
 * 是**窄解析器**（不做通用 YAML）：只认 key: value、引号、注释、缩进边界。
 * 解析不出必需字段就返回 null，调用方据此跳过「主动开口」，而不是猜。
 */

export interface OneBotConn {
  readonly baseUrl: string;
  readonly token: string;
  readonly peer: number;
  readonly dryRun: boolean;
  /** HTTP 用 baseUrl，WebSocket 收消息用 wsUrl（默认 ws://127.0.0.1:3001） */
  readonly wsUrl: string;
  /** WS 的 access_token；没单独配就沿用 token */
  readonly wsToken: string;
  /** 桥归谁：host（插件）或 autonomy（常驻进程）。缺省 host。 */
  readonly owner: "host" | "autonomy";
  /**
   * 她在对话里对他的称呼（纯文本标识，不是人格设定）。
   * P2.1（task-157）：可配 `qq.onebot.peerName`，缺省「用户」。
   */
  readonly peerName: string;
}

const DEFAULT_WS_URL = "ws://127.0.0.1:3001";
/** task-157：网页/QQ 聊天里的对方称呼缺省值（与 F326 前人格卡 speech 无关的 UI 标识）。 */
export const DEFAULT_PEER_NAME = "用户";

interface Split {
  readonly key: string;
  readonly value: string;
  readonly indent: number;
}

function splitLine(line: string): Split | null {
  const indent = line.length - line.trimStart().length;
  const body = line.trim();
  if (body === "" || body.startsWith("#") || body.startsWith("- ")) return null;
  const at = body.indexOf(":");
  if (at <= 0) return null;
  return { key: body.slice(0, at).trim(), value: body.slice(at + 1).trim(), indent };
}

/** 去掉值里的行内注释（引号内的 # 不算注释）与包裹引号 */
function clean(value: string): string {
  let out = "";
  let quote = "";
  for (const ch of value) {
    if (quote === "") {
      if (ch === "#") break;
      if (ch === '"' || ch === "'") quote = ch;
      out += ch;
    } else if (ch === quote) {
      quote = "";
      out += ch;
    } else {
      out += ch;
    }
  }
  out = out.trim();
  if (out.length >= 2 && ((out.startsWith('"') && out.endsWith('"')) || (out.startsWith("'") && out.endsWith("'")))) {
    out = out.slice(1, -1);
  }
  return out;
}

export function readOneBotConn(yaml: string): OneBotConn | null {
  const lines = yaml.split(/\r?\n/);
  const head = lines.findIndex((line) => {
    const s = splitLine(line);
    return s !== null && s.key === "onebot";
  });
  if (head < 0) return null;
  const headSplit = splitLine(lines[head] ?? "");
  const indent = headSplit === null ? 0 : headSplit.indent;
  const values = new Map<string, string>();
  for (let i = head + 1; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    if (line.trim() === "" || line.trim().startsWith("#")) continue;
    const here = line.length - line.trimStart().length;
    if (here <= indent) break;
    const s = splitLine(line);
    if (s === null) continue;
    values.set(s.key, clean(s.value));
  }
  const baseUrl = values.get("baseUrl") ?? "";
  const token = values.get("token") ?? "";
  const peer = Number(values.get("peer") ?? "");
  if (!baseUrl.startsWith("http") || token === "" || !Number.isInteger(peer) || peer <= 0) return null;
  const wsUrl = values.get("wsUrl") ?? DEFAULT_WS_URL;
  const wsToken = values.get("wsToken") ?? token;
  const owner = values.get("owner") === "autonomy" ? "autonomy" : "host";
  const peerName = (values.get("peerName") ?? "").trim() || DEFAULT_PEER_NAME;
  return { baseUrl, token, peer, dryRun: values.get("dryRun") === "true", wsUrl, wsToken, owner, peerName };
}
