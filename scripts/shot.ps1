<#
.SYNOPSIS
  Render a FISH document on Windows with nothing but a browser already on the machine.
  No npm, no Node, no Playwright: Edge/Chrome --headless is part of Windows.

.EXAMPLE
  .\shot.ps1 design.fish.html out.png
  .\shot.ps1 design.fish.html out.png -Scale 2
  .\shot.ps1 design.fish.html out.png -Element hero-title
  .\shot.ps1 design.fish.html out.png -Debug
#>

[CmdletBinding()]
param (
  [Parameter(Position = 0, Mandatory = $true)]
  [string]$Doc,

  [Parameter(Position = 1, Mandatory = $true)]
  [string]$Out,

  [Parameter()]
  [double]$Scale = 1.0,

  [Parameter()]
  [string]$Element = "",

  [Parameter()]
  [switch]$DebugMode
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path -Path $Doc -PathType Leaf)) {
  Write-Error "no such file: $Doc"
  exit 2
}

function Find-Browser {
  $candidates = @(
    "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
    "${env:ProgramFiles}\Microsoft\Edge\Application\msedge.exe",
    "${env:ProgramFiles}\Google\Chrome\Application\chrome.exe",
    "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
    "${env:LOCALAPPDATA}\Google\Chrome\Application\chrome.exe",
    "${env:LOCALAPPDATA}\Microsoft\Edge\Application\msedge.exe"
  )

  if ($env:FISH_BROWSER -and (Test-Path -Path $env:FISH_BROWSER)) {
    return $env:FISH_BROWSER
  }

  foreach ($c in $candidates) {
    if ($c -and (Test-Path -Path $c)) {
      return $c
    }
  }

  $cmd = Get-Command "msedge.exe", "chrome.exe" -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($cmd) { return $cmd.Source }

  return $null
}

$browser = Find-Browser
if (-not $browser) {
  Write-Host "No Edge or Chrome found on this Windows machine. Point FISH_BROWSER environment variable to one." -ForegroundColor Red
  exit 2
}

$absDoc = (Resolve-Path $Doc).Path
$fileUrl = [System.Uri]::new($absDoc).AbsoluteUri
# out.report.json, never out.json: a design authored as design.json beside the
# shell already owns the bare name, and the report would take it.
$jsonOut = [System.IO.Path]::Combine([System.IO.Path]::GetDirectoryName($Out), [System.IO.Path]::GetFileNameWithoutExtension($Out) + ".report.json")
if ([System.IO.Path]::GetFullPath($jsonOut) -eq $absDoc) {
  Write-Error "refusing to write the report over the input document: $jsonOut"
  exit 2
}

