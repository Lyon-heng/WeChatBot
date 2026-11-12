param(
  [Parameter(Mandatory=$true)][string]$DirectiveFile,
  [Parameter(Mandatory=$true)][string]$PayloadRoot,
  [Parameter(Mandatory=$true)][string]$OutputDirectory
)

$ErrorActionPreference = 'Stop'
$directive = (Resolve-Path -LiteralPath $DirectiveFile).Path
$payload = (Resolve-Path -LiteralPath $PayloadRoot).Path.TrimEnd('\')
$out = [IO.Path]::GetFullPath($OutputDirectory)
if (-not (Test-Path -LiteralPath $out)) { New-Item -ItemType Directory -Path $out | Out-Null }
$out = (Resolve-Path -LiteralPath $out).Path
if ($out.StartsWith($payload + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'OutputDirectory must be outside PayloadRoot.' }

$lines = [IO.File]::ReadAllLines($directive)
$result = [Collections.Generic.List[string]]::new()
$removedLocales = 0
$removedVoice = 0
$rootPrefix = $payload + '\'
foreach ($line in $lines) {
  $match = [regex]::Match($line, '^"(?<path>[^"]+)"$')
  if (-not $match.Success) {
    if ($line -match '^\.Set CabinetNameTemplate=') { $result.Add('.Set CabinetNameTemplate=' + (Join-Path $out 'WeChatBot-core.cab')); continue }
    if ($line -match '^\.Set InfFileName=') { $result.Add('.Set InfFileName=' + (Join-Path $out 'WeChatBot-core.inf')); continue }
    if ($line -match '^\.Set RptFileName=') { $result.Add('.Set RptFileName=' + (Join-Path $out 'WeChatBot-core.rpt')); continue }
    $result.Add($line); continue
  }
  $source = [IO.Path]::GetFullPath($match.Groups['path'].Value)
  if (-not $source.StartsWith($rootPrefix, [StringComparison]::OrdinalIgnoreCase)) { $result.Add($line); continue }
  $relative = $source.Substring($rootPrefix.Length).Replace('\','/')
  if ($relative -match '^app/locales/(?!en-US\.pak$|zh-CN\.pak$)[^/]+\.pak$') { $removedLocales++; continue }
  if ($relative -match '^data/voice-(?:python|wsl)(?:/|$)') { $removedVoice++; continue }
  $result.Add($line)
}

$coreDirective = Join-Path $out 'WeChatBot-core.DDF'
[IO.File]::WriteAllLines($coreDirective, [string[]]$result, [Text.UTF8Encoding]::new($false))

$voiceRoots = @('data/voice-python','data/voice-wsl') | ForEach-Object { Join-Path $payload $_.Replace('/','\') } | Where-Object { Test-Path -LiteralPath $_ }
$voiceZip = Join-Path $out 'WeChatBot-voice-components.zip'
$voiceArchiveEntries = 0
if ($voiceRoots.Count) {
  Add-Type -AssemblyName System.IO.Compression
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  if (Test-Path -LiteralPath $voiceZip) { Remove-Item -LiteralPath $voiceZip -Force }
  $archive = [IO.Compression.ZipFile]::Open($voiceZip, [IO.Compression.ZipArchiveMode]::Create)
  try {
    foreach ($voiceRoot in $voiceRoots) {
      Get-ChildItem -LiteralPath $voiceRoot -File -Recurse | ForEach-Object {
        if ($_.Name -in @('.lock','.gitignore') -or $_.FullName -match '[\\/](?:\.git|\.temp|__pycache__|Cache)(?:[\\/]|$)' -or $_.Extension -eq '.pyc') { return }
        $relative = $_.FullName.Substring($payload.Length + 1).Replace('\','/')
        [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($archive, $_.FullName, $relative, [IO.Compression.CompressionLevel]::Optimal) | Out-Null
        $script:voiceArchiveEntries++
      }
    }
    $readme = "WeChatBot optional voice components`r`n`r`nExtract this archive into the installation root beside the app and data folders. It restores data/voice-python and data/voice-wsl. Restart WeChatBot after extraction. If you do not use voice generation or singing, you can leave this package uninstalled.`r`n"
    $entry = $archive.CreateEntry('VOICE-OPTIONAL-README.txt')
    $writer = [IO.StreamWriter]::new($entry.Open(), [Text.UTF8Encoding]::new($false))
    try { $writer.Write($readme) } finally { $writer.Dispose() }
  } finally { $archive.Dispose() }
}

[pscustomobject]@{
  CoreDirective = $coreDirective
  OptionalVoiceArchive = if ($voiceRoots.Count) { $voiceZip } else { $null }
  LocalePacksRemoved = $removedLocales
  VoiceDirectiveEntriesRemoved = $removedVoice
  VoiceArchiveEntries = $voiceArchiveEntries
  Note = 'Build the core installer from WeChatBot-core.DDF. Keep the optional voice archive beside the release download.'
} | ConvertTo-Json -Depth 3
