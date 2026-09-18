# Draws FileTree's app mark and hands it to `tauri icon`.
#
# The mark is a treemap: a square carved into blocks of unequal size, which is
# what the app draws and what makes it recognisable as this app rather than as
# a generic folder. The palette is the app's own accent, so the icon and the UI
# agree.
#
# Checked in so the icon can be regenerated rather than being a binary nobody
# can edit. Run it, then `npx tauri icon assets/icon-source.png`.

$ErrorAction = 'Stop'
Add-Type -AssemblyName System.Drawing

$size = 1024
$out = Join-Path $PSScriptRoot '..\assets\icon-source.png'

function New-RoundedRect([float]$x, [float]$y, [float]$w, [float]$h, [float]$r) {
    $path = New-Object System.Drawing.Drawing2D.GraphicsPath
    $d = $r * 2
    $path.AddArc($x, $y, $d, $d, 180, 90)
    $path.AddArc($x + $w - $d, $y, $d, $d, 270, 90)
    $path.AddArc($x + $w - $d, $y + $h - $d, $d, $d, 0, 90)
    $path.AddArc($x, $y + $h - $d, $d, $d, 90, 90)
    $path.CloseFigure()
    return $path
}

function New-Gradient([int]$x1, [int]$y1, [int]$x2, [int]$y2, [string]$from, [string]$to) {
    $a = [System.Drawing.ColorTranslator]::FromHtml($from)
    $b = [System.Drawing.ColorTranslator]::FromHtml($to)
    return New-Object System.Drawing.Drawing2D.LinearGradientBrush(
        (New-Object System.Drawing.Point $x1, $y1),
        (New-Object System.Drawing.Point $x2, $y2), $a, $b)
}

$bitmap = New-Object System.Drawing.Bitmap $size, $size, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$g = [System.Drawing.Graphics]::FromImage($bitmap)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$g.Clear([System.Drawing.Color]::Transparent)

# The plate. Dark, so the blocks on it carry the colour.
$plate = New-RoundedRect 40 40 944 944 180
$plateBrush = New-Gradient 40 40 984 984 '#17395c' '#0a1a2b'
$g.FillPath($plateBrush, $plate)

# A hairline of light along the top edge, which is what stops a flat dark plate
# looking like a hole at small sizes.
$rim = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(38, 255, 255, 255)), 4
$g.DrawPath($rim, $plate)

# The treemap. Five blocks, deliberately unequal: an even grid would read as a
# spreadsheet, and the whole point of a treemap is that size means something.
$blocks = @(
    @{ x = 150; y = 150; w = 396; h = 480; c = '#4ca6f0' },
    @{ x = 578; y = 150; w = 296; h = 286; c = '#8fcdf8' },
    @{ x = 578; y = 468; w = 296; h = 162; c = '#2f7fc4' },
    @{ x = 150; y = 662; w = 264; h = 212; c = '#5ad6d8' },
    @{ x = 446; y = 662; w = 428; h = 212; c = '#2a5d8f' }
)
foreach ($b in $blocks) {
    $rect = New-RoundedRect $b.x $b.y $b.w $b.h 28
    $brush = New-Object System.Drawing.SolidBrush ([System.Drawing.ColorTranslator]::FromHtml($b.c))
    $g.FillPath($brush, $rect)
    $brush.Dispose()
    $rect.Dispose()
}

$g.Dispose()
$resolved = [System.IO.Path]::GetFullPath($out)
$bitmap.Save($resolved, [System.Drawing.Imaging.ImageFormat]::Png)
$bitmap.Dispose()
Write-Host "Wrote $resolved"
