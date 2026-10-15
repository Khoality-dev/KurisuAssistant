"""The one place the calendar asks which zone a user is in.

Every zone lookup in the calendar — the tools reading "19:00 on Friday", the
"Coming up" list's today, a reminder's "Due at 19:00" — goes through
:func:`zone_for`. The account's zone is an account setting that arrives with
#352 (``users.timezone``, read by ``core/timezone.py::user_timezone``); until
that lands this answers UTC for everyone, and afterwards it becomes that one
call — a one-line change here and nowhere else.
"""

from zoneinfo import ZoneInfo

UTC = ZoneInfo("UTC")


def zone_for(user) -> ZoneInfo:
    """The zone ``user`` reads the calendar in.

    After #352: ``return user_timezone(user)`` from ``core/timezone.py``.
    """
    return UTC
