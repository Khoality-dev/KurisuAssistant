# Skills

Skills are user-created instruction blocks that teach agents how to perform specific tasks. They act as on-demand knowledge — skill names appear in every agent's system prompt, and agents fetch the full instructions via the `get_skill_instructions` tool when relevant.

## Format

A skill has two fields:

| Field | Type | Description |
|-------|------|-------------|
| `name` | string | Unique identifier per user (e.g., `music_player`, `code_review`) |
| `instructions` | string | Free-form text instructions for the agent to follow |

### Export/Import Format (`.skill.json`)

```json
{
  "name": "music_player",
  "instructions": "When the user asks to play music, use the play_music tool...",
  "version": 1
}
```

- File extension: `.skill.json` (also accepts `.json`)
- `name` (required): Must be a non-empty string
- `instructions` (optional): Defaults to empty string if omitted
- `version` (optional): Currently always `1`, reserved for future format changes

## How Skills Work

1. **Listing**: On each agent request, all skill names for the user are loaded and injected into the system prompt:
   ```
   You have skills available: music_player, code_review.
   IMPORTANT: Before performing any task, check if a relevant skill is available.
   If so, call get_skill_instructions to read the skill's full instructions first, then follow them.
   ```

2. **Lookup**: When the agent determines a skill is relevant, it calls the `get_skill_instructions` tool with the skill name to retrieve the full instructions.

3. **Execution**: The agent follows the retrieved instructions to complete the task.

This two-step approach (names in system prompt, full text on-demand) keeps system prompts concise while making detailed instructions available when needed.

## Writing Effective Skills

Skills can reference tools, define workflows, set behavioral guidelines, or combine multiple capabilities:

```json
{
  "name": "music_player",
  "instructions": "Use the play_music MCP tool to play songs. When the user asks to play something, search by song name and artist. If they ask what's playing, use get_music_state. Always confirm what you're playing.",
  "version": 1
}
```

Tips:
- **Be specific** — tell the agent exactly which tools to use and how
- **Cover edge cases** — what should the agent do if a tool fails or returns unexpected results?
- **Keep it focused** — one skill per capability; use multiple skills for unrelated tasks
- **Reference tools by name** — use the exact tool names so the agent can match them

## API

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/skills` | List all skills for the current user |
| `POST` | `/skills` | Create a skill (`{name, instructions}`) |
| `PATCH` | `/skills/{id}` | Update a skill (`{name?, instructions?}`) |
| `DELETE` | `/skills/{id}` | Delete a skill |

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

## Key Files

- `db/models.py` — `Skill` DB model
- `db/repositories/skill.py` — `SkillRepository` queries
- `routers/skills.py` — REST API endpoints
- `tools/skills.py` — `GetSkillInstructionsTool` + `get_skill_names_for_user()`
- `agents/base.py` — System prompt injection (line ~337)
