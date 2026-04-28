"""merge_persona_into_agent

Revision ID: 83e667457a0b
Revises: 659942852e18
Create Date: 2026-04-13 02:21:01.632561

Merges Persona identity fields into Agent model:
- Copies voice_reference, avatar_uuid, character_config, preferred_name from linked personas
- Adds agent_type column ('main' or 'sub')
- Adds active_agent_id to frames for routing
- Removes persona_id FK from agents
- Deletes Administrator system agent (no longer needed)
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

# revision identifiers, used by Alembic.
revision: str = '83e667457a0b'
down_revision: Union[str, Sequence[str], None] = '659942852e18'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    # Drop unused devices table
    op.drop_table('devices')

    # 1. Add new columns to agents (nullable first for existing rows)
    op.add_column('agents', sa.Column('voice_reference', sa.String(), nullable=True))
    op.add_column('agents', sa.Column('avatar_uuid', sa.String(), nullable=True))
    op.add_column('agents', sa.Column('character_config', sa.JSON(), nullable=True))
    op.add_column('agents', sa.Column('preferred_name', sa.Text(), nullable=True))
    op.add_column('agents', sa.Column('agent_type', sa.String(), nullable=True))

    # 2. Copy persona data to linked agents
    op.execute("""
        UPDATE agents
        SET
            voice_reference = p.voice_reference,
            avatar_uuid = p.avatar_uuid,
            character_config = p.character_config,
            preferred_name = p.preferred_name
        FROM personas p
        WHERE agents.persona_id = p.id
    """)

    # 3. Set agent_type to 'main' for all existing agents
    op.execute("UPDATE agents SET agent_type = 'main' WHERE agent_type IS NULL")

    # 4. Make agent_type non-nullable now that all rows have values
    op.alter_column('agents', 'agent_type', nullable=False, server_default='main')

    # 5. Delete Administrator system agent (no longer needed for routing)
    op.execute("DELETE FROM agents WHERE name = 'Administrator' AND is_system = true")

    # 6. Drop persona_id FK and column
    op.drop_constraint('fk_agents_persona_id', 'agents', type_='foreignkey')
    op.drop_column('agents', 'persona_id')

    # 7. Add active_agent_id to frames for routing
    op.add_column('frames', sa.Column('active_agent_id', sa.Integer(), nullable=True))
    op.create_foreign_key(
        'fk_frames_active_agent_id',
        'frames', 'agents',
        ['active_agent_id'], ['id'],
        ondelete='SET NULL'
    )


def downgrade() -> None:
    """Downgrade schema."""
    # Remove active_agent_id from frames
    op.drop_constraint('fk_frames_active_agent_id', 'frames', type_='foreignkey')
    op.drop_column('frames', 'active_agent_id')

    # Re-add persona_id to agents
    op.add_column('agents', sa.Column('persona_id', sa.INTEGER(), autoincrement=False, nullable=True))
    op.create_foreign_key('fk_agents_persona_id', 'agents', 'personas', ['persona_id'], ['id'], ondelete='SET NULL')

    # Remove persona fields from agents
    op.drop_column('agents', 'agent_type')
    op.drop_column('agents', 'preferred_name')
    op.drop_column('agents', 'character_config')
    op.drop_column('agents', 'avatar_uuid')
    op.drop_column('agents', 'voice_reference')

    # Re-create devices table
    op.create_table('devices',
        sa.Column('id', sa.INTEGER(), autoincrement=True, nullable=False),
        sa.Column('user_id', sa.INTEGER(), autoincrement=False, nullable=False),
        sa.Column('name', sa.VARCHAR(), autoincrement=False, nullable=False),
        sa.Column('hostname', sa.VARCHAR(), autoincrement=False, nullable=False),
        sa.Column('platform', sa.VARCHAR(), autoincrement=False, nullable=False),
        sa.Column('last_seen', postgresql.TIMESTAMP(), autoincrement=False, nullable=True),
        sa.Column('created_at', postgresql.TIMESTAMP(), autoincrement=False, nullable=True),
        sa.ForeignKeyConstraint(['user_id'], ['users.id'], name='devices_user_id_fkey'),
        sa.PrimaryKeyConstraint('id', name='devices_pkey'),
        sa.UniqueConstraint('user_id', 'hostname', name='uq_device_user_hostname')
    )

    # Note: Cannot restore deleted Administrator agent or persona data in downgrade
