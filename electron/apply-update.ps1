param([int]$TargetPid, [string]$Package, [string]$Target, [string]$Mode, [string]$Version)
$ErrorActionPreference = 'Stop'
$log = Join-Path (Split-Path -Parent $Package) 'install.log'
function Write-UpdateLog([string]$message) {
    Add-Content -LiteralPath $log -Value "$(Get-Date -Format o) $message" -ErrorAction SilentlyContinue
}
try {
    Write-UpdateLog "Starting $Mode update to $Version"
    if (-not (Test-Path -LiteralPath $Package -PathType Leaf)) { throw "Missing download: $Package" }
    if ($Mode -eq 'setup') {
        # Hand off to the real installer before asking Electron to release its files.
        $installDir = Split-Path -Parent $Target
        $installer = Start-Process -FilePath $Package -ArgumentList "/S --updated /D=$installDir" -PassThru
    }
    [Console]::Out.WriteLine('TOTKMAP_UPDATE_READY')
    [Console]::Out.Flush()
    $handedOff = $true
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
        $installer.WaitForExit()
        Write-UpdateLog "Installer exit code: $($installer.ExitCode)"
        if ($installer.ExitCode -ne 0) { throw "Installer exit code: $($installer.ExitCode)" }

        $info = [Diagnostics.FileVersionInfo]::GetVersionInfo($Target)
        $installed = "$($info.FileMajorPart).$($info.FileMinorPart).$($info.FileBuildPart)"
        if ($installed -ne $Version) { throw "Expected $Version at $Target, found $installed." }
        # Relaunch explicitly as this user; do not depend on NSIS --force-run.
        Start-Process -FilePath $Target -WorkingDirectory $installDir
        Write-UpdateLog "Launched $Target ($installed)"
    }
    Remove-Item -LiteralPath $Package -Force -ErrorAction SilentlyContinue
} catch {
    Write-UpdateLog "Update failed: $($_.Exception.Message)"
    if (-not $handedOff) { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }
    Add-Type -AssemblyName System.Windows.Forms
    [void][Windows.Forms.MessageBox]::Show("Update failed: $($_.Exception.Message)`n`nDownloaded package: $Package", 'Totkmap')
    exit 1
} finally {
    Remove-Item -LiteralPath $PSCommandPath -Force -ErrorAction SilentlyContinue
}
