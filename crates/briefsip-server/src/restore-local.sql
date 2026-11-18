UPDATE turns SET status='interrupted',paused=1,revision=revision+1,error='Restored from backup. Check earlier effects before resuming.' WHERE status IN ('queued','running');
UPDATE provider_calls SET status='interrupted' WHERE status='pending';
UPDATE routines SET enabled=0,revision=revision+1;
UPDATE script_permissions SET enabled=0,revision=revision+1;
UPDATE workflow_schedules SET enabled=0,revision=revision+1;
UPDATE workflow_webhooks SET enabled=0,revision=revision+1;
UPDATE workflow_runs SET status='failed',revision=revision+1,error='Restored from backup. Check the results before running again.' WHERE status IN ('ready','waiting','approval');
UPDATE workflow_steps SET status='failed',detail='Restored from backup; the run was stopped.' WHERE status IN ('waiting','approval');
UPDATE flow_steps SET status='failed',result='Restored from backup; the run was stopped.' WHERE status IN ('waiting','queued');
