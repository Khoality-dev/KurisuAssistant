from sqlalchemy import BigInteger, Boolean, Column, Index, Integer, String, Text, DateTime, ForeignKey, JSON, UniqueConstraint, false, text
from sqlalchemy.orm import relationship
from datetime import datetime
from pgvector.sqlalchemy import Vector
from .base import Base


class User(Base):
    __tablename__ = 'users'

    id = Column(Integer, primary_key=True)
    username = Column(String, unique=True, nullable=False)
    password = Column(Text, nullable=False)
    # Registration is open; activation is the gate. A new account is inactive
    # until the operator flips this in the database — there is no admin account
    # and no endpoint that can do it (#148).
    is_active = Column(Boolean, nullable=False, server_default=false())
    system_prompt = Column(Text, default='')
    preferred_name = Column(Text, default='')
    agent_avatar_uuid = Column(String, nullable=True)
    ollama_url = Column(String, nullable=True)
    summary_model = Column(String, nullable=True)  # Model for context compaction + memory consolidation
    summary_provider = Column(String, default='ollama', nullable=False)
    context_size = Column(Integer, nullable=True)
    gemini_api_key = Column(String, nullable=True)
    nvidia_api_key = Column(String, nullable=True)
    poe_api_key = Column(String, nullable=True)
    tool_policies = Column(JSON, nullable=True)  # {"tools": {"tool_name": "allow"|"deny"}}
    # The account's IANA time zone, filled by a client from its device the first
    # time it is empty. Wall times — a task's 07:30 — are read in it; null is UTC.
    # Read through core/timezone.py::user_timezone, never directly.
    timezone = Column(String, nullable=True)

    conversations = relationship("Conversation", back_populates="user", cascade="all, delete-orphan")
    personas = relationship("Persona", back_populates="user", cascade="all, delete-orphan")
    # One assistant per user — the capability half of the old Agent.
    assistant = relationship(
        "Assistant", back_populates="user", uselist=False, cascade="all, delete-orphan"
    )


class Conversation(Base):
    __tablename__ = 'conversations'

    id = Column(Integer, primary_key=True)
    user_id = Column(Integer, ForeignKey('users.id', ondelete='CASCADE'), nullable=False, index=True)
    title = Column(Text, default='New conversation')
    # No persona: a conversation is not tied to one (#354). Who answers is the
    # persona in use for the whole account, ``assistants.selected_persona_id``.
    compacted_context = Column(Text, nullable=False, default="", server_default="")
    compacted_up_to_id = Column(Integer, nullable=False, default=0, server_default="0")
    created_at = Column(DateTime, default=datetime.utcnow)
    # Indexed: the idle scanner ranges on it once a minute (#96).
    updated_at = Column(DateTime, default=datetime.utcnow, index=True)
    # Memory-consolidation bookkeeping, kept on the row so it survives a restart
    # and so the idle scan can skip what is already done (#96). A conversation is
    # due when consolidated_at is null or older than updated_at; a failed attempt
    # sets consolidation_next_retry_at with backoff, and after enough failures the
    # row is stamped as consolidated so it is left alone until it changes again.
    consolidated_at = Column(DateTime, nullable=True)
    consolidation_attempts = Column(Integer, nullable=False, default=0, server_default="0")
    consolidation_next_retry_at = Column(DateTime, nullable=True)
    # Retrieval index bookkeeping (#6), same shape as consolidation: a
    # conversation is due for chunking when indexed_at is null or older than
    # updated_at, and indexed_up_to_id is the last message already turned into
    # passages. Nothing rewinds it on delete — message ids are monotonic and the
    # passages of a deleted message cascade away with it.
    indexed_up_to_id = Column(Integer, nullable=False, default=0, server_default="0")
    indexed_at = Column(DateTime, nullable=True)
    # A conversation a task run left behind (#352): the assistant working on its
    # own, nobody in the chat. ``task_run`` stays true after the task is deleted,
    # which only clears ``task_id`` — the run still happened.
    task_run = Column(Boolean, nullable=False, default=False, server_default=false())
    # ``use_alter``: tasks also points back at conversations (where a task was
    # planned), and a cycle needs one side added after both tables exist.
    task_id = Column(
        Integer,
        ForeignKey('tasks.id', ondelete='SET NULL', use_alter=True, name='conversations_task_id_fkey'),
        nullable=True, index=True,
    )

    user = relationship("User", back_populates="conversations")
    messages = relationship("Message", back_populates="conversation", cascade="all, delete-orphan")


