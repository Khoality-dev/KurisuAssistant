"""The user's calendar (#282): events and reminders.

The calendar is the user's own record. Nothing on it starts the assistant —
work the assistant does by itself is a task (#352) — and nothing records who
put an entry there. The pieces:

* ``times`` — wall-clock time in the account's zone to the naive UTC the
  database stores, and back into words.
* ``entries`` — the rules of what can be on a calendar, shared by the REST
  router and the assistant's tools so the two cannot disagree.
* ``delivery`` — one due reminder handed to the notifications module (#353).

The scanner that finds due reminders is ``workers/reminders.py``.
"""
