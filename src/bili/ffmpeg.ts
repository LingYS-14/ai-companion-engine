/**
 * ffmpeg 可执行文件定位。
 *
 * 为什么不直接写 "ffmpeg"：她的常驻进程由**计划任务**拉起，进程环境是任务计划程序的
 * 环境，不一定和交互 shell 的 PATH 一样。取帧失败是**静默**的（cropTile 返回 false），
 * 所以「PATH 里没有 ffmpeg」会表现成「拼图下载了几十张、帧目录却是空的」——
 * F138 就是踩在这里。定位规则：
 *
 *   1. `ACE_FFMPEG` 环境变量（用户显式指定，原样返回，不做存在性检查）；
 *   2. `%USERPROFILE%` 或 `C:\Users\<USERNAME>` 下的 `bin\ffmpeg.exe`（存在才用）；
 *   3. `"ffmpeg"`（最后的兜底：让 PATH 去找，找不到就是找不到）。
 *
 * 纯函数：`env` 与 `exists` 都从外面给，测试可以造任意环境。
 */
export interface ResolveFfmpegOptions {
  readonly env: { readonly ACE_FFMPEG?: string | undefined; readonly USERPROFILE?: string | undefined; readonly USERNAME?: string | undefined };
  readonly exists: (path: string) => boolean;
}

const FFMPEG_EXE = "ffmpeg.exe";

export function resolveFfmpegPath(opts: ResolveFfmpegOptions): string {
  const explicit = (opts.env.ACE_FFMPEG ?? "").trim();
  if (explicit !== "") return explicit;

  const home = (opts.env.USERPROFILE ?? "").trim();
  const user = (opts.env.USERNAME ?? "").trim();
  const roots: string[] = [];
  if (home !== "") roots.push(home);
  if (user !== "") roots.push(`C:\\Users\\${user}`);

  for (const root of roots) {
    const candidate = `${root}\\bin\\${FFMPEG_EXE}`;
    if (opts.exists(candidate)) return candidate;
  }
  return "ffmpeg";
}
