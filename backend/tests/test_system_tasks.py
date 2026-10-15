"""System tests for tasks (#352): the assistant's own work, now or on a schedule.

The real app on a real Postgres, the model the in-process mock Ollama. A task
run happens on the server with nobody in the chat, so these tests start runs
the way the server does — a due row and a kick of the scheduler — and then
watch what the REST surface says about them.

The mock's unscripted replies are deterministic: ``call <tool> {json}`` as the
last user message makes it call that tool, a tool result makes it say "The tool
returned: …", and anything else is echoed as "You said: …". Tests that need a
scripted reply create their task directly, so no chat turn competes for it.
"""

import time
from datetime import datetime, timedelta

import pytest

from tests.mock_ollama import DEFAULT_MODEL, Reply

pytestmark = pytest.mark.db


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def use_model(account):
    resp = account.client.patch("/assistant", json={"model_name": DEFAULT_MODEL}, headers=account.headers)
    assert resp.status_code == 200, resp.text


def allow(account, tool):
    resp = account.client.patch(
        "/users/me/tool-policies", json={"tool_name": tool, "policy": "allow"}, headers=account.headers,
    )
    assert resp.status_code == 200, resp.text


def make_task(account, *, title="Morning briefing", instructions="Say good morning.",
              repeat="now", next_run_at=None, **schedule_kwargs) -> int:
    """A task row as the assistant's tools would leave it, due at ``next_run_at``."""
    from kurisuassistant.db.repositories import TaskRepository
    from kurisuassistant.db.session import get_session
    from kurisuassistant.tasks.schedule import parse_schedule

    schedule = parse_schedule(repeat, **schedule_kwargs)
    with get_session() as session:
        task = TaskRepository(session).create_task(
            account.id,
            title=title,
            instructions=instructions,
            schedule=schedule,
            next_run_at=next_run_at or datetime.utcnow(),
        )
        return task.id


def kick():
    from kurisuassistant.tasks import service

    service.kick()


def get_task(account, task_id):
    resp = account.client.get(f"/tasks/{task_id}", headers=account.headers)
    assert resp.status_code == 200, resp.text
    return resp.json()


def wait_for_run(account, task_id, *, statuses=("done", "failed", "stopped"), timeout=15.0):
    """Poll until the task's newest run reaches one of ``statuses``."""
    deadline = time.monotonic() + timeout
    last = None
    while time.monotonic() < deadline:
        last = get_task(account, task_id)
        runs = last["runs"]
        if runs and runs[0]["status"] in statuses:
            return runs[0]
        time.sleep(0.1)
    raise AssertionError(f"no run reached {statuses} in {timeout}s: {last}")


def run_messages(account, conversation_id):
    resp = account.client.get(f"/conversations/{conversation_id}?limit=50", headers=account.headers)
    assert resp.status_code == 200, resp.text
    return resp.json()["messages"]


def events_until_done(ws, limit=300):
    out = []
    for _ in range(limit):
        event = ws.receive_json()
        out.append(event)
        if event["type"] in ("done", "error"):
            return out
    raise AssertionError(f"no done/error after {limit} events: {[e['type'] for e in out]}")


def chat(account, text, conversation_id=None):
    """One chat turn; returns (events, conversation_id)."""
    with account.socket() as ws:
        assert ws.receive_json()["type"] == "connected"
        ws.send_json({"type": "chat_request", "text": text, "model_name": "", "conversation_id": conversation_id})
        events = events_until_done(ws)
    done = events[-1]
    assert done["type"] == "done", events[-1]
    return events, done["conversation_id"]


def tool_chunks(events, name):
    return [e for e in events if e["type"] == "stream_chunk" and e["role"] == "tool" and e.get("name") == name]


# ---------------------------------------------------------------------------
# The assistant plans tasks from a chat
# ---------------------------------------------------------------------------

