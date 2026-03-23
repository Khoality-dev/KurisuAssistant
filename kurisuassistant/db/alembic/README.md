# Database Migrations

This directory contains Alembic database migrations for the Kurisu Assistant project.

## Usage

All commands should be run from the `db/` directory:

```bash
cd db
```

### Create a new migration

```bash
alembic revision --autogenerate -m "description of changes"
```

### Apply migrations

```bash
# Upgrade to latest
alembic upgrade head

# Upgrade/downgrade to specific revision
alembic upgrade <revision>
alembic downgrade <revision>
```

### View migration history

```bash
alembic history
alembic current
```

## Configuration

- `alembic.ini`: Configuration file
- `alembic/env.py`: Migration environment setup
- `alembic/versions/`: Migration scripts

Database URL is read from the `DATABASE_URL` environment variable, defaulting to `postgresql://kurisu:kurisu@localhost:5432/kurisu`.
