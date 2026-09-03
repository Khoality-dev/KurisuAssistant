@echo off
echo Stopping llm-hub on port 15597...

for /f "tokens=5" %%a in ('netstat -ano ^| findstr :15597 ^| findstr LISTENING') do (
    echo Killing process %%a
    taskkill /F /PID %%a >nul 2>&1
)

echo Done.