class TestPlanningFromAChat:
    def test_the_assistant_schedules_a_repeating_task(self, account):
        use_model(account)
        allow(account, "task_schedule")
        events, conversation_id = chat(
            account,
            'call task_schedule {"title": "Morning briefing", "instructions": "Weather and today\'s calendar.",'
            ' "repeat": "weekdays", "time": "07:30", "timezone": "Europe/Paris"}',
        )

        [result] = tool_chunks(events, "task_schedule")
        assert result["tool_status"] == "success", result["content"]
        assert "Weekdays at 07:30" in result["content"]

        tasks = account.client.get("/tasks", headers=account.headers).json()
        [task] = tasks
        assert task["title"] == "Morning briefing"
        assert task["instructions"] == "Weather and today's calendar."
        assert task["status"] == "scheduled"
        assert task["schedule_label"] == "Weekdays at 07:30 (Europe/Paris)"
        assert task["planned_in_conversation_id"] == conversation_id
        assert task["next_run_at"] is not None

    def test_a_bad_schedule_comes_back_as_an_error_the_model_can_read(self, account):
        use_model(account)
        allow(account, "task_schedule")
        events, _ = chat(
            account,
            'call task_schedule {"title": "x", "instructions": "y", "repeat": "daily", "time": "8am"}',
        )
        [result] = tool_chunks(events, "task_schedule")
        assert result["tool_status"] == "error"
        assert "HH:MM" in result["content"]
        assert account.client.get("/tasks", headers=account.headers).json() == []

    def test_the_assistant_starts_a_task_that_runs_on_its_own(self, account):
        use_model(account)
        allow(account, "task_start")
        events, conversation_id = chat(
            account,
            'call task_start {"title": "Apartment notes", "instructions": "Gather the apartment notes."}',
        )
        [result] = tool_chunks(events, "task_start")
        assert result["tool_status"] == "success", result["content"]

        # A started task is a one-off: once its run is over it leaves the list.
        [task] = account.client.get("/tasks?include_finished=true", headers=account.headers).json()
        run = wait_for_run(account, task["id"])
        assert run["status"] == "done", run
        assert run["conversation_id"] not in (None, conversation_id)

        messages = run_messages(account, run["conversation_id"])
        assert messages[0]["role"] == "user"
        assert messages[0]["content"] == "Gather the apartment notes."
        assert messages[-1]["role"] == "assistant"
        assert messages[-1]["content"] == "You said: Gather the apartment notes."

    def test_the_assistant_lists_changes_and_deletes_tasks(self, account):
        use_model(account)
        for tool in ("task_list", "task_update", "task_delete"):
            allow(account, tool)
        task_id = make_task(
            account, title="French recap", repeat="weekly", time="20:00", days=["sun"],
            next_run_at=datetime.utcnow() + timedelta(days=3),
        )

        events, _ = chat(account, "call task_list {}")
        [listed] = tool_chunks(events, "task_list")
        assert "French recap" in listed["content"] and str(task_id) in listed["content"]

        events, _ = chat(account, f'call task_update {{"task_id": {task_id}, "paused": true}}')
        [updated] = tool_chunks(events, "task_update")
        assert updated["tool_status"] == "success", updated["content"]
        assert get_task(account, task_id)["status"] == "paused"

        events, _ = chat(account, f'call task_delete {{"task_id": {task_id}}}')
        [deleted] = tool_chunks(events, "task_delete")
        assert deleted["tool_status"] == "success", deleted["content"]
        assert account.client.get(f"/tasks/{task_id}", headers=account.headers).status_code == 404


# ---------------------------------------------------------------------------
# A run: headless, its own conversation, its outcome recorded
# ---------------------------------------------------------------------------

