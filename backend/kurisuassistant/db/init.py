"""Database initialization and migration utilities."""

import os
import logging
from alembic.config import Config
from alembic import command

from .session import get_session
from .repositories import UserRepository
from kurisuassistant.core.security import hash_password

logger = logging.getLogger(__name__)


def init_db():
    """Initialize the database: run Alembic migrations, then seed the admin account.

    A migration failure propagates. There is deliberately no fallback to
    ``Base.metadata.create_all``: it used to mask broken migrations by building
    the current schema without an Alembic version, which left every later
    start failing the same way.
    """
    logger.info("Initializing database with Alembic migrations...")

    alembic_ini_path = os.path.join(os.path.dirname(__file__), "alembic.ini")
    alembic_cfg = Config(alembic_ini_path)
    alembic_cfg.set_main_option("script_location", os.path.join(os.path.dirname(__file__), "alembic"))

    logger.info(f"Running Alembic migrations from: {alembic_ini_path}")
    command.upgrade(alembic_cfg, "head")
    logger.info("Alembic migrations completed successfully")

    with get_session() as session:
        user_repo = UserRepository(session)
        if not user_repo.admin_exists():
            logger.info("Creating default admin account")
            user_repo.create_user("admin", hash_password("admin"))
        else:
            logger.info("Admin account already exists")

    logger.info("Database initialization completed successfully")
