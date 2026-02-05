"""Database migration script.

Run this before starting the application to ensure the database schema is up-to-date.

Usage:
    python migrate.py
"""
import logging
import sys
from db.init import init_db

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