class TestRuns:
    def test_a_run_leaves_a_conversation_marked_as_a_task_run(self, account):
        use_model(account)
        task_id = make_task(account, title="Morning briefing", instructions="Say good morning.")
        kick()
        run = wait_for_run(account, task_id)
        assert run["status"] == "done", run

        conversations = account.client.get("/conversations", headers=account.headers).json()
        [conv] = [c for c in conversations if c["id"] == run["conversation_id"]]
        assert conv["title"] == "Morning briefing"
        assert conv["task_run"] is True
        assert conv["task_id"] == task_id

    def test_a_run_answers_in_the_persona_in_use(self, account, mock_ollama):
        use_model(account)
        persona = account.client.post(
            "/personas", json={"name": "Mayuri", "system_prompt": "You are cheerful."}, headers=account.headers,
        ).json()
        account.client.patch("/assistant", json={"selected_persona_id": persona["id"]}, headers=account.headers)

        task_id = make_task(account)
        kick()
        run = wait_for_run(account, task_id)
        assert run["status"] == "done", run

        [request] = [r for r in mock_ollama.state.requests_to("/api/chat")
                     if any(m.get("content") == "Say good morning." for m in r["messages"])]
        system = "\n".join(m["content"] for m in request["messages"] if m["role"] == "system")
        assert "You are Mayuri." in system and "You are cheerful." in system
        assert "nobody is in the chat" in system.lower()

        reply = run_messages(account, run["conversation_id"])[-1]
        assert reply["persona_id"] == persona["id"]

    def test_a_tool_set_to_allow_runs_without_anyone_there(self, account):
        use_model(account)
        allow(account, "history_list")
        task_id = make_task(account, instructions="call history_list {}")
        kick()
        run = wait_for_run(account, task_id)
        assert run["status"] == "done", run
        messages = run_messages(account, run["conversation_id"])
        assert [m["tool_status"] for m in messages if m["role"] == "tool"] == ["success"]
        assert messages[-1]["content"].startswith("The tool returned:")

    def test_a_run_cannot_start_or_change_tasks(self, account):
        use_model(account)
        allow(account, "task_start")
        task_id = make_task(account, instructions='call task_start {"title": "again", "instructions": "again"}')
        kick()
        run = wait_for_run(account, task_id)
        tool_messages = [m for m in run_messages(account, run["conversation_id"]) if m["role"] == "tool"]
        assert [m["tool_status"] for m in tool_messages] == ["error"]
        listed = account.client.get("/tasks?include_finished=true", headers=account.headers).json()
        assert [t["id"] for t in listed] == [task_id]

    def test_no_model_fails_the_run_with_a_reason(self, account):
        task_id = make_task(account)
        kick()
        run = wait_for_run(account, task_id)
        assert run["status"] == "failed"
        assert "model" in run["error"].lower()

    def test_a_one_off_task_is_finished_after_its_run_and_left_off_the_list(self, account):
        use_model(account)
        task_id = make_task(account)
        kick()
        wait_for_run(account, task_id)
        task = get_task(account, task_id)
        assert task["status"] == "finished"
        assert task["next_run_at"] is None
        # The Tasks tab shows what the assistant will still do; a finished
        # one-off's run stays a conversation, and the task itself is asked for.
        assert account.client.get("/tasks", headers=account.headers).json() == []
        listed = account.client.get("/tasks?include_finished=true", headers=account.headers).json()
        assert [t["id"] for t in listed] == [task_id]

    def test_a_repeating_task_is_rescheduled_after_its_run(self, account):
        use_model(account)
        task_id = make_task(account, repeat="daily", time="08:00", next_run_at=datetime.utcnow() - timedelta(hours=5))
        kick()
        wait_for_run(account, task_id)
        task = get_task(account, task_id)
        assert task["status"] == "scheduled"
        assert task["next_run_at"] > datetime.utcnow().isoformat()

    def test_a_run_missed_while_the_server_was_down_runs_once(self, account, mock_ollama):
        use_model(account)
        task_id = make_task(
            account, repeat="hourly", every_hours=1, next_run_at=datetime.utcnow() - timedelta(hours=7),
        )
        kick()
        wait_for_run(account, task_id)
        kick()
        time.sleep(0.5)
        assert len(get_task(account, task_id)["runs"]) == 1

    def test_stopping_a_run(self, account, mock_ollama):
        use_model(account)
        mock_ollama.state.script(Reply(content="word " * 200, words_per_chunk=1, delay_ms=50))
        task_id = make_task(account)
        kick()
        wait_for_run(account, task_id, statuses=("running",))
        resp = account.client.post(f"/tasks/{task_id}/stop", headers=account.headers)
        assert resp.status_code == 200, resp.text
        run = wait_for_run(account, task_id)
        assert run["status"] == "stopped"

    def test_a_run_interrupted_by_a_restart_is_marked_failed(self, account):
        from kurisuassistant.db.repositories import TaskRunRepository
        from kurisuassistant.db.session import get_session
        from kurisuassistant.tasks import service

        task_id = make_task(account, next_run_at=datetime.utcnow() + timedelta(days=1))
        with get_session() as session:
            TaskRunRepository(session).start_run(task_id, account.id)
        service.recover_interrupted_runs()
        run = get_task(account, task_id)["runs"][0]
        assert run["status"] == "failed"
        assert "restart" in run["error"].lower()

    def test_clients_hear_that_tasks_changed(self, account):
        use_model(account)
        with account.socket() as ws:
            assert ws.receive_json()["type"] == "connected"
            task_id = make_task(account)
            kick()
            seen = []
            for _ in range(20):
                event = ws.receive_json()
                seen.append(event)
                if event["type"] == "tasks_changed" and event.get("task_id") == task_id:
                    break
            else:
                raise AssertionError([e["type"] for e in seen])
        wait_for_run(account, task_id)


