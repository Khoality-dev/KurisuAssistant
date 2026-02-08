#!/bin/bash
set -e

echo "Waiting for PostgreSQL to be ready..."
until python -c "from db.session import engine; engine.connect()" 2>/dev/null; do
  echo "PostgreSQL is unavailable - sleeping"
  sleep 2
done

echo "PostgreSQL is up - running migrations"
if python migrate.py; then
    echo "Migrations completed successfully"
else
    echo "Migration failed with exit code $?"
    exit 1
fi

echo "Starting application..."
exec uvicorn main:app --host 0.0.0.0 --port 15597
