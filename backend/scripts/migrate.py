"""Database migration script.

Run this before starting the application to ensure the database schema is up-to-date.

Usage:
    python -m scripts.migrate
"""
import logging
import sys

import dotenv

# db.session reads POSTGRES_* at import time, so the environment file has to be
# loaded first — otherwise a local `python -m scripts.migrate` silently migrates
# whatever is at the hardcoded default (localhost:5432, kurisu/kurisu) instead of
# the database configured for the deployment.
dotenv.load_dotenv()

from kurisuassistant.db.init import init_db

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)


def main():
    """Run database migrations."""
    logger.info("Starting database migrations...")

    try:
        init_db()
        logger.info("✓ Database migrations completed successfully")
        return 0
    except Exception as e:
        logger.error(f"✗ Migration failed: {e}")
        return 1


if __name__ == "__main__":
    sys.exit(main())