# ---------------------------------------------------------------------------
# The Tasks screen's REST surface
# ---------------------------------------------------------------------------

class TestTasksScreen:
    def test_pause_and_resume(self, account):
        task_id = make_task(account, repeat="daily", time="08:00",
                            next_run_at=datetime.utcnow() + timedelta(hours=2))
        resp = account.client.patch(f"/tasks/{task_id}", json={"paused": True}, headers=account.headers)
        assert resp.status_code == 200, resp.text
        task = get_task(account, task_id)
        assert task["status"] == "paused" and task["next_run_at"] is None

        account.client.patch(f"/tasks/{task_id}", json={"paused": False}, headers=account.headers)
        task = get_task(account, task_id)
        assert task["status"] == "scheduled" and task["next_run_at"] is not None

    def test_changing_the_schedule_and_instructions(self, account):
        task_id = make_task(account, repeat="daily", time="08:00",
                            next_run_at=datetime.utcnow() + timedelta(hours=2))
        resp = account.client.patch(
            f"/tasks/{task_id}",
            json={"title": "Evening briefing", "instructions": "Tomorrow's weather.",
                  "schedule": {"repeat": "weekly", "time": "19:00", "days": ["mon", "thu"], "timezone": "UTC"}},
            headers=account.headers,
        )
        assert resp.status_code == 200, resp.text
        task = get_task(account, task_id)
        assert task["title"] == "Evening briefing"
        assert task["instructions"] == "Tomorrow's weather."
        assert task["schedule_label"] == "Mondays and Thursdays at 19:00"
        assert task["days"] == ["mon", "thu"]

    def test_a_bad_schedule_is_a_400_naming_the_problem(self, account):
        task_id = make_task(account, repeat="daily", time="08:00",
                            next_run_at=datetime.utcnow() + timedelta(hours=2))
        resp = account.client.patch(
            f"/tasks/{task_id}", json={"schedule": {"repeat": "daily", "time": "25:00"}}, headers=account.headers,
        )
        assert resp.status_code == 400
        assert "HH:MM" in resp.json()["detail"]

    def test_delete(self, account):
        task_id = make_task(account, next_run_at=datetime.utcnow() + timedelta(days=1))
        assert account.client.delete(f"/tasks/{task_id}", headers=account.headers).status_code == 200
        assert account.client.get(f"/tasks/{task_id}", headers=account.headers).status_code == 404

    def test_a_deleted_task_keeps_its_runs_conversations(self, account):
        use_model(account)
        task_id = make_task(account)
        kick()
        run = wait_for_run(account, task_id)
        account.client.delete(f"/tasks/{task_id}", headers=account.headers)
        conversations = account.client.get("/conversations", headers=account.headers).json()
        [conv] = [c for c in conversations if c["id"] == run["conversation_id"]]
        assert conv["task_run"] is True and conv["task_id"] is None

    def test_someone_elses_task_is_a_404(self, account, system_client):
        task_id = make_task(account, next_run_at=datetime.utcnow() + timedelta(days=1))
        import uuid

        from tests.conftest import Account, _create_activated_user

        name = f"tasks-other-{uuid.uuid4().hex[:8]}"
        _create_activated_user(name, "other-password")
        other = Account(system_client, name, "other-password")
        for method, path in (("get", f"/tasks/{task_id}"), ("patch", f"/tasks/{task_id}"),
                             ("delete", f"/tasks/{task_id}"), ("post", f"/tasks/{task_id}/stop")):
            kwargs = {"json": {"paused": True}} if method == "patch" else {}
            resp = getattr(other.client, method)(path, headers=other.headers, **kwargs)
            assert resp.status_code == 404, (method, path, resp.status_code)
        assert other.client.get("/tasks", headers=other.headers).json() == []

    def test_listing_groups_by_status(self, account):
        later = datetime.utcnow() + timedelta(days=1)
        scheduled = make_task(account, title="a", repeat="daily", time="08:00", next_run_at=later)
        paused = make_task(account, title="b", repeat="daily", time="08:00", next_run_at=later)
        account.client.patch(f"/tasks/{paused}", json={"paused": True}, headers=account.headers)
        statuses = {t["id"]: t["status"] for t in account.client.get("/tasks", headers=account.headers).json()}
        assert statuses == {scheduled: "scheduled", paused: "paused"}


