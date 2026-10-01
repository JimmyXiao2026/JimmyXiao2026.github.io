@echo off
chcp 936 >nul
cd /d "%~dp0"

echo === 一键推送 GitHub ===
git add .
git commit -m "update %date% %time%"
git push

if %errorlevel%==0 (
    echo.
    echo 推送成功！
) else (
    echo.
    echo 推送失败，请检查网络或 Watt Toolkit 是否开启。
)
pause
