#!/usr/bin/env bash
# Move a KurisuAssistant deployment's Docker volumes to the Amadeus names (#378).
#
# Run from backend/ of the new checkout, after stopping the old stack without
# removing its volumes:  docker compose -p kurisuassistant down
#
#   ./scripts/migrate_from_kurisu.sh [from_project] [to_project]
#
# Each <from>_<volume> is copied to <to>_<volume>; a target that already exists
# is skipped and nothing is deleted. On the copied Postgres volume the old
# `kurisu` database and role are renamed to the deployment's POSTGRES_DB and
# POSTGRES_USER and the role is given POSTGRES_PASSWORD — read, as Compose reads
# them, from the environment or else from ./.env, else the new defaults.
set -euo pipefail

from_project="${1:-kurisuassistant}"
to_project="${2:-amadeus}"

# The value Compose would use: the environment first, then ./.env.
setting() {
  local name="$1" fallback="$2" value=""
  if [[ -n "${!name:-}" ]]; then
    printf '%s' "${!name}"
    return
  fi
  if [[ -f .env ]]; then
    value="$(sed -n "s/^[[:space:]]*${name}[[:space:]]*=[[:space:]]*//p" .env | tail -n 1)"
    value="${value%$'\r'}"
    value="${value#\"}"; value="${value%\"}"
    value="${value#\'}"; value="${value%\'}"
  fi
  printf '%s' "${value:-$fallback}"
}

target_user="$(setting POSTGRES_USER amadeus)"
target_password="$(setting POSTGRES_PASSWORD amadeus)"
target_db="$(setting POSTGRES_DB amadeus)"
postgres_image="${POSTGRES_IMAGE:-pgvector/pgvector:pg16}"
postgres_target="${to_project}_postgres-data"
postgres_copied=false

if [[ "$from_project" == "$to_project" ]]; then
  echo "Source and target Compose projects must differ." >&2
  exit 2
fi

mapfile -t source_volumes < <(
  docker volume ls --format '{{.Name}}' | awk -v prefix="${from_project}_" 'index($0, prefix) == 1'
)

if ((${#source_volumes[@]} == 0)); then
  echo "No volumes named ${from_project}_* were found." >&2
  exit 1
fi

for source in "${source_volumes[@]}"; do
  suffix="${source#"${from_project}"_}"
  target="${to_project}_${suffix}"
  if docker volume inspect "$target" >/dev/null 2>&1; then
    echo "skip  $target (already exists)"
    continue
  fi
  docker volume create "$target" >/dev/null
  echo "copy  $source -> $target"
  if ! docker run --rm \
      -v "$source:/from:ro" -v "$target:/to" \
      alpine:3.20 sh -c 'cp -a /from/. /to/'; then
    docker volume rm "$target" >/dev/null
    echo "Copy failed; removed the incomplete target $target." >&2
    exit 1
  fi
  [[ "$target" == "$postgres_target" ]] && postgres_copied=true
done

if [[ "$postgres_copied" == true ]]; then
  container="amadeus-volume-migration-$$"
  cleanup() { docker rm -f "$container" >/dev/null 2>&1 || true; }
  trap cleanup EXIT
  echo "start $postgres_image temporarily to rename the copied database and role"
  docker run --rm -d --name "$container" \
    -v "$postgres_target:/var/lib/postgresql/data" \
    "$postgres_image" >/dev/null

  ready=false
  for _ in {1..60}; do
    if docker exec "$container" pg_isready -d postgres >/dev/null 2>&1; then ready=true; break; fi
    sleep 1
  done
  if [[ "$ready" != true ]]; then
    echo "The copied Postgres did not start; the copies are kept, nothing was renamed." >&2
    exit 1
  fi

  # Local connections inside the container are trusted, so any existing role
  # will do: the old default if it is there, else the deployment's own user.
  connect_user=kurisu
  if ! docker exec "$container" psql -U kurisu -d postgres -tAc 'SELECT 1' >/dev/null 2>&1; then
    connect_user="$target_user"
  fi

  docker exec -i "$container" psql -v ON_ERROR_STOP=1 -U "$connect_user" -d postgres \
    --set=target_user="$target_user" --set=target_db="$target_db" \
    --set=target_password="$target_password" <<'SQL'
SELECT format('ALTER DATABASE %I RENAME TO %I', 'kurisu', :'target_db')
WHERE :'target_db' <> 'kurisu'
  AND EXISTS (SELECT 1 FROM pg_database WHERE datname = 'kurisu')
  AND NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = :'target_db') \gexec
SELECT format('ALTER ROLE %I RENAME TO %I', 'kurisu', :'target_user')
WHERE :'target_user' <> 'kurisu'
  AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kurisu')
  AND NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'target_user')
  AND current_user <> 'kurisu' \gexec
SQL
  # A role cannot rename itself while connected as it, so when the old default
  # was the only way in, rename it from a temporary superuser.
  if [[ "$connect_user" == kurisu && "$target_user" != kurisu ]]; then
    docker exec -i "$container" psql -v ON_ERROR_STOP=1 -U kurisu -d postgres \
      --set=target_user="$target_user" <<'SQL'
SELECT 'CREATE ROLE amadeus_migration_tmp SUPERUSER LOGIN'
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'amadeus_migration_tmp') \gexec
SQL
    docker exec -i "$container" psql -v ON_ERROR_STOP=1 -U amadeus_migration_tmp -d postgres \
      --set=target_user="$target_user" <<'SQL'
SELECT format('ALTER ROLE %I RENAME TO %I', 'kurisu', :'target_user')
WHERE EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kurisu')
  AND NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'target_user') \gexec
SQL
    docker exec -i "$container" psql -v ON_ERROR_STOP=1 -U "$target_user" -d postgres \
      -c 'DROP ROLE amadeus_migration_tmp'
  fi
  docker exec -i "$container" psql -v ON_ERROR_STOP=1 -U "$target_user" -d postgres \
    --set=target_user="$target_user" --set=target_password="$target_password" <<'SQL'
SELECT format('ALTER ROLE %I PASSWORD %L', :'target_user', :'target_password') \gexec
SQL
  cleanup
  trap - EXIT
  echo "database and role are now $target_db / $target_user, with the configured password"
else
  echo "skip  $postgres_target database rename (target existed or no source Postgres volume)"
fi

echo
echo "Migration complete. Start and verify the $to_project stack before removing anything."
echo "The source volumes were not changed. After verification, remove them explicitly with:"
printf '  docker volume rm'
printf ' %q' "${source_volumes[@]}"
printf '\n'
echo "The ./data bind mount needs no migration."