# ---------------------------------------------------------------------------
# A tool that needs approval: the run waits for the user
# ---------------------------------------------------------------------------

@pytest.fixture()
def notified(monkeypatch):
    """What the run asked to be told, in place of #353's notification."""
    from kurisuassistant.tasks import approvals

    calls = []

    async def record(**kwargs):
        calls.append(kwargs)

    monkeypatch.setattr(approvals, "notify_approval_needed", record)
    return calls


def approvals_of(account):
    resp = account.client.get("/tasks/approvals", headers=account.headers)
    assert resp.status_code == 200, resp.text
    return resp.json()


def wait_for_approval(account, timeout=15.0):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        pending = approvals_of(account)
        if pending:
            return pending
        time.sleep(0.1)
    raise AssertionError("no approval was asked for")


def answer(account, approval_id, approved, **extra):
    return account.client.post(
        f"/tasks/approvals/{approval_id}", json={"approved": approved, **extra}, headers=account.headers,
    )


class TestApproval:
    def test_a_run_waits_and_the_user_is_told(self, account, notified):
        use_model(account)
        task_id = make_task(account, title="Tidy up", instructions="call history_list {}")
        kick()
        run = wait_for_run(account, task_id, statuses=("waiting_for_approval",))
        [approval] = wait_for_approval(account)

        task = get_task(account, task_id)
        assert task["status"] == "waiting_for_approval"
        assert task["pending_approval"]["id"] == approval["id"]
        assert task["pending_approval"]["tool_name"] == "history_list"
        assert approval["task_id"] == task_id
        assert approval["conversation_id"] == run["conversation_id"]
        assert approval["description"]
        assert approval["expires_at"] > approval["requested_at"]

        [told] = notified
        assert told["user_id"] == account.id
        assert told["task_title"] == "Tidy up"
        assert told["tool_name"] == "history_list"
        assert told["conversation_id"] == run["conversation_id"]

        answer(account, approval["id"], False)
        wait_for_run(account, task_id)

    def test_the_wait_is_a_notification_on_every_device(self, account):
        """Not the stand-in: the run's notification is stored like any other (#353)."""
        use_model(account)
        task_id = make_task(account, title="Tidy up", instructions="call history_list {}")
        kick()
        run = wait_for_run(account, task_id, statuses=("waiting_for_approval",))
        [approval] = wait_for_approval(account)

        resp = account.client.get("/notifications?unread=true", headers=account.headers)
        assert resp.status_code == 200, resp.text
        [shown] = resp.json()["notifications"]
        assert shown["source"] == "assistant"
        assert shown["title"] == "Tidy up is waiting for your approval"
        assert "history_list" in shown["body"]
        assert shown["conversation_id"] == run["conversation_id"]

        answer(account, approval["id"], False)
        wait_for_run(account, task_id)

    def test_approving_carries_on_where_it_stopped(self, account, notified):
        use_model(account)
        task_id = make_task(account, instructions="call history_list {}")
        kick()
        [approval] = wait_for_approval(account)
        resp = answer(account, approval["id"], True, modified_args={"limit": 1})
        assert resp.status_code == 200, resp.text

        run = wait_for_run(account, task_id)
        assert run["status"] == "done", run
        messages = run_messages(account, run["conversation_id"])
        assert [m["tool_status"] for m in messages if m["role"] == "tool"] == ["success"]
        assert messages[-1]["content"].startswith("The tool returned:")
        assert approvals_of(account) == []

    def test_denying_ends_the_call_as_denied(self, account, notified):
        use_model(account)
        task_id = make_task(account, instructions="call history_list {}")
        kick()
        [approval] = wait_for_approval(account)
        answer(account, approval["id"], False)

        run = wait_for_run(account, task_id)
        assert run["status"] == "failed"
        assert "denied" in run["error"].lower() and "history_list" in run["error"]
        tool_messages = [m for m in run_messages(account, run["conversation_id"]) if m["role"] == "tool"]
        assert [m["tool_status"] for m in tool_messages] == ["denied"]

    def test_an_answer_counts_once(self, account, notified):
        use_model(account)
        task_id = make_task(account, instructions="call history_list {}")
        kick()
        [approval] = wait_for_approval(account)
        assert answer(account, approval["id"], False).status_code == 200
        assert answer(account, approval["id"], True).status_code == 409
        wait_for_run(account, task_id)

    def test_a_stored_deny_applies_first(self, account, notified):
        use_model(account)
        resp = account.client.patch(
            "/users/me/tool-policies", json={"tool_name": "history_list", "policy": "deny"}, headers=account.headers,
        )
        assert resp.status_code == 200
        task_id = make_task(account, instructions="call history_list {}")
        kick()
        run = wait_for_run(account, task_id)
        assert run["status"] == "failed" and "Deny" in run["error"]
        assert notified == [] and approvals_of(account) == []

    def test_nobody_answering_denies_the_call(self, account, notified, monkeypatch):
        from kurisuassistant.tasks import approvals

        monkeypatch.setattr(approvals, "APPROVAL_TIMEOUT_SECONDS", 0.5)
        use_model(account)
        task_id = make_task(account, instructions="call history_list {}")
        kick()
        run = wait_for_run(account, task_id)
        assert run["status"] == "failed"
        assert "Nobody approved history_list" in run["error"]
        assert approvals_of(account) == []

    def test_a_waiting_run_does_not_hold_a_slot(self, account, notified):
        use_model(account)
        waiting = [make_task(account, title=f"waits {i}", instructions="call history_list {}") for i in range(2)]
        kick()
        deadline = time.monotonic() + 15
        while len(approvals_of(account)) < 2 and time.monotonic() < deadline:
            time.sleep(0.1)
        assert len(approvals_of(account)) == 2

        free = make_task(account, title="free", instructions="Say hello.")
        kick()
        assert wait_for_run(account, free)["status"] == "done"

        for approval in approvals_of(account):
            answer(account, approval["id"], False)
        for task_id in waiting:
            wait_for_run(account, task_id)

    def test_stopping_a_waiting_run(self, account, notified):
        use_model(account)
        task_id = make_task(account, instructions="call history_list {}")
        kick()
        wait_for_approval(account)
        assert account.client.post(f"/tasks/{task_id}/stop", headers=account.headers).status_code == 200
        assert wait_for_run(account, task_id)["status"] == "stopped"
        assert approvals_of(account) == []

    def test_a_restart_while_waiting_fails_the_run_and_says_so(self, account):
        from kurisuassistant.db.repositories import TaskApprovalRepository, TaskRunRepository
        from kurisuassistant.db.session import get_session
        from kurisuassistant.tasks import service

        task_id = make_task(account, next_run_at=datetime.utcnow() + timedelta(days=1))
        with get_session() as session:
            run = TaskRunRepository(session).start_run(task_id, account.id)
            run.status = "waiting_for_approval"
            TaskApprovalRepository(session).create_pending(
                run, tool_name="history_list", tool_args={}, description="List past conversations",
            )
        service.recover_interrupted_runs()
        run = get_task(account, task_id)["runs"][0]
        assert run["status"] == "failed"
        assert "restart" in run["error"].lower() and "approval" in run["error"].lower()
        assert approvals_of(account) == []

    def test_someone_elses_approval_is_a_404(self, account, system_client, notified):
        import uuid

        from tests.conftest import Account, _create_activated_user

        use_model(account)
        task_id = make_task(account, instructions="call history_list {}")
        kick()
        [approval] = wait_for_approval(account)
        name = f"approvals-other-{uuid.uuid4().hex[:8]}"
        _create_activated_user(name, "other-password")
        other = Account(system_client, name, "other-password")
        assert approvals_of(other) == []
        assert answer(other, approval["id"], True).status_code == 404
        answer(account, approval["id"], False)
        wait_for_run(account, task_id)


