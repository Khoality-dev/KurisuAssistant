"""add context_size to users

Revision ID: 7366c53f6dde
Revises: 4a3e80dc6c45
Create Date: 2026-03-10 00:41:47.484714

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '7366c53f6dde'
down_revision: Union[str, Sequence[str], None] = '4a3e80dc6c45'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.add_column('users', sa.Column('context_size', sa.Integer(), nullable=True))


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_column('users', 'context_size')
