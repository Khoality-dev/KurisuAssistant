"""Who may see a stored image.

There are two kinds of image in ``data/image_storage/data/``. Anything uploaded
since #154 sits under ``users/{user_id}/``, so the path itself records the owner.
Anything older sits in the flat store with no owner on disk, and the only way to
place it is the row that points at it.

**Both halves are needed, and so is the check at the other end.** Reading is not
the only way to reach an image: ``personas.avatar_uuid`` is a plain string the
client supplies, so an ownership test of the form "does a row you own reference
this UUID?" is a lock whose key the attacker can cut — attach a UUID overheard
from a proxy log to your own persona, and the read check then says yes. That is
why :func:`owns_image` guards the *attach* in ``routers/personas.py`` as well as
the *fetch* in ``routers/images.py``: a UUID has to be yours before you can point
anything at it.
"""

from kurisuassistant.db.models import FaceIdentity, FacePhoto, Persona, User
from kurisuassistant.utils.images import get_user_image_path


def references_image(session, user_id: int, image_uuid: str) -> bool:
    """Does a row belonging to ``user_id`` point at this UUID?

    These three columns are every place an image UUID is referenced: an account
    avatar, a persona avatar, and a face photo under one of the user's
    identities. A UUID matching none of them is either somebody else's or an
    orphan, and both mean the caller has no business with it.
    """
    if session.query(User.id).filter(
        User.id == user_id, User.agent_avatar_uuid == image_uuid,
    ).first():
        return True
    if session.query(Persona.id).filter(
        Persona.user_id == user_id, Persona.avatar_uuid == image_uuid,
    ).first():
        return True
    return bool(
        session.query(FacePhoto.id)
        .join(FaceIdentity, FacePhoto.identity_id == FaceIdentity.id)
        .filter(FaceIdentity.user_id == user_id, FacePhoto.photo_uuid == image_uuid)
        .first()
    )


def owns_image(session, user_id: int, image_uuid: str) -> bool:
    """May ``user_id`` use this image at all — to fetch it, or to attach it?

    The directory answers first because it is the cheap case and the honest one:
    the user uploaded the file, so it is theirs even though nothing references it
    yet. That is what lets the persona editor preview an avatar before the
    persona is saved.
    """
    if get_user_image_path(user_id, image_uuid):
        return True
    return references_image(session, user_id, image_uuid)
