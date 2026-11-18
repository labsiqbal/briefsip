CREATE UNIQUE INDEX IF NOT EXISTS queue_edit_active ON queue_edits(turn) WHERE state='held';
