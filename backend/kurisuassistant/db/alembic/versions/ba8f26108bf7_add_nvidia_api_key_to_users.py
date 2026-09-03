"""add_nvidia_api_key_to_users

Revision ID: ba8f26108bf7
Revises: e65c290cdcd6
Create Date: 2026-03-23 07:14:00.487985

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'ba8f26108bf7'
down_revision: Union[str, Sequence[str], None] = 'e65c290cdcd6'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    # e65c290cdcd6 already adds this column on a fresh database; production ran
    # an earlier version of that migration without it.
    columns = [c['name'] for c in sa.inspect(op.get_bind()).get_columns('users')]
    if 'nvidia_api_key' not in columns:
        op.add_column('users', sa.Column('nvidia_api_key', sa.String(), nullable=True))


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_column('users', 'nvidia_api_key')
