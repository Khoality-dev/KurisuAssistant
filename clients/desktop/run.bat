@echo off
@setlocal
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

echo Starting KurisuAssistant Client...
%VENV_PYTHON% main.py
pause