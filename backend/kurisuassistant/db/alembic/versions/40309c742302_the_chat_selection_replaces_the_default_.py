"""the chat selection replaces the default persona

`assistants.default_persona_id` was the persona a new conversation silently
adopted when the request named none. The server no longer adopts anyone (#334):
the column becomes `selected_persona_id`, who the account's chat is on, which a
client reads when it opens and writes when the user picks someone. A rename, so
each account's persona is still who it opens on.

Revision ID: 40309c742302
Revises: c4f16d4d97dd
Create Date: 2026-09-27 23:44:20.127617

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '40309c742302'
down_revision: Union[str, Sequence[str], None] = 'c4f16d4d97dd'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.alter_column("assistants", "default_persona_id", new_column_name="selected_persona_id")
    op.execute(
        "ALTER TABLE assistants RENAME CONSTRAINT fk_assistants_default_persona_id "
        "TO fk_assistants_selected_persona_id"
    )


def downgrade() -> None:
    """Downgrade schema."""
    op.execute(
        "ALTER TABLE assistants RENAME CONSTRAINT fk_assistants_selected_persona_id "
        "TO fk_assistants_default_persona_id"
    )
    op.alter_column("assistants", "selected_persona_id", new_column_name="default_persona_id")
