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
    tool_policies = Column(JSON, nullable=True)  # {"tools": {"tool_name": "allow"|"deny"}}

    conversations = relationship("Conversation", back_populates="user", cascade="all, delete-orphan")
    agents = relationship("Agent", back_populates="user", cascade="all, delete-orphan")


class Conversation(Base):
    __tablename__ = 'conversations'

    id = Column(Integer, primary_key=True)
    user_id = Column(Integer, ForeignKey('users.id'), nullable=False)
    title = Column(Text, default='New conversation')
    # Main agent for this conversation. Null = not yet picked; gets picked on the next
    # incoming message via trigger-word-then-random selection and then persisted.
    main_agent_id = Column(Integer, ForeignKey('agents.id', ondelete='SET NULL'), nullable=True)
    compacted_context = Column(Text, nullable=False, default="", server_default="")
    compacted_up_to_id = Column(Integer, nullable=False, default=0, server_default="0")
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow)

    user = relationship("User", back_populates="conversations")
    messages = relationship("Message", back_populates="conversation", cascade="all, delete-orphan")
    main_agent = relationship("Agent", foreign_keys=[main_agent_id])


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
    context_files = Column(JSON, nullable=True)
    images = Column(JSON, nullable=True)
    conversation_id = Column(Integer, ForeignKey('conversations.id', ondelete='CASCADE'), nullable=False, index=True)
    agent_id = Column(Integer, ForeignKey('agents.id', ondelete='SET NULL'), nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)

    conversation = relationship("Conversation", back_populates="messages")
    agent = relationship("Agent")


class Agent(Base):
    """Agent with identity and capabilities.

    MainAgent (agent_type='main') has identity fields + trigger_word.
    SubAgent (agent_type='sub') ignores identity fields.
    """
    __tablename__ = 'agents'

    id = Column(Integer, primary_key=True)
    user_id = Column(Integer, ForeignKey('users.id'), nullable=True)  # NULL for system agents
    name = Column(String, nullable=False)
    description = Column(String, default='', nullable=False)
    system_prompt = Column(Text, default='')

    # Identity — MainAgent only
    voice_reference = Column(String, nullable=True)
    avatar_uuid = Column(String, nullable=True)
    character_config = Column(JSON, nullable=True)
    preferred_name = Column(Text, nullable=True)
    trigger_word = Column(String, nullable=True)  # First-message selection hint for MainAgents

    # Inference config
    model_name = Column(String, nullable=True)
    provider_type = Column(String, default='ollama', nullable=False)
    available_tools = Column(JSON, nullable=True)
    think = Column(Boolean, default=False, nullable=False)
    use_deferred_tools = Column(Boolean, default=False, nullable=False)

    # State
    agent_type = Column(String, default='main', nullable=False)  # 'main' | 'sub'
    memory = Column(Text, nullable=True)
    memory_enabled = Column(Boolean, default=True, nullable=False)
    enabled = Column(Boolean, default=True, nullable=False)
    is_system = Column(Boolean, default=False, nullable=False)
    created_at = Column(DateTime, default=datetime.utcnow)

    __table_args__ = (UniqueConstraint('user_id', 'name', name='uq_agent_user_id_name'),)

    user = relationship("User", back_populates="agents")


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
