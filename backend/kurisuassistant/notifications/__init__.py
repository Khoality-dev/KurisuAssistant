"""Notifications on every device of an account, with the app closed (#353)."""

from kurisuassistant.notifications import push
from kurisuassistant.notifications.service import notify

__all__ = ["notify", "push"]