# ---------------------------------------------------------------------------
# Schedules are in the account's time zone
# ---------------------------------------------------------------------------

class TestTimezone:
    def test_the_assistant_schedules_in_the_accounts_zone(self, account):
        use_model(account)
        allow(account, "task_schedule")
        account.client.patch("/users/me", json={"timezone": "Europe/Paris"}, headers=account.headers)
        events, _ = chat(
            account,
            'call task_schedule {"title": "Briefing", "instructions": "Weather.", "repeat": "daily", "time": "07:30"}',
        )
        [result] = tool_chunks(events, "task_schedule")
        assert result["tool_status"] == "success", result["content"]
        [task] = account.client.get("/tasks", headers=account.headers).json()
        assert task["timezone"] == "Europe/Paris"
        assert task["schedule_label"] == "Every day at 07:30 (Europe/Paris)"

    def test_a_zone_named_in_the_call_still_wins(self, account):
        use_model(account)
        allow(account, "task_schedule")
        account.client.patch("/users/me", json={"timezone": "Europe/Paris"}, headers=account.headers)
        chat(
            account,
            'call task_schedule {"title": "Call", "instructions": "x", "repeat": "daily", "time": "09:00",'
            ' "timezone": "Asia/Tokyo"}',
        )
        [task] = account.client.get("/tasks", headers=account.headers).json()
        assert task["timezone"] == "Asia/Tokyo"

    def test_utc_when_the_account_has_none(self, account):
        task_id = make_task(account, repeat="daily", time="08:00", next_run_at=datetime.utcnow() + timedelta(hours=1))
        account.client.patch(
            f"/tasks/{task_id}", json={"schedule": {"repeat": "daily", "time": "09:00"}}, headers=account.headers,
        )
        assert get_task(account, task_id)["timezone"] == "UTC"

    def test_the_screens_schedule_change_uses_the_accounts_zone(self, account):
        account.client.patch("/users/me", json={"timezone": "America/New_York"}, headers=account.headers)
        task_id = make_task(account, repeat="daily", time="08:00", next_run_at=datetime.utcnow() + timedelta(hours=1))
        account.client.patch(
            f"/tasks/{task_id}", json={"schedule": {"repeat": "weekdays", "time": "07:00"}}, headers=account.headers,
        )
        assert get_task(account, task_id)["schedule_label"] == "Weekdays at 07:00 (America/New_York)"

    def test_the_tool_no_longer_asks_the_model_for_a_zone(self):
        from kurisuassistant.tools.tasks import TaskScheduleTool

        description = TaskScheduleTool().get_schema()["function"]["parameters"]["properties"]["timezone"]["description"]
        assert "ask the user" not in description.lower()
        assert "account" in description.lower()
