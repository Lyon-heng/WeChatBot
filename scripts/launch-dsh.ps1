$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$config = Get-Content -LiteralPath (Join-Path $root 'config\wechatagent.json') -Raw -Encoding UTF8 | ConvertFrom-Json
if (-not $config.runtime.dshDesktop -or -not (Test-Path -LiteralPath $config.runtime.dshDesktop)) { throw 'DSH_NOT_CONFIGURED: Install DSH from the setup link, then select DeepSeek Harness.exe and save settings.' }
# Old Desktop versions leave per-launch loopback cookies until HTTP headers overflow.
# The helper skips running DSH, backs up privately, and never touches model login.
$dshAuthHelper=Join-Path $PSScriptRoot 'dsh-local-auth.mjs'
if(Test-Path -LiteralPath $dshAuthHelper){
    $dshAuthNode=(Get-Command node -ErrorAction Stop).Source
    # Windows PowerShell can treat native stderr as terminating with Stop.
    # A warning does not mean the cache check failed; use its exit code.
    $previousErrorPreference=$ErrorActionPreference
    try {
        $ErrorActionPreference='Continue'
        $dshAuthResult=& $dshAuthNode --disable-warning=ExperimentalWarning $dshAuthHelper $root 2>$null
        $dshAuthExitCode=$LASTEXITCODE
    } finally { $ErrorActionPreference=$previousErrorPreference }
    if($dshAuthExitCode -ne 0){throw 'DSH_AUTH_RECOVERY_UNAVAILABLE: Local startup cache could not be checked safely; existing data was preserved.'}
}
$previousDshHome=$env:DSH_HOME
try {
    $distributionFile=Join-Path $root 'config\distribution.json'
    $arguments=@()
    if(Test-Path -LiteralPath $distributionFile){
        $distribution=Get-Content -LiteralPath $distributionFile -Raw -Encoding UTF8 | ConvertFrom-Json
        if($config.runtime.dshDesktop -eq $distribution.dsh -and $distribution.dshHome){
            $env:DSH_HOME=$distribution.dshHome
            $arguments=@('--user-data-dir="'+(Join-Path $distribution.dshHome 'desktop')+'"')
        }
    }
    if($arguments.Count){Start-Process -FilePath $config.runtime.dshDesktop -ArgumentList $arguments -WorkingDirectory (Split-Path -Parent $config.runtime.dshDesktop) -WindowStyle Normal | Out-Null}
    else {Start-Process -FilePath $config.runtime.dshDesktop -WorkingDirectory (Split-Path -Parent $config.runtime.dshDesktop) -WindowStyle Normal | Out-Null}
} finally {$env:DSH_HOME=$previousDshHome}
Write-Output 'DSH opened. Sign in, enable the local WeChatAgent plugin, then restart DSH from its tray menu.'
