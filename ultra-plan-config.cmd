@echo off
echo ========================================
echo   Ultra Plan Mode - Config Page
echo ========================================
echo.

set "PORT=8787"
set "URL=http://localhost:%PORT%/#/config"
set "SCRIPT_DIR=%~dp0"

:: Try to reach the server
curl -s -o nul -w "%%{http_code}" "http://localhost:%PORT%/api/config" > "%TEMP%\up_health.txt" 2>nul
set /p STATUS=<"%TEMP%\up_health.txt"
del "%TEMP%\up_health.txt" 2>nul

if "%STATUS%"=="200" (
    echo [info] Server already running on port %PORT%
    echo [open] %URL%
    start "" "%URL%"
    exit /b 0
)

echo [info] Server not running, starting it...
echo.

:: Build if needed
if not exist "%SCRIPT_DIR%web\dist" (
    echo [build] Building frontend...
    cd /d "%SCRIPT_DIR%web" && call npm run build
    if errorlevel 1 (
        echo [ERROR] Frontend build failed
        pause
        exit /b 1
    )
    echo.
)

if not exist "%SCRIPT_DIR%server\dist" (
    echo [build] Building server...
    cd /d "%SCRIPT_DIR%server" && call npm run build
    if errorlevel 1 (
        echo [ERROR] Server build failed
        pause
        exit /b 1
    )
    echo.
)

:: Start server in background, suppress its auto-open browser
echo [start] Starting server for configuration...
set "ULTRAPLAN_NO_BROWSER=1"
start "" /b node "%SCRIPT_DIR%server\dist\index.js"

:: Wait for server to be ready (max 10s)
set "RETRIES=0"
:wait_loop
if %RETRIES% GEQ 20 (
    echo [ERROR] Server failed to start within 10s
    pause
    exit /b 1
)
timeout /t 0 /nobreak >nul 2>nul
curl -s -o nul "http://localhost:%PORT%/api/config" 2>nul
if errorlevel 1 (
    set /a RETRIES+=1
    timeout /t 1 /nobreak >nul 2>nul
    goto wait_loop
)

echo [open] %URL%
start "" "%URL%"
