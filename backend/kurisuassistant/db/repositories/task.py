"""Tasks and their runs (#352). See ``kurisuassistant/tasks``."""

from datetime import datetime, timedelta
from typing import List, Optional

from sqlalchemy.orm import Session

from ..models import AssistantTask, TaskApproval, TaskRun
from .base import BaseRepository

RUN_RUNNING = "running"
RUN_WAITING = "waiting_for_approval"
#: A run that has not ended: going, or paused on the user's approval.
RUN_ACTIVE_STATUSES = (RUN_RUNNING, RUN_WAITING)
RUN_DONE = "done"
RUN_FAILED = "failed"
RUN_STOPPED = "stopped"
RUN_FINISHED_STATUSES = (RUN_DONE, RUN_FAILED, RUN_STOPPED)


class TaskRepository(BaseRepository[AssistantTask]):
    def __init__(self, session: Session):
        super().__init__(AssistantTask, session)

    def create_task(
        self,
        user_id: int,
        *,
        title: str,
        instructions: str,
        schedule,
        next_run_at: Optional[datetime],
        planned_in_conversation_id: Optional[int] = None,
    ) -> AssistantTask:
        """A new active task. ``schedule`` is a ``tasks.schedule.Schedule``."""
        from kurisuassistant.tasks.records import schedule_columns

        now = datetime.utcnow()
        task = AssistantTask(
            user_id=user_id,
            title=title,
            instructions=instructions,
            state="active",
            next_run_at=next_run_at,
            planned_in_conversation_id=planned_in_conversation_id,
            created_at=now,
            updated_at=now,
            **schedule_columns(schedule),
        )
        self.session.add(task)
        self.session.flush()
        return task

    def get_by_user_and_id(self, user_id: int, task_id: int) -> Optional[AssistantTask]:
        return (
            self.session.query(AssistantTask)
            .filter(AssistantTask.user_id == user_id, AssistantTask.id == task_id)
            .first()
        )

    def list_by_user(self, user_id: int) -> List[AssistantTask]:
        return (
            self.session.query(AssistantTask)
            .filter(AssistantTask.user_id == user_id)
            .order_by(AssistantTask.id)
            .all()
        )

    def due(self, now: datetime, limit: int = 50) -> List[AssistantTask]:
        """Active tasks whose time has come, earliest first."""
        return (
            self.session.query(AssistantTask)
            .filter(
                AssistantTask.state == "active",
                AssistantTask.next_run_at.isnot(None),
                AssistantTask.next_run_at <= now,
            )
            .order_by(AssistantTask.next_run_at)
            .limit(limit)
            .all()
        )

    def touch(self, task: AssistantTask) -> None:
        task.updated_at = datetime.utcnow()


class TaskRunRepository(BaseRepository[TaskRun]):
    def __init__(self, session: Session):
        super().__init__(TaskRun, session)

    def start_run(self, task_id: int, user_id: int) -> TaskRun:
        run = TaskRun(task_id=task_id, user_id=user_id, status=RUN_RUNNING, started_at=datetime.utcnow())
        self.session.add(run)
        self.session.flush()
        return run

    def finish(self, run: TaskRun, status: str, error: Optional[str] = None) -> TaskRun:
        run.status = status
        run.error = error
        run.finished_at = datetime.utcnow()
        return run

    def running_for_task(self, task_id: int) -> Optional[TaskRun]:
        return (
            self.session.query(TaskRun)
            .filter(TaskRun.task_id == task_id, TaskRun.status.in_(RUN_ACTIVE_STATUSES))
            .order_by(TaskRun.id.desc())
            .first()
        )

    def running_task_ids(self, user_id: int) -> set:
        rows = (
            self.session.query(TaskRun.task_id)
            .filter(TaskRun.user_id == user_id, TaskRun.status.in_(RUN_ACTIVE_STATUSES))
            .all()
        )
        return {row.task_id for row in rows}

    def recent_for_task(self, task_id: int, limit: int = 10) -> List[TaskRun]:
        return (
            self.session.query(TaskRun)
            .filter(TaskRun.task_id == task_id)
            .order_by(TaskRun.id.desc())
            .limit(limit)
            .all()
        )

    def all_running(self) -> List[TaskRun]:
        return self.session.query(TaskRun).filter(TaskRun.status.in_(RUN_ACTIVE_STATUSES)).all()


APPROVAL_PENDING = "pending"


class TaskApprovalRepository(BaseRepository[TaskApproval]):
    """Tool calls task runs are waiting on the user to approve (#352)."""

    def __init__(self, session: Session):
        super().__init__(TaskApproval, session)

    def create_pending(
        self, run: TaskRun, *, tool_name: str, tool_args, description: str,
        timeout_seconds: float = 24 * 3600,
    ) -> TaskApproval:
        now = datetime.utcnow()
        approval = TaskApproval(
            run_id=run.id, user_id=run.user_id, tool_name=tool_name, tool_args=tool_args,
            description=description or "", status=APPROVAL_PENDING, requested_at=now,
            expires_at=now + timedelta(seconds=timeout_seconds),
        )
        self.session.add(approval)
        self.session.flush()
        return approval

    def get_for_user(self, user_id: int, approval_id: int) -> Optional[TaskApproval]:
        return (
            self.session.query(TaskApproval)
            .filter(TaskApproval.user_id == user_id, TaskApproval.id == approval_id)
            .first()
        )

    def pending_for_user(self, user_id: int) -> List[TaskApproval]:
        return (
            self.session.query(TaskApproval)
            .filter(TaskApproval.user_id == user_id, TaskApproval.status == APPROVAL_PENDING)
            .order_by(TaskApproval.id)
            .all()
        )

    def pending_for_run(self, run_id: int) -> Optional[TaskApproval]:
        return (
            self.session.query(TaskApproval)
            .filter(TaskApproval.run_id == run_id, TaskApproval.status == APPROVAL_PENDING)
            .order_by(TaskApproval.id.desc())
            .first()
        )

    def decide(self, approval: TaskApproval, status: str, modified_args=None) -> TaskApproval:
        approval.status = status
        approval.modified_args = modified_args
        approval.decided_at = datetime.utcnow()
        return approval
