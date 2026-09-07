# Recall: retrieval over past conversations and stored documents

Issue #6. The assistant can search everything the user has said to it before,
and every readable file in their Kurisu Drive, and answer by quoting what was
actually said or written — with the conversation, speaker, time and message id,
or the file path and page — instead of paraphrasing a summary.

Two tools, one index. The model chooses:

| Tool | Finds | How |
| --- | --- | --- |
| `recall_regex` | exact wording | a case-insensitive POSIX regular expression (Postgres `~*`) over the passage text, newest first |
| `recall_semantic` | meaning | cosine distance between the embedded query and the stored embeddings (pgvector), closest first |

Both replace `history_search`, which was an unindexed `ILIKE '%q%'` over
`messages.message` that truncated every hit to 200 characters, cited no message
id, and could not see the drive at all. It is removed, not aliased.

## The index: `passages`

One row per verbatim slice of a source (`db/models.py::Passage`):

| column | meaning |
| --- | --- |
| `user_id` | whose. Every read filters on it in `PassageRepository`, so neither tool can be talked into another account's history |
| `source_kind` | `message` or `drive` |
| `conversation_id`, `message_id` | for a message passage — what a citation names |
| `drive_node_id` | for a drive passage; the full path is resolved at query time (`DriveNodeRepository.paths_for`), so a rename or move needs no re-index |
| `ordinal` | position within the source |
| `content` | the text, exactly as stored. The tools quote it |
| `page`, `start_line`, `end_line` | where in the file: PDF page, PPTX slide, XLSX sheet — or the line range of a text file / of a long message |
| `embedding`, `embedding_model` | the vector and which model made it; null until embedded |
| `embed_attempts` | how many times a provider refused this text |

Every foreign key cascades. That is load-bearing: `MessageRepository.
delete_from_message` and `DriveNodeRepository.delete_subtree` are bulk deletes
that fire no ORM events, so the database is what removes a passage whose
source is gone.

**`embedding` has no dimension.** The model is the operator's choice
(`EMBEDDING_MODEL`), and models differ in width, so the column is a bare
`vector`. pgvector cannot build an HNSW index on such a column, which means a
semantic query is an exact scan over one account's rows — narrowed by
`ix_passages_user_id_embedding_model` — and at per-account scale that is both
fast enough and exact. If a deployment ever outgrows it, the escape hatch is an
expression index over `embedding::vector(N)` for the deployed model's N; nothing
in the code assumes a width.

### Chunking

`utils/chunking.py` cuts a text into passages of about 1200 characters (~300
tokens) with ~200 of overlap, at paragraph boundaries first, then sentences,
then a line end or a space. Every chunk is an exact slice of its source with
its offsets and 1-based line range, which is what lets a citation say
"lines 40–58". A short message is one passage; a long answer is several, in
order. Only `user` and `assistant` messages with text are indexed — tool
results are the model's own scratch work.

### Extraction

`utils/extraction.py` turns a drive file into text, page by page where the
format has pages:

| Format | Reader | Pages |
| --- | --- | --- |
| UTF-8 text, Markdown, source, JSON, CSV… | decode | one, with line numbers |
| HTML | stdlib `html.parser`, tags stripped, scripts and styles dropped | one |
| PDF | `pypdf` | PDF pages |
| DOCX | `python-docx`, paragraphs and table cells | one |
| PPTX | `python-pptx` | slides |
| XLSX / XLSM | `openpyxl`, one line per row, prefixed with the sheet name | sheets |

Whether a file is text is decided from the **bytes** (no NUL byte, decodes as
UTF-8 — the same sniff `drive_read` uses), not only the name: `mimetypes` calls
`.ts` a video and a file with no extension is often a README. The libraries are
imported lazily, like every heavy provider, so `requirements-ci.txt` carries
them only because the unit tests write and read each format.

**Secrets are never indexed.** Dotenv files, private keys, certificate bundles
and password databases are text and would sniff as such, but the index is a
second copy of their contents that every recall query can surface.
`extraction.is_secret_name` refuses them by name before the bytes are read.

