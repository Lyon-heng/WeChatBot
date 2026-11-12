param([switch]$Launch,[switch]$CheckOnly)
$ErrorActionPreference='Stop'
$voiceRoot=Split-Path -Parent $PSScriptRoot
$voiceConfig=Get-Content -LiteralPath (Join-Path $voiceRoot 'config/wechatagent.json') -Raw -Encoding UTF8|ConvertFrom-Json
$voiceExpected=Get-Content -LiteralPath (Join-Path $PSScriptRoot 'native-hook/voice-build.json') -Raw -Encoding UTF8|ConvertFrom-Json
$voiceCandidate=Join-Path $voiceRoot 'state/hook/voice-candidate/version.dll'
if($voiceExpected.targetVersion -ne $voiceConfig.hook.expectedVersion -or (Get-FileHash -LiteralPath $voiceCandidate -Algorithm SHA256).Hash.ToLowerInvariant() -ne $voiceExpected.sha256){throw 'VOICE_CANDIDATE_HASH_OR_VERSION_MISMATCH'}
foreach($voiceSource in $voiceExpected.sources.PSObject.Properties){$voicePath=[IO.Path]::GetFullPath((Join-Path $voiceRoot $voiceSource.Name));if(-not $voicePath.StartsWith([IO.Path]::GetFullPath($voiceRoot)+'\',[StringComparison]::OrdinalIgnoreCase) -or (Get-FileHash -LiteralPath $voicePath -Algorithm SHA256).Hash.ToLowerInvariant() -ne $voiceSource.Value){throw 'VOICE_REVIEWED_SOURCE_CHANGED'}}
$voiceExe=if([IO.Path]::IsPathRooted($voiceConfig.hook.wechatExecutable)){[IO.Path]::GetFullPath($voiceConfig.hook.wechatExecutable)}else{[IO.Path]::GetFullPath((Join-Path $voiceRoot $voiceConfig.hook.wechatExecutable))}
$voiceOpen=@(Get-CimInstance Win32_Process -Filter "Name='Weixin.exe'"|Where-Object {$_.ExecutablePath -eq $voiceExe -and $_.CommandLine -notmatch '--type=|--crashpad-handler'})
$voiceNative=Join-Path $voiceRoot 'state/hook/native'
$voiceCurrent=Get-Content -LiteralPath (Join-Path $voiceNative 'build.json') -Raw -Encoding UTF8|ConvertFrom-Json
if((Get-FileHash -LiteralPath (Join-Path $voiceNative 'version.dll')).Hash.ToLowerInvariant() -ne $voiceCurrent.sha256){throw 'VOICE_PREVIOUS_NATIVE_HASH_MISMATCH'}
$voiceApplication=Join-Path (Split-Path -Parent (Split-Path -Parent $voiceRoot)) 'app/WeChatAgent.exe'
$voiceAppOpen=@(Get-CimInstance Win32_Process -Filter "Name='WeChatAgent.exe'"|Where-Object {$_.ExecutablePath -eq $voiceApplication -and $_.CommandLine -notmatch '--type='})
if($CheckOnly){Write-Output ('Voice candidate/source/previous-build hashes verified. WeChatOpen='+[bool]$voiceOpen.Count+' WeChatAgentOpen='+[bool]$voiceAppOpen.Count);exit 0}
if($voiceOpen.Count -or $voiceAppOpen.Count){throw 'VOICE_UPDATE_REQUIRES_APP_EXIT: Exit WeChatAgent and the project WeChat from their trays before applying the new native component.'}
$voiceBackup=Join-Path $voiceRoot ('state/voice-activation-backup-'+(Get-Date -Format 'yyyyMMdd-HHmmss'))
New-Item -ItemType Directory -Path $voiceBackup -Force|Out-Null
foreach($voiceFile in @('version.dll','build.json','build.previous.json','version.dll.previous')){if(Test-Path -LiteralPath (Join-Path $voiceNative $voiceFile)){Copy-Item -LiteralPath (Join-Path $voiceNative $voiceFile) -Destination (Join-Path $voiceBackup $voiceFile)}}
Copy-Item -LiteralPath (Join-Path $voiceNative 'build.json') -Destination (Join-Path $voiceNative 'build.previous.json') -Force
$voiceNext=@{};foreach($voiceProperty in $voiceCurrent.PSObject.Properties){$voiceNext[$voiceProperty.Name]=$voiceProperty.Value};$voiceNext.sha256=$voiceExpected.sha256;$voiceNext.nativeVoice=$voiceExpected.nativeVoice;$voiceNext.voiceSource=$voiceExpected.voiceSource
if($voiceExpected.PSObject.Properties.Name -contains 'nativeMentions'){$voiceNext.nativeMentions=$voiceExpected.nativeMentions}
Copy-Item -LiteralPath $voiceCandidate -Destination (Join-Path $voiceNative 'version.dll') -Force
$voiceNext|ConvertTo-Json -Depth 5|Set-Content -LiteralPath (Join-Path $voiceNative 'build.json') -Encoding UTF8
$voiceVendor=Join-Path (Split-Path -Parent (Split-Path -Parent $voiceRoot)) 'app/resources/vendor/hook'
if(Test-Path -LiteralPath (Join-Path $voiceVendor 'build.json')){
 foreach($voiceFile in @('version.dll','build.json')){Copy-Item -LiteralPath (Join-Path $voiceVendor $voiceFile) -Destination (Join-Path $voiceBackup ('vendor-'+$voiceFile));Copy-Item -LiteralPath (Join-Path $voiceNative $voiceFile) -Destination (Join-Path $voiceVendor $voiceFile) -Force}
}
if($Launch){& (Join-Path $PSScriptRoot 'launch-hook-wechat.ps1') -UpdateHook}else{& (Join-Path $PSScriptRoot 'launch-hook-wechat.ps1') -PrepareOnly -UpdateHook}
Write-Output 'Verified voice component applied. Reopen DSH and WeChatAgent to load the voice host. Sign in to WeChat if prompted.'
