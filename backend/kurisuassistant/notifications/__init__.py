"""Notifications on every device of an account, with the app closed (#353)."""

from kurisuassistant.notifications import push
from kurisuassistant.notifications.service import mark_read, notify

__all__ = ["mark_read", "notify", "push"]
