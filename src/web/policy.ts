/**
 * 网页能力的准入策略（纯函数，无 IO）。
 *
 * 两条硬边界来自 spec v2.3 §6.1 / §8.3：
 *   1. **只许 https**、只许公网地址——学习循环拿到的是模型给的搜索结果，不能把
 *      `http://127.0.0.1:8080` / `http://169.254.169.254/…` 这类地址带进抓取阶段；
 *   2. **query 只能来自学习计划/热榜**——learning-plan、hot-topic 两个来源必须带
 *      `planKeyword` 且与 query 完全一致；自由文本只走 tool 面（W2 才接），且限长、
 *      单行、无控制字符。
 *
 * 失败一律抛 `WebPolicyError`，调用方按 `reason` 记日志（不带 query 原文）。
 */

import type { WebSearchRequest } from "./types.js";

export type WebPolicyReason =
  | "source"
  | "query-empty"
  | "query-len"
  | "query-control"
  | "plan-mismatch"
  | "count"
  | "url-protocol"
  | "url-port"
  | "url-credentials"
  | "url-host"
  | "url-private";

export class WebPolicyError extends Error {
  readonly reason: WebPolicyReason;

  constructor(reason: WebPolicyReason, message: string) {
    super(message);
    this.name = "WebPolicyError";
    this.reason = reason;
  }
}

/** 允许的来源（learning-plan/hot-topic 是学习路径；tool 是 W2 的交互面） */
export const WEB_QUERY_SOURCES: readonly WebSearchRequest["querySource"][] = ["learning-plan", "hot-topic", "tool"];

/** tool 面自由文本的长度上下限（spec §8.3） */
export const WEB_TOOL_QUERY_MIN = 2;
export const WEB_TOOL_QUERY_MAX = 120;

/** 单次搜索允许的条数上限（API 侧 count 的合理区间） */
const MAX_COUNT = 50;

/** 控制字符：换行/制表/零宽之外的 C0 控制符都算 */
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

const PRIVATE_HOSTNAMES = new Set([
  "localhost",
  "metadata.google.internal",
  "instance-data",
]);

/** 私网 / loopback / link-local / CGNAT 等 IPv4 段（命中即拒） */
const PRIVATE_IPV4 = [
  /^0\./,
  /^10\./,
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./,
  /^127\./,
  /^169\.254\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.0\.0\./,
  /^192\.168\./,
  /^198\.(1[89])\./,
  /^22[4-9]\./,
  /^23\d\./,
  /^24\d\./,
  /^25[0-5]\./,
];

const IPV4_LITERAL = /^\d{1,3}(?:\.\d{1,3}){3}$/;

function trimText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * 校验一次搜索请求；不合法直接抛（调用方捕获后按 `[web] fail kind=blocked` 记日志）。
 */
export function assertSearchRequest(req: WebSearchRequest): void {
  const source = req.querySource;
  if (!WEB_QUERY_SOURCES.includes(source)) {
    throw new WebPolicyError("source", `不允许的 querySource: ${String(source)}`);
  }
  const query = trimText(req.query);
  if (query.length === 0) throw new WebPolicyError("query-empty", "query 不能为空");
  if (CONTROL_CHARS.test(req.query)) throw new WebPolicyError("query-control", "query 不能含控制字符");

  if (source === "tool") {
    if (query.length < WEB_TOOL_QUERY_MIN || query.length > WEB_TOOL_QUERY_MAX) {
      throw new WebPolicyError("query-len", "query 长度必须在 2–120 之间");
    }
  } else {
    // 学习路径：query 必须就是这一拍的学习关键词本身，不许由调用方自由拼接
    const planKeyword = trimText(req.planKeyword);
    if (planKeyword.length === 0 || planKeyword !== query) {
      throw new WebPolicyError("plan-mismatch", "学习路径的 query 必须等于 planKeyword");
    }
  }

  if (!Number.isInteger(req.count) || req.count < 1 || req.count > MAX_COUNT) {
    throw new WebPolicyError("count", `count 必须是 1–${MAX_COUNT} 的整数`);
  }
}

/**
 * 校验抓取目标并返回解析后的 URL。只接受 `https://` + 公网主机名/IP。
 *
 * 重定向的逐跳校验在 `search.ts` 里做（URL 每跳都要再过一遍这个函数）。
 */
export function assertPublicUrl(input: string): URL {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new WebPolicyError("url-host", "URL 无法解析");
  }
  if (url.protocol !== "https:") {
    throw new WebPolicyError("url-protocol", "只允许 https://");
  }
  // F1（soul_web_fetch）：端口只允许缺省或 443；80/8080 等一律拒（逐跳重定向也走这里）。
  if (url.port !== "" && url.port !== "443") {
    throw new WebPolicyError("url-port", "只允许 443 端口");
  }
  if (url.username !== "" || url.password !== "") {
    throw new WebPolicyError("url-credentials", "URL 不能内嵌凭据");
  }
  const host = url.hostname.toLowerCase();
  if (host.length === 0) throw new WebPolicyError("url-host", "URL 缺主机名");
  if (host.startsWith("[")) {
    // IPv6 字面量：W1 一律拒（私网/回环都在这个形状里）
    throw new WebPolicyError("url-private", "不接受 IPv6 字面量");
  }
  if (PRIVATE_HOSTNAMES.has(host) || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) {
    throw new WebPolicyError("url-private", "不接受本机/内网主机名");
  }
  if (IPV4_LITERAL.test(host) && PRIVATE_IPV4.some((re) => re.test(host))) {
    throw new WebPolicyError("url-private", "不接受私网/回环/链路本地 IP");
  }
  return url;
}