Two deterministic failure kinds, neither retried: `Unextractable` (binary,
unknown format, secret, over `RETRIEVAL_MAX_FILE_BYTES`) and `ExtractionError`
(a file that claims a format and cannot be parsed as it). Both stamp the file as
looked at (below), so a broken PDF costs one attempt per version, not one a
minute. A file that chunks past `RETRIEVAL_MAX_PASSAGES_PER_FILE` stops there,
with a warning.

## Keeping it in step: the indexer

`utils/indexing.py` holds the operations; `workers/service.py` runs them on two
threads of their own — `index-worker` (the queue) and `index-scanner` (once a
minute) — separate from `db-worker`, whose single-threadedness is what keeps two
memory consolidations for one user from clobbering each other. Indexing has no
such read-modify-write; sharing the queue would only make each wait for the other.

Two rules shape every operation: **no network call inside a database
callable** (extraction and embedding run on the worker thread; only their
results enter `DBService`'s single queue), and each callable stays small
(≤ 200 messages per chunking batch, 32 rows per embedding write).

**Conversations.** `chunk_conversation` reads messages above
`conversations.indexed_up_to_id`, chunks them, inserts the passages and moves
the watermark — in **one** callable. Read → chunk → insert → stamp on the single
database thread is what makes it atomic against a `delete_from_message` landing
in between, which would otherwise leave the insert pointing at a message that is
gone. The watermark never rewinds: message ids are monotonic and a deleted
message's passages cascade. `indexed_at` is the scan predicate
(`indexed_at IS NULL OR indexed_at < updated_at`), the same shape as
`consolidated_at`.

**Drive files.** `chunk_drive_file` extracts off-thread, then in one callable
re-reads the node's `checksum`, discards the work if the file was replaced
meanwhile, deletes that file's passages, inserts the new ones and stamps
`drive_nodes.indexed_checksum`. A file is due when `checksum IS DISTINCT FROM
indexed_checksum` — which is exactly what `checksum` was put on the table for in
#17. The stamp is written whether or not any text came out.

**Embeddings.** `embed_pending` takes a batch of passage ids, embeds their text
off-thread with the configured model and writes the vectors in one callable.
Failures are of two kinds and are treated differently:

- **Transient** (`TransientEmbedError`: the provider is unreachable, timing out,
  5xx, rate limiting, or misconfigured — a provider with no embeddings, a model
  that cannot be pulled) — nothing about the rows is wrong. The worker pauses the
  embedding side with backoff (1 min doubling to 30 min) and touches no row; the
  first success resets it.
- **Permanent** (`PermanentEmbedError`: a 4xx that is not 408/429) — the provider
  looked at the request and refused it, so one of the texts is the problem. The
  batch is bisected until the refused text stands alone, only that row's
  `embed_attempts` is bumped, and the rest go through. After five refusals a row
  stays keyword-only; the partial index `ix_passages_pending_embed` is defined
  with the same predicate so the backlog scan stays small.

**The scanner** queues, per minute: up to 50 due conversations, up to 50 due
files, and up to 256 pending passages in embed tasks of 32 — skipping the embed
side while paused, and skipping ids already in flight. It is the safety net for
what the direct submits miss (a restart, a crash between write and submit) and
the **backfill**: a deployment that predates the index gets its whole history
chunked over the following minutes and embedded over the following hours,
without a migration touching data. `recall_regex` sees a passage as soon as it is
chunked; `recall_semantic` as soon as it is embedded.

**Direct submits** for low latency: `websocket/handlers.py` queues a
`ChunkConversationTask` right before `done` (and after a failed turn, since the
messages saved before the failure are still worth recalling); `routers/drive.py`
and `tools/drive.py` queue a `ChunkDriveFileTask` after every write. Queued
tasks are deduplicated while waiting.

**A changed `EMBEDDING_MODEL`** is handled at scanner start: every vector not
made by the current model is forgotten in bounded batches
(`sweep_stale_embeddings`) and re-embedded by the backlog, while recall keeps
filtering on `embedding_model = current` so vectors from two models are never
compared.

## The embedding model

Server-wide, from the environment — not per user like the chat model — because
every vector in one table must come from the same model for a distance to mean
anything. `utils/embeddings.py`:

| Variable | Default | Meaning |
| --- | --- | --- |
| `EMBEDDING_PROVIDER` | `ollama` | `ollama` (via `LLM_API_URL`), `gemini` or `nvidia` (via the server-wide keys). Poe has no embeddings endpoint and raises |
| `EMBEDDING_MODEL` | `bge-m3` | multilingual, so Vietnamese and English both work. Empty switches semantic recall **off**: `recall_semantic` says so and points at `recall_regex` |
| `RETRIEVAL_MAX_FILE_BYTES` | 20 MB | files over it are stamped without being read |
| `RETRIEVAL_MAX_PASSAGES_PER_FILE` | 2000 | a file stops chunking here |

`BaseLLMProvider.embed(model, texts, kind=...)` is implemented for Ollama
(`/api/embed`), Gemini (`embed_content` with `RETRIEVAL_DOCUMENT` /
`RETRIEVAL_QUERY`) and the OpenAI dialect (`/embeddings`; NVIDIA adds
`input_type` and `truncate`, because the nv-embedqa family refuses a request that
does not say which side it is). The provider is built once and pulls the model
once (bge-m3 is 1.2 GB — worth one loud log line). Query embedding in the tool
has a 15 s ceiling; past it the tool says the model is not answering and points
at `recall_regex`.

## The tools

`tools/recall.py`. Both are `built_in`, like the history tools they replace, so
recall is always offered. Both take `scope` (`all` | `conversations` |
`documents`), `in_conversation`, `after`, `before` and `limit` (8, at most 20);
`recall_regex` takes `pattern`, `recall_semantic` takes `query`. `user_id` and
`conversation_id` are injected by `BaseAgent.execute_tool` and are not in the
schema.

A result is numbered passages, each a source line and the text quoted as it was
stored:

```
[1] Conversation #12 "Trip admin" — Kurisu, 2026-03-01 09:30, message #345
> We agreed the passport renewal appointment is on 14 March at the embassy.

[2] /Reports/2026/q3.pdf, page 3 — file #77
> Quarterly revenue rose eleven percent on the strength of the Hanoi office.
```

**The current conversation is skipped while it is still in context.** Messages
above the compaction watermark (`compacted_up_to_id`) are verbatim in the
model's context already; recall is for what scrolled away, so only the
compacted-away part of the conversation the call is made from is searched.
`in_conversation` overrides that.

**Documents are gated on `drive_read`.** The drive's rule is that file access
never arrives through the built-in bypass, and recall over drive files is file
access. So document passages are included only when `drive_read` would itself
be allowed to run: it is in the agent's allowlist (`_available_tools`, injected
by `execute_tool` — not on `AgentContext`, because sub-agents share that object
and have their own allowlist) and `users.tool_policies["drive_read"]` is not
`deny`. Otherwise the result says "Documents were not searched", and a
`documents`-only call is refused outright. Under the default unset policy the
approval the user gives to the recall call is what admits documents; that is
stated in `tools.md`'s policy table.

`recall_regex` validates the pattern with Python's `re` first (a sentence, not
a traceback, for an unbalanced parenthesis) and turns the database's own refusal
of a pattern into one too. Patterns are capped at 500 characters and the
statement timeout bounds a pathological one.

The system prompt (`agents/main.py::_prepare_messages`) carries a short
**Recall** section: use one of the tools before saying you do not remember, and
quote and cite what they return.

## What is deliberately not here

- **A REST endpoint.** Recall is the assistant's; the desktop explorer's search
  over drive paths is a separate ticket.
- **Rank fusion.** The two tools are two tools by decision: the model chooses
  wording or meaning, and each result is one ordered list.
- **Full-text search** (`tsvector`). Regex covers exact wording; stemming would
  be wrong for Vietnamese anyway.
- **Indexing `compacted_context` or `assistants.memory`.** Both are derived
  text; the point of the index is the original wording.
