"""Repository for DriveNode model operations.

Every method here takes a ``user_id`` and filters on it. That is deliberate: the
drive is the first store where the *names* are user-supplied, so "which account
does this row belong to" has to be answered in one place rather than in each
caller. The HTTP router and the assistant's drive tools both go through this
class, so there is one implementation of what the drive allows.
"""

from typing import List, Optional, Tuple

from sqlalchemy import func
from sqlalchemy.orm import Session

from ..models import DriveNode
from .base import BaseRepository, UNSET


def _parent_is(parent_id: Optional[int]):
    """Match a parent, root included.

    ``parent_id == None`` renders as ``= NULL``, which matches nothing, and
    ``.is_(5)`` renders as ``IS 5``, which is not valid SQL. The root and a
    folder therefore need different operators.
    """
    if parent_id is None:
        return DriveNode.parent_id.is_(None)
    return DriveNode.parent_id == parent_id


class DriveNodeRepository(BaseRepository[DriveNode]):
    """Repository for DriveNode model operations."""

    def __init__(self, session: Session):
        super().__init__(DriveNode, session)

    # ── reads ──────────────────────────────────────────────────────────────

    def list_children(self, user_id: int, parent_id: Optional[int]) -> List[DriveNode]:
        """Children of ``parent_id`` (or of the root when it is None).

        Folders first, then name — the order both clients render in, decided
        here so two clients cannot disagree about it.
        """
        return (
            self.session.query(DriveNode)
            .filter(DriveNode.user_id == user_id, _parent_is(parent_id))
            .order_by(DriveNode.is_dir.desc(), DriveNode.name)
            .all()
        )

    def get_by_user_and_id(self, user_id: int, node_id: int) -> Optional[DriveNode]:
        return self.get_by_filter(user_id=user_id, id=node_id)

    def get_child(self, user_id: int, parent_id: Optional[int], name: str) -> Optional[DriveNode]:
        return (
            self.session.query(DriveNode)
            .filter(
                DriveNode.user_id == user_id,
                _parent_is(parent_id),
                DriveNode.name == name,
            )
            .first()
        )

    def resolve_path(self, user_id: int, path: str) -> Optional[DriveNode]:
        """Walk a ``/a/b/c`` path down the tree, one row lookup per segment.

        Returns None for a path that does not exist, and for the root itself —
        the root is not a row. Nothing here touches the filesystem, so a segment
        of ``..`` simply fails to match a name and the walk ends; there is no
        path to escape from.
        """
        node = None
        for segment in split_path(path):
            node = self.get_child(user_id, node.id if node else None, segment)
            if node is None:
                return None
        return node

    def usage(self, user_id: int) -> Tuple[int, int]:
        """``(bytes stored, file count)`` for one account. Folders count as neither."""
        used, count = (
            self.session.query(
                func.coalesce(func.sum(DriveNode.size), 0),
                func.count(DriveNode.id),
            )
            .filter(DriveNode.user_id == user_id, DriveNode.is_dir.is_(False))
            .one()
        )
        return int(used), int(count)

    def subtree_ids(self, user_id: int, node: DriveNode) -> List[int]:
        """``node`` and every descendant, breadth-first.

        Used to reject a move into a node's own subtree, and to gather the blobs
        a folder delete has to unlink. Iterative rather than a recursive CTE
        because a user's tree is small and this stays readable.
        """
        found = [node.id]
        frontier = [node.id]
        while frontier:
            rows = (
                self.session.query(DriveNode.id)
                .filter(DriveNode.user_id == user_id, DriveNode.parent_id.in_(frontier))
                .all()
            )
            frontier = [r[0] for r in rows]
            found.extend(frontier)
        return found

    # ── writes ─────────────────────────────────────────────────────────────

    def _require_free_name(self, user_id: int, parent_id: Optional[int], name: str) -> None:
        if self.get_child(user_id, parent_id, name):
            raise ValueError(f"'{name}' already exists here")

    def _require_folder(self, user_id: int, parent_id: Optional[int]) -> None:
        """A parent must exist, belong to the caller, and be a folder.

        None is the root, which always exists and needs no row.
        """
        if parent_id is None:
            return
        parent = self.get_by_user_and_id(user_id, parent_id)
        if parent is None:
            raise LookupError("Parent folder not found")
        if not parent.is_dir:
            raise ValueError("Parent is a file, not a folder")

    def create_folder(self, user_id: int, parent_id: Optional[int], name: str) -> DriveNode:
        self._require_folder(user_id, parent_id)
        self._require_free_name(user_id, parent_id, name)
        return self.create(
            user_id=user_id, parent_id=parent_id, name=name, is_dir=True, size=0,
        )

    def create_file(
        self,
        user_id: int,
        parent_id: Optional[int],
        name: str,
        size: int,
        mime: Optional[str],
        checksum: str,
        storage_key: str,
    ) -> DriveNode:
        self._require_folder(user_id, parent_id)
        self._require_free_name(user_id, parent_id, name)
        return self.create(
            user_id=user_id,
            parent_id=parent_id,
            name=name,
            is_dir=False,
            size=size,
            mime=mime,
            checksum=checksum,
            storage_key=storage_key,
        )

    def replace_file(
        self,
        node: DriveNode,
        size: int,
        mime: Optional[str],
        checksum: str,
        storage_key: str,
    ) -> str:
        """Point a file row at new bytes, returning the storage key it let go of.

        The caller unlinks that blob **after** the transaction commits: dropping
        it first would leave a row pointing at nothing if the commit then failed.
        """
        from datetime import datetime

        previous = node.storage_key
        self.update(
            node,
            size=size,
            mime=mime,
            checksum=checksum,
            storage_key=storage_key,
            updated_at=datetime.utcnow(),
        )
        return previous

    def rename_move(
        self,
        user_id: int,
        node: DriveNode,
        name: object = UNSET,
        parent_id: object = UNSET,
    ) -> DriveNode:
        """Rename and/or reparent a node, refusing anything that breaks the tree."""
        from datetime import datetime

        new_name = node.name if name is UNSET else name
        new_parent = node.parent_id if parent_id is UNSET else parent_id

        if new_name == node.name and new_parent == node.parent_id:
            return node

        if parent_id is not UNSET and new_parent is not None:
            self._require_folder(user_id, new_parent)
            # A folder cannot be moved inside itself; the row would survive but
            # the subtree would be unreachable from the root forever.
            if new_parent in self.subtree_ids(user_id, node):
                raise ValueError("A folder cannot be moved into itself")

        existing = self.get_child(user_id, new_parent, new_name)
        if existing and existing.id != node.id:
            raise ValueError(f"'{new_name}' already exists here")

        return self.update(
            node, name=new_name, parent_id=new_parent, updated_at=datetime.utcnow(),
        )

    def delete_subtree(self, user_id: int, node: DriveNode) -> List[str]:
        """Delete a node and everything under it; return the blobs to unlink.

        Rows go first and in one statement (the self-referencing FK cascades
        anyway; deleting them explicitly keeps the returned key list honest). A
        blob left behind is wasted disk; a row left pointing at a deleted blob
        is a broken file, so this order is the safe one.
        """
        ids = self.subtree_ids(user_id, node)
        keys = [
            key
            for (key,) in self.session.query(DriveNode.storage_key)
            .filter(DriveNode.id.in_(ids), DriveNode.storage_key.isnot(None))
            .all()
        ]
        (
            self.session.query(DriveNode)
            .filter(DriveNode.user_id == user_id, DriveNode.id.in_(ids))
            .delete(synchronize_session=False)
        )
        self.session.flush()
        return keys

    def touch_parents(self, node: DriveNode) -> None:
        """Bump ``updated_at`` on the folder a change happened in.

        A folder's modified time is about its contents — that is what the
        Modified column means next to a folder in the explorer.
        """
        from datetime import datetime

        if node.parent_id is None:
            return
        parent = self.get_by_id(node.parent_id)
        if parent is not None:
            self.update(parent, updated_at=datetime.utcnow())


def split_path(path: str) -> List[str]:
    """``/Reports/Q3.md`` → ``['Reports', 'Q3.md']``; ``/`` → ``[]``.

    Empty segments are dropped, so ``//a//b`` and ``/a/b`` are the same path.
    ``.`` and ``..`` are left alone on purpose: they are matched against stored
    names like any other segment and simply do not exist, which is safer than
    resolving them.
    """
    return [segment for segment in path.split("/") if segment]
