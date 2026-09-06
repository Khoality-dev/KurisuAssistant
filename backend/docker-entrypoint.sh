#!/bin/bash
set -e

# Wait for the database, but bounded and out loud.
#
# This loop used to run forever with stderr thrown away, and the service
# restarts `unless-stopped`, so a wrong POSTGRES_HOST or a bad password looked
# exactly like a slow start: "PostgreSQL is unavailable" every two seconds, for
# ever, with the actual error — the one naming the host or refusing the
# password — discarded. Compose now waits for the database's healthcheck before
# starting this container at all, so reaching the end of this loop means
# something is genuinely misconfigured, and the operator gets told what.
ATTEMPTS=${DB_WAIT_ATTEMPTS:-60}
INTERVAL=${DB_WAIT_INTERVAL:-2}

echo "Waiting for PostgreSQL at ${POSTGRES_HOST:-<unset>}:${POSTGRES_PORT:-<unset>} db=${POSTGRES_DB:-<unset>} user=${POSTGRES_USER:-<unset>}"

attempt=1
while true; do
  if error=$(python -c "from kurisuassistant.db.session import engine; engine.connect()" 2>&1); then
    break
  fi

  if [ "$attempt" -ge "$ATTEMPTS" ]; then
    echo "PostgreSQL still unreachable after ${ATTEMPTS} attempts. Last error:"
    echo "$error" | tail -5
    exit 1
  fi

  # Every fifth attempt, show why — not just that.
  if [ $((attempt % 5)) -eq 0 ]; then
    echo "PostgreSQL unavailable (attempt ${attempt}/${ATTEMPTS}): $(echo "$error" | tail -1)"
  fi

  attempt=$((attempt + 1))
  sleep "$INTERVAL"
done

echo "PostgreSQL is up - running migrations"
if python -m scripts.migrate; then
    echo "Migrations completed successfully"
else
    echo "Migration failed with exit code $?"
    exit 1
fi

echo "Starting application..."
exec uvicorn kurisuassistant.main:app --host 0.0.0.0 --port 15597 --ws-ping-interval 5 --ws-ping-timeout 5
