@echo off
SETLOCAL EnableDelayedExpansion

set "SCRIPT_NAME=build-vsix.sh"

:: Anchor to this script's own folder, so the "./build-vsix.sh" below resolves whether this is
:: double-clicked from scripts\ or invoked as scripts\run-build.bat from the repo root.
:: (build-vsix.sh then cd's up to the repo root itself.)
cd /d "%~dp0"

echo [BATCH] Looking for Git Bash to execute %SCRIPT_NAME%...

:: 1. Check standard absolute Git Bash installation paths FIRST (Bypasses broken system PATHs)
set "LOOKUP_PATHS[0]=%ProgramFiles%\Git\bin\bash.exe"
set "LOOKUP_PATHS[1]=%ProgramFiles(x86)%\Git\bin\bash.exe"
set "LOOKUP_PATHS[2]=%LocalAppData%\Programs\Git\bin\bash.exe"

for /L %%i in (0,1,2) do (
    if exist "!LOOKUP_PATHS[%%i]!" (
        echo [BATCH] Found explicit Git Bash at: "!LOOKUP_PATHS[%%i]!"
        "!LOOKUP_PATHS[%%i]!" --login -i -c "./%SCRIPT_NAME%"
        goto :END
    )
)

:: 2. Fallback to system PATH bash if absolute paths weren't found
where bash >nul 2>nul
if %ERRORLEVEL% equ 0 (
    echo [BATCH] Found bash in system PATH. Executing with script flags...
    bash -c "./%SCRIPT_NAME%"
    goto :END
)

echo ❌ Error: Could not find a working Git Bash environment.
pause
exit /b 1

:END
echo.
echo [BATCH] Script execution finished.
pause