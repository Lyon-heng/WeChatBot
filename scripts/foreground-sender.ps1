$ErrorActionPreference='Stop'
$OutputEncoding=[Console]::OutputEncoding=New-Object System.Text.UTF8Encoding($false)
[Console]::InputEncoding=New-Object System.Text.UTF8Encoding($false)
try {
  Add-Type -Path (Join-Path $PSScriptRoot 'foreground-sender.cs') -ReferencedAssemblies UIAutomationClient,UIAutomationTypes,System.Windows.Forms,System.Core,WindowsBase
  [Console]::WriteLine('{"ready":true}')
  while($null -ne ($line=[Console]::ReadLine())) {
    try {
      $body=$line | ConvertFrom-Json
      [WhaleForeground]::Attempted=$false
      if($body.probe) { $ok=[WhaleForeground]::Probe($body.executable) }
      elseif($body.favorite){ $ok=[WhaleForeground]::SendFavorite($body.executable,$body.name) }
      else { $ok=[WhaleForeground]::Send($body.executable,$body.name,$body.text) }
      [Console]::WriteLine((@{accepted=$ok;attempted=[WhaleForeground]::Attempted} | ConvertTo-Json -Compress))
    } catch {
      $code=if($_.Exception.ToString() -match 'FOREGROUND_[A-Z_]+'){$Matches[0]}else{'FOREGROUND_UI_UNAVAILABLE'}
      [Console]::WriteLine((@{accepted=$false;attempted=[WhaleForeground]::Attempted;code=$code}|ConvertTo-Json -Compress))
    }
  }
} catch { [Console]::WriteLine('{"ready":false}');exit 1 }
