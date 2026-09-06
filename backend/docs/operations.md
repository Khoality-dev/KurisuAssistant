# Operations

Running a deployment over time: backing it up, updating it, taking it down, and
the things about it that will surprise you. Getting one running in the first
place is the deployment tutorial in the [root README](../../README.md), which is
the whole of the user documentation and deliberately stops at a working server.

Everything here runs from `backend/`.

## Accounts

Nothing is seeded. Anyone may register — that is open by default — and the
account they create is **inactive**: it can hold a password and nothing else.
Every authenticated route, the chat socket, the image routes and token refresh
refuse it until you say otherwise, and you say so in the database.

See who is waiting (the API also logs this at startup):

```bash
docker compose exec -T postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"' <<'SQL'
SELECT username, is_active FROM users ORDER BY id;
SQL
```

Activate one:

```bash
docker compose exec -T postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"' <<'SQL'
UPDATE users SET is_active = true WHERE username = 'name';
SQL
```

Revoking is the same statement with `false`, and it takes effect on that
account's next request rather than when its token expires.

This replaced a seeded `admin` / `admin` account whose password no endpoint
could change and which came back on the next start if you deleted it (#148).
There is still no password-change endpoint: someone who forgets theirs needs a
new row, or a new hash written into the old one.

## Back up

The database, `data/` and the environment file are **one unit**. Rows are handles
to files: `personas.avatar_uuid`, `face_photos.photo_uuid` and `messages.images`
all name files under `data/`. Restoring a database beside an older `data/` is
destructive rather than merely lossy — persona asset cleanup deletes files the
restored configuration does not reference. And `data/jwt_secret.key` has to
survive, or every signed-in client is logged out.

```bash
set -a; . ./.env; set +a
OUT=/backup/kurisu-$(date -u +%Y%m%dT%H%M%SZ); mkdir -p "$OUT"
git rev-parse HEAD > "$OUT/commit"
docker compose stop api
docker compose exec -T postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
  -tAc 'select version_num from alembic_version' > "$OUT/alembic_version"
docker compose exec -T postgres pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc > "$OUT/kurisu.dump"
sudo tar -C . -czf "$OUT/data.tar.gz" data
cp .env "$OUT/env"
[ -d nginx/certs ] && sudo tar -C . -czf "$OUT/nginx-certs.tar.gz" nginx/certs
docker compose start api
chmod 600 "$OUT/env" "$OUT/data.tar.gz"
```

`sudo` because the API container runs as root, so everything under `data/` is
root-owned on the host. Stopping the API first is what makes the dump and the
archive describe the same moment.

Both artefacts are credential stores: the archive holds the session signing key,
the dump holds each user's provider API keys in plain columns, and the
environment file holds the database password.

With `--profile voice`, also archive `${VIXTTS_ROOT}/models` and
`${UVOICE_ROOT}/data`; with `--profile sovits`, `data/sovits/weights`.

## Restore

`data/` must be in place **before the API starts**, or it generates a new signing
key and every existing session dies.

```bash
cd <deployment>/backend
cp /backup/<stamp>/env .env && set -a && . ./.env && set +a
docker compose down
docker volume rm kurisuassistant_postgres-data
sudo rm -rf data && sudo tar -C . -xzf /backup/<stamp>/data.tar.gz
docker compose up -d postgres
until docker compose exec -T postgres pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB"; do sleep 2; done
docker compose exec -T postgres pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
  --no-owner --clean --if-exists < /backup/<stamp>/kurisu.dump
docker compose up -d --build api && docker compose logs -f api
```

The volume is `kurisuassistant_postgres-data`, not `postgres-data`: the project
name is pinned, so Compose prefixes it. Removing it is what lets `initdb` apply
the credentials from the restored environment file.

Restoring into a **newer** deployment is fine — migrations run forward on start.
Restoring into an **older** one is not supported; check out the commit recorded
in `commit` if you are rolling back.

Check afterwards: `data/jwt_secret.key` still carries the backup's timestamp (a
fresh one means the API started first), `alembic_version` is the recorded
revision or later, and a client that was already signed in still works without
logging in again.

## Update

Back up first. Migrations run on container start and are forward-only.

```bash
git fetch --tags && git checkout backend-vX.Y.Z && docker compose up -d --build
```

`--build` is what ships the code; `up -d` alone reuses the old image.

**When a release moves `WIRE_PROTOCOL`, publish the clients first.** A backend
ahead of an installed client shows that client an "Update required" screen with
no way back (#150). `GET /version` reports both numbers.

Postgres is pinned to `pgvector/pgvector:pg16`. Changing that tag to a newer
major version is not an upgrade path — the new server refuses to start on the old
data directory. Use the backup and restore procedure with the new image between
the dump and the reload.

## Stop and remove

- `docker compose stop` — containers down, everything kept.
- `docker compose down` — containers removed, named volumes kept.
- `docker compose down -v` — **deletes the database volume**: every account,
  conversation and memory. It does not touch `data/`, so what is left is a
  half-deleted installation rather than a clean reset.

To remove everything: `docker compose down -v`, then `sudo rm -rf data`.

## Things that will surprise you

**The bundled TLS authenticates nothing.** Both clients accept any certificate
for any hostname — the desktop through Electron's `certificate-error` handler,
Android through a trust-everything manager. That is what makes a self-signed
certificate work without installing it on each device. So `--profile tls` stops
passive listening on the same network and stops nothing else. Anything reachable
from the internet wants a real certificate and a proxy you configure yourself.

**There is no admin role**, and no account is special. "Operator" means whoever
can reach the database; that is the only privilege the system recognises. Every
account sees only its own data.

**A server-wide provider key is spendable by every account**, whether or not that
provider appears in their model picker: a user can point their assistant at the
provider and the key is used as the fallback.

**Behind a proxy the login rate limiter collapses to one bucket** (#155): it keys
on the socket peer, and uvicorn runs without `--proxy-headers`.

**The vision pipeline needs a GPU the base stack does not reserve** (#152).

**Logs are capped** at 10 MB × 5 per service. They were unbounded.

## What persists

| | Where | Loss means |
| --- | --- | --- |
| Accounts, conversations, memory, personas | volume `kurisuassistant_postgres-data` | everything textual |
| Images, avatars, face photos, voices, character assets | `backend/data/` | the media those rows point at |
| Session signing key | `backend/data/jwt_secret.key` | every client signed out |
| Database password, provider keys | `backend/.env` | the API cannot open its own database |
| TLS certificate | `backend/nginx/certs/` | regenerate with the script |

Model caches under `data/` (`face_recognition/models/`, `gesture_detection/models/`)
are re-downloaded on demand and need no backup.
