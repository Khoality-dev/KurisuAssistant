"""remove_user_avatar_uuid

Revision ID: 95da57f8d547
Revises: b239e1d93828
Create Date: 2026-03-03 20:56:38.058291

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '95da57f8d547'
down_revision: Union[str, Sequence[str], None] = 'b239e1d93828'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.drop_column('users', 'user_avatar_uuid')


def downgrade() -> None:
    """Downgrade schema."""
    op.add_column('users', sa.Column('user_avatar_uuid', sa.VARCHAR(), autoincrement=False, nullable=True))
