"""merge heads

Revision ID: 902de88d379e
Revises: add_skills_table, add_summary_model_to_users
Create Date: 2026-02-14 23:57:15.968521

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '902de88d379e'
down_revision: Union[str, Sequence[str], None] = ('add_skills_table', 'add_summary_model_to_users')
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    pass


def downgrade() -> None:
    """Downgrade schema."""
    pass
