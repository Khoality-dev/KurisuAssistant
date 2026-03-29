"""add_context_files_to_messages

Revision ID: 659942852e18
Revises: 984ab5611ea6
Create Date: 2026-03-29 22:41:14.845116

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '659942852e18'
down_revision: Union[str, Sequence[str], None] = '984ab5611ea6'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.add_column('messages', sa.Column('context_files', sa.JSON(), nullable=True))


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_column('messages', 'context_files')
