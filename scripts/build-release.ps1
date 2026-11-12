param(
  [Parameter(Mandatory=$true)][string]$PayloadRoot,
  [Parameter(Mandatory=$true)][string]$OutputDirectory,
  [string]$Version = '1.0.0',
  [string]$VoiceComponentsZip = '',
  [switch]$Resume,
  [switch]$InstallerTestMode
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$payload = (Resolve-Path -LiteralPath $PayloadRoot).Path.TrimEnd('\')
$out = [IO.Path]::GetFullPath($OutputDirectory)
if (-not (Test-Path -LiteralPath $out)) { New-Item -ItemType Directory -Path $out | Out-Null }
$out = (Resolve-Path -LiteralPath $out).Path
if ($out -eq $payload -or $out.StartsWith($payload + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'OutputDirectory must be outside PayloadRoot.' }
if ($Version -notmatch '^\d+\.\d+\.\d+$') { throw 'Version must use major.minor.patch format.' }

$exe = Join-Path $payload 'app/WeChatBot.exe'
$oldExe = Join-Path $payload 'app/WeChatAgent.exe'
if (-not (Test-Path -LiteralPath $exe) -and (Test-Path -LiteralPath $oldExe)) {
  Copy-Item -LiteralPath $oldExe -Destination $exe
  if ((Get-FileHash -LiteralPath $oldExe).Hash -ne (Get-FileHash -LiteralPath $exe).Hash) { throw 'Brand executable copy did not verify.' }
  [IO.File]::Delete($oldExe)
}
if (-not (Test-Path -LiteralPath $exe)) { throw 'Payload is missing app/WeChatBot.exe.' }
if (-not (Test-Path -LiteralPath (Join-Path $payload 'app/resources/project/public/console/index.html'))) { throw 'Payload is missing the application workspace.' }
if (-not (Test-Path -LiteralPath (Join-Path $payload 'app/resources/app/main.cjs'))) { throw 'Payload is missing the Electron desktop shell.' }
if (!$InstallerTestMode) {
  & node (Join-Path $repo 'scripts/verify-package-runtime.mjs') $payload
  if($LASTEXITCODE -ne 0){throw 'The isolated packaged runtime import check failed; no release was generated.'}
}

$portableName = "WeChatBot-$Version-portable-x64.zip"
$setupName = "WeChatBot-Setup-$Version-x64.exe"
$voiceName = 'WeChatBot-voice-components.zip'
$portablePath = Join-Path $out $portableName
$setupPath = Join-Path $out $setupName
$voicePath = Join-Path $out $voiceName
if($VoiceComponentsZip){
 $VoiceComponentsZip=(Resolve-Path -LiteralPath $VoiceComponentsZip).Path
 if($VoiceComponentsZip -eq $voicePath){throw 'VoiceComponentsZip must be outside the output directory.'}
 & node (Join-Path $repo 'scripts/verify-voice-components.mjs') $VoiceComponentsZip
 if($LASTEXITCODE -ne 0){throw 'Use the registered voice component archive; do not repack an unregistered environment.'}
}
if (!$Resume) { foreach ($file in @($portablePath,$setupPath,$voicePath)) { if (Test-Path -LiteralPath $file) { throw "Release output already exists: $file" } } }
if ($Resume) { foreach ($file in @($portablePath,$setupPath,$voicePath,(Join-Path $out 'SHA256SUMS.txt'),(Join-Path $out 'VERIFICATION.json'))) { if (Test-Path -LiteralPath $file) { [IO.File]::Delete($file) } } }
if($VoiceComponentsZip){Copy-Item -LiteralPath $VoiceComponentsZip -Destination $voicePath}

& (Join-Path $repo 'scripts/build-launcher.ps1') -OutputPath (Join-Path $payload 'WeChatBot.exe')
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$files = Get-ChildItem -LiteralPath $payload -File -Recurse | Where-Object {
  $rel = $_.FullName.Substring($payload.Length + 1).Replace('\','/')
  $rel -notmatch '^(?:Start-WeChatBot|Start-WeChatAgent)\.cmd$|^app/(?:uninstall\.exe|Uninstall WeChat(?:Girl|Agent)\.exe|uninstallerIcon\.ico)$|(^|/)\.git(/|$)|(^|/)__pycache__(/|$)|(^|/)(?:\.temp|Cache)(/|$)|\.pyc$|^data/\.wechatagent-data\.json$|(^|/)data/workspace/state(/|$)|(^|/)data/workspace/plugins(/|$)|(^|/)data/desktop/(?:runtime\.json|session)(?:/|$)|\.lock$' -and
    $rel -notmatch '^data/voice-(?:python|wsl)(?:/|$)' -and
    ($rel -notmatch '^app/locales/[^/]+\.pak$' -or $rel -match '^app/locales/(?:en-US|zh-CN)\.pak$')
}
if (-not $files.Count) { throw 'No payload files remain after release exclusions.' }

$manifest = Get-Content -LiteralPath (Join-Path $payload 'app/resources/project/deployment.json') -Raw | ConvertFrom-Json
$desktopVersion = (Get-Content -LiteralPath (Join-Path $payload 'app/resources/app/package.json') -Raw | ConvertFrom-Json).version
if ($manifest.version -ne $Version -or $manifest.packageVersion -ne $Version -or $desktopVersion -ne $Version) { throw 'Payload versions do not match the requested release.' }
foreach ($file in $files) {
  $relative = $file.FullName.Substring($payload.Length + 1).Replace('\','/')
  if ($relative -match '(?:^|/)(?:\.env|storage\.ini|plugins\.json|distribution\.json)$|\.(?:token|log|db|sqlite|pem|key|pfx|tmp)$|^app/resources/project/(?:state|plugins)/|^app/resources/project/config/(?!wechatagent\.example\.json$)') {
    throw "Private or temporary file in payload: $relative"
  }
}

if (!(Test-Path -LiteralPath $portablePath)) {
  $portable = [IO.Compression.ZipFile]::Open($portablePath, [IO.Compression.ZipArchiveMode]::Create)
  try {
    foreach ($file in $files) {
      $entry = $file.FullName.Substring($payload.Length + 1).Replace('\','/')
      [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($portable, $file.FullName, $entry, [IO.Compression.CompressionLevel]::Optimal) | Out-Null
    }
  } finally { $portable.Dispose() }
}

# Component packages must be pre-reviewed and match the importer's registered hash.
$fileList = Join-Path $out 'installer-file-list.json'
try {
  @($files | ForEach-Object { $_.FullName.Substring($payload.Length + 1).Replace('\','/') }) | ConvertTo-Json | Set-Content -LiteralPath $fileList -Encoding utf8
  $installerArgs = @((Join-Path $repo 'scripts/build-windows-installer.mjs'),$payload,$out,$Version,$fileList)
  if($InstallerTestMode){$installerArgs+='--test'}
  & node @installerArgs
  if($LASTEXITCODE -ne 0){throw 'NSIS installer build failed.'}
} finally { if(Test-Path -LiteralPath $fileList){[IO.File]::Delete($fileList)} }

$sums = @($portableName,$setupName) + $(if (Test-Path -LiteralPath $voicePath) { @($voiceName) } else { @() })
$sums | ForEach-Object { (Get-FileHash -LiteralPath (Join-Path $out $_) -Algorithm SHA256).Hash.ToLowerInvariant() + '  ' + $_ } | Set-Content -LiteralPath (Join-Path $out 'SHA256SUMS.txt') -Encoding ascii
[pscustomobject]@{
  version = $Version
  buildId = $manifest.buildId
  builtAt = $manifest.builtAt
  InstallerComponent = 'electron-builder 26.15.3 / NSIS'
  InstallerTestMode = [bool]$InstallerTestMode
  Portable = $portableName
  Setup = $setupName
  OptionalVoice = if (Test-Path -LiteralPath $voicePath) { $voiceName } else { $null }
  PayloadFiles = $files.Count
  OptionalLanguages = 'en-US, zh-CN'
  Excludes = 'voice runtime, user state, user plugins, transient caches'
} | ConvertTo-Json -Depth 3 | Set-Content -LiteralPath (Join-Path $out 'VERIFICATION.json') -Encoding utf8
Get-ChildItem -LiteralPath $out -File | Select-Object Name,Length
