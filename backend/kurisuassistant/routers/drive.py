"""Kurisu Drive — account-scoped file storage every client can reach.

Two rules shape this router.

**Everything is addressed by node id, not by path.** A path appears in exactly
one place, ``GET /drive/resolve``, where it is walked segment by segment against
database rows. Nothing here joins user text onto a filesystem path, so directory
traversal is not a thing to sanitise — it cannot be expressed. Blobs are named
by a server-generated UUID (``utils/drive_storage.py``).

**A node that is not yours is 404, not 403.** Same rule the images router
states: telling a caller that an id exists is the same leak in a smaller
envelope.
"""

import logging
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import FileResponse
from pydantic import BaseModel
from sqlalchemy.exc import IntegrityError

from kurisuassistant.core.deps import (
    get_authenticated_user,
    optional_oauth2_scheme,
    resolve_user_from_token,
)
from kurisuassistant.core.errors import internal_error
from kurisuassistant.db.models import DriveNode, User
from kurisuassistant.db.repositories import UNSET, DriveNodeRepository
from kurisuassistant.db.service import get_db_service
from kurisuassistant.utils import drive_storage

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/drive", tags=["drive"])


class FolderCreate(BaseModel):
    parent_id: Optional[int] = None
    name: str


class NodeUpdate(BaseModel):
    name: Optional[str] = None
    parent_id: Optional[int] = None


def _node_to_response(node: DriveNode) -> dict:
    return {
        "id": node.id,
        "parent_id": node.parent_id,
        "name": node.name,
        "is_dir": node.is_dir,
        "size": node.size,
        "mime": node.mime,
        "checksum": node.checksum,
        "created_at": node.created_at.isoformat() + "Z" if node.created_at else None,
        "updated_at": node.updated_at.isoformat() + "Z" if node.updated_at else None,
    }


def _require_node(repo: DriveNodeRepository, user_id: int, node_id: int) -> DriveNode:
    node = repo.get_by_user_and_id(user_id, node_id)
    if node is None:
        raise HTTPException(status_code=404, detail="Not found")
    return node


class _OverQuota(Exception):
    """The bytes arrived, but no longer fit. Raised inside the write
    transaction, where the check and the insert are atomic."""


# ── reads ──────────────────────────────────────────────────────────────────
# Static segments are declared before any "{node_id}" route: FastAPI matches in
# declaration order, so "/drive/nodes" after "/drive/nodes/{id}" would still
# work but "/drive/files/{id}/content" and a future "/drive/files/anything"
# would not. Same reason images.py declares "/u/{uuid}" before "/{uuid}".


@router.get("/usage")
async def get_usage(user: User = Depends(get_authenticated_user)):
    """How much of the account's quota is used — the sidebar bar and the
    Settings card both read this."""
    try:
        def _usage(session):
            used, count = DriveNodeRepository(session).usage(user.id)
            return {
                "used_bytes": used,
                "quota_bytes": drive_storage.QUOTA_BYTES,
                "file_count": count,
                "max_file_bytes": drive_storage.MAX_FILE_BYTES,
            }

        return await get_db_service().execute(_usage)
    except Exception as e:
        raise internal_error(e, "Error reading drive usage")


@router.get("/resolve")
async def resolve(
    path: str = Query(...),
    user: User = Depends(get_authenticated_user),
):
    """Turn ``/Reports/Q3.md`` into a node, for deep links and cold starts.

    The walk is over database rows, one lookup per segment, so a segment of
    ``..`` simply matches no name and the path does not exist.
    """
    try:
        def _resolve(session):
            node = DriveNodeRepository(session).resolve_path(user.id, path)
            if node is None:
                raise HTTPException(status_code=404, detail="Not found")
            return _node_to_response(node)

        return await get_db_service().execute(_resolve)
    except HTTPException:
        raise
    except Exception as e:
        raise internal_error(e, "Error resolving a drive path")


@router.get("/nodes")
async def list_nodes(
    parent_id: Optional[int] = Query(None),
    user: User = Depends(get_authenticated_user),
):
    """Children of ``parent_id``; omit it for the root of the drive."""
    try:
        def _list(session):
            repo = DriveNodeRepository(session)
            if parent_id is not None:
                parent = _require_node(repo, user.id, parent_id)
                if not parent.is_dir:
                    raise HTTPException(status_code=400, detail="That is a file, not a folder.")
            return [_node_to_response(n) for n in repo.list_children(user.id, parent_id)]

        return await get_db_service().execute(_list)
    except HTTPException:
        raise
    except Exception as e:
        raise internal_error(e, "Error listing a drive folder")


