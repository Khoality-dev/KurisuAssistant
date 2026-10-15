"""Who is listening for an account's notifications, right now.

One queue per open ``/ws/notifications`` socket. ``publish`` puts a payload on
every queue of the account and returns at once; each socket's own task writes
it out, so a slow or dead device never holds up ``notify`` or another device.

This is deliberately not the chat's ``ConnectionManager``: the chat is
last-one-wins, and a second chat socket closes the first. Every device of the
account holds one of these at once — that is the point of them.
"""

import asyncio
import logging
from typing import Dict, Set

logger = logging.getLogger(__name__)

# A device that stops reading must not grow memory without bound. What it
# misses past this is still in the table and replays when it reconnects.
QUEUE_LIMIT = 100


class NotificationHub:
    def __init__(self) -> None:
        self._queues: Dict[int, Set[asyncio.Queue]] = {}

    def subscribe(self, user_id: int) -> asyncio.Queue:
        queue: asyncio.Queue = asyncio.Queue(maxsize=QUEUE_LIMIT)
        self._queues.setdefault(user_id, set()).add(queue)
        return queue

    def unsubscribe(self, user_id: int, queue: asyncio.Queue) -> None:
        queues = self._queues.get(user_id)
        if queues is None:
            return
        queues.discard(queue)
        if not queues:
            del self._queues[user_id]

    def publish(self, user_id: int, payload: dict) -> None:
        for queue in list(self._queues.get(user_id, ())):
            try:
                queue.put_nowait(payload)
            except asyncio.QueueFull:
                logger.warning(
                    "A notifications socket of user %s is not reading; it will catch up on reconnect",
                    user_id,
                )

    def listeners(self, user_id: int) -> int:
        return len(self._queues.get(user_id, ()))


hub = NotificationHub()
