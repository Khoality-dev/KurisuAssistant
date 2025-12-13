#!/bin/bash
set -e

echo "Waiting for PostgreSQL to be ready..."
until python -c "from db.session import engine; engine.connect()" 2>/dev/null; do
  echo "PostgreSQL is unavailable - sleeping"
  sleep 2
done

echo "PostgreSQL is up - running migrations"
python migrate.py

echo "Starting application..."
exec "$@"
