#!/usr/bin/env pwsh
$ErrorActionPreference = 'Stop'

try {
    $null = docker compose version 2>$null
    if ($LASTEXITCODE -eq 0) {
        & docker compose -f compose.yaml -p crypto-screener down --remove-orphans @args
        exit $LASTEXITCODE
    }
} catch {
    # fall through
}

Write-Error ("Only legacy docker-compose v1 detected. Install Compose V2 plugin:`n" +
    "  https://docs.docker.com/compose/install/windows/")
exit 2
