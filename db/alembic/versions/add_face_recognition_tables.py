"""Add face_identities and face_photos tables with pgvector

Revision ID: add_face_recognition_tables
Revises: add_character_config_to_agents
Create Date: 2026-02-10
"""
from alembic import op
import sqlalchemy as sa
from pgvector.sqlalchemy import Vector


# revision identifiers, used by Alembic.
revision = 'add_face_recognition_tables'
down_revision = 'add_character_config_to_agents'
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Enable pgvector extension
    op.execute('CREATE EXTENSION IF NOT EXISTS vector')

    op.create_table(
        'face_identities',
        sa.Column('id', sa.Integer(), primary_key=True),
        sa.Column('user_id', sa.Integer(), sa.ForeignKey('users.id'), nullable=False),
        sa.Column('name', sa.String(), nullable=False),
        sa.Column('created_at', sa.DateTime(), server_default=sa.func.now()),
        sa.UniqueConstraint('user_id', 'name', name='uq_face_identity_user_id_name'),
    )

    op.create_table(
        'face_photos',
        sa.Column('id', sa.Integer(), primary_key=True),
        sa.Column('identity_id', sa.Integer(), sa.ForeignKey('face_identities.id', ondelete='CASCADE'), nullable=False),
        sa.Column('embedding', Vector(512), nullable=False),
        sa.Column('photo_uuid', sa.String(), nullable=False),
        sa.Column('created_at', sa.DateTime(), server_default=sa.func.now()),
    )

    # Create HNSW index for fast cosine similarity search
    op.execute(
        'CREATE INDEX ix_face_photos_embedding_hnsw ON face_photos '
        'USING hnsw (embedding vector_cosine_ops)'
    )


def downgrade() -> None:
    op.execute('DROP INDEX IF EXISTS ix_face_photos_embedding_hnsw')
    op.drop_table('face_photos')
    op.drop_table('face_identities')
