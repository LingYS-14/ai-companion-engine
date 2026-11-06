param([string]$Kind, [string]$Payload)
$ErrorActionPreference = "Stop"
try {
  Add-Type -AssemblyName System.Windows.Forms
  switch ($Kind) {
    'text' {
      $t = [System.IO.File]::ReadAllText($Payload, [System.Text.Encoding]::UTF8)
      Set-Clipboard -Value $t
    }
    'image' {
      Add-Type -AssemblyName System.Drawing
      $img = [System.Drawing.Image]::FromFile($Payload)
      try { [System.Windows.Forms.Clipboard]::SetImage($img) } finally { $img.Dispose() }
    }
    'file' { Set-Clipboard -Path $Payload }
    default { throw "unknown kind: $Kind" }
  }
  [Console]::Out.Write("ok")
} catch {
  [Console]::Error.Write($_.Exception.Message)
  exit 1
}
