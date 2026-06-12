#!/usr/bin/env pwsh
# Forces Compose V2 CLI on Windows / PowerShell.
$ErrorActionPreference = 'Stop'

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    Write-Error "docker not installed"
    exit 1
}

try {
    $null = docker compose version 2>$null
    if ($LASTEXITCODE -eq 0) {
        & docker compose -f compose.yaml -p crypto-screener up -d --build @args
        exit $LASTEXITCODE
    }
} catch {
    # fall through
}

if (Get-Command docker-compose -ErrorAction SilentlyContinue) {
    Write-Error ("Only legacy docker-compose v1 detected. Install the Compose V2 plugin:`n" +
        "  Download: https://docs.docker.com/compose/install/windows/`n" +
        "After install, use 'docker compose' (space, not hyphen).")
    exit 2
}

Write-Error "Docker and Compose V2 are required."
exit 1