class Message(Base):
    __tablename__ = 'messages'

    id = Column(Integer, primary_key=True)
    role = Column(Text, nullable=False)
    message = Column(Text, nullable=False)
    thinking = Column(Text, nullable=True)
    raw_input = Column(Text, nullable=True)
    raw_output = Column(Text, nullable=True)
    name = Column(String, nullable=True)
    model_name = Column(String, nullable=True)
    provider_type = Column(String, nullable=True)
    tool_args = Column(JSON, nullable=True)
    tool_status = Column(String, nullable=True)
    # What the stream says about a tool row, kept so the history says it too:
    # a delegation to a sub-agent or an ordinary tool, and how long it took
    # (#327). Null on rows written before, and on every non-tool row.
    tool_kind = Column(String, nullable=True)
    duration_ms = Column(Integer, nullable=True)
    # An assistant message records the calls it made; a tool message records
    # which call it answers. Without these, replayed history is a tool message
    # with no matching request, which strict providers reject.
    tool_calls = Column(JSON, nullable=True)
    tool_call_id = Column(String, nullable=True)
    # Where the persona's feeling changed inside an assistant message (#243):
    # ``[{"emotion": "happy", "at": 42}, ...]``, ``at`` in UTF-16 code units of
    # ``message``. The tags the model wrote are stripped before anything is
    # stored — ``message`` and ``raw_output`` both hold the clean text — so
    # this column is the only record of where they stood.
    emotion_cues = Column(JSON, nullable=True)
    context_files = Column(JSON, nullable=True)
    images = Column(JSON, nullable=True)
    conversation_id = Column(Integer, ForeignKey('conversations.id', ondelete='CASCADE'), nullable=False)
    # Who spoke: the persona in use when this assistant message was written. A
    # record of the past, not a binding — the next turn answers as whoever is
    # in use then (#354).
    persona_id = Column(Integer, ForeignKey('personas.id', ondelete='SET NULL'), nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)

    __table_args__ = (
        # Both hot reads filter on the conversation and order by id: the paged
        # history the UI loads, and the context rebuild on every turn, which
        # also compares id against the compaction watermark. A lone index on
        # conversation_id does not cover the sort, so the database still walked
        # and re-sorted every conversation read (#95). Keyed on id rather than
        # created_at because id is monotonic and unique, and created_at ties
        # within a fast turn.
        Index('ix_messages_conversation_id_id', 'conversation_id', text('id DESC')),
    )

    conversation = relationship("Conversation", back_populates="messages")
    persona = relationship("Persona")


class Persona(Base):
    """How the assistant sounds: a voice, a name, a prompt.

    A persona carries presentation only. It owns no model, no tools and no memory —
    those belong to the user's single :class:`Assistant`, so swapping persona changes
    the voice without changing what the assistant can do or remember. One persona,
    or none, is in use for the whole account (``assistants.selected_persona_id``,
    #354); each message records the persona that produced it (``messages.persona_id``).
    """
    __tablename__ = 'personas'

    id = Column(Integer, primary_key=True)
    user_id = Column(Integer, ForeignKey('users.id', ondelete='CASCADE'), nullable=False, index=True)
    name = Column(String, nullable=False)
    description = Column(String, default='', nullable=False)
    system_prompt = Column(Text, default='')

    # Presentation
    voice_reference = Column(String, nullable=True)
    avatar_uuid = Column(String, nullable=True)
    # `{kind, pose_tree?, vrm?}` — see kurisuassistant/character/schema.py. A Python
    # None lands as SQL NULL: with SQLAlchemy's default (none_as_null=False) it was
    # stored as the JSON literal `null`, so every persona created through the API
    # carried a non-NULL column that read back as None.
    character_config = Column(JSON(none_as_null=True), nullable=True)
    preferred_name = Column(Text, nullable=True)  # what this persona calls the *user*

    enabled = Column(Boolean, default=True, nullable=False)
    created_at = Column(DateTime, default=datetime.utcnow)

    __table_args__ = (UniqueConstraint('user_id', 'name', name='uq_persona_user_id_name'),)

    user = relationship("User", back_populates="personas")


