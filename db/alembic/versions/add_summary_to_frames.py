"""Add summary column to frames table

Revision ID: add_summary_to_frames
Revises: add_face_recognition_tables
Create Date: 2026-02-14
"""
from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = 'add_summary_to_frames'
down_revision = 'add_face_recognition_tables'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column('frames', sa.Column('summary', sa.Text(), nullable=True))


def downgrade() -> None:
    op.drop_column('frames', 'summary')
