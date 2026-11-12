param([ValidateSet('start','start-singing','stop','status','stop-cosy')][string]$Action='start')
$ErrorActionPreference='Stop'
$voiceWorkspace=Split-Path -Parent $PSScriptRoot
$voiceBase=Join-Path $voiceWorkspace 'state/voice'
$voiceRecord=Join-Path $voiceBase 'processes.json'
$voiceRecords=@{}
if(Test-Path -LiteralPath $voiceRecord){$voiceSaved=Get-Content -LiteralPath $voiceRecord -Raw -Encoding UTF8|ConvertFrom-Json;foreach($voiceItem in $voiceSaved.PSObject.Properties){$voiceRecords[$voiceItem.Name]=$voiceItem.Value}}
function Voice-Owned($Item){
 if(-not $Item){return $null}
 $voiceScope=[IO.Path]::GetFullPath($voiceBase).TrimEnd('\','/')+[IO.Path]::DirectorySeparatorChar
 if(-not $Item.exe -or -not [IO.Path]::GetFullPath([string]$Item.exe).StartsWith($voiceScope,[StringComparison]::OrdinalIgnoreCase) -or -not $Item.marker){throw 'VOICE_PROCESS_OUTSIDE_WORKSPACE'}
 $voiceProcess=Get-CimInstance Win32_Process -Filter ('ProcessId='+[int]$Item.pid)
 if(-not $voiceProcess){return $null}
 if(-not $voiceProcess.ExecutablePath -or -not $voiceProcess.CommandLine -or [IO.Path]::GetFullPath($voiceProcess.ExecutablePath) -ne [IO.Path]::GetFullPath($Item.exe) -or $voiceProcess.CommandLine.IndexOf([string]$Item.marker,[StringComparison]::OrdinalIgnoreCase) -lt 0){throw 'VOICE_PROCESS_IDENTITY_CHANGED'}
 return $voiceProcess
}
if($Action -in @('stop','stop-cosy')){
 $voiceStopNames=if($Action -eq 'stop-cosy'){@('cosyvoice')}else{@('breeze','singing','embeddings','cosyvoice')}
 foreach($voiceName in $voiceStopNames){if($voiceRecords.ContainsKey($voiceName)){if(Voice-Owned $voiceRecords[$voiceName]){if($voiceName -in @('singing','cosyvoice','embeddings')){& taskkill.exe /PID ([int]$voiceRecords[$voiceName].pid) /T /F | Out-Null;if($LASTEXITCODE -ne 0){throw 'VOICE_SERVICE_STOP_FAILED'}}else{Stop-Process -Id ([int]$voiceRecords[$voiceName].pid) -ErrorAction Stop}};$voiceRecords.Remove($voiceName)}}
 if(Test-Path -LiteralPath $voiceBase){$voiceRecords|ConvertTo-Json -Depth 4|Set-Content -LiteralPath $voiceRecord -Encoding UTF8};exit 0
}
if($Action -eq 'status'){foreach($voiceName in $voiceRecords.Keys){Write-Output ($voiceName+': '+[bool](Voice-Owned $voiceRecords[$voiceName]))};exit 0}
$voiceConfigFile=Join-Path $voiceWorkspace 'config/plugins.json'
if(-not(Test-Path -LiteralPath $voiceConfigFile)){exit 0}
$voiceNode=(Get-Command node -ErrorAction Stop).Source
$voiceSettingsText=& $voiceNode (Join-Path $PSScriptRoot 'voice-service-settings.mjs') $voiceWorkspace 2>$null
if($LASTEXITCODE -ne 0){throw 'VOICE_SERVICE_SETTINGS_UNAVAILABLE'}
$voiceSettings=$voiceSettingsText|ConvertFrom-Json
if(-not $voiceSettings.enabled){exit 0}
$voicePort=[int]$voiceSettings.port
if($voicePort -lt 1024 -or $voicePort -gt 65534){throw 'VOICE_PORT_INVALID'}
$voiceBreezeBin=Join-Path $voiceBase 'breeze/runtime/breeze-tts-2-v0.1.6-windows-x64-vulkan/breeze-server.exe'
$voiceModel=Join-Path $voiceBase 'breeze/models/breeze-tts-2-q8_0.gguf'
if($voiceSettings.modelPath){$voiceModel=[string]$voiceSettings.modelPath}
$voiceServer=Join-Path $voiceBase 'feiyu-service/server'
$voiceServices=@()
if(($voiceSettings.voiceEnabled -ne $false) -and (Test-Path -LiteralPath $voiceBreezeBin) -and (Test-Path -LiteralPath $voiceModel)){$voiceServices+=@{name='breeze';exe=$voiceBreezeBin;port=$voicePort;marker=$voiceModel;cwd=(Split-Path -Parent $voiceBreezeBin);args=('"'+$voiceModel+'" --host 127.0.0.1 --port '+$voicePort+' --ws-port -1 --voices-dir "'+(Join-Path $voiceBase 'breeze/voices')+'" --split-chars 180 --parallel 1')}}
if(($voiceSettings.voiceEnabled -ne $false) -and (Test-Path -LiteralPath (Join-Path $voiceServer 'configs/voice_service.json')) -and (Test-Path -LiteralPath (Join-Path $voiceServer '.venv/Scripts/python.exe'))){$voiceServices+=@{name='singing';exe=(Join-Path $voiceServer '.venv/Scripts/python.exe');port=19882;marker='-m feiyu_voice_service';cwd=$voiceServer;args='-B -m feiyu_voice_service --host 127.0.0.1 --port 19882'}}
$voiceServices+=@($voiceSettings.models|Where-Object {$_ -and $_.ready -and (Test-Path -LiteralPath $_.exe)})
if($Action -eq 'start-singing'){$voiceServices=@($voiceServices|Where-Object {$_.name -eq 'singing'})}
foreach($voiceService in $voiceServices){
 $voiceName=$voiceService.name
 if($voiceRecords.ContainsKey($voiceName) -and (Voice-Owned $voiceRecords[$voiceName])){continue}
 $voiceListeners=@(Get-NetTCPConnection -State Listen -LocalPort $voiceService.port -ErrorAction SilentlyContinue)
 if($voiceListeners.Count){
  $voiceOwners=@($voiceListeners|Select-Object -ExpandProperty OwningProcess -Unique)
  if($voiceOwners.Count -ne 1){throw 'VOICE_PORT_IN_USE'}
  $voiceExisting=Get-CimInstance Win32_Process -Filter ('ProcessId='+$voiceOwners[0])
  $voiceRecordItem=@{pid=[int]$voiceOwners[0];exe=$voiceService.exe;marker=$voiceService.marker}
  $voiceOwned=$null;try{$voiceOwned=Voice-Owned $voiceRecordItem}catch{}
  if(-not $voiceOwned -and $voiceName -eq 'singing'){$voiceRecordItem.pid=[int]$voiceExisting.ParentProcessId;try{$voiceOwned=Voice-Owned $voiceRecordItem}catch{}}
  if(-not $voiceOwned){throw 'VOICE_PORT_IN_USE'}
  $voiceRecords[$voiceName]=$voiceRecordItem;continue
 }
 $voiceOldPath=$env:PATH;$voiceOldUtf8=$env:PYTHONUTF8
 try{$env:PATH=(Join-Path $voiceBase 'tools')+';'+$env:PATH;$env:PYTHONUTF8='1';$voiceProcess=Start-Process -FilePath $voiceService.exe -ArgumentList $voiceService.args -WorkingDirectory $voiceService.cwd -WindowStyle Hidden -RedirectStandardOutput (Join-Path $voiceBase ($voiceName+'.stdout.log')) -RedirectStandardError (Join-Path $voiceBase ($voiceName+'.stderr.log')) -PassThru;$voiceRecords[$voiceName]=@{pid=$voiceProcess.Id;exe=$voiceService.exe;marker=$voiceService.marker}}finally{$env:PATH=$voiceOldPath;$env:PYTHONUTF8=$voiceOldUtf8}
}
$voiceRecords|ConvertTo-Json -Depth 4|Set-Content -LiteralPath $voiceRecord -Encoding UTF8
Write-Output 'Configured local voice services started or reused.'
