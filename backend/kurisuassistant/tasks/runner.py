"""One task run (#352): the assistant, headless, in a conversation of its own.

A run is an ordinary assistant turn with nobody in the chat. Its opening message
is the task's instructions; the assistant answers with its own model, tools,
memory and skills, in the persona in use when the run starts; and everything it
says or does is saved to a new conversation marked as a task run, so it can be
opened afterwards. When it has something the user should see it reaches them
the way it would from any turn — the notification tool (#353) — and nothing
here sends anything to a client except "tasks changed".

There is no client to approve a tool call, so a call the user has neither
allowed nor denied waits for them: ``approvals.RunApprover`` stands in for the
chat session, writes a pending approval, notifies the user, and carries on with
their answer. A denial — by the user, by nobody answering in time, or by a
stored Deny — ends the turn, and the run is recorded as failed saying which.

The streaming-and-saving loop is the chat's own (``_stream_and_save_agent``),
run on a handler with no socket, so a run's messages are stored exactly as a
chat turn's are — tool-call linkage, emotion cues and all.
"""

import asyncio
import logging
from dataclasses import dataclass, field
from datetime import datetime
from typing import Dict, List, Optional

from kurisuassistant.agents import AgentContext, AssistantConfig, MainAgent, PersonaConfig
from kurisuassistant.agents.selection import persona_in_use
from kurisuassistant.core.errors import GENERIC_MESSAGE, log_internal_error
from kurisuassistant.core.timezone import user_timezone
from kurisuassistant.db.models import Conversation
from kurisuassistant.db.repositories import (
    AssistantRepository,
    MessageRepository,
    PersonaRepository,
    TaskRunRepository,
    UserRepository,
)
from kurisuassistant.db.repositories.task import RUN_DONE, RUN_FAILED, RUN_STOPPED
from kurisuassistant.db.service import get_db_service
from kurisuassistant.models.llm.base import ProviderNotConfigured
from kurisuassistant.tools import tool_registry
from kurisuassistant.utils.prompts import build_system_messages
from kurisuassistant.websocket.handlers import ChatSessionHandler

logger = logging.getLogger(__name__)

NO_MODEL_REASON = "No model is selected for the assistant. Pick one on the Assistant screen."
DENIED_REASON = "You denied {tool}, so the run stopped there."
EXPIRED_REASON = "Nobody approved {tool} within {wait}, so it was denied and the run stopped there."
POLICY_REASON = "{tool} is set to Deny in Settings › Tools, so the run stopped there."


def denial_reason(tool: str, outcome: Optional[str]) -> str:
    """Why a run ended on a denied call: the user, the clock, or the stored policy."""
    from .approvals import APPROVAL_TIMEOUT_SECONDS, describe_timeout

    if outcome == "denied":
        return DENIED_REASON.format(tool=tool)
    if outcome == "expired":
        return EXPIRED_REASON.format(tool=tool, wait=describe_timeout(APPROVAL_TIMEOUT_SECONDS))
    return POLICY_REASON.format(tool=tool)


def task_run_prompt(title: str) -> str:
    """What the assistant is told about a run, after the user's own instructions."""
    return (
        "## Task run\n"
        f"You are running the task \"{title}\" on your own: nobody is in the chat and "
        "nobody will answer a question. The message below is the task's instructions. "
        "Do the work, then finish with a short account of what you did. What you write "
        "is saved for the user to read later; if they should hear about it now, send "
        "them a notification."
    )


def persona_for_run(session, user_id: int) -> PersonaConfig:
    """Who a run speaks as: the account's persona in use, as every chat turn does (#354)."""
    assistant = AssistantRepository(session).get_or_create_for_user(user_id)
    personas = [
        ChatSessionHandler._to_persona_config(p)
        for p in PersonaRepository(session).list_enabled_by_user(user_id)
    ]
    return persona_in_use(personas, assistant.selected_persona_id)


