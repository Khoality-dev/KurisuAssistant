"""Add gemini_api_key to users and provider_type to agents

Revision ID: add_gemini_support
Revises: rename_tools_to_excluded_tools
Create Date: 2026-03-22
"""
import sqlalchemy as sa
from alembic import op

revision = 'add_gemini_support'
down_revision = 'rename_tools_to_excluded_tools'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column('users', sa.Column('gemini_api_key', sa.String(), nullable=True))
    op.add_column('agents', sa.Column('provider_type', sa.String(), nullable=False, server_default='ollama'))


def downgrade() -> None:
    op.drop_column('agents', 'provider_type')
    op.drop_column('users', 'gemini_api_key')
