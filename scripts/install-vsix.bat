@echo off
SETLOCAL EnableDelayedExpansion

:: Installs the most recently built .vsix into VS Code.
:: Run run-build.bat first if you want to package the current source.

:: This script lives in scripts\, but vsce writes the .vsix to the repo ROOT — so anchor there
:: rather than to the script's own folder, or no package is ever found.
cd /d "%~dp0.."

:: 1. Pick the newest .vsix in the repo root, so a stale version can never be installed by accident.
set "VSIX="
for /f "delims=" %%f in ('dir /b /o-d *.vsix 2^>nul') do (
    if not defined VSIX set "VSIX=%%f"
)

if not defined VSIX (
    echo [ERROR] No .vsix found in "%CD%".
    echo         Build one first: scripts\run-build.bat
    pause
    exit /b 1
)

echo [INSTALL] Package: !VSIX!

:: 2. Locate the VS Code CLI, and resolve it to a FULL PATH.
::    Calling it by bare name ("call code ...") must be avoided: cmd then sets %0 to the literal
::    string, so the %~dp0 inside VS Code's own code.cmd resolves against the *current* directory
::    and it hunts for Code.exe next to this repo. That fails with exit 9009.
set "CODE="
for /f "delims=" %%p in ('where code.cmd 2^>nul') do (
    if not defined CODE set "CODE=%%p"
)

:: Fall back to the standard install locations when "Add to PATH" was skipped at install time.
set "LOOKUP[0]=%LocalAppData%\Programs\Microsoft VS Code\bin\code.cmd"
set "LOOKUP[1]=%ProgramFiles%\Microsoft VS Code\bin\code.cmd"
set "LOOKUP[2]=%ProgramFiles(x86)%\Microsoft VS Code\bin\code.cmd"
for /L %%i in (0,1,2) do (
    if not defined CODE (
        if exist "!LOOKUP[%%i]!" set "CODE=!LOOKUP[%%i]!"
    )
)

if not defined CODE (
    echo [ERROR] Could not find the VS Code CLI ^("code"^).
    echo         Open VS Code, press Ctrl+Shift+P, and run:
    echo             Shell Command: Install 'code' command in PATH
    pause
    exit /b 1
)

:: 3. --force installs over an existing copy instead of refusing when the version already exists.
echo [INSTALL] Using CLI: !CODE!
call "!CODE!" --install-extension "!VSIX!" --force
if %ERRORLEVEL% neq 0 (
    echo.
    echo [ERROR] Install failed ^(exit %ERRORLEVEL%^).
    pause
    exit /b %ERRORLEVEL%
)

echo.
echo [OK] Installed !VSIX!
echo      Reload VS Code to pick it up: Ctrl+Shift+P -^> "Developer: Reload Window"
pause
