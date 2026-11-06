/**
 * 入站消息里「图片」这一部分的解析。
 *
 * 为什么需要它：QQ 的图片不会出现在拖选复制的纯文本里，只会以 HTML 片段
 * `<img src="file://C:\...\xxx.png" />` 的形式出现。`qq-ops/py/parse_msgs.py`
 * 把它转成 `[图片 xxx.png] <file:///C:/...>`，于是正文里同时带着「占位」和「本地路径」。
 *
 * 这一层只做两件事：把路径抽出来、把占位从正文里拿掉（模型不该看到 `<file://…>` 这种噪音）。
 * 真正读文件、判断是不是图片，在宿主侧（`host.ts`）做。
 */

export interface InboundImage {
  readonly name: string;
  /** 本地绝对路径，已统一成 `/` 分隔 */
  readonly path: string;
}

export interface ParsedInbound {
  /** 去掉图片标记后的正文 */
  readonly text: string;
  readonly images: readonly InboundImage[];
}

// 路径里可能有空格（"Tencent Files"），所以路径段只排除 `>`，不排除空白。
const IMAGE_MARK = /\[图片 ([^\]]{1,120})\] <file:\/\/\/([^>]{1,500})>/g;

/** 从正文里抽出图片路径，并把这些标记从文本中去掉。 */
export function parseInbound(text: string): ParsedInbound {
  const images: InboundImage[] = [];
  const stripped = text.replace(IMAGE_MARK, (_all, name: string, path: string) => {
    images.push({ name, path });
    return "";
  });
  // 去掉标记后常留下多余空格；保留换行结构。
  const cleaned = stripped
    .split("\n")
    .map((line) => line.replace(/[ \t]{2,}/g, " ").trim())
    .join("\n")
    .trim();
  return { text: cleaned, images };
}

/** 只有图片、没有文字时，给模型一句人话，别让它面对空消息。 */
export function imageNote(count: number): string {
  if (count <= 0) return "";
  return count === 1 ? "（对方发来一张图片）" : `（对方发来 ${count} 张图片）`;
}

/**
 * 图片标记存在、但字节没读出来时，给模型一句「别装作看见了」。
 *
 * 这条是拿真实事故换来的：2026-10-28 21:50 那条回复把AI助手的立绘说成
 * 「这朵花的耳朵怎么这么尖」，因为她只看到了 `[图片 …]` 占位、没拿到图，
 * 于是照着文件名猜了内容，还编了一句「既然拍都拍了，我就当是收到了」。
 * 两分钟后的下一条（图片真的读进来了）才说「这张……是我呀」。
 * 猜图 + 谎称收到，比「我没看到」伤害大得多。
 */
export function unreadImageNote(expected: number, loaded: number): string {
  if (expected <= 0) return "";
  const missing = expected - loaded;
  if (missing <= 0) return "";
  if (loaded === 0) {
    return "（对方发来图片，但图片没能读取。不要描述、不要猜图片内容，也不要声称你看到了；可以请对方用文字说说。）";
  }
  return `（对方发来 ${expected} 张图片，其中 ${missing} 张没能读取。别描述没读到的那几张。）`;
}