@router.get("/files/{node_id}/content")
async def download_file(
    node_id: int,
    inline: bool = Query(False),
    token: Optional[str] = Query(None),
    header_token: Optional[str] = Depends(optional_oauth2_scheme),
):
    """Serve a file's bytes back, unchanged.

    Auth by header **or** ``?token=``: a streamed download in the Electron main
    process and a ``<video src=…>`` both reach this without being able to set a
    header, the same reason the images routes take one.

    Served as an attachment by default, and inline only for types that cannot
    execute. An uploaded ``.html`` rendered inline would run on the API's own
    origin with the caller's session behind it, so ``?inline=1`` is honoured for
    images, audio, video, PDF and plain text and ignored for everything else.

    Range requests come free: ``FileResponse`` implements ``Range``/``If-Range``,
    206 and 416 itself, which is what makes seeking in a long voice memo work.
    """
    resolved_token = token or header_token
    if not resolved_token:
        raise HTTPException(status_code=401, detail="Not authenticated")
    user = await resolve_user_from_token(resolved_token)

    try:
        def _fetch(session):
            node = _require_node(DriveNodeRepository(session), user.id, node_id)
            if node.is_dir:
                raise HTTPException(status_code=400, detail="That is a folder, not a file.")
            return {"name": node.name, "mime": node.mime, "storage_key": node.storage_key}

        meta = await get_db_service().execute(_fetch)
    except HTTPException:
        raise
    except Exception as e:
        raise internal_error(e, "Error reading a drive file")

    path = drive_storage.blob_path(user.id, meta["storage_key"])
    if not path.is_file():
        # The row outlived its blob. That is a bug, not a client error, so it is
        # logged loudly — but the caller still gets the honest answer.
        logger.error("drive: node %s for user %s has no blob on disk", node_id, user.id)
        raise HTTPException(status_code=404, detail="Not found")

    serve_inline = inline and drive_storage.is_inline_safe(meta["mime"])
    disposition = "inline" if serve_inline else "attachment"
    return FileResponse(
        path=path,
        media_type=meta["mime"] if serve_inline else drive_storage.DEFAULT_MIME,
        filename=meta["name"],
        content_disposition_type=disposition,
        headers={
            "Cache-Control": "private, no-store",
            # The type above is deliberate; do not let a browser second-guess it.
            "X-Content-Type-Options": "nosniff",
        },
    )


@router.get("/nodes/{node_id}")
async def get_node(node_id: int, user: User = Depends(get_authenticated_user)):
    try:
        def _get(session):
            return _node_to_response(
                _require_node(DriveNodeRepository(session), user.id, node_id)
            )

        return await get_db_service().execute(_get)
    except HTTPException:
        raise
    except Exception as e:
        raise internal_error(e, "Error reading a drive node")


# ── writes ─────────────────────────────────────────────────────────────────


@router.post("/folders")
async def create_folder(
    data: FolderCreate,
    user: User = Depends(get_authenticated_user),
):
    name = drive_storage.validate_name(data.name)
    try:
        def _create(session):
            repo = DriveNodeRepository(session)
            node = repo.create_folder(user.id, data.parent_id, name)
            return _node_to_response(node)

        return await get_db_service().execute(_create)
    except HTTPException:
        raise
    except LookupError:
        raise HTTPException(status_code=404, detail="Not found")
    except (ValueError, IntegrityError):
        raise HTTPException(status_code=409, detail=f"'{name}' already exists here")
    except Exception as e:
        raise internal_error(e, "Error creating a drive folder")


