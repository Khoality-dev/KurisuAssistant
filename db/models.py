from sqlalchemy import Boolean, Column, Integer, String, Text, DateTime, ForeignKey, JSON, UniqueConstraint
from sqlalchemy.orm import relationship
from datetime import datetime
from .base import Base

class User(Base):
    __tablename__ = 'users'

    id = Column(Integer, primary_key=True)
    username = Column(String, unique=True, nullable=False)
    password = Column(Text, nullable=False)
    system_prompt = Column(Text, default='')
    preferred_name = Column(Text, default='')
    user_avatar_uuid = Column(String, nullable=True)
    agent_avatar_uuid = Column(String, nullable=True)
    ollama_url = Column(String, nullable=True)  # Custom Ollama server URL (None = use default env var)

    conversations = relationship("Conversation", back_populates="user", cascade="all, delete-orphan")
    agents = relationship("Agent", back_populates="user", cascade="all, delete-orphan")

class Conversation(Base):
    __tablename__ = 'conversations'

    id = Column(Integer, primary_key=True)
    user_id = Column(Integer, ForeignKey('users.id'), nullable=False)
    title = Column(Text, default='New conversation')
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow)

    user = relationship("User", back_populates="conversations")
    frames = relationship("Frame", back_populates="conversation", cascade="all, delete-orphan")

class Frame(Base):
    """Context frame (formerly Chunk) - segments conversations into context windows."""
    __tablename__ = 'frames'

    id = Column(Integer, primary_key=True)
    conversation_id = Column(Integer, ForeignKey('conversations.id', ondelete='CASCADE'), nullable=False, index=True)
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow)

    conversation = relationship("Conversation", back_populates="frames")
    messages = relationship("Message", back_populates="frame", cascade="all, delete-orphan")

class Message(Base):
    __tablename__ = 'messages'

    id = Column(Integer, primary_key=True)
    role = Column(Text, nullable=False)
    message = Column(Text, nullable=False)
    thinking = Column(Text, nullable=True)
    raw_input = Column(Text, nullable=True)   # JSON: messages array sent to LLM
    raw_output = Column(Text, nullable=True)  # Full concatenated LLM response
    name = Column(String, nullable=True)  # Display name (agent name or tool name)
    frame_id = Column(Integer, ForeignKey('frames.id', ondelete='CASCADE'), index=True)
    agent_id = Column(Integer, ForeignKey('agents.id', ondelete='SET NULL'), nullable=True)  # Which agent sent this message
    created_at = Column(DateTime, default=datetime.utcnow)

    frame = relationship("Frame", back_populates="messages")
    agent = relationship("Agent")


class Agent(Base):
    """User-created agent with custom personality and voice."""
    __tablename__ = 'agents'

    id = Column(Integer, primary_key=True)
    user_id = Column(Integer, ForeignKey('users.id'), nullable=False)
    name = Column(String, nullable=False)  # Display name (e.g., "Kurisu")
    system_prompt = Column(Text, default='')  # Custom personality prompt
    voice_reference = Column(String, nullable=True)  # Voice file name for TTS
    avatar_uuid = Column(String, nullable=True)  # Avatar image UUID
    model_name = Column(String, nullable=True)  # LLM model override
    tools = Column(JSON, nullable=True)  # List of tool names
    think = Column(Boolean, default=False, nullable=False)  # Enable extended reasoning
    created_at = Column(DateTime, default=datetime.utcnow)

    # Unique name per user
    __table_args__ = (UniqueConstraint('user_id', 'name', name='uq_agent_user_id_name'),)

    user = relationship("User", back_populates="agents")