class Assistant(Base):
    """What the assistant can do: exactly one row per user.

    Holds the capability half of the old Agent — model, tools, reasoning and the single
    memory document — plus the wake word. Personas change the voice; this does not
    change with them.
    """
    __tablename__ = 'assistants'

    id = Column(Integer, primary_key=True)
    user_id = Column(
        Integer, ForeignKey('users.id', ondelete='CASCADE'), nullable=False, unique=True
    )

    # Inference config
    model_name = Column(String, nullable=True)
    provider_type = Column(String, default='ollama', nullable=False)
    available_tools = Column(JSON, nullable=True)  # NULL = every tool
    think = Column(Boolean, default=False, nullable=False)
    use_deferred_tools = Column(Boolean, default=False, nullable=False)

    # One memory document for the whole assistant, consolidated at conversation idle.
    memory = Column(Text, nullable=True)
    memory_enabled = Column(Boolean, default=True, nullable=False)

    # Voice wake word. Assistant-level: saying it wakes the assistant, and the
    # persona in use answers. It does not select a persona.
    trigger_word = Column(String, nullable=True)

    # The persona in use for the whole account (#334, #354): every turn, in any
    # conversation and on every device, answers as it. Null = the assistant itself
    # (#302), where a new account starts and where deleting or disabling the
    # persona returns it.
    selected_persona_id = Column(
        Integer, ForeignKey('personas.id', ondelete='SET NULL'), nullable=True
    )
    created_at = Column(DateTime, default=datetime.utcnow)

    user = relationship("User", back_populates="assistant")
    selected_persona = relationship("Persona", foreign_keys=[selected_persona_id])


class AssistantTask(Base):
    """Work the assistant does on its own, now or on a schedule (#352).

    Planned by the assistant with its task tools, listed and changed on the Tasks
    screen. The schedule is stored as its parts (see ``tasks/schedule.py``):
    ``repeat`` and whichever of ``run_at`` / ``time_of_day`` / ``days`` /
    ``every_hours`` it uses, with wall times in ``timezone``.

    ``state`` is ``active`` (it will run at ``next_run_at``), ``paused`` (it will
    not, and ``next_run_at`` is null) or ``finished`` (a one-off that has run).
    Whether it is *running* is not a state: it is a ``task_runs`` row that is.
    Named ``AssistantTask`` because ``Task`` is asyncio's, and the scheduler uses both.
    """
    __tablename__ = 'tasks'

    id = Column(Integer, primary_key=True)
    user_id = Column(Integer, ForeignKey('users.id', ondelete='CASCADE'), nullable=False, index=True)
    title = Column(String, nullable=False)
    # What the assistant does each run: the opening message of every run.
    instructions = Column(Text, nullable=False)

    repeat = Column(String, nullable=False)
    timezone = Column(String, nullable=False, default='UTC', server_default='UTC')
    run_at = Column(DateTime, nullable=True)        # once: UTC
    time_of_day = Column(String, nullable=True)     # "HH:MM" in timezone
    days = Column(JSON, nullable=True)              # weekly: [0..6], Monday first
    every_hours = Column(Integer, nullable=True)    # hourly

    state = Column(String, nullable=False, default='active', server_default='active')
    # Indexed: the scheduler ranges on it every scan.
    next_run_at = Column(DateTime, nullable=True, index=True)
    last_run_at = Column(DateTime, nullable=True)
    # The chat the assistant planned it in, for the Tasks screen's link back.
    planned_in_conversation_id = Column(
        Integer, ForeignKey('conversations.id', ondelete='SET NULL'), nullable=True
    )
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow)

    user = relationship("User")
    runs = relationship(
        "TaskRun", back_populates="task", cascade="all, delete-orphan", passive_deletes=True,
        order_by="desc(TaskRun.id)",
    )


class TaskRun(Base):
    """One run of a task (#352): ``running``, then ``done``, ``failed`` or ``stopped``.

    ``conversation_id`` is the conversation the run wrote, so a run can be opened
    afterwards. ``error`` says why a run failed, in words the Tasks screen shows.
    """
    __tablename__ = 'task_runs'

    id = Column(Integer, primary_key=True)
    task_id = Column(Integer, ForeignKey('tasks.id', ondelete='CASCADE'), nullable=False, index=True)
    user_id = Column(Integer, ForeignKey('users.id', ondelete='CASCADE'), nullable=False, index=True)
    conversation_id = Column(
        Integer, ForeignKey('conversations.id', ondelete='SET NULL'), nullable=True
    )
    status = Column(String, nullable=False, default='running', server_default='running')
    error = Column(Text, nullable=True)
    started_at = Column(DateTime, default=datetime.utcnow)
    finished_at = Column(DateTime, nullable=True)

    task = relationship("AssistantTask", back_populates="runs")
    approvals = relationship(
        "TaskApproval", back_populates="run", cascade="all, delete-orphan", passive_deletes=True,
    )