@dataclass
class _RunSetup:
    conversation_id: int
    assistant: AssistantConfig
    persona: PersonaConfig
    user_message: Dict
    system_messages: List[Dict] = field(default_factory=list)
    user_system_prompt: str = ""
    preferred_name: str = ""
    ollama_url: Optional[str] = None
    gemini_api_key: Optional[str] = None
    nvidia_api_key: Optional[str] = None
    poe_api_key: Optional[str] = None
    context_size: Optional[int] = None
    tool_policies: Dict[str, str] = field(default_factory=dict)
    timezone: Optional[object] = None


class _RunFailed(ValueError):
    """A run that cannot go on, with the reason the Tasks screen shows."""


class _HeadlessTurn(ChatSessionHandler):
    """The chat's stream-and-save loop with no socket on the other end.

    It never calls ``ChatSessionHandler.__init__``: there is no websocket, and
    nothing here reads one. ``send_event`` keeps what a run needs to know
    afterwards — which tool, if any, was refused — and sends nothing.
    """

    def __init__(self, user_id: int):  # noqa: D401 - deliberately not super().__init__
        self.user_id = user_id
        self._initial_token_count = 0
        self._response_chars = 0
        self.denied_tool: Optional[str] = None
        self.conversation_id: Optional[int] = None

    async def send_event(self, event) -> None:
        if getattr(event, "role", None) == "tool" and getattr(event, "tool_status", None) == "denied":
            self.denied_tool = self.denied_tool or event.name


async def _broadcast(user_id: int, task_id: Optional[int]) -> None:
    from .service import broadcast_tasks_changed

    await broadcast_tasks_changed(user_id, task_id)


async def run_task(
    *, run_id: int, task_id: int, user_id: int, title: str, instructions: str,
    gate: Optional[asyncio.Semaphore] = None,
) -> None:
    """Run a task once, recording the outcome on its ``task_runs`` row.

    ``gate`` bounds how many runs go at once; waiting for it is part of the run,
    so a run stopped while it waits is recorded as stopped like any other. A run
    waiting for the user's approval gives its place back (``approvals``).
    """
    from .approvals import RunApprover, RunSlot

    db = get_db_service()
    conversation_id: Optional[int] = None
    status, error = RUN_DONE, None
    turn = _HeadlessTurn(user_id)
    slot = RunSlot(gate)
    approver = RunApprover(run_id=run_id, task_id=task_id, user_id=user_id, task_title=title, slot=slot)
    try:
        await slot.acquire()
        try:
            conversation_id = await _run(db, turn, approver, run_id, task_id, user_id, title, instructions)
        finally:
            slot.release()
        if turn.denied_tool:
            status, error = RUN_FAILED, denial_reason(turn.denied_tool, approver.outcome)
    except asyncio.CancelledError:
        status, error = RUN_STOPPED, None
        conversation_id = conversation_id or turn.conversation_id
    except _RunFailed as e:
        status, error = RUN_FAILED, str(e)
        conversation_id = conversation_id or turn.conversation_id
    except ProviderNotConfigured as e:
        status, error = RUN_FAILED, e.public_message
        conversation_id = conversation_id or turn.conversation_id
    except Exception as e:  # noqa: BLE001 - every failure is recorded on the run
        reference = log_internal_error(e, f"running task {task_id}")
        status, error = RUN_FAILED, f"{GENERIC_MESSAGE} (reference: {reference})"
        conversation_id = conversation_id or turn.conversation_id
    finally:
        try:
            await _finish(db, run_id, conversation_id, status, error)
            if conversation_id:
                turn._submit_indexing(conversation_id)
            await _broadcast(user_id, task_id)
        except Exception:  # noqa: BLE001 - never let the bookkeeping mask the run
            logger.error("Could not record the end of task run %s", run_id, exc_info=True)
    logger.info("Task %s run %s finished: %s", task_id, run_id, status)


