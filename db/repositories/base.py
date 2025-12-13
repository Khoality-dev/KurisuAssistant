from typing import Generic, TypeVar, Type, Optional, List, Any
from sqlalchemy.orm import Session
from sqlalchemy import desc

ModelType = TypeVar("ModelType")


class BaseRepository(Generic[ModelType]):
    """Base repository with common CRUD operations."""

    def __init__(self, model: Type[ModelType], session: Session):
        """Initialize repository with model class and database session.

        Args:
            model: SQLAlchemy model class
            session: SQLAlchemy session instance
        """
        self.model = model
        self.session = session

    def get_by_id(self, id: Any) -> Optional[ModelType]:
        """Get a single record by primary key.

        Args:
            id: Primary key value

        Returns:
            Model instance or None if not found
        """
        return self.session.query(self.model).filter(self.model.id == id).first()

    def get_all(self, limit: Optional[int] = None, offset: int = 0) -> List[ModelType]:
        """Get all records with optional pagination.

        Args:
            limit: Maximum number of records to return
            offset: Number of records to skip

        Returns:
            List of model instances
        """
        query = self.session.query(self.model)
        if limit:
            query = query.limit(limit).offset(offset)
        return query.all()

    def get_by_filter(self, **filters) -> Optional[ModelType]:
        """Get a single record by filter criteria.

        Args:
            **filters: Field-value pairs to filter by

        Returns:
            Model instance or None if not found
        """
        return self.session.query(self.model).filter_by(**filters).first()

    def get_many_by_filter(
        self, limit: Optional[int] = None, offset: int = 0, **filters
    ) -> List[ModelType]:
        """Get multiple records by filter criteria.

        Args:
            limit: Maximum number of records to return
            offset: Number of records to skip
            **filters: Field-value pairs to filter by

        Returns:
            List of model instances
        """
        query = self.session.query(self.model).filter_by(**filters)
        if limit:
            query = query.limit(limit).offset(offset)
        return query.all()

    def create(self, **data) -> ModelType:
        """Create a new record.

        Args:
            **data: Field-value pairs for the new record

        Returns:
            Created model instance
        """
        instance = self.model(**data)
        self.session.add(instance)
        self.session.flush()
        return instance

    def update(self, instance: ModelType, **data) -> ModelType:
        """Update an existing record.

        Args:
            instance: Model instance to update
            **data: Field-value pairs to update

        Returns:
            Updated model instance
        """
        for key, value in data.items():
            setattr(instance, key, value)
        self.session.flush()
        return instance

    def delete(self, instance: ModelType) -> None:
        """Delete a record.

        Args:
            instance: Model instance to delete
        """
        self.session.delete(instance)
        self.session.flush()

    def delete_by_filter(self, **filters) -> int:
        """Delete records by filter criteria.

        Args:
            **filters: Field-value pairs to filter by

        Returns:
            Number of records deleted
        """
        return self.session.query(self.model).filter_by(**filters).delete()

    def count(self, **filters) -> int:
        """Count records matching filter criteria.

        Args:
            **filters: Field-value pairs to filter by

        Returns:
            Number of matching records
        """
        query = self.session.query(self.model)
        if filters:
            query = query.filter_by(**filters)
        return query.count()

    def exists(self, **filters) -> bool:
        """Check if records matching criteria exist.

        Args:
            **filters: Field-value pairs to filter by

        Returns:
            True if at least one record exists, False otherwise
        """
        return self.session.query(
            self.session.query(self.model).filter_by(**filters).exists()
        ).scalar()
