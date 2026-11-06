<#
  桌面工具层的执行器（Windows 自带能力，不装第三方依赖）。
  所有动作都输出**一行 JSON** 到 stdout，失败也在 JSON 里写 error，不靠退出码传语义。
  动作：screen / windows / click / type / key
  授权不在这里判——由 src/desktop/desktop.ts 的 DesktopPolicy 判，脚本只管执行。
#>
param(
  [Parameter(Mandatory = $true)][ValidateSet('screen', 'windows', 'click', 'type', 'key')][string]$Action,
  [string]$OutPath = '',
  [int]$X = 0,
  [int]$Y = 0,
  [string]$Text = '',
  [string]$Keys = ''
)

$ErrorActionPreference = 'Stop'
# 中文窗口标题必须按 UTF-8 输出，否则 node 侧拿到的是乱码（实测：默认 OEM 代码页）。
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8
function Reply([hashtable]$obj) {
  $json = $obj | ConvertTo-Json -Compress -Depth 6
  [Console]::Out.WriteLine($json)
}

try {
  switch ($Action) {
    'screen' {
      if ($OutPath -eq '') { throw 'screen 需要 -OutPath' }
      Add-Type -AssemblyName System.Windows.Forms
      Add-Type -AssemblyName System.Drawing
      $vs = [System.Windows.Forms.SystemInformation]::VirtualScreen
      $bmp = New-Object System.Drawing.Bitmap($vs.Width, $vs.Height)
      $g = [System.Drawing.Graphics]::FromImage($bmp)
      $g.CopyFromScreen($vs.Left, $vs.Top, 0, 0, $bmp.Size)
      $dir = Split-Path -Parent $OutPath
      if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
      $bmp.Save($OutPath, [System.Drawing.Imaging.ImageFormat]::Png)
      $g.Dispose(); $bmp.Dispose()
      Reply @{ ok = $true; action = 'screen'; path = $OutPath; width = $vs.Width; height = $vs.Height }
    }
    'windows' {
      $list = @()
      foreach ($p in Get-Process) {
        if ($p.MainWindowTitle -ne '' -and $p.MainWindowTitle -ne $null) {
          $list += @{ pid = $p.Id; title = $p.MainWindowTitle }
        }
      }
      Reply @{ ok = $true; action = 'windows'; count = $list.Count; windows = $list }
    }
    'click' {
      Add-Type -Namespace AseInput -Name User32 -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
[DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, System.UIntPtr dwExtraInfo);
'@
      [AseInput.User32]::SetCursorPos($X, $Y) | Out-Null
      [AseInput.User32]::mouse_event(0x0002, 0, 0, 0, [System.UIntPtr]::Zero) | Out-Null
      [AseInput.User32]::mouse_event(0x0004, 0, 0, 0, [System.UIntPtr]::Zero) | Out-Null
      Reply @{ ok = $true; action = 'click'; x = $X; y = $Y }
    }
    'type' {
      Add-Type -AssemblyName System.Windows.Forms
      [System.Windows.Forms.SendKeys]::SendWait($Text)
      Reply @{ ok = $true; action = 'type'; chars = $Text.Length }
    }
    'key' {
      Add-Type -AssemblyName System.Windows.Forms
      [System.Windows.Forms.SendKeys]::SendWait($Keys)
      Reply @{ ok = $true; action = 'key'; keys = $Keys }
    }
    default { throw "不认识的动作：$Action" }
  }
} catch {
  Reply @{ ok = $false; action = $Action; error = $_.Exception.Message }
  exit 1
}
