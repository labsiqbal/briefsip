SELECT o.scheduled_at,o.missed,o.run,
       EXISTS(SELECT 1 FROM record_scopes s
              WHERE s.table_name='workflow_occurrences' AND s.key_json=json_array(o.workflow,o.scheduled_at)
                AND s.account=?2 AND s.project=?3 AND s.visibility='owner' AND s.root_kind='workflow' AND s.root_id=o.workflow)
       AND (o.run IS NULL OR EXISTS(
           SELECT 1 FROM workflow_runs r
           JOIN workflow_versions v ON v.workflow=r.workflow AND v.revision=r.version
           JOIN record_scopes version ON version.table_name='workflow_versions' AND version.key_json=json_array(v.workflow,v.revision)
               AND version.account=?2 AND version.project=?3 AND version.visibility='owner' AND version.root_kind='workflow' AND version.root_id=r.workflow
           JOIN record_scopes run ON run.table_name='workflow_runs' AND run.key_json=json_array(r.id)
               AND run.account=?2 AND run.project=?3 AND run.visibility='owner' AND run.root_kind='workflow' AND run.root_id=r.workflow
           WHERE r.id=o.run AND r.workflow=o.workflow AND r.agent=?4
       ))
FROM workflow_occurrences o WHERE o.workflow=?1 ORDER BY o.scheduled_at;
