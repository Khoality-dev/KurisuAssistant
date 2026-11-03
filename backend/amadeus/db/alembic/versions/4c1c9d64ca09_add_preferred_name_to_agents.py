"""add_preferred_name_to_agents

Revision ID: 4c1c9d64ca09
Revises: 95da57f8d547
Create Date: 2026-03-03 21:23:18.119629

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '4c1c9d64ca09'
down_revision: Union[str, Sequence[str], None] = '95da57f8d547'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.add_column('agents', sa.Column('preferred_name', sa.Text(), nullable=True))


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_column('agents', 'preferred_name')
