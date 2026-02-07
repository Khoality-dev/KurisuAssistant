"""Add name field to messages

Revision ID: add_name_to_messages
Revises: 9ec2a635a335
Create Date: 2026-02-07
"""
from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = 'add_name_to_messages'
down_revision = '9ec2a635a335'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column('messages', sa.Column('name', sa.String(), nullable=True))


def downgrade() -> None:
    op.drop_column('messages', 'name')
