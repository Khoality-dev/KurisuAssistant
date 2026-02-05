"""Database initialization and migration utilities."""

import os
import logging
from alembic.config import Config
from alembic import command

from .session import get_session, engine
from .base import Base
from .repositories import UserRepository
from core.security import hash_password

logger = logging.getLogger(__name__)


def init_db():
    """Initialize database using Alembic migrations."""
    logger.info("Initializing database with Alembic migrations...")

    try:
        # Run Alembic migrations to create/update schema
        alembic_ini_path = os.path.join(os.path.dirname(__file__), "alembic.ini")
        alembic_cfg = Config(alembic_ini_path)
        alembic_cfg.set_main_option("script_location", os.path.join(os.path.dirname(__file__), "alembic"))

        logger.info(f"Running Alembic migrations from: {alembic_ini_path}")

        command.upgrade(alembic_cfg, "head")
        logger.info("Alembic migrations completed successfully")

        # Ensure default admin account exists
        with get_session() as session:
            user_repo = UserRepository(session)
            if not user_repo.admin_exists():
                logger.info("Creating default admin account")
                user_repo.create_user("admin", hash_password("admin"))
            else:
                logger.info("Admin account already exists")

        logger.info("Database initialization completed successfully")
    except Exception as e:
        logger.error(f"Error running Alembic migrations: {e}")
        logger.warning("Falling back to manual schema creation...")
        _init_db_manual()


def _init_db_manual():
    """Fallback manual database initialization."""
    try:
        Base.metadata.create_all(bind=engine)

        with get_session() as session:
            user_repo = UserRepository(session)
            if not user_repo.admin_exists():
                user_repo.create_user("admin", hash_password("admin"))

        logger.info("Database initialized using manual schema creation")
    except Exception as e:
        logger.error(f"Error in manual database initialization: {e}")
        raise
