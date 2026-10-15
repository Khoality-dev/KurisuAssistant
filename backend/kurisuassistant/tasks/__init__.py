"""Tasks (#352): work the assistant does on its own, now or on a schedule.

- ``schedule`` — what a schedule may say, its next run and its label (pure);
- ``service``  — the scheduler: finds due tasks, starts and stops runs;
- ``runner``   — one run: the assistant, headless, in a conversation of its own.

The tools the assistant plans them with are in ``kurisuassistant/tools/tasks.py``,
the REST surface the Tasks screen uses in ``routers/tasks.py``.
"""
