import os
from sqlalchemy import create_engine
from sqlalchemy.ext.declarative import declarative_base
from sqlalchemy.orm import sessionmaker

Base = declarative_base()

# Database engine setup
DATABASE_URL = os.getenv("DATABASE_URL", "postgresql://kurisu:kurisu@localhost:5432/kurisu")
engine = create_engine(DATABASE_URL)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)