$tmpDir = Join-Path ([System.IO.Path]::GetTempPath()) ("fish-shot-" + [System.Guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $tmpDir -Force | Out-Null
$profileDir = Join-Path $tmpDir "profile"

try {
  $chromeFlags = @(
    "--headless=new",
    "--disable-gpu",
    "--hide-scrollbars",
    "--user-data-dir=$profileDir"
  )

  # Fast-path: When capturing the whole document (no -Element specified),
  # statically extract canvas dimensions from <script id="design-doc">.
  # This avoids launching a headless browser twice and eliminates Preact mount lag on large files.
  $staticWindow = $null
  if (-not $Element) {
    try {
      $fileHead = Get-Content -Path $Doc -TotalCount 2000 -Raw -Encoding utf8
      $scriptMatch = [regex]::Match($fileHead, '<script id="design-doc"[^>]*>(.*?)</script>', [System.Text.RegularExpressions.RegexOptions]::Singleline)
      if ($scriptMatch.Success) {
        $inner = $scriptMatch.Groups[1].Value
        $canvasMatch = [regex]::Match($inner, '"canvas"\s*:\s*\{([^}]*)\}', [System.Text.RegularExpressions.RegexOptions]::Singleline)
        if ($canvasMatch.Success) {
          $canvasBody = $canvasMatch.Groups[1].Value
          $wMatch = [regex]::Match($canvasBody, '"width"\s*:\s*(\d+)')
          $hMatch = [regex]::Match($canvasBody, '"height"\s*:\s*(\d+)')
          if ($wMatch.Success -and $hMatch.Success) {
            $staticWindow = "$($wMatch.Groups[1].Value)x$($hMatch.Groups[1].Value)"
          }
        }
      }
    } catch {
      $staticWindow = $null
    }
  }

  $window = ""
  $origin = ""

  if ($staticWindow) {
    $window = $staticWindow
    $wVal = $window.Split('x')[0]
    $hVal = $window.Split('x')[1]
    $synthReport = "{`"ok`":true,`"canvas`":{`"width`":$wVal,`"height`":$hVal},`"window`":`"$window`",`"expected`":`"$([math]::Round($wVal * $Scale))x$([math]::Round($hVal * $Scale))`",`"scale`":$Scale}"
    Set-Content -Path $jsonOut -Value $synthReport -Encoding utf8
  } else {
    # Pass 1: dump DOM to read fish-report for elements or fallback
    $reportQuery = "view=canvas&report=1&scale=$Scale"
    if ($Element) {
      $reportQuery += "&element=$Element"
    }
    $pass1Url = "$fileUrl`?$reportQuery"

    if ($DebugMode) {
      Write-Host "[DEBUG] dump-dom: $browser $chromeFlags --virtual-time-budget=2000 --window-size=1440,900 --dump-dom `"$pass1Url`""
    }

    $p1Args = $chromeFlags + @("--virtual-time-budget=2000", "--window-size=1440,900", "--dump-dom", $pass1Url)
    $p1Output = & $browser $p1Args 2>$null | Out-String

    if (-not $p1Output) {
      Write-Error "browser exited without dumping DOM"
      exit 1
    }

    $match = [regex]::Match($p1Output, '<script id="fish-report" type="application/json">(.*?)</script>', [System.Text.RegularExpressions.RegexOptions]::Singleline)
    if (-not $match.Success) {
      Write-Error "this document's shell predates ?report — rebuild it from dist/index.html"
      exit 1
    }

    $reportJson = $match.Groups[1].Value.Trim()
    Set-Content -Path $jsonOut -Value $reportJson -Encoding utf8

    $reportObj = $null
    try {
      $reportObj = ConvertFrom-Json $reportJson
    } catch {
      Write-Error "failed to parse report JSON"
      exit 1
    }

    if ($reportObj.ok -eq $false) {
      Write-Host "report failed: $reportJson" -ForegroundColor Red
      exit 1
    }

    $window = if ($reportObj.window) { $reportObj.window } else { "1440x900" }
    $origin = if ($reportObj.origin) { $reportObj.origin } else { "" }
  }

  # Pass 2: screenshot
  $pass2Query = "view=canvas"
  if ($origin) {
    $pass2Query += "&origin=$origin"
  }
  $pass2Url = "$fileUrl`?$pass2Query"

  $absOut = [System.IO.Path]::GetFullPath($Out)
  $windowDimensions = $window -replace 'x', ','

  if ($DebugMode) {
    Write-Host "[DEBUG] screenshot: $browser $chromeFlags --force-device-scale-factor=$Scale --window-size=$windowDimensions --screenshot=`"$absOut`" `"$pass2Url`""
  }

  $p2Args = $chromeFlags + @(
    "--force-device-scale-factor=$Scale",
    "--window-size=$windowDimensions",
    "--screenshot=$absOut",
    $pass2Url
  )

  & $browser $p2Args 2>$null | Out-Null

  if (-not (Test-Path -Path $absOut) -or ((Get-Item $absOut).Length -eq 0)) {
    Write-Error "no image produced (window $window)"
    exit 1
  }

  $imgSize = (Get-Item $absOut).Length
  # The bitmap the screenshot comes back as: `window` is CSS pixels and the
  # browser raises it by Scale. Log those pixels, or the line reads as the output
  # size and is off by the factor.
  $expected = "$([math]::Round(($window -split 'x')[0] * $Scale))x$([math]::Round(($window -split 'x')[1] * $Scale))"
  if ($reportObj -and $reportObj.expected) { $expected = $reportObj.expected }
  Write-Host "$Out ($imgSize bytes, $expected @${Scale}x) + $jsonOut"

} finally {
  if (Test-Path $tmpDir) {
    Remove-Item -Path $tmpDir -Recurse -Force -ErrorAction SilentlyContinue
  }
}
