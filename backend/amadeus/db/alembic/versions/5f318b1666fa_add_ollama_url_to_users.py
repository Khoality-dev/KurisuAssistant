"""Add ollama_url field to users

Revision ID: 5f318b1666fa
Revises: b1696c3172de
Create Date: 2025-02-04
"""
from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = '5f318b1666fa'
down_revision = 'b1696c3172de'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column('users', sa.Column('ollama_url', sa.String(), nullable=True))


def downgrade() -> None:
    op.drop_column('users', 'ollama_url')
