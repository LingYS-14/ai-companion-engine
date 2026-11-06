# 在场信号探针（DSH 方向一）：读 Windows 的"最后一次键鼠输入"，输出一行 JSON。
#
# 为什么由装配层调用、而不是她自己去猜：GetLastInputInfo 是操作系统事实，不依赖
# 她的记忆或 DSH 是否连着。她只拿这个事实做判断（"他在电脑前/他离开了"），
# 不拿它当"他愿意说话"——这是在忙还是在，由她按情境自己判断（用户 m09313）。
#
# 输出：{"idleSeconds":<int>,"atMs":<int>}（单位秒/毫秒时间戳，UTC epoch）
# 失败：退出码 1，stderr 一行原因（调用方必须把它当"没有信号"，不是"他不在"）。
#
# 注意：本文件必须保持纯 ASCII（PowerShell 5.1 按 ANSI 读 -File 脚本）且不写 BOM。
$ErrorActionPreference = "Stop"

$signature = @'
using System;
using System.Runtime.InteropServices;
public class SoulIdleProbe {
  [StructLayout(LayoutKind.Sequential)] public struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }
  [DllImport("user32.dll")] public static extern bool GetLastInputInfo(ref LASTINPUTINFO plii);
  public static uint IdleMs() {
    LASTINPUTINFO info = new LASTINPUTINFO();
    info.cbSize = (uint)Marshal.SizeOf(info);
    if (!GetLastInputInfo(ref info)) return 0;
    return ((uint)Environment.TickCount - info.dwTime);
  }
}
'@

try {
  Add-Type -TypeDefinition $signature -ErrorAction Stop
  $idleMs = [SoulIdleProbe]::IdleMs()
  $atMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  $idleSeconds = [int][Math]::Floor($idleMs / 1000)
  Write-Output ("{{""idleSeconds"":{0},""atMs"":{1}}}" -f $idleSeconds, $atMs)
} catch {
  [Console]::Error.WriteLine("idle-probe: " + $_.Exception.Message)
  exit 1
}
