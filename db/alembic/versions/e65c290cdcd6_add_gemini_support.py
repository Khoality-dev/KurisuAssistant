"""add_gemini_support

Revision ID: e65c290cdcd6
Revises: 7366c53f6dde
Create Date: 2026-03-22
"""
import sqlalchemy as sa
from alembic import op

revision = 'e65c290cdcd6'
down_revision = '7366c53f6dde'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column('users', sa.Column('gemini_api_key', sa.String(), nullable=True))
    op.add_column('agents', sa.Column('provider_type', sa.String(), nullable=False, server_default='ollama'))


def downgrade() -> None:
    op.drop_column('agents', 'provider_type')
    op.drop_column('users', 'gemini_api_key')
