param(
  [string]$Source = (Join-Path $PSScriptRoot "..\public\brand\origin-mark-256.png"),
  [string]$OutDir = (Join-Path $PSScriptRoot "..\desktop\assets")
)

Add-Type -AssemblyName System.Drawing

$sourcePath = (Resolve-Path $Source).Path
$outDirPath = (Resolve-Path $OutDir).Path
$outPath = Join-Path $outDirPath "icon.ico"
$sizes = @(16, 24, 32, 48, 64, 128, 256)
$pngs = New-Object System.Collections.Generic.List[byte[]]

$sourceImage = [System.Drawing.Image]::FromFile($sourcePath)
try {
  foreach ($size in $sizes) {
    $bmp = New-Object System.Drawing.Bitmap $size, $size
    try {
      $g = [System.Drawing.Graphics]::FromImage($bmp)
      try {
        $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
        $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
        $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
        $g.Clear([System.Drawing.Color]::Transparent)
        $g.DrawImage($sourceImage, 0, 0, $size, $size)
      } finally { $g.Dispose() }
      $ms = New-Object System.IO.MemoryStream
      try {
        $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
        $pngs.Add($ms.ToArray())
      } finally { $ms.Dispose() }
    } finally { $bmp.Dispose() }
  }
} finally {
  $sourceImage.Dispose()
}

$fs = [System.IO.File]::Create($outPath)
$bw = New-Object System.IO.BinaryWriter($fs)
try {
  $bw.Write([UInt16]0)
  $bw.Write([UInt16]1)
  $bw.Write([UInt16]$sizes.Count)
  $offset = 6 + (16 * $sizes.Count)
  for ($i = 0; $i -lt $sizes.Count; $i++) {
    $size = $sizes[$i]
    $dim = if ($size -ge 256) { 0 } else { $size }
    $bw.Write([byte]$dim)
    $bw.Write([byte]$dim)
    $bw.Write([byte]0)
    $bw.Write([byte]0)
    $bw.Write([UInt16]1)
    $bw.Write([UInt16]32)
    $bw.Write([UInt32]$pngs[$i].Length)
    $bw.Write([UInt32]$offset)
    $offset += $pngs[$i].Length
  }
  foreach ($png in $pngs) { $bw.Write($png) }
} finally {
  $bw.Dispose()
  $fs.Dispose()
}

Copy-Item -LiteralPath $outPath -Destination (Join-Path $PSScriptRoot "..\src\app\favicon.ico") -Force
Write-Output ("Wrote " + $outPath + " (" + (Get-Item $outPath).Length + " bytes)")
