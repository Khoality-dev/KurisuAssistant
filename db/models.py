from sqlalchemy import Column, Integer, String, Text, DateTime, ForeignKey
from sqlalchemy.orm import relationship
from datetime import datetime
from .base import Base

class User(Base):
    __tablename__ = 'users'
    
    username = Column(String, primary_key=True)
    password = Column(Text, nullable=False)
    system_prompt = Column(Text, default='')
    preferred_name = Column(Text, default='')
    user_avatar_uuid = Column(String, nullable=True)
    agent_avatar_uuid = Column(String, nullable=True)
    
    conversations = relationship("Conversation", back_populates="user")

class Conversation(Base):
    __tablename__ = 'conversations'

    id = Column(Integer, primary_key=True)
    username = Column(String, ForeignKey('users.username'), nullable=False)
    title = Column(Text, default='New conversation')
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow)

    user = relationship("User", back_populates="conversations")
    chunks = relationship("Chunk", back_populates="conversation", cascade="all, delete-orphan")

class Chunk(Base):
    __tablename__ = 'chunks'

    id = Column(Integer, primary_key=True)
    conversation_id = Column(Integer, ForeignKey('conversations.id', ondelete='CASCADE'), nullable=False)
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow)

    conversation = relationship("Conversation", back_populates="chunks")
    messages = relationship("Message", back_populates="chunk", cascade="all, delete-orphan")

class Message(Base):
    __tablename__ = 'messages'

    id = Column(Integer, primary_key=True)
    role = Column(Text, nullable=False)
    username = Column(String, nullable=False)
    message = Column(Text, nullable=False)
    thinking = Column(Text, nullable=True)
    chunk_id = Column(Integer, ForeignKey('chunks.id', ondelete='CASCADE'))
    created_at = Column(DateTime, default=datetime.utcnow)

    chunk = relationship("Chunk", back_populates="messages")