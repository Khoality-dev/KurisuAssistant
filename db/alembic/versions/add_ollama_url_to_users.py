"""Add ollama_url field to users

Revision ID: add_ollama_url_to_users
Revises: refactor_user_id_frames
Create Date: 2025-02-04
"""
from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = 'add_ollama_url_to_users'
down_revision = 'refactor_user_id_frames'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column('users', sa.Column('ollama_url', sa.String(), nullable=True))


def downgrade() -> None:
    op.drop_column('users', 'ollama_url')
