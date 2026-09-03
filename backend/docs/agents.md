# Agents & Orchestration

## Multi-Agent Orchestration

Two modes controlled by `event.agent_id` in `ChatRequestEvent`:

### Single Agent Mode

(`agent_id` set): Direct path — `_run_single_agent()` skips all Administrator logic. Message goes straight to the specified agent. No OrchestrationSession, no routing loop. Frontend selects agent via top-bar dropdown (persisted in localStorage); each agent maps to one conversation via `kurisu_agent_conversations` localStorage mapping.

**Tool loop**: `SimpleAgent.process()` loops up to 10 rounds — after each LLM call, if tool_calls exist, executes tools, appends assistant+tool messages to context, and calls LLM again so it can reason about results or chain further tool calls.

### Group Discussion Mode

(`agent_id` null): Turn-based orchestration where **AdministratorAgent** (system-level, not a user agent) routes messages between **SimpleAgents** (user-created, equal-tier). Currently disabled in UI.

**Group Flow**: User message → Administrator selects agent → Agent responds → Administrator routes to next agent or back to user. Max 10 turns per user message. Admin model: `gemma3:4b`.

**WebSocket Events**: `TurnUpdateEvent`, `LLMLogEvent`, `AgentSwitchEvent`

## Agent Message Preparation

`SimpleAgent._prepare_messages()`: Builds unified system prompt (agent identity + agent prompt + user prompt + preferred_name + timestamp + other agent descriptions). Filters out system/administrator messages from history.

## Tool Access Control

All tools available by default. Built-in tools (`built_in = True`) always available regardless. `Agent.excluded_tools` JSON array lists tools to disable for that agent. `execute_tool()` enforces exclusions.

## Agent Memory

Per-agent free-form text document (markdown), automatically consolidated from conversation history and injected into the agent's system prompt every request.

- **Storage**: `Agent.memory` text column (nullable). No separate table. `Agent.memory_enabled` boolean (default True) controls injection + consolidation.
- **Injection**: Appended to system prompt in `SimpleAgent._prepare_messages()` as "Your memory:\n{memory}" only when `memory_enabled` is True. Loaded from `AgentConfig.memory` (no runtime DB query).
- **Consolidation**: `utils/memory_consolidation.py` — fire-and-forget async task triggered on frame idle detection (same trigger as frame summarization). Reads agent's system prompt + current memory + new frame messages, calls LLM to produce updated memory. Hard limit ~4000 chars. Uses `User.summary_model` (same model as frame summarization).
- **Trigger**: In `_run_single_agent()`, after frame summarization. Fires when `consolidation_fids` (old frame + unsummarized frames) is non-empty, `agent_id` is set, `memory_enabled` is True, and `summary_model` is configured. Both summarization and consolidation are skipped if no summary model is set.
- **Frontend**: Editable textarea in agent edit dialog (AgentsWindow.tsx). Exposed via `GET/PATCH /agents/{id}`.
