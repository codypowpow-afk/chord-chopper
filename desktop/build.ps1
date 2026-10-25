# Builds dist\ChordChopper.exe: a single offline exe with the web app and WebView2 SDK embedded.
# Needs only what ships with Windows (.NET Framework 4.x csc.exe). The WebView2 NuGet package
# is downloaded once into desktop\packages on first build.
#   powershell -ExecutionPolicy Bypass -File desktop\build.ps1
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$desk = $PSScriptRoot
$wv2Version = '1.0.4314.35'
$pkg = Join-Path $desk "packages\webview2.$wv2Version"

$csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path $csc)) { throw "csc.exe not found at $csc (.NET Framework 4.x is required)" }

if (-not (Test-Path $pkg)) {
    Write-Host "Downloading WebView2 SDK $wv2Version..."
    New-Item -ItemType Directory -Force $pkg | Out-Null
    $zip = Join-Path $pkg 'pkg.zip'
    Invoke-WebRequest "https://api.nuget.org/v3-flatcontainer/microsoft.web.webview2/$wv2Version/microsoft.web.webview2.$wv2Version.nupkg" -OutFile $zip
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    [IO.Compression.ZipFile]::ExtractToDirectory($zip, $pkg)
    Remove-Item $zip
}

# App icon: a 256px PNG wrapped in an .ico container. Chopped bars climbing like a chord.
$icon = Join-Path $desk 'icon.ico'
if (-not (Test-Path $icon)) {
    Add-Type -AssemblyName System.Drawing
    $bmp = New-Object Drawing.Bitmap 256, 256
    $g = [Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = 'AntiAlias'; $g.TextRenderingHint = 'AntiAliasGridFit'
    $g.Clear([Drawing.Color]::Transparent)
    $path = New-Object Drawing.Drawing2D.GraphicsPath
    $r = 48; $path.AddArc(8, 8, $r, $r, 180, 90); $path.AddArc(248 - $r, 8, $r, $r, 270, 90)
    $path.AddArc(248 - $r, 248 - $r, $r, $r, 0, 90); $path.AddArc(8, 248 - $r, $r, $r, 90, 90); $path.CloseFigure()
    $g.FillPath((New-Object Drawing.SolidBrush ([Drawing.Color]::FromArgb(31, 29, 39))), $path)
    $pink = New-Object Drawing.SolidBrush ([Drawing.Color]::FromArgb(255, 61, 139))
    $cyan = New-Object Drawing.SolidBrush ([Drawing.Color]::FromArgb(61, 224, 255))
    $ys = 196, 172, 148, 124, 172, 148, 124, 100
    for ($i = 0; $i -lt 8; $i++) {
        $x = 30 + $i * 25
        $g.FillRectangle($cyan, $x + 3, $ys[$i] - 3, 18, 16)
        $g.FillRectangle($pink, $x, $ys[$i], 18, 16)
    }
    $font = New-Object Drawing.Font 'Segoe UI Black', 70, ([Drawing.FontStyle]::Bold), ([Drawing.GraphicsUnit]::Pixel)
    $g.DrawString('CC', $font, [Drawing.Brushes]::White, 44, 4)
    $ms = New-Object IO.MemoryStream
    $bmp.Save($ms, [Drawing.Imaging.ImageFormat]::Png)
    $png = $ms.ToArray()
    $out = New-Object IO.MemoryStream
    $w = New-Object IO.BinaryWriter $out
    $w.Write([UInt16]0); $w.Write([UInt16]1); $w.Write([UInt16]1)
    $w.Write([Byte]0); $w.Write([Byte]0); $w.Write([Byte]0); $w.Write([Byte]0)
    $w.Write([UInt16]1); $w.Write([UInt16]32); $w.Write([UInt32]$png.Length); $w.Write([UInt32]22)
    $w.Write($png); $w.Flush()
    [IO.File]::WriteAllBytes($icon, $out.ToArray())
}

$lib = Join-Path $pkg 'lib\net462'
$core = Join-Path $lib 'Microsoft.Web.WebView2.Core.dll'
$winforms = Join-Path $lib 'Microsoft.Web.WebView2.WinForms.dll'
$loader = Join-Path $pkg 'runtimes\win-x64\native\WebView2Loader.dll'

$resources = @(
    "/resource:$core,lib/Microsoft.Web.WebView2.Core.dll",
    "/resource:$winforms,lib/Microsoft.Web.WebView2.WinForms.dll",
    "/resource:$loader,native/WebView2Loader.dll"
)
$web = @('index.html', 'style.css') + (Get-ChildItem (Join-Path $root 'js') -Filter *.js | ForEach-Object { 'js/' + $_.Name })
foreach ($f in $web) { $resources += "/resource:$(Join-Path $root $f),web/$f" }

$dist = Join-Path $root 'dist'
New-Item -ItemType Directory -Force $dist | Out-Null
$exe = Join-Path $dist 'ChordChopper.exe'

& $csc /nologo /target:winexe /platform:x64 /optimize+ "/out:$exe" "/win32icon:$icon" `
    /r:System.Windows.Forms.dll /r:System.Drawing.dll "/r:$core" "/r:$winforms" `
    $resources (Join-Path $desk 'ChordChopper.cs')
if ($LASTEXITCODE -ne 0) { throw "csc failed ($LASTEXITCODE)" }
Write-Host "Built $exe ($([math]::Round((Get-Item $exe).Length / 1MB, 2)) MB)"