class TaskApproval(Base):
    """A tool call a task run is waiting on the user to approve (#352).

    A run has nobody attached to ask, so it writes one of these, puts its run in
    ``waiting_for_approval``, notifies the user and waits. The answer comes over
    REST — from the run's conversation or the Tasks screen — and ``status`` moves
    from ``pending`` to ``approved`` or ``denied``; ``expired`` when nobody
    answered by ``expires_at`` (or the server restarted while it waited), and
    ``cancelled`` when the run was stopped first.
    """
    __tablename__ = 'task_approvals'

    id = Column(Integer, primary_key=True)
    run_id = Column(Integer, ForeignKey('task_runs.id', ondelete='CASCADE'), nullable=False, index=True)
    user_id = Column(Integer, ForeignKey('users.id', ondelete='CASCADE'), nullable=False, index=True)
    tool_name = Column(String, nullable=False)
    tool_args = Column(JSON, nullable=True)
    # What the call will do, as the tool describes itself.
    description = Column(Text, nullable=False, default='', server_default='')
    status = Column(String, nullable=False, default='pending', server_default='pending')
    # The arguments the user approved, when they changed them.
    modified_args = Column(JSON, nullable=True)
    requested_at = Column(DateTime, default=datetime.utcnow)
    expires_at = Column(DateTime, nullable=False)
    decided_at = Column(DateTime, nullable=True)

    run = relationship("TaskRun", back_populates="approvals")


class Skill(Base):
    """User-created skill — instructions injected into all agent system prompts."""
    __tablename__ = 'skills'

    id = Column(Integer, primary_key=True)
    user_id = Column(Integer, ForeignKey('users.id', ondelete='CASCADE'), nullable=False, index=True)
    name = Column(String, nullable=False)
    instructions = Column(Text, default='')
    created_at = Column(DateTime, default=datetime.utcnow)

    __table_args__ = (UniqueConstraint('user_id', 'name', name='uq_skill_user_id_name'),)

    user = relationship("User")


class MCPServer(Base):
    """User-configured MCP server connection."""
    __tablename__ = 'mcp_servers'

    id = Column(Integer, primary_key=True)
    user_id = Column(Integer, ForeignKey('users.id', ondelete='CASCADE'), nullable=False, index=True)
    name = Column(String, nullable=False)
    transport_type = Column(String, nullable=False)
    url = Column(String, nullable=True)
    command = Column(String, nullable=True)
    args = Column(JSON, nullable=True)
    env = Column(JSON, nullable=True)
    enabled = Column(Boolean, default=True, nullable=False)
    location = Column(String, default='server', nullable=False)
    created_at = Column(DateTime, default=datetime.utcnow)

    __table_args__ = (UniqueConstraint('user_id', 'name', name='uq_mcp_server_user_id_name'),)

    user = relationship("User")


class FaceIdentity(Base):
    __tablename__ = 'face_identities'

    id = Column(Integer, primary_key=True)
    user_id = Column(Integer, ForeignKey('users.id', ondelete='CASCADE'), nullable=False, index=True)
    name = Column(String, nullable=False)
    created_at = Column(DateTime, default=datetime.utcnow)

    __table_args__ = (UniqueConstraint('user_id', 'name', name='uq_face_identity_user_id_name'),)

    user = relationship("User")
    photos = relationship("FacePhoto", back_populates="identity", cascade="all, delete-orphan")


class FacePhoto(Base):
    __tablename__ = 'face_photos'

    id = Column(Integer, primary_key=True)
    identity_id = Column(Integer, ForeignKey('face_identities.id', ondelete='CASCADE'), nullable=False, index=True)
    embedding = Column(Vector(512), nullable=False)
    photo_uuid = Column(String, nullable=False)
    created_at = Column(DateTime, default=datetime.utcnow)

    __table_args__ = (
        # Created by migration 20486507cf9d, but never declared here — so every
        # `alembic revision --autogenerate` proposed dropping it, and one
        # long-running deployment ended up without it while its migration
        # history said otherwise (#162). Declared now, which is also what makes
        # the models-versus-migrations check meaningful.
        Index(
            'ix_face_photos_embedding_hnsw', 'embedding',
            postgresql_using='hnsw',
            postgresql_ops={'embedding': 'vector_cosine_ops'},
        ),
    )

    identity = relationship("FaceIdentity", back_populates="photos")


