"""add_poe_api_key_to_users

One more write-only provider key on ``users``, next to ``gemini_api_key`` and
``nvidia_api_key``. Autogenerate also proposed dropping the HNSW index on
``face_photos.embedding`` because the model does not declare it; that is
unrelated (see #95) and was removed from this revision.

Revision ID: 485f1296faf8
Revises: 0dacee9f63b8
Create Date: 2026-09-05 22:12:57.864916

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '485f1296faf8'
down_revision: Union[str, Sequence[str], None] = '0dacee9f63b8'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.add_column('users', sa.Column('poe_api_key', sa.String(), nullable=True))


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_column('users', 'poe_api_key')
