"""fix_users_id_sequence

Revision ID: 16a129919a0c
Revises: 7038b249d1a4
Create Date: 2026-04-13 06:19:02.947372

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '16a129919a0c'
down_revision: Union[str, Sequence[str], None] = '7038b249d1a4'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    # Create sequence for users.id
    op.execute("CREATE SEQUENCE IF NOT EXISTS users_id_seq")

    # Set the sequence value to max(id) + 1 (or 1 if no rows)
    op.execute("SELECT setval('users_id_seq', COALESCE((SELECT MAX(id) FROM users), 0) + 1, false)")

    # Set the column default to use the sequence
    op.execute("ALTER TABLE users ALTER COLUMN id SET DEFAULT nextval('users_id_seq')")

    # Own the sequence to the column
    op.execute("ALTER SEQUENCE users_id_seq OWNED BY users.id")


def downgrade() -> None:
    """Downgrade schema."""
    op.execute("ALTER TABLE users ALTER COLUMN id DROP DEFAULT")
    op.execute("DROP SEQUENCE IF EXISTS users_id_seq")
