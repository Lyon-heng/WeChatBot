param([Parameter(Mandatory=$true)][string]$Root)
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
$rootPath=[IO.Path]::GetFullPath($Root)
$config=Get-Content -LiteralPath (Join-Path $rootPath 'config/wechatagent.json') -Raw -Encoding UTF8|ConvertFrom-Json
$configured=if([IO.Path]::IsPathRooted($config.hook.wechatExecutable)){[IO.Path]::GetFullPath($config.hook.wechatExecutable)}else{[IO.Path]::GetFullPath((Join-Path $rootPath $config.hook.wechatExecutable))}
$bundled=Join-Path $rootPath 'state/hook/wechat-4.1.10.27/Weixin.exe'
$candidates=[Collections.Generic.List[string]]::new()
$candidates.Add($configured);$candidates.Add($bundled)
foreach($base in @($env:ProgramFiles,${env:ProgramFiles(x86)},$env:LOCALAPPDATA)){
 if($base){foreach($relative in @('Tencent/Weixin/Weixin.exe','Tencent/WeChat/WeChat.exe')){$candidates.Add((Join-Path $base $relative))}}
}
foreach($hive in @('HKCU:','HKLM:')){foreach($name in @('Weixin.exe','WeChat.exe')){
 $key="$hive\Software\Microsoft\Windows\CurrentVersion\App Paths\$name"
 if(Test-Path -LiteralPath $key){$value=(Get-Item -LiteralPath $key).GetValue('');if($value){$candidates.Add(([string]$value).Trim('"'))}}
}}
$running=@(Get-CimInstance Win32_Process -Filter "Name='Weixin.exe' OR Name='WeChat.exe'" -ErrorAction SilentlyContinue)
foreach($process in $running){if($process.ExecutablePath){$candidates.Add($process.ExecutablePath)}}
$rows=@()
foreach($file in @($candidates|Select-Object -Unique)){
 if(!(Test-Path -LiteralPath $file -PathType Leaf)){continue}
 try{
  $file=[IO.Path]::GetFullPath($file)
  $item=Get-Item -LiteralPath $file
  $version=[string]$item.VersionInfo.FileVersion
  $core=Join-Path (Split-Path -Parent $file) ($version+'/Weixin.dll')
  $coreVersion=if(Test-Path -LiteralPath $core -PathType Leaf){[string](Get-Item -LiteralPath $core).VersionInfo.FileVersion}else{''}
  $signature=Get-AuthenticodeSignature -LiteralPath $file
  $coreSignature=if($coreVersion){Get-AuthenticodeSignature -LiteralPath $core}else{$null}
  $stream=[IO.File]::OpenRead($file)
  try{$reader=[IO.BinaryReader]::new($stream);$stream.Position=60;$offset=$reader.ReadInt32();$stream.Position=$offset+4;$machine=$reader.ReadUInt16()}finally{$stream.Dispose()}
  $rows+=[pscustomobject]@{path=$file;version=$version;coreVersion=$coreVersion;architecture=if($machine -eq 34404){'x64'}elseif($machine -eq 332){'x86'}else{'unknown'};signed=($signature.Status -eq 'Valid' -and $signature.SignerCertificate.Subject -match 'Tencent');coreSigned=($null -ne $coreSignature -and $coreSignature.Status -eq 'Valid' -and $coreSignature.SignerCertificate.Subject -match 'Tencent');running=(@($running|Where-Object ExecutablePath -EQ $file).Count -gt 0);bundled=($file -eq $bundled);configured=($file -eq $configured)}
 }catch{$rows+=[pscustomobject]@{path=$file;version='';signed=$false;coreSigned=$false;error='WECHAT_CLIENT_INSPECTION_FAILED';bundled=($file -eq $bundled);configured=($file -eq $configured)}}
}
$native=Join-Path $rootPath 'state/hook/native'
$nativeReady=$false
try{$record=Get-Content -LiteralPath (Join-Path $native 'build.json') -Raw -Encoding UTF8|ConvertFrom-Json;$nativeReady=($record.targetVersion -eq '4.1.10.27' -and (Get-FileHash -LiteralPath (Join-Path $native 'version.dll') -Algorithm SHA256).Hash.ToLowerInvariant() -eq $record.sha256)}catch{}
[pscustomobject]@{clients=@($rows);nativeReady=$nativeReady}|ConvertTo-Json -Depth 4 -Compress
