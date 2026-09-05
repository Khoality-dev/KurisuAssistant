from sqlalchemy import Boolean, Column, Integer, String, Text, DateTime, ForeignKey, JSON, UniqueConstraint
from sqlalchemy.orm import relationship
from datetime import datetime
from pgvector.sqlalchemy import Vector
from .base import Base


class User(Base):
    __tablename__ = 'users'

    id = Column(Integer, primary_key=True)
    username = Column(String, unique=True, nullable=False)
    password = Column(Text, nullable=False)
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

    conversations = relationship("Conversation", back_populates="user", cascade="all, delete-orphan")
    personas = relationship("Persona", back_populates="user", cascade="all, delete-orphan")
    sub_agents = relationship("SubAgent", back_populates="user", cascade="all, delete-orphan")
    # One assistant per user — the capability half of the old Agent.
    assistant = relationship(
        "Assistant", back_populates="user", uselist=False, cascade="all, delete-orphan"
    )


class Conversation(Base):
    __tablename__ = 'conversations'

    id = Column(Integer, primary_key=True)
    user_id = Column(Integer, ForeignKey('users.id'), nullable=False)
    title = Column(Text, default='New conversation')
    # Persona bound to this conversation — who answers. Null = not yet bound; the next
    # incoming message binds it to the user's default persona (or an explicit override)
    # and persists it. There is no trigger-word routing here: the trigger word wakes the
    # assistant, it does not choose the voice.
    persona_id = Column(Integer, ForeignKey('personas.id', ondelete='SET NULL'), nullable=True)
    compacted_context = Column(Text, nullable=False, default="", server_default="")
    compacted_up_to_id = Column(Integer, nullable=False, default=0, server_default="0")
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow)

    user = relationship("User", back_populates="conversations")
    messages = relationship("Message", back_populates="conversation", cascade="all, delete-orphan")
    persona = relationship("Persona", foreign_keys=[persona_id])


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
    # An assistant message records the calls it made; a tool message records
    # which call it answers. Without these, replayed history is a tool message
    # with no matching request, which strict providers reject.
    tool_calls = Column(JSON, nullable=True)
    tool_call_id = Column(String, nullable=True)
    context_files = Column(JSON, nullable=True)
    images = Column(JSON, nullable=True)
    conversation_id = Column(Integer, ForeignKey('conversations.id', ondelete='CASCADE'), nullable=False, index=True)
    persona_id = Column(Integer, ForeignKey('personas.id', ondelete='SET NULL'), nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)

    conversation = relationship("Conversation", back_populates="messages")
    persona = relationship("Persona")


class Persona(Base):
    """How the assistant sounds: a voice, a name, a prompt.

    A persona carries presentation only. It owns no model, no tools and no memory —
    those belong to the user's single :class:`Assistant`, so swapping persona changes
    the voice without changing what the assistant can do or remember. A conversation
    binds to exactly one persona (``conversations.persona_id``) and each message
    records the persona that produced it (``messages.persona_id``).
    """
    __tablename__ = 'personas'

    id = Column(Integer, primary_key=True)
    user_id = Column(Integer, ForeignKey('users.id', ondelete='CASCADE'), nullable=False)
    name = Column(String, nullable=False)
    description = Column(String, default='', nullable=False)
    system_prompt = Column(Text, default='')

    # Presentation
    voice_reference = Column(String, nullable=True)
    avatar_uuid = Column(String, nullable=True)
    character_config = Column(JSON, nullable=True)
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

    # Voice wake word. Assistant-level: saying it wakes the assistant, and the bound
    # persona answers. It does not select a persona.
    trigger_word = Column(String, nullable=True)

    # Persona used for new conversations, and by anything the server creates on the
    # user's behalf (auto-compaction). SET NULL so deleting a persona cannot orphan
    # the row; callers fall back to any enabled persona.
    default_persona_id = Column(
        Integer, ForeignKey('personas.id', ondelete='SET NULL'), nullable=True
    )
    created_at = Column(DateTime, default=datetime.utcnow)

    user = relationship("User", back_populates="assistant")
    default_persona = relationship("Persona", foreign_keys=[default_persona_id])


class SubAgent(Base):
    """A task-only worker the assistant calls mid-answer.

    Has its own model and tools because it runs its own LLM loop, but no identity: it
    never speaks to the user and is never bound to a conversation. It carries no memory
    — the consolidation pipeline only ever wrote main-agent memory, so a ``memory``
    column here could never be filled.
    """
    __tablename__ = 'sub_agents'

    id = Column(Integer, primary_key=True)
    user_id = Column(Integer, ForeignKey('users.id', ondelete='CASCADE'), nullable=False)
    name = Column(String, nullable=False)
    description = Column(String, default='', nullable=False)
    system_prompt = Column(Text, default='')

    model_name = Column(String, nullable=True)
    provider_type = Column(String, default='ollama', nullable=False)
    available_tools = Column(JSON, nullable=True)
    think = Column(Boolean, default=False, nullable=False)
    use_deferred_tools = Column(Boolean, default=False, nullable=False)

    enabled = Column(Boolean, default=True, nullable=False)
    created_at = Column(DateTime, default=datetime.utcnow)

    __table_args__ = (UniqueConstraint('user_id', 'name', name='uq_sub_agent_user_id_name'),)

    user = relationship("User", back_populates="sub_agents")


class Skill(Base):
    """User-created skill — instructions injected into all agent system prompts."""
    __tablename__ = 'skills'

    id = Column(Integer, primary_key=True)
    user_id = Column(Integer, ForeignKey('users.id'), nullable=False)
    name = Column(String, nullable=False)
    instructions = Column(Text, default='')
    created_at = Column(DateTime, default=datetime.utcnow)

    __table_args__ = (UniqueConstraint('user_id', 'name', name='uq_skill_user_id_name'),)

    user = relationship("User")


class MCPServer(Base):
    """User-configured MCP server connection."""
    __tablename__ = 'mcp_servers'

    id = Column(Integer, primary_key=True)
    user_id = Column(Integer, ForeignKey('users.id'), nullable=False)
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
    user_id = Column(Integer, ForeignKey('users.id'), nullable=False)
    name = Column(String, nullable=False)
    created_at = Column(DateTime, default=datetime.utcnow)

    __table_args__ = (UniqueConstraint('user_id', 'name', name='uq_face_identity_user_id_name'),)

    user = relationship("User")
    photos = relationship("FacePhoto", back_populates="identity", cascade="all, delete-orphan")


class FacePhoto(Base):
    __tablename__ = 'face_photos'

    id = Column(Integer, primary_key=True)
    identity_id = Column(Integer, ForeignKey('face_identities.id', ondelete='CASCADE'), nullable=False)
    embedding = Column(Vector(512), nullable=False)
    photo_uuid = Column(String, nullable=False)
    created_at = Column(DateTime, default=datetime.utcnow)

    identity = relationship("FaceIdentity", back_populates="photos")