class DriveNode(Base):
    """One entry in a user's Kurisu Drive — a folder, or a file with bytes on disk.

    The drive is a tree: ``parent_id`` is null at the root and points at a folder
    otherwise. A file's bytes live under ``data/drive/{user_id}/{storage_key}``;
    ``storage_key`` is a server-generated UUID and is the **only** thing a
    filesystem path is ever built from, so no name a user types reaches the disk.
    Directories carry no ``storage_key``, ``checksum`` or ``mime``.

    ``checksum`` is here from the start for #6: chunks embedded from a file have
    to be attributable, and re-embedded when the bytes change.
    """

    __tablename__ = 'drive_nodes'

    id = Column(Integer, primary_key=True)
    user_id = Column(Integer, ForeignKey('users.id', ondelete='CASCADE'), nullable=False, index=True)
    # Self-referencing, cascading: deleting a folder row takes its subtree with
    # it in one statement. The blobs those rows named are unlinked afterwards,
    # which is why delete returns the storage keys it removed.
    parent_id = Column(Integer, ForeignKey('drive_nodes.id', ondelete='CASCADE'), nullable=True, index=True)
    name = Column(String, nullable=False)
    is_dir = Column(Boolean, nullable=False, default=False, server_default=false())
    # BigInteger, unlike every other integer column here: Integer stops at 2 GB
    # and a drive file will not. Always 0 for a directory.
    size = Column(BigInteger, nullable=False, default=0, server_default="0")
    mime = Column(String, nullable=True)
    checksum = Column(String, nullable=True)  # sha256 hex of the bytes
    # The checksum the retrieval index last looked at (#6). A file is due when
    # this differs from `checksum`; it is stamped whether or not any passages
    # came out, so an unextractable file is looked at once per version.
    indexed_checksum = Column(String, nullable=True)
    storage_key = Column(String, nullable=True)  # uuid4 naming the blob on disk
    created_at = Column(DateTime, default=datetime.utcnow)
    # Maintained by hand in DriveNodeRepository. There is no `onupdate` anywhere
    # in this schema and conversations.updated_at is bumped explicitly too, so
    # following the convention matters more than the convenience would.
    updated_at = Column(DateTime, default=datetime.utcnow)

    __table_args__ = (
        # Two indexes rather than one UniqueConstraint, because Postgres treats
        # NULLs as distinct: a plain constraint over (user_id, parent_id, name)
        # would let a user create "Reports" at the root twice. The partial pair
        # covers both cases and doubles as the listing index.
        Index(
            'uq_drive_node_user_id_parent_id_name',
            'user_id', 'parent_id', 'name',
            unique=True,
            postgresql_where=text('parent_id IS NOT NULL'),
        ),
        Index(
            'uq_drive_node_user_id_name_root',
            'user_id', 'name',
            unique=True,
            postgresql_where=text('parent_id IS NULL'),
        ),
    )

    user = relationship("User")


