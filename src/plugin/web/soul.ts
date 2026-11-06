/**
 * 工作台（P4-4 P1）：工作台静态页的三条只读路由。
 *
 * 为什么页面不写在这里：R4 文本规则管的是**结构位置**——装配点/工具层一旦开始
 * 拼 HTML，边界检查就会出现盲区。所以这里只做"读文件 + 设头 + 写回"，页面内容
 * 全部住在包根的 `lib/soul/`（与 `lib/client.js` 同一层，刷新即见，不需要构建）。
 *
 * 路由（宿主 webServer 只认 exact）：
 *   GET /soul                                  -> index.html
 *   GET /plugins/ai-companion-engine/soul.css    -> soul.css
 *   GET /plugins/ai-companion-engine/soul.js     -> soul.js
 *
 * P1 口径：只读静态资源，不碰状态、不写文件、不代她推进。
 */

import { readFileSync } from "node:fs";

import type { RouteHandler, WebResponseLike } from "./handlers.js";

/** 工作台首页（同源 iframe 的 src） */
export const SOUL_PAGE_PATH = "/soul";
/** 工作台样式 */
export const SOUL_CSS_PATH = "/plugins/ai-companion-engine/soul.css";
/** 工作台脚本 */
export const SOUL_JS_PATH = "/plugins/ai-companion-engine/soul.js";

/**
 * 包根 `lib/soul/` 的相对位置。
 *
 * 源码在 `src/plugin/web/`、构建产物在 `dist/plugin/web/`，两者到包根都是上三级；
 * 这样 src 直跑（vitest）与 dist 运行（插件）指向同一个目录。
 */
const SOUL_DIR = new URL("../../../lib/soul/", import.meta.url);

const COMMON_HEADERS: Readonly<Record<string, string>> = {
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "referrer-policy": "same-origin",
};

function send(res: WebResponseLike, status: number, contentType: string, body: string): void {
  res.writeHead(status, { "content-type": contentType, ...COMMON_HEADERS });
  res.end(body);
}

/** 读一个工作台静态文件；缺失/读失败返回 null（由调用方转 404，不抛）。 */
function readSoulFile(name: string): string | null {
  try {
    return readFileSync(new URL(name, SOUL_DIR), "utf8");
  } catch {
    return null;
  }
}

/** GET /soul：工作台首页。 */
export function createSoulPageHandler(): RouteHandler {
  return (_req, res) => {
    const html = readSoulFile("index.html");
    if (html === null) {
      send(res, 404, "text/plain; charset=utf-8", "soul page missing");
      return;
    }
    send(res, 200, "text/html; charset=utf-8", html);
  };
}

/**
 * GET 一个静态资源。
 *
 * @param fileName 相对 `lib/soul/` 的文件名（只允许单段文件名，防止路径穿越）
 * @param contentType 响应的 content-type
 */
export function createSoulAssetHandler(fileName: string, contentType: string): RouteHandler {
  // 静态资源只允许单段文件名：不接受 "/"、".."、绝对路径——路由本身是 exact，
  // 但 handler 也不能给以后复用的人留一个能读任意文件的入口。
  const safe = !fileName.includes("/") && !fileName.includes("\\") && !fileName.includes("..");
  return (_req, res) => {
    if (!safe) {
      send(res, 404, "text/plain; charset=utf-8", `${fileName} missing`);
      return;
    }
    const body = readSoulFile(fileName);
    if (body === null) {
      send(res, 404, "text/plain; charset=utf-8", `${fileName} missing`);
      return;
    }
    send(res, 200, contentType, body);
  };
}
