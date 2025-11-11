"""Add avatar UUIDs to user table

Revision ID: 3a040bb577f9
Revises: c0b02d56d7ff
Create Date: 2025-08-03 22:41:12.338491

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '3a040bb577f9'
down_revision: Union[str, Sequence[str], None] = 'c0b02d56d7ff'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.add_column('users', sa.Column('user_avatar_uuid', sa.String(), nullable=True))
    op.add_column('users', sa.Column('agent_avatar_uuid', sa.String(), nullable=True))


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_column('users', 'agent_avatar_uuid')
    op.drop_column('users', 'user_avatar_uuid')
