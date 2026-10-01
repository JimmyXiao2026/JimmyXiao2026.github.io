@echo off
cd /d "%~dp0"

echo === One-click push to GitHub ===
git add .
git commit -m "update %date% %time%"
git push

if %errorlevel%==0 (
    echo.
    echo [OK] Pushed successfully.
) else (
    echo.
    echo [FAIL] Push failed. Check network or enable Watt Toolkit.
)
pause
