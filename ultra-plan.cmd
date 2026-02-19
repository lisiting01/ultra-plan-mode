@echo off
echo ========================================
echo   Ultra Plan Mode - One-Click Start
echo ========================================
echo.

:: Resolve script directory
set "SCRIPT_DIR=%~dp0"

:: Check directories
if not exist "%SCRIPT_DIR%server" (
    echo [ERROR] server directory not found
    echo [ERROR] Please run this script from project root
    pause
    exit /b 1
)

if not exist "%SCRIPT_DIR%web" (
    echo [ERROR] web directory not found
    echo [ERROR] Please run this script from project root
    pause
    exit /b 1
)

:: Determine project path (first argument or current directory)
if "%~1"=="" (
    set "PROJECT_PATH=%CD%"
) else (
    set "PROJECT_PATH=%~1"
)

:: Determine initial question (second argument, optional)
if "%~2"=="" (
    set "INITIAL_QUESTION="
) else (
    set "INITIAL_QUESTION=%~2"
)

echo [info] Project path: %PROJECT_PATH%
if defined INITIAL_QUESTION (
    echo [info] Initial question: %INITIAL_QUESTION%
)
echo.

:: Build web if needed
if not exist "%SCRIPT_DIR%web\dist" (
    echo [build] Building frontend...
    cd /d "%SCRIPT_DIR%web" && call npm run build
    if errorlevel 1 (
        echo [ERROR] Frontend build failed
        pause
        exit /b 1
    )
    echo [build] Frontend build complete
    echo.
)

:: Build server if needed
if not exist "%SCRIPT_DIR%server\dist" (
    echo [build] Building server...
    cd /d "%SCRIPT_DIR%server" && call npm run build
    if errorlevel 1 (
        echo [ERROR] Server build failed
        pause
        exit /b 1
    )
    echo [build] Server build complete
    echo.
)

:: Start the server (single process - serves both API and static files)
echo [start] Starting Ultra Plan server...
echo [start] Browser will open automatically
echo.
node "%SCRIPT_DIR%server\dist\index.js" "%PROJECT_PATH%" "%INITIAL_QUESTION%"