@router.post("/files")
async def upload_file(
    request: Request,
    name: str = Query(...),
    parent_id: Optional[int] = Query(None),
    overwrite: bool = Query(False),
    user: User = Depends(get_authenticated_user),
):
    """Store a file, streaming the raw request body to disk as it arrives.

    **The body is raw bytes, not multipart, and that is load-bearing.** A
    handler that declares an ``UploadFile`` makes FastAPI call
    ``await request.form()`` *before* it resolves dependencies — so the whole
    body is parsed and spooled to the container's disk before
    ``get_authenticated_user`` runs, before ``MAX_FILE_BYTES`` and before the
    quota. An unauthenticated caller could push whatever nginx allows onto the
    server's filesystem and only then be told 401, and a legitimate upload paid
    for its bytes twice: once into starlette's spool, once copying out of it.
    Taking the body as a stream is what makes every promise in
    ``utils/drive_storage`` true on this route as well as on ``PUT``.

    The name and the destination therefore travel as query parameters. The bytes
    are written before the row exists, because the size and checksum are only
    known once the stream ends; if the row then cannot be created the blob is
    unlinked, so a refused upload leaves nothing behind.
    """
    final_name = drive_storage.validate_name(name)

    try:
        def _plan(session):
            repo = DriveNodeRepository(session)
            if parent_id is not None:
                parent = _require_node(repo, user.id, parent_id)
                if not parent.is_dir:
                    raise HTTPException(status_code=400, detail="That is a file, not a folder.")
            existing = repo.get_child(user.id, parent_id, final_name)
            if existing and not overwrite:
                raise HTTPException(
                    status_code=409, detail=f"'{final_name}' already exists here"
                )
            if existing and existing.is_dir:
                raise HTTPException(
                    status_code=409, detail="A folder of that name is already here."
                )
            used, _ = repo.usage(user.id)
            # Replacing a file releases its bytes, so they are not spent twice.
            reclaimed = existing.size if existing else 0
            return {
                "existing_id": existing.id if existing else None,
                "quota_remaining": drive_storage.QUOTA_BYTES - used + reclaimed,
            }

        plan = await get_db_service().execute(_plan)
    except HTTPException:
        raise
    except Exception as e:
        raise internal_error(e, "Error preparing a drive upload")

    if plan["quota_remaining"] <= 0:
        raise HTTPException(
            status_code=507,
            detail="Your drive is full. Remove something, or ask for more space.",
        )

    storage_key, size, checksum = await drive_storage.store_stream(
        user.id, request.stream(), plan["quota_remaining"]
    )
    mime = drive_storage.guess_mime(final_name)

    try:
        def _persist(session):
            repo = DriveNodeRepository(session)
            node = (
                repo.get_by_user_and_id(user.id, plan["existing_id"])
                if plan["existing_id"] is not None
                else None
            )
            # The quota was measured before the bytes arrived, and nothing
            # reserved the space in between. Re-measuring here is what makes
            # concurrent uploads safe: every `_persist` runs on the single
            # database thread, so this check and the insert are atomic with
            # respect to every other upload.
            used, _ = repo.usage(user.id)
            reclaimed = node.size if node is not None else 0
            if used - reclaimed + size > drive_storage.QUOTA_BYTES:
                raise _OverQuota()
            if node is not None:
                replaced = repo.replace_file(node, size, mime, checksum, storage_key)
                repo.touch_parents(node)
                return _node_to_response(node), replaced
            node = repo.create_file(
                user.id, parent_id, final_name, size, mime, checksum, storage_key
            )
            repo.touch_parents(node)
            return _node_to_response(node), None

        body, replaced_key = await get_db_service().execute(_persist)
    except _OverQuota:
        await drive_storage.delete_blobs(user.id, [storage_key])
        raise HTTPException(
            status_code=507,
            detail="Your drive is full. Remove something, or ask for more space.",
        )
    except (ValueError, IntegrityError):
        # Someone created the same name between the check and the write.
        await drive_storage.delete_blobs(user.id, [storage_key])
        raise HTTPException(status_code=409, detail=f"'{final_name}' already exists here")
    except LookupError:
        # ...or removed the folder it was going into.
        await drive_storage.delete_blobs(user.id, [storage_key])
        raise HTTPException(status_code=404, detail="Not found")
    except BaseException as e:
        # BaseException so a client hanging up mid-request — which arrives as a
        # cancellation, not an Exception — still releases the bytes.
        await drive_storage.delete_blobs(user.id, [storage_key])
        if isinstance(e, HTTPException):
            raise
        raise internal_error(e, "Error storing a drive file")

    if replaced_key:
        await drive_storage.delete_blobs(user.id, [replaced_key])
    return body


