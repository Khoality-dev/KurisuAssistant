# Skills

Skills are user-created instruction blocks that teach the assistant how to perform
a specific task. They work as on-demand knowledge: the **names** go into the system
prompt, and the full text is fetched with the `get_skill_instructions` tool when
one turns out to be relevant.

## Format

A skill has two fields:

| Field | Type | Description |
|-------|------|-------------|
| `name` | string | Unique per user (e.g. `music_player`, `code_review`) |
| `instructions` | string | Free-form text for the model to follow |

## How Skills Work

1. **Listing.** While building the system prompt, `MainAgent._prepare_messages`
   calls `get_skill_names_for_user()` and, if there are any, appends a `## Skills`
   section:

   ```
   ## Skills
   You have the following skills: music_player, code_review.
   Skills contain detailed instructions on HOW to perform specific tasks. You MUST
   call get_skill_instructions to load the relevant skill's instructions BEFORE
   attempting any task that matches a skill name. Do NOT guess or improvise —
   always read the skill first and follow its instructions exactly.
   ```

2. **Lookup.** The model calls `get_skill_instructions` with the skill name and
   gets the stored `instructions` back — or `Skill '<name>' not found.`

3. **Execution.** It follows what it read.

Names in the prompt, text on demand: system prompts stay short while the detail
stays reachable.

### Where the list is injected

Skills belong to the **user**, not to a persona, and the list is appended to the
assistant's system prompt **after** the persona's own prompt (and after the user's
`system_prompt`, preferred name and the current time) — it is the second block in
`MainAgent._prepare_messages`, before the deferred-tool guide, the memory and the
compacted context. Switching persona does not change which skills exist.

**Sub-agents are not given the list.** `SubAgent.execute` builds its prompt from
its own `system_prompt` and nothing else — no skills section, no memory, no
compacted context. `get_skill_instructions` is a built-in tool, so a sub-agent can
still call it by name; it just is not told what exists. If a sub-agent needs a
skill, name it in that sub-agent's own `system_prompt`.

## Writing Effective Skills

Skills can reference tools, define workflows, set behavioural guidelines, or
combine several capabilities:

```
Use the web-search MCP tool to find sources before answering a factual question.
Search with a specific query rather than the user's whole sentence. If the tool
returns nothing, say so instead of answering from memory. Always cite the URLs
you used.
```

Tips:
- **Be specific** — name the exact tools to use and how.
- **Cover edge cases** — what should happen when a tool fails or returns nothing?
- **Keep it focused** — one skill per capability; use several skills for unrelated
  tasks.
- **Reference tools by their real names** — the names from `GET /tools`, so the
  model can match them.

## API

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/skills` | List all skills for the current user |
| `POST` | `/skills` | Create a skill (`{name, instructions}`) — `409` on a duplicate name |
| `PATCH` | `/skills/{id}` | Update a skill (`{name?, instructions?}`) |
| `DELETE` | `/skills/{id}` | Delete a skill → `{"deleted": true}` |

### Create/Update Schema

```json
{
  "name": "skill_name",
  "instructions": "Full instructions text..."
}
```

### Response Schema

```json
{
  "id": 1,
  "name": "skill_name",
  "instructions": "Full instructions text...",
  "created_at": "2026-01-01T00:00:00Z"
}
```

## Export / Import

**The server has no skill export or import endpoint.** The desktop client
implements it entirely on its own: it writes a `<name>.skill.json` file holding
`{name, instructions, version: 1}` and, on import, posts the parsed fields back to
`POST /skills`. Nothing about that file format is enforced by the backend.

(Personas and sub-agents *do* have server-side export/import — a different format,
version 3, described in [API.md](API.md#export--import-format).)

## Key Files

- `db/models.py` — the `Skill` model
- `db/repositories/skill.py` — `SkillRepository` queries
- `routers/skills.py` — the REST endpoints
- `tools/skills.py` — `GetSkillInstructionsTool` + `get_skill_names_for_user()`
- `agents/main.py` — `_prepare_messages()`, where the `## Skills` block is appended
