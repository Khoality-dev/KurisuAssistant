# Kurisu Drive

Account-scoped file storage on the server. A file put in from any signed-in
client comes back, unchanged, from any other — which is the thing that did not
exist before (#17). The desktop explorer shows it as a second root beside "This
computer"; the assistant reaches it through four tools.

REST only. Nothing here touches the WebSocket, so the wire protocol is untouched
and the drive tools ride the tool-approval machinery that already exists.

## The model

One table, `drive_nodes`, holding a tree per account:

| Column | Notes |
| --- | --- |
| `id` | integer PK, as everywhere else in this schema |
| `user_id` | → `users.id`, `ON DELETE CASCADE`, indexed |
| `parent_id` | → `drive_nodes.id`, `ON DELETE CASCADE`, null at the root |
| `name` | the entry's name; validated, never used to build a path |
| `is_dir` | a folder has no bytes |
| `size` | `BigInteger` — the only one in the schema; `Integer` stops at 2 GB |
| `mime` | guessed from the extension, never taken from the client |
| `checksum` | sha256 hex of the bytes |
| `storage_key` | uuid4 naming the blob on disk |
| `created_at`, `updated_at` | `updated_at` is maintained by hand, as `conversations` does |

`checksum` is there from the first migration on purpose: #6 (RAG) needs to
attribute chunks to a file and re-embed when the bytes change, and retrofitting a
checksum onto an already-full drive means rehashing everything.

Uniqueness is **two partial indexes**, not one constraint, because Postgres
treats NULLs as distinct — a plain `UNIQUE (user_id, parent_id, name)` would
allow two folders called `Reports` at the root, since `parent_id` is NULL in both
rows:

- `uq_drive_node_user_id_parent_id_name` where `parent_id IS NOT NULL`
- `uq_drive_node_user_id_name_root` where `parent_id IS NULL`

There is no synthetic per-user root row. The root is the absence of a parent.

## Where the bytes are

`data/drive/{user_id}/{storage_key}`, verbatim. Not under `image_storage/`: the
drive is the one store that grows without bound, and an operator has to be able
to archive or exclude it on its own. See `operations.md`.

Nothing is re-encoded. Every other upload route in this backend runs its bytes
through `cv2.imdecode`/`imwrite` at JPEG quality 90 and discards the original;
giving back exactly what it was given is the drive's whole job.

## Path safety

**A path is never joined onto a filesystem path.** Every mutating call addresses
a node by id; the one route that takes a path, `GET /drive/resolve`, walks it
segment by segment against `drive_nodes` rows. A segment of `..` is matched
against stored names, where it does not exist, and the walk ends — there is no
directory to escape from. Blob paths are built only from `storage_key`, which the
server generates.

That is deliberately different from `routers/character.py` and `routers/tts.py`,
which build real paths out of request parameters and are the reason this was
worth designing around rather than sanitising.

`utils/drive_storage.validate_name` still refuses names that would *look* like a
path — a separator, `.`, `..`, a null byte, leading or trailing whitespace, over
255 bytes — but that guards the database and the UI, not the disk.

## Serving

Downloads go through Starlette's `FileResponse`, which implements
`Range`/`If-Range`, 206 and 416 itself. Seeking in a long voice memo works
because of that and would have to be reimplemented if the route read bytes
itself.

Every download carries `X-Content-Type-Options: nosniff` and
`Cache-Control: private, no-store`, and is an **attachment** typed
`application/octet-stream` unless the caller passes `?inline=1` *and* the stored
type is one that cannot execute: `image/*`, `audio/*`, `video/*`,
`application/pdf`, `text/plain` — minus `image/svg+xml`, which is an image the
browser runs. An uploaded page served inline would execute on the API's own
origin with the caller's session behind it.

Auth is by header or `?token=`, the same pair the images routes use, because a
streamed download in the Electron main process and a `<video src=…>` cannot set
a header. The verification lives in `core/deps.resolve_user_from_token` so the
images and drive routes cannot drift apart.

A node belonging to someone else is **404, never 403**.

## Uploads stream

`utils/drive_storage.store_stream` writes incrementally to
`data/drive/{user_id}/.incoming/{uuid}`, hashing and counting as it goes, and
`os.replace`s the file into place only when the stream ends. A refused,
cancelled or abandoned upload leaves nothing behind.

Nothing else in this backend streams: all nine other `UploadFile` routes read the
whole body into memory first, so their size ceiling is checked after the upload
has already been paid for. Here the file ceiling and the account's quota are both
enforced as the bytes arrive.

A part-file is unlinked on every exception, including a client hanging up — but
not when the process is killed outright, and an orphan there counts against no
quota, because the quota is the sum of the *rows*. So each upload first sweeps
its own account's `.incoming` of anything older than a day. Self-healing, and one
listdir of a directory that is normally empty.

Behind nginx, `location /drive/` sets `proxy_request_buffering off` — otherwise
nginx spools the entire body to its own disk before the API sees a byte, which
turns the incremental write back into a copy plus a wait.

## Limits

| Variable | Default | What it bounds |
| --- | --- | --- |
| `DRIVE_QUOTA_BYTES` | 15 GB | Total stored bytes per account |
| `DRIVE_MAX_FILE_BYTES` | 2 GB | One file |

Registration is open by default (`operations.md`), so an unmetered drive would be
a disk-exhaustion surface for the whole host. Over the file ceiling is `413`;
over quota is `507`. Both are per-account: there is no per-user override column,
because the design shows a usage bar, not a per-account editor.

With the `tls` profile in front, nginx's `client_max_body_size` for `/drive/`
applies as well, and whichever is smaller wins. Keep it at or above
`DRIVE_MAX_FILE_BYTES`: an upload nginx refuses never reaches the message the
backend would have given.

## Deletion

Hard. There is no trash and no versioning — nothing in this system versions
anything, and #6 wants a plain `ON DELETE CASCADE` off `drive_nodes.id`.

Rows go first, in one statement, and the blobs they named are unlinked
afterwards. The other order would leave a row pointing at bytes that are gone —
a file the explorer lists and nothing can open — whereas this order's worst case
is disk nobody is using. A failed unlink is logged, not raised: the row is
already gone, and telling the caller the delete failed would be false.

## The assistant's tools

`tools/drive.py` registers four, all going through the same
`DriveNodeRepository` and `drive_storage` the router uses, so the assistant
cannot reach anything the HTTP API would refuse:

| Tool | Notes |
| --- | --- |
| `drive_list` | folder contents |
| `drive_read` | text only; binary is refused rather than returned as noise; bounded at 256 KB |
| `drive_write` | the parent folder must exist; `if_exists` defaults to `fail` |
| `drive_delete` | hard delete; a non-empty folder needs `recursive: true` |

None is `built_in`, so narrowing an account's `available_tools` takes the drive
away — file access must not arrive through the built-in bypass.

Scope comes from `args["user_id"]`, injected by `BaseAgent.execute_tool` after
the model has produced its arguments. It is not in the declared schema, so the
model cannot name another account.

Approval is the existing machinery, not something this module reimplements. See
`tools.md` for how the three-way Drive policy maps onto `users.tool_policies`.
`describe_call` writes the sentence the approval bar shows; for `drive_write` and
`drive_delete` it names the file and the size, because that is what someone reads
before pressing Enter on something irreversible.

## What is deliberately not here

- **Search.** That is #6, and it needs this first: a drive with no search is
  useful, search over an empty drive is not.
- **Sharing.** There is no ACL, no share link and no second reader. Every row is
  its owner's.
- **Rename or move by the assistant.** Those stay human actions.
- **A trash.** See Deletion.
