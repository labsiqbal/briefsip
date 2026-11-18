UPDATE recovery_evidence_sessions SET revoked=1;
UPDATE execution_owners SET stopped=1;
UPDATE task_actions SET state='uncertain',effect_status='unknown',uncertain_reason='Disaster restore requires original journal evidence.' WHERE state NOT IN('acknowledged','not_sent');
UPDATE tasks SET state='uncertain',revision=revision+1 WHERE state NOT IN('completed','failed','cancelled','transferred','paused','approval');
UPDATE turns SET paused=1,revision=revision+1 WHERE status IN('queued','running','interrupted');
