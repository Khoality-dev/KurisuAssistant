"""Notifications on every device of an account, with the app closed (#353)."""

from amadeus.notifications import push
from amadeus.notifications.service import mark_read, notify

__all__ = ["mark_read", "notify", "push"]
