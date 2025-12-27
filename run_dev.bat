@echo off

REM Set virtual environment paths
set VENV_PYTHON=venv\Scripts\python.exe
set VENV_PIP=venv\Scripts\pip.exe

REM Activate virtual environment
if not exist "%VENV_PYTHON%" (
    echo Virtual environment not found. Creating venv...
    python -m venv venv
    echo Installing requirements...
    %VENV_PIP% install -r requirements.txt
)

REM Environment variables for local development
set LLM_API_URL=https://10.0.0.122:11434
set POSTGRES_USER=kurisu
set POSTGRES_PASSWORD=kurisu
set POSTGRES_HOST=localhost
set POSTGRES_PORT=5432
set POSTGRES_DB=kurisu
set JWT_SECRET_KEY=your-secret-key-change-in-production
set ACCESS_TOKEN_EXPIRE_DAYS=30

REM Run migrations first
echo Running database migrations...
%VENV_PYTHON% migrate.py
if %errorlevel% neq 0 (
    echo Migration failed!
    pause
    exit /b %errorlevel%
)

REM Start the application
echo Starting llm-hub application...
%VENV_PYTHON% -m uvicorn main:app --host 0.0.0.0 --port 15597 --reload