async def _run(db, turn: "_HeadlessTurn", approver, run_id, task_id, user_id, title, instructions) -> int:
    """The turn itself. Returns the run's conversation id."""
    setup = await db.execute(lambda s: _prepare(s, run_id, task_id, user_id, title, instructions))
    conversation_id = setup.conversation_id
    turn.conversation_id = conversation_id
    await _broadcast(user_id, task_id)
    if not setup.assistant.model_name:
        raise _RunFailed(NO_MODEL_REASON)

    context = AgentContext(
        user_id=user_id,
        conversation_id=conversation_id,
        model_name=setup.assistant.model_name,
        # Not a chat session: the approver puts an unapproved call to the user
        # out of band and waits for the answer (approvals.py).
        handler=approver,
        user_system_prompt="\n\n".join(p for p in (setup.user_system_prompt, task_run_prompt(title)) if p),
        preferred_name=setup.preferred_name,
        api_url=setup.ollama_url,
        gemini_api_key=setup.gemini_api_key,
        nvidia_api_key=setup.nvidia_api_key,
        poe_api_key=setup.poe_api_key,
        client_tools=[],
        context_size=setup.context_size,
        tool_policies=setup.tool_policies,
        timezone=setup.timezone,
    )
    agent = MainAgent(setup.assistant, tool_registry, identity=setup.persona)
    messages = setup.system_messages + [setup.user_message]
    await turn._stream_and_save_agent(
        agent=agent,
        persona=setup.persona,
        messages=messages,
        context=context,
        conversation_id=conversation_id,
        conversation_messages=list(messages),
    )
    return conversation_id


def _prepare(session, run_id: int, task_id: int, user_id: int, title: str, instructions: str) -> _RunSetup:
    """Everything a run reads, and its conversation and opening message, in one trip."""
    user_repo = UserRepository(session)
    user = user_repo.get_by_id(user_id)
    if user is None:
        raise _RunFailed("The account no longer exists.")
    assistant_row = AssistantRepository(session).get_or_create_for_user(user_id)
    assistant = ChatSessionHandler._to_assistant_config(assistant_row)
    persona = persona_for_run(session, user_id)

    now = datetime.utcnow()
    conversation = Conversation(
        user_id=user_id, title=title, task_run=True, task_id=task_id, created_at=now, updated_at=now,
    )
    session.add(conversation)
    session.flush()
    run = TaskRunRepository(session).get_by_id(run_id)
    if run is not None:
        run.conversation_id = conversation.id

    MessageRepository(session).create_message(
        role="user", message=instructions, conversation_id=conversation.id,
    )
    system_prompt, preferred_name = user_repo.get_preferences(user)
    return _RunSetup(
        conversation_id=conversation.id,
        assistant=assistant,
        persona=persona,
        user_message={"role": "user", "content": instructions},
        system_messages=build_system_messages(system_prompt, preferred_name),
        user_system_prompt=system_prompt,
        preferred_name=preferred_name or "",
        ollama_url=user.ollama_url,
        gemini_api_key=getattr(user, "gemini_api_key", None),
        nvidia_api_key=getattr(user, "nvidia_api_key", None),
        poe_api_key=getattr(user, "poe_api_key", None),
        context_size=user.context_size,
        tool_policies=dict((user.tool_policies or {}).get("tools", {})),
        timezone=user_timezone(user),
    )


async def _finish(db, run_id: int, conversation_id: Optional[int], status: str, error: Optional[str]) -> None:
    def _write(session):
        repo = TaskRunRepository(session)
        run = repo.get_by_id(run_id)
        if run is None:  # the task was deleted while it ran
            return
        repo.finish(run, status, error)
        if conversation_id:
            conversation = session.query(Conversation).filter_by(id=conversation_id).first()
            if conversation is not None:
                conversation.updated_at = datetime.utcnow()

    await db.execute(_write)
