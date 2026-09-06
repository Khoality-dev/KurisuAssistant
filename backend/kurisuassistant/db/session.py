import os
from contextlib import contextmanager
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker, Session
from sqlalchemy.pool import QueuePool

# Construct DATABASE_URL from individual environment variables
POSTGRES_USER = os.getenv("POSTGRES_USER", "kurisu")
POSTGRES_PASSWORD = os.getenv("POSTGRES_PASSWORD", "kurisu")
POSTGRES_HOST = os.getenv("POSTGRES_HOST", "localhost")
POSTGRES_PORT = os.getenv("POSTGRES_PORT", "5432")
POSTGRES_DB = os.getenv("POSTGRES_DB", "kurisu")

DATABASE_URL = f"postgresql://{POSTGRES_USER}:{POSTGRES_PASSWORD}@{POSTGRES_HOST}:{POSTGRES_PORT}/{POSTGRES_DB}"

# Ceilings on the two ways a database can hold the db-service thread forever
# (#153): accepting TCP and never finishing the handshake, and running one
# pathological query indefinitely. Both are libpq settings, so they cover
# every session on this engine and nothing else — Alembic builds its own engine
# and a migration may legitimately take longer than a statement.
CONNECT_TIMEOUT_SECONDS = int(os.getenv("DB_CONNECT_TIMEOUT_SECONDS", "5"))
STATEMENT_TIMEOUT_SECONDS = int(os.getenv("DB_STATEMENT_TIMEOUT_SECONDS", "30"))


def connect_args(connect_timeout: int = CONNECT_TIMEOUT_SECONDS,
                 statement_timeout: int = STATEMENT_TIMEOUT_SECONDS) -> dict:
    """psycopg2 connection arguments; ``0`` disables the statement timeout."""
    args: dict = {"connect_timeout": connect_timeout}
    if statement_timeout > 0:
        args["options"] = f"-c statement_timeout={statement_timeout * 1000}"
    return args


# Create engine with connection pooling
engine = create_engine(
    DATABASE_URL,
    poolclass=QueuePool,
    pool_size=10,
    max_overflow=20,
    pool_pre_ping=True,  # Verify connections before using
    pool_recycle=3600,   # Recycle connections after 1 hour
    connect_args=connect_args(),
)

# Create session factory
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)


@contextmanager
def get_session() -> Session:
    """Context manager for database sessions.

    Usage:
        with get_session() as session:
            user = session.query(User).filter_by(username='admin').first()
    """
    session = SessionLocal()
    try:
        yield session
        session.commit()
    except Exception:
        session.rollback()
        raise
    finally:
        session.close()


def get_db_session() -> Session:
    """Get a new database session. Caller is responsible for closing it.

    Use get_session() context manager instead when possible.
    """
    return SessionLocal()
