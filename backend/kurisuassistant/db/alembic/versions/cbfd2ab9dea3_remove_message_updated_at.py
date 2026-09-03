"""remove_message_updated_at

Revision ID: cbfd2ab9dea3
Revises: d4e8f92a3b1c
Create Date: 2025-12-15 20:24:53.064924

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'cbfd2ab9dea3'
down_revision: Union[str, Sequence[str], None] = 'd4e8f92a3b1c'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    # Drop updated_at column from messages table
    op.drop_column('messages', 'updated_at')


def downgrade() -> None:
    """Downgrade schema."""
    # Add updated_at column back to messages table
    op.add_column('messages', sa.Column('updated_at', sa.DateTime(), nullable=True))
    # Set default values for existing rows
    op.execute("UPDATE messages SET updated_at = created_at WHERE updated_at IS NULL")
