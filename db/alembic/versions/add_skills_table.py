"""Add skills table

Revision ID: add_skills_table
Revises: add_summary_to_frames
Create Date: 2026-02-14
"""
from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = 'add_skills_table'
down_revision = 'add_summary_to_frames'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        'skills',
        sa.Column('id', sa.Integer(), primary_key=True),
        sa.Column('user_id', sa.Integer(), sa.ForeignKey('users.id'), nullable=False),
        sa.Column('name', sa.String(), nullable=False),
        sa.Column('instructions', sa.Text(), server_default=''),
        sa.Column('created_at', sa.DateTime(), server_default=sa.func.now()),
        sa.UniqueConstraint('user_id', 'name', name='uq_skill_user_id_name'),
    )

    # Seed default "Music Player" skill for admin user (id=1)
    op.execute(
        sa.text(
            "INSERT INTO skills (user_id, name, instructions) "
            "SELECT 1, 'Music Player', :instructions "
            "WHERE EXISTS (SELECT 1 FROM users WHERE id = 1)"
        ).bindparams(instructions=(
            "You can play music for the user using the built-in music player.\n"
            "\n"
            "Available tools:\n"
            "- play_music(query, enqueue=false): Search YouTube and play a track. "
            "Set enqueue=true to add to queue instead of playing immediately.\n"
            "- music_control(action): Control playback. Actions: pause, resume, skip, stop.\n"
            "- get_music_queue(): Check what's currently playing and the upcoming queue.\n"
            "\n"
            "Guidelines:\n"
            "- When the user asks to play a song, use play_music with a descriptive search query "
            "(include artist name and song title when known).\n"
            "- If the user asks to \"add\" or \"queue\" a song, use play_music with enqueue=true.\n"
            "- If music is already playing and the user asks to play something new without saying "
            "\"queue\" or \"add\", play it immediately (enqueue=false) — this replaces the current track.\n"
            "- Use get_music_queue to check the current state before responding to questions like "
            "\"what's playing?\" or \"what's in the queue?\".\n"
            "- Respond naturally about the music. Mention the track title from the tool result."
        ))
    )


def downgrade() -> None:
    op.drop_table('skills')
