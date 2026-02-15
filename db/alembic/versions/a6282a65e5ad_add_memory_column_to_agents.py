"""add memory column to agents

Revision ID: a6282a65e5ad
Revises: 902de88d379e
Create Date: 2026-02-14 23:58:53.418270

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'a6282a65e5ad'
down_revision: Union[str, Sequence[str], None] = '902de88d379e'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.add_column('agents', sa.Column('memory', sa.Text(), nullable=True))


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_column('agents', 'memory')
