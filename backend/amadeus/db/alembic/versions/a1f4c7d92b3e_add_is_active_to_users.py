"""add_is_active_to_users

Accounts are created inactive and the operator activates them by hand. This
replaces the seeded ``admin`` / ``admin`` account, which could not have its
password changed and came back if deleted (#148).

Existing rows are backfilled to active. A deployment that upgrades into this
migration has accounts in use, and locking their owners out of their own server
would be a rude way to ship a security fix.

Revision ID: a1f4c7d92b3e
Revises: 485f1296faf8
Create Date: 2026-09-06 03:10:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'a1f4c7d92b3e'
down_revision: Union[str, Sequence[str], None] = '485f1296faf8'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    # Added nullable, backfilled, then made NOT NULL: adding a NOT NULL column
    # with a server default would silently mark existing accounts inactive on
    # any database where the default did not apply retroactively.
    op.add_column('users', sa.Column('is_active', sa.Boolean(), nullable=True))
    op.execute('UPDATE users SET is_active = true WHERE is_active IS NULL')
    op.alter_column(
        'users',
        'is_active',
        existing_type=sa.Boolean(),
        nullable=False,
        server_default=sa.false(),
    )


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_column('users', 'is_active')