@router.put("/files/{node_id}/content")
async def replace_content(
    node_id: int,
    request: Request,
    user: User = Depends(get_authenticated_user),
):
    """Overwrite an existing file's bytes with the raw request body.

    This is what the editor's Save calls. The body is streamed rather than read
    whole, so saving a large file costs the same memory as saving a small one.
    """
    try:
        def _plan(session):
            repo = DriveNodeRepository(session)
            node = _require_node(repo, user.id, node_id)
            if node.is_dir:
                raise HTTPException(status_code=400, detail="That is a folder, not a file.")
            used, _ = repo.usage(user.id)
            return {
                "name": node.name,
                "quota_remaining": drive_storage.QUOTA_BYTES - used + node.size,
            }

        plan = await get_db_service().execute(_plan)
    except HTTPException:
        raise
    except Exception as e:
        raise internal_error(e, "Error preparing a drive write")

    storage_key, size, checksum = await drive_storage.store_stream(
        user.id, request.stream(), plan["quota_remaining"]
    )
    mime = drive_storage.guess_mime(plan["name"])

    try:
        def _persist(session):
            repo = DriveNodeRepository(session)
            node = _require_node(repo, user.id, node_id)
            replaced = repo.replace_file(node, size, mime, checksum, storage_key)
            repo.touch_parents(node)
            return _node_to_response(node), replaced

        body, replaced_key = await get_db_service().execute(_persist)
    except BaseException as e:
        await drive_storage.delete_blobs(user.id, [storage_key])
        if isinstance(e, HTTPException):
            raise
        raise internal_error(e, "Error writing a drive file")

    await drive_storage.delete_blobs(user.id, [replaced_key])
    return body


@router.patch("/nodes/{node_id}")
async def update_node(
    node_id: int,
    data: NodeUpdate,
    user: User = Depends(get_authenticated_user),
):
    """Rename and/or move a node.

    ``exclude_unset`` matters here: an omitted ``parent_id`` leaves the node
    where it is, while an explicit ``null`` moves it to the root.
    """
    provided = data.model_dump(exclude_unset=True)
    name = provided["name"] if "name" in provided else UNSET
    parent_id = provided["parent_id"] if "parent_id" in provided else UNSET

    if name is not UNSET:
        if name is None:
            raise HTTPException(status_code=400, detail="A name is required.")
        name = drive_storage.validate_name(name)

    try:
        def _update(session):
            repo = DriveNodeRepository(session)
            node = _require_node(repo, user.id, node_id)
            node = repo.rename_move(user.id, node, name=name, parent_id=parent_id)
            return _node_to_response(node)

        return await get_db_service().execute(_update)
    except HTTPException:
        raise
    except LookupError:
        raise HTTPException(status_code=404, detail="Not found")
    except IntegrityError:
        raise HTTPException(status_code=409, detail="That name is taken here")
    # The message is one this module wrote — "'x' already exists here", "a folder
    # cannot be moved into itself" — so it is the actionable thing to return.
    except ValueError as e:
        raise HTTPException(status_code=409, detail=str(e))
    except Exception as e:
        raise internal_error(e, "Error updating a drive node")


@router.delete("/nodes/{node_id}")
async def delete_node(
    node_id: int,
    user: User = Depends(get_authenticated_user),
):
    """Delete a node, and everything under it if it is a folder.

    Rows go first, then the blobs they named. The other order would leave a row
    pointing at bytes that are gone — a file the explorer lists and nothing can
    open — whereas this order's worst case is wasted disk.
    """
    try:
        def _delete(session):
            repo = DriveNodeRepository(session)
            node = _require_node(repo, user.id, node_id)
            parent_id = node.parent_id
            keys = repo.delete_subtree(user.id, node)
            if parent_id is not None:
                parent = repo.get_by_id(parent_id)
                if parent is not None:
                    from datetime import datetime

                    repo.update(parent, updated_at=datetime.utcnow())
            return keys

        keys = await get_db_service().execute(_delete)
    except HTTPException:
        raise
    except Exception as e:
        raise internal_error(e, "Error deleting a drive node")

    await drive_storage.delete_blobs(user.id, keys)
    return {"deleted": True}
