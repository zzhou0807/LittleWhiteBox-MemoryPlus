$ErrorActionPreference = 'Stop'
$root = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$workspace = [System.IO.Path]::GetFullPath((Join-Path $root '..'))
$output = Join-Path $workspace 'LittleWhiteBox-delivery'
New-Item -ItemType Directory -Path $output -Force | Out-Null
$archivePath = Join-Path $output 'LittleWhiteBox-MemoryPlus-3.1.2-memory.1.zip'
$excluded = @('summary-test-results.txt', 'summary-build-results.txt', 'summary-runtime-results.txt', 'summary-lint-results.txt')
$safeRoot = $root.Replace('\', '/')
$files = & git -C $root -c "safe.directory=$safeRoot" -c core.quotepath=false ls-files --cached --others --exclude-standard
if ($LASTEXITCODE -ne 0) { throw 'Cannot enumerate repository files' }
Add-Type -AssemblyName System.IO.Compression
$stream = [System.IO.File]::Open($archivePath, [System.IO.FileMode]::Create)
$archive = [System.IO.Compression.ZipArchive]::new($stream, [System.IO.Compression.ZipArchiveMode]::Create, $false)
$count = 0
try {
    foreach ($relative in ($files | Sort-Object -Unique)) {
        if ($excluded -contains $relative) { continue }
        $absolute = [System.IO.Path]::GetFullPath((Join-Path $root $relative))
        if (-not $absolute.StartsWith($root + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)) {
            throw "Path outside package root: $relative"
        }
        if (-not (Test-Path -LiteralPath $absolute -PathType Leaf)) { continue }
        $entry = $archive.CreateEntry('LittleWhiteBox/' + $relative.Replace('\', '/'), [System.IO.Compression.CompressionLevel]::Optimal)
        $inputStream = [System.IO.File]::OpenRead($absolute)
        $entryStream = $entry.Open()
        try { $inputStream.CopyTo($entryStream) } finally { $entryStream.Dispose(); $inputStream.Dispose() }
        $count++
    }
} finally {
    $archive.Dispose()
    $stream.Dispose()
}
foreach ($name in @('总结增强版-安装说明.md', '总结增强版-验证记录.md')) {
    Copy-Item -LiteralPath (Join-Path $root $name) -Destination (Join-Path $output $name) -Force
}
$hash = Get-FileHash -LiteralPath $archivePath -Algorithm SHA256
"$($hash.Hash.ToLower())  $([System.IO.Path]::GetFileName($archivePath))" | Set-Content -LiteralPath (Join-Path $output 'SHA256.txt') -Encoding utf8
Write-Output "Packaged $count files: $archivePath"
Write-Output "SHA256: $($hash.Hash)"
