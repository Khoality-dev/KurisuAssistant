"""Add memory_enabled to agents

Revision ID: ea77116bd1c6
Revises: rename_tools_to_excluded_tools
Create Date: 2026-02-28 12:17:01.908431

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'ea77116bd1c6'
down_revision: Union[str, Sequence[str], None] = 'rename_tools_to_excluded_tools'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.add_column('agents', sa.Column('memory_enabled', sa.Boolean(), nullable=False, server_default=sa.text('true')))


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_column('agents', 'memory_enabled')
