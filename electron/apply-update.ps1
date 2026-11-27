param([int]$TargetPid, [string]$Package, [string]$Target, [string]$Mode)
$ErrorActionPreference = 'Stop'
try {
    $old = Get-Process -Id $TargetPid -ErrorAction SilentlyContinue
    if ($old -and -not $old.WaitForExit(60000)) { throw 'Totkmap did not exit.' }

    if ($Mode -eq 'portable') {
        # The portable launcher may still be cleaning up after Electron exits.
        $staged = "$Target.$TargetPid.new"
        try {
            [IO.File]::Copy($Package, $staged, $true)
            for ($i = 0; ; $i++) {
                try { [IO.File]::Replace($staged, $Target, "$staged.bak"); break }
                catch [IO.IOException] {
                    if ($i -ge 119) { throw }
                    Start-Sleep -Milliseconds 500
                }
            }
        } finally { Remove-Item -LiteralPath $staged -Force -ErrorAction SilentlyContinue }
        Remove-Item -LiteralPath "$staged.bak" -Force -ErrorAction SilentlyContinue
        Start-Process -FilePath $Target -WorkingDirectory (Split-Path -Parent $Target)
    } else {
        # NSIS --force-run launches the installed build, including custom install paths.
        $installer = Start-Process -FilePath $Package -ArgumentList '/S','--updated','--force-run' -PassThru
        $installer.WaitForExit()
        if ($installer.ExitCode -ne 0) { throw "Installer exit code: $($installer.ExitCode)" }
    }
    Remove-Item -LiteralPath $Package -Force -ErrorAction SilentlyContinue
} catch {
    Add-Type -AssemblyName System.Windows.Forms
    [void][Windows.Forms.MessageBox]::Show("Update failed: $($_.Exception.Message)`n`nDownloaded package: $Package", 'Totkmap')
    exit 1
} finally {
    Remove-Item -LiteralPath $PSCommandPath -Force -ErrorAction SilentlyContinue
}
