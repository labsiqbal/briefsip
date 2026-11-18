CREATE INDEX IF NOT EXISTS project_workflow_notifications_reader ON project_workflow_notifications(project,account,seq);
CREATE INDEX IF NOT EXISTS routine_occurrences_active ON routine_occurrences(state,routine);
CREATE UNIQUE INDEX IF NOT EXISTS routine_occurrences_schedule ON routine_occurrences(routine,schedule_revision,due_at) WHERE source='schedule';
CREATE UNIQUE INDEX IF NOT EXISTS occurrence_pending ON occurrences(schedule,schedule_revision) WHERE state IN('pending','blocked');
