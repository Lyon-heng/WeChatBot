param([Parameter(Mandatory=$true)][string]$OutputPath)
$ErrorActionPreference='Stop'
$repo=Split-Path -Parent $PSScriptRoot
$csc=@((Join-Path $env:WINDIR 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'),(Join-Path $env:WINDIR 'Microsoft.NET/Framework/v4.0.30319/csc.exe')) | Where-Object {Test-Path -LiteralPath $_} | Select-Object -First 1
if(!$csc){throw '.NET Framework C# compiler not found.'}
$destination=[IO.Path]::GetFullPath($OutputPath)
New-Item -ItemType Directory -Path (Split-Path -Parent $destination) -Force | Out-Null
$icon=Join-Path $repo 'desktop/icon.ico'
& $csc /nologo /target:winexe /platform:x64 /optimize+ /out:$destination /win32icon:$icon /reference:System.Windows.Forms.dll (Join-Path $repo 'packaging/windows/Launcher.cs') (Join-Path $repo 'packaging/windows/AssemblyInfo.cs')
if($LASTEXITCODE -ne 0){throw 'GUI launcher compilation failed.'}