class Passage(Base):
    """One retrievable piece of text: a slice of a stored message, or of a file
    in Kurisu Drive (#6).

    Both recall tools read this table and nothing else, which is what makes a
    conversation and a document searchable the same way. A row carries the text
    **verbatim** — the tools quote it, they do not summarise it — and enough to
    say where it came from: the message (and so the conversation, speaker and
    time) or the drive node plus a page or line range.

    ``embedding`` is a dimensionless ``vector`` on purpose: the model is the
    operator's choice (``EMBEDDING_MODEL``) and different models have different
    widths. The cost is that pgvector cannot build an HNSW index over a column
    with no fixed dimension, so a semantic query is an exact scan over one
    account's rows — which at per-account scale is both fast enough and gives
    perfect recall. ``embedding_model`` records which model produced a vector so
    a query never compares vectors from two models; a changed model is re-embedded
    in the background (see ``workers/service.py``).

    Deletion is by cascade only: a message, a conversation, a drive node or a
    user going away takes its passages with it at the database level, which
    matters because ``DriveNodeRepository.delete_subtree`` and
    ``MessageRepository.delete_from_message`` are bulk deletes that fire no ORM
    events.
    """

    __tablename__ = 'passages'

    id = Column(Integer, primary_key=True)
    user_id = Column(Integer, ForeignKey('users.id', ondelete='CASCADE'), nullable=False, index=True)
    source_kind = Column(String, nullable=False)  # 'message' | 'drive'
    conversation_id = Column(Integer, ForeignKey('conversations.id', ondelete='CASCADE'), nullable=True, index=True)
    message_id = Column(Integer, ForeignKey('messages.id', ondelete='CASCADE'), nullable=True, index=True)
    drive_node_id = Column(Integer, ForeignKey('drive_nodes.id', ondelete='CASCADE'), nullable=True, index=True)
    # Position within the source, so a long message or a file reads back in order.
    ordinal = Column(Integer, nullable=False, default=0, server_default="0")
    # Not `text`: that is a Postgres type name, and `sqlalchemy.text` is imported above.
    content = Column(Text, nullable=False)
    page = Column(Integer, nullable=True)
    start_line = Column(Integer, nullable=True)
    end_line = Column(Integer, nullable=True)
    embedding = Column(Vector(), nullable=True)
    embedding_model = Column(String, nullable=True)
    # Deterministic embedding failures (a provider rejecting the text) bump
    # this; after RETRIEVAL_MAX_EMBED_ATTEMPTS the row is left keyword-only.
    # Transient failures (the provider being down) do not touch it.
    embed_attempts = Column(Integer, nullable=False, default=0, server_default="0")
    created_at = Column(DateTime, default=datetime.utcnow)

    __table_args__ = (
        # The embedding backlog the scanner reads every minute. Partial, so it
        # stays tiny once everything is embedded instead of covering the table.
        Index(
            'ix_passages_pending_embed', 'id',
            postgresql_where=text('embedding IS NULL AND embed_attempts < 5'),
        ),
        # A semantic query is "this user's rows embedded by the current model";
        # this is the index that narrows the exact scan to exactly those.
        Index('ix_passages_user_id_embedding_model', 'user_id', 'embedding_model'),
    )

    user = relationship("User")
    conversation = relationship("Conversation")
    message = relationship("Message")
    drive_node = relationship("DriveNode")


class Notification(Base):
    """Something the user should see on every device, even with the app closed (#353).

    The server keeps every notification and whether it has been read; the clients
    only display them. Written by ``notifications.notify`` — the assistant's
    ``notify_user`` tool and calendar reminders — and pushed over
    ``/ws/notifications``. ``read_at`` is set once, by whichever device reads it
    first, and every other device then drops it; a device that was away is sent
    what is still unread when it reconnects. ``sender`` is fixed at send time: the
    persona in use then, ``Assistant`` with none, or ``Calendar``. ``reminder_id``
    is the calendar's id for the reminder and deliberately not a foreign key, so
    this table does not depend on the calendar's.
    """
    __tablename__ = 'notifications'

    id = Column(Integer, primary_key=True)
    user_id = Column(Integer, ForeignKey('users.id', ondelete='CASCADE'), nullable=False, index=True)
    source = Column(String, nullable=False)  # "assistant" | "calendar"
    sender = Column(String, nullable=False)
    title = Column(Text, nullable=False)
    body = Column(Text, nullable=False, default='', server_default='')
    conversation_id = Column(
        Integer, ForeignKey('conversations.id', ondelete='SET NULL'), nullable=True
    )
    reminder_id = Column(Integer, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    read_at = Column(DateTime, nullable=True)


class NotificationDevice(Base):
    """A phone that gets notifications pushed through Firebase Cloud Messaging (#353).

    A phone's app is not running to hold ``/ws/notifications``, so the server
    pushes to it instead: each phone registers its FCM token here while its
    notifications are on, and unregisters it when they are turned off or it
    signs out. A token is one installed app, so it belongs to whoever registered
    it last; one FCM reports as unregistered or invalid is dropped.
    """
    __tablename__ = 'notification_devices'

    id = Column(Integer, primary_key=True)
    user_id = Column(Integer, ForeignKey('users.id', ondelete='CASCADE'), nullable=False, index=True)
    platform = Column(String, nullable=False)  # "android"
    fcm_token = Column(String, nullable=False, unique=True)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    last_seen_at = Column(DateTime, default=datetime.utcnow, nullable=False)
