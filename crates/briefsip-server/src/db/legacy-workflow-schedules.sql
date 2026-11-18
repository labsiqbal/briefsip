SELECT l.workflow,w.agent,p.id,p.account,m.grant_revision,d.id,d.zone,d.zone_revision,
       l.revision,l.next_at,l.interval_ms,l.input
FROM workflow_schedules l
JOIN workflows w ON w.id=l.workflow AND w.deleted=0
JOIN workflow_versions v ON v.workflow=w.id AND v.revision=w.revision
JOIN record_scopes s ON s.table_name='workflow_schedules' AND s.key_json=json_array(l.workflow)
    AND s.visibility='owner' AND s.root_kind='workflow' AND s.root_id=w.id
JOIN projects p ON p.id=s.project AND p.account=s.account AND p.private=1 AND p.deleted=0
JOIN accounts a ON a.id=p.account AND a.blocked=0
JOIN project_members m ON m.project=p.id AND m.account=p.account AND m.role='owner' AND m.deleted=0
JOIN agent_projects ap ON ap.project=p.id AND ap.agent=w.agent AND ap.deleted=0
JOIN agent_authority h ON h.agent=ap.agent AND h.owner_account=p.account
JOIN devices d ON d.id=h.home_device AND d.account=p.account AND d.status NOT IN('revoked','blocked')
JOIN installations i ON i.id=d.installation AND i.account=p.account AND i.revoked=0
JOIN record_scopes work ON work.table_name='workflows' AND work.key_json=json_array(w.id)
    AND work.account=p.account AND work.project=p.id AND work.visibility='owner' AND work.root_kind='workflow' AND work.root_id=w.id
JOIN record_scopes version ON version.table_name='workflow_versions' AND version.key_json=json_array(w.id,v.revision)
    AND version.account=p.account AND version.project=p.id AND version.visibility='owner' AND version.root_kind='workflow' AND version.root_id=w.id
JOIN record_scopes agent ON agent.table_name='agents' AND agent.key_json=json_array(w.agent)
    AND agent.account=p.account AND agent.project=p.id AND agent.visibility='owner' AND agent.root_kind='agent' AND agent.root_id=w.agent
WHERE EXISTS(SELECT 1 FROM json_each(d.capabilities_json) WHERE value='execution')
  AND NOT EXISTS(SELECT 1 FROM schedules WHERE id=l.workflow)
ORDER BY l.workflow;
