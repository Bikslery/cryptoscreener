@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"

set "SERVER_PORT=3001"
set "CLIENT_PORT=5173"

echo ============================================
echo   Crypto Screener - запуск за один файл
echo ============================================
echo.

if not exist "server\package.json" (
    echo [ERROR] Не найден server\package.json
    pause
    exit /b 1
)
if not exist "client\package.json" (
    echo [ERROR] Не найден client\package.json
    pause
    exit /b 1
)

echo [1/2] API server (Express :%SERVER_PORT%)...
powershell -NoProfile -Command ^
  "$c = Get-NetTCPConnection -LocalPort %SERVER_PORT% -State Listen -ErrorAction SilentlyContinue; if ($c) { Write-Host '  уже запущен, пропускаю' } else { Start-Process -FilePath 'cmd.exe' -ArgumentList '/c','npm run dev' -WorkingDirectory '%CD%\server' -RedirectStandardOutput '%CD%\server\dev.out.log' -RedirectStandardError '%CD%\server\dev.err.log' -WindowStyle Hidden; Write-Host '  запущен' }"

echo [2/2] Client (Vite :%CLIENT_PORT%)...
powershell -NoProfile -Command ^
  "$c = Get-NetTCPConnection -LocalPort %CLIENT_PORT% -State Listen -ErrorAction SilentlyContinue; if ($c) { Write-Host '  уже запущен, пропускаю' } else { Start-Process -FilePath 'cmd.exe' -ArgumentList '/c','npm run dev' -WorkingDirectory '%CD%\client' -RedirectStandardOutput '%CD%\client\vite.out.log' -RedirectStandardError '%CD%\client\vite.err.log' -WindowStyle Hidden; Write-Host '  запущен' }"

echo [3/3] Жду готовности...
set "READY="
for /l %%i in (1,1,60) do (
    powershell -NoProfile -Command "try { (Invoke-WebRequest -Uri 'http://localhost:%SERVER_PORT%/api/health' -TimeoutSec 2 -UseBasicParsing).StatusCode | Out-Null; exit 0 } catch { exit 1 }" >nul 2>&1
    if not errorlevel 1 (
        powershell -NoProfile -Command "try { (Invoke-WebRequest -Uri 'http://localhost:%CLIENT_PORT%' -TimeoutSec 2 -UseBasicParsing).StatusCode | Out-Null; exit 0 } catch { exit 1 }" >nul 2>&1
        if not errorlevel 1 ( set "READY=1" & goto :ready )
    )
    timeout /t 1 /nobreak >nul
)

:ready
if "%READY%"=="1" (
    echo.
    echo ============================================
    echo   Готово! Открываю интерфейс...
    echo.
    echo   Клиент : http://localhost:%CLIENT_PORT%
    echo   API    : http://localhost:%SERVER_PORT%/api/health
    echo.
    echo   Остановка: закройте консоль или убейте процессы node
    echo ============================================
    start "" "http://localhost:%CLIENT_PORT%"
) else (
    echo.
    echo [ERROR] Сервисы не поднялись за 60 секунд.
    echo   Логи:
    echo     server\dev.err.log
    echo     client\vite.err.log
)

pause