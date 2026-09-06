"""Database initialization and migration utilities."""

import os
import logging
from alembic.config import Config
from alembic import command

from .session import get_session
from .repositories import UserRepository

logger = logging.getLogger(__name__)


def init_db():
    """Initialize the database: run Alembic migrations.

    A migration failure propagates. There is deliberately no fallback to
    ``Base.metadata.create_all``: it used to mask broken migrations by building
    the current schema without an Alembic version, which left every later
    start failing the same way.

    **Nothing is seeded.** This used to create an ``admin`` / ``admin`` account,
    which was a published password that no endpoint could change, and which came
    back on the next start if the operator deleted it (#148). Accounts are made
    by registering; each one is inactive until the operator activates it:

        UPDATE users SET is_active = true WHERE username = 'name';

    A fresh server therefore has no accounts and no way in until someone
    registers — which is the intended state, not a broken one.
    """
    logger.info("Initializing database with Alembic migrations...")

    alembic_ini_path = os.path.join(os.path.dirname(__file__), "alembic.ini")
    alembic_cfg = Config(alembic_ini_path)
    alembic_cfg.set_main_option("script_location", os.path.join(os.path.dirname(__file__), "alembic"))

    logger.info(f"Running Alembic migrations from: {alembic_ini_path}")
    command.upgrade(alembic_cfg, "head")
    logger.info("Alembic migrations completed successfully")

    _log_activation_hint()
    _warn_on_default_admin_password()

    logger.info("Database initialization completed successfully")


def _log_activation_hint() -> None:
    """Tell the operator what to do when accounts are waiting.

    Registration is open, activation is manual, and the only place the two meet
    is the database — so a server with nobody activated needs to say so
    somewhere the operator is already looking.
    """
    try:
        with get_session() as session:
            user_repo = UserRepository(session)
            waiting = [u.username for u in user_repo.list_inactive()]
            if not waiting:
                return
            logger.warning(
                "=" * 72
                + f"\n{len(waiting)} account(s) waiting for activation: {', '.join(waiting)}\n"
                "Activate one with:\n"
                "  UPDATE users SET is_active = true WHERE username = 'name';\n"
                + "=" * 72
            )
    except Exception:
        # Never worth failing startup for.
        logger.debug("Could not list inactive accounts", exc_info=True)


def _warn_on_default_admin_password() -> None:
    """Keep shouting about a password this project used to publish.

    Removing the seed does nothing for servers that already ran it: their
    ``admin`` account survives the upgrade with whatever password it has, and
    the activation backfill marks it active. If that password is still the
    published one, the only thing standing between the server and anyone who
    can reach the port is that nobody has tried — and there is still no
    endpoint to change it (#148), so the operator has to write a new hash.
    """
    from kurisuassistant.core.security import verify_password

    try:
        with get_session() as session:
            admin = UserRepository(session).get_by_username("admin")
            if admin and admin.is_active and verify_password("admin", admin.password):
                logger.warning(
                    "=" * 72
                    + "\nSECURITY: the 'admin' account still has the published default password.\n"
                    "Nothing seeds it any more, but this server was created when something did.\n"
                    "Deactivate it, or replace its password hash:\n"
                    "  UPDATE users SET is_active = false WHERE username = 'admin';\n"
                    + "=" * 72
                )
    except Exception:
        logger.debug("Could not check the admin password", exc_info=True)
