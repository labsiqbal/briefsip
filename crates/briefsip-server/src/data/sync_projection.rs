use super::*;
pub(super) fn records(db: &Connection) -> Result<String> {
    fn tables(db: &Connection, names: &[&str]) -> Result<bool> {
        for name in names {
            if !table(db, name)? {
                return Ok(false);
            }
        }
        Ok(true)
    }
    let workflows = tables(db, &["workflows", "workflow_versions", "workflow_runs"])?;
    let notifications = workflows && table(db, "project_workflow_notifications")?;
    let schedules = workflows
        && tables(
            db,
            &["schedules", "workflow_schedule_targets", "occurrences"],
        )?;
    let routines = tables(
        db,
        &[
            "routines",
            "routine_flows",
            "routine_schedule_bindings",
            "routine_occurrences",
        ],
    )?;
    let mut prefix = r###"WITH viewer AS (
  SELECT m.role,p.account AS owner FROM project_members m JOIN projects p ON p.id=m.project
  WHERE m.project=$project AND m.account=$account
)"###
        .to_owned();
    let mut body = r###"
  SELECT 'project' AS kind,p.id AS id,p.revision,
    CASE WHEN p.deleted=1 THEN 'delete' ELSE 'upsert' END AS operation,
    json_object('projectId',p.id,'name',p.name,'private',json(CASE WHEN p.private=1 THEN 'true' ELSE 'false' END),'deleted',json(CASE WHEN p.deleted=1 THEN 'true' ELSE 'false' END),'revision',p.revision) AS body
  FROM projects p WHERE p.id=$project
  UNION ALL
  SELECT 'member',json_array(m.project,m.account),m.grant_revision,CASE WHEN m.deleted=1 THEN 'revoke' ELSE 'upsert' END,
    json_object('projectId',m.project,'accountId',m.account,'role',m.role,'grantRevision',m.grant_revision,'deleted',json(CASE WHEN m.deleted=1 THEN 'true' ELSE 'false' END))
  FROM project_members m,viewer v WHERE m.project=$project AND (v.role='owner' OR m.account=$account)
  UNION ALL
  SELECT 'assignment',json_array(c.project,c.account,c.agent),c.revision,CASE WHEN c.enabled=0 THEN 'revoke' ELSE 'upsert' END,
    json_object('projectId',c.project,'accountId',c.account,'agentId',c.agent,'enabled',json(CASE WHEN c.enabled=1 THEN 'true' ELSE 'false' END),'revision',c.revision)
  FROM collaborator_agents c,viewer v WHERE c.project=$project AND (v.role='owner' OR c.account=$account)
  UNION ALL
  SELECT 'response_policy',json_array(c.project,c.account,c.agent),c.revision,'upsert',
    json_object('projectId',c.project,'accountId',c.account,'agentId',c.agent,'respond',json(CASE WHEN c.respond=1 THEN 'true' ELSE 'false' END),'revision',c.revision)
  FROM response_policies c,viewer v WHERE c.project=$project AND (v.role='owner' OR c.account=$account)
  UNION ALL
  SELECT 'agent',a.id,p.revision,CASE WHEN p.deleted=1 THEN 'delete' ELSE 'upsert' END,
    json_object('agentId',a.id,'name',a.name,'role',a.role,'model',a.model,'agentRevision',a.revision,'participationRevision',p.revision,'homeDeviceId',h.home_device,'rules',p.rules,'capabilities',json(p.capabilities_json))
  FROM agent_projects p JOIN agents a ON a.id=p.agent JOIN agent_authority h ON h.agent=a.id,viewer v
  WHERE p.project=$project AND h.owner_account=v.owner AND (v.role='owner' OR EXISTS(SELECT 1 FROM collaborator_agents c WHERE c.project=p.project AND c.agent=p.agent AND c.account=$account AND c.enabled=1))
  UNION ALL
  SELECT 'task',t.id,t.revision,'upsert',
    json_object('taskId',t.id,'projectId',t.project,'agentId',t.agent,'initiatorAccountId',t.initiator_account,'homeDeviceId',t.home_device,'state',t.state,'revision',t.revision,'createdAt',t.created)
  FROM tasks t,viewer v
  WHERE t.project=$project AND (v.role='owner' OR EXISTS(SELECT 1 FROM collaborator_agents c WHERE c.project=t.project AND c.agent=t.agent AND c.account=$account AND c.enabled=1)) AND EXISTS(
    SELECT 1 FROM record_scopes s WHERE s.table_name='turns' AND s.key_json=json_array(t.logical_turn)
      AND s.project=t.project AND (s.visibility='project' OR s.account=$account)
  )
  UNION ALL
  SELECT 'device',d.id,d.revision,CASE WHEN d.status='revoked' THEN 'revoke' ELSE 'upsert' END,
    json_object('deviceId',d.id,'status',d.status,'generation',d.generation,'connectionGeneration',d.connection_generation,'zone',d.zone,'zoneRevision',d.zone_revision,'capabilities',json(d.capabilities_json),'revision',d.revision)
  FROM devices d,viewer v WHERE d.account=v.owner AND (v.role='owner' OR EXISTS(
    SELECT 1 FROM agent_authority h JOIN agent_projects ap ON ap.agent=h.agent AND ap.project=$project
      JOIN collaborator_agents c ON c.project=ap.project AND c.agent=ap.agent AND c.account=$account
    WHERE h.home_device=d.id AND h.owner_account=v.owner AND ap.deleted=0 AND c.enabled=1
  ))
  UNION ALL
  SELECT 'invitation',i.id,i.revision,CASE WHEN i.state='revoked' THEN 'revoke' ELSE 'upsert' END,
    json_object('invitationId',i.id,'state',i.state,'expiresAt',i.expires_at,'revision',i.revision)
  FROM invitations i,viewer v WHERE i.project=$project AND v.role='owner'"###.to_owned();
    if workflows {
        prefix.push_str(r###", workflow_roots AS (
  SELECT w.*,h.home_device,m.account AS reader_account,s.project AS project_id FROM workflows w
    JOIN record_scopes s ON s.table_name='workflows' AND s.key_json=json_array(w.id) AND s.root_kind='workflow' AND s.root_id=w.id
    JOIN agent_projects ap ON ap.agent=w.agent AND ap.project=s.project AND ap.deleted=0
    JOIN agent_authority h ON h.agent=w.agent JOIN projects p ON p.id=ap.project AND p.account=h.owner_account
    JOIN project_members m ON m.project=p.id AND m.deleted=0
    JOIN accounts a ON a.id=m.account AND a.blocked=0 JOIN accounts o ON o.id=p.account AND o.blocked=0
    JOIN record_scopes sa ON sa.table_name='agents' AND sa.key_json=json_array(w.agent) AND sa.account=p.account AND sa.root_kind='agent' AND sa.root_id=w.agent
  WHERE s.project=$project AND p.deleted=0 AND ($account IS NULL OR m.account=$account) AND (s.visibility='project' OR s.account=m.account)
    AND (m.role='owner' OR EXISTS(SELECT 1 FROM collaborator_agents c WHERE c.project=p.id AND c.account=m.account AND c.agent=w.agent AND c.enabled=1))
), workflow_read_runs AS (
  SELECT r.*,w.reader_account,w.project_id,w.home_device FROM workflow_runs r JOIN workflow_roots w ON w.id=r.workflow AND w.agent=r.agent
    JOIN record_scopes s ON s.table_name='workflow_runs' AND s.key_json=json_array(r.id) AND s.root_kind='workflow' AND s.root_id=w.id
    JOIN workflow_versions v ON v.workflow=r.workflow AND v.revision=r.version
    JOIN record_scopes vs ON vs.table_name='workflow_versions' AND vs.key_json=json_array(v.workflow,v.revision) AND vs.root_kind='workflow' AND vs.root_id=w.id
  WHERE s.project=$project AND (s.visibility='project' OR s.account=w.reader_account) AND vs.project=$project AND (vs.visibility='project' OR vs.account=w.reader_account)
)"###);
        body.push_str(r###"
  UNION ALL
  SELECT 'workflow',w.id,w.revision,CASE WHEN w.deleted=1 THEN 'delete' ELSE 'upsert' END,
    json_object('workflowId',w.id,'projectId',$project,'agentId',w.agent,'homeDeviceId',w.home_device,'name',w.name,'revision',w.revision,'deleted',json(CASE WHEN w.deleted=1 THEN 'true' ELSE 'false' END),'detailRef','/api/projects/'||$project||'/workflows/'||w.id)
  FROM workflow_roots w JOIN workflow_versions v ON v.workflow=w.id AND v.revision=w.revision
    JOIN record_scopes s ON s.table_name='workflow_versions' AND s.key_json=json_array(v.workflow,v.revision) AND s.root_kind='workflow' AND s.root_id=w.id
  WHERE s.project=$project AND (s.visibility='project' OR s.account=$account)
  UNION ALL
  SELECT 'workflow_run',r.id,r.revision,'upsert',
    json_object('runId',r.id,'workflowId',r.workflow,'projectId',$project,'agentId',r.agent,'homeDeviceId',r.home_device,'version',r.version,'status',r.status,'stepCount',r.steps,'revision',r.revision,'createdAt',r.created,'detailRef','/api/projects/'||$project||'/workflow-runs/'||r.id)
  FROM workflow_read_runs r"###);
    }
    if notifications {
        body.push_str(r###"
  UNION ALL
  SELECT 'workflow_notification',n.run,n.read+1,'upsert',
    json_object('runId',n.run,'projectId',n.project,'name',n.name,'createdAt',n.created,'read',json(CASE WHEN n.read=1 THEN 'true' ELSE 'false' END),'revision',n.read+1,'detailRef','/api/projects/'||n.project||'/workflow-runs/'||n.run)
  FROM project_workflow_notifications n JOIN workflow_read_runs r ON r.id=n.run AND r.project_id=n.project AND r.reader_account=n.account
  WHERE n.project=$project AND n.account=$account"###);
    }
    if schedules {
        prefix.push_str(r###", workflow_read_schedules AS (
  SELECT s.*,w.deleted,t.workflow FROM schedules s JOIN workflow_schedule_targets t ON t.schedule=s.id
    JOIN workflow_roots w ON w.id=t.workflow AND w.agent=s.agent AND w.home_device=s.home_device
    JOIN workflow_versions v ON v.workflow=w.id AND v.revision=w.revision
    JOIN record_scopes vs ON vs.table_name='workflow_versions' AND vs.key_json=json_array(v.workflow,v.revision) AND vs.root_kind='workflow' AND vs.root_id=w.id
  WHERE s.project=$project AND vs.project=$project AND (vs.visibility='project' OR vs.account=$account)
)"###);
        body.push_str(r###"
  
  UNION ALL
  SELECT 'workflow_schedule',s.id,s.observation_revision,CASE WHEN s.deleted=1 THEN 'delete' ELSE 'upsert' END,
    json_object('scheduleId',s.id,'workflowId',s.workflow,'projectId',s.project,'agentId',s.agent,'homeDeviceId',s.home_device,'kind',s.kind,
      'zone',s.zone,'zoneRevision',s.zone_revision,'nextAt',s.next_at,'enabled',json(CASE WHEN s.enabled=1 THEN 'true' ELSE 'false' END),
      'scheduleRevision',s.revision,'revision',s.observation_revision,'deleted',json(CASE WHEN s.deleted=1 THEN 'true' ELSE 'false' END),'detailRef','/api/projects/'||s.project||'/workflows/'||s.workflow||'/schedule')
  FROM workflow_read_schedules s
  UNION ALL
  SELECT 'workflow_schedule_occurrence',json_array(o.schedule,o.occurrence_id),o.observation_revision,'upsert',
    json_object('scheduleId',o.schedule,'occurrenceId',o.occurrence_id,'dueAt',o.due_at,'scheduleRevision',o.schedule_revision,
      'zoneRevision',o.zone_revision,'state',o.state,'missedCount',o.missed_count,'taskId',o.task,'runId',o.run,
      'revision',o.observation_revision,'detailRef','/api/projects/'||s.project||'/workflows/'||s.workflow||'/schedule')
  FROM occurrences o JOIN workflow_read_schedules s ON s.id=o.schedule"###);
    }
    if routines {
        prefix.push_str(r###", routine_roots AS (
  SELECT r.*,s.project AS project_id,h.home_device,m.account AS reader_account FROM routines r
    JOIN record_scopes s ON s.table_name='routines' AND s.key_json=json_array(r.id) AND s.root_kind='agent' AND s.root_id=r.agent
    JOIN agent_projects ap ON ap.agent=r.agent AND ap.project=s.project AND ap.deleted=0
    JOIN agent_authority h ON h.agent=r.agent JOIN projects p ON p.id=ap.project AND p.account=h.owner_account AND p.deleted=0
    JOIN project_members m ON m.project=p.id AND m.account=$account AND m.deleted=0
    JOIN accounts a ON a.id=m.account AND a.blocked=0 JOIN accounts o ON o.id=p.account AND o.blocked=0
    JOIN record_scopes sa ON sa.table_name='agents' AND sa.key_json=json_array(r.agent) AND sa.account=p.account AND sa.root_kind='agent' AND sa.root_id=r.agent
  WHERE s.project=$project AND (s.visibility='project' OR s.account=$account)
    AND (m.role='owner' OR EXISTS(SELECT 1 FROM collaborator_agents c WHERE c.project=p.id AND c.account=$account AND c.agent=r.agent AND c.enabled=1))
)"###);
        body.push_str(r###"
  
  UNION ALL
  SELECT 'routine',r.id,r.observation_revision,'upsert',
    json_object('routineId',r.id,'projectId',r.project_id,'agentId',r.agent,'homeDeviceId',r.home_device,'name',r.name,
      'trigger',r.trigger,'scheduleKind',coalesce(json_extract(b.spec_json,'$.kind'),CASE WHEN r.interval_ms IS NULL THEN 'instant' ELSE 'interval' END),'nextAt',r.next_at,'intervalMs',r.interval_ms,'enabled',json(CASE WHEN r.enabled=1 THEN 'true' ELSE 'false' END),
      'zone',b.zone,'zoneRevision',b.zone_revision,'scheduleRevision',r.revision,'revision',r.observation_revision,
      'detailRef','/api/projects/'||r.project_id||'/routines/'||r.id)
  FROM routine_roots r LEFT JOIN routine_schedule_bindings b ON b.routine=r.id AND b.project=r.project_id
  UNION ALL
  SELECT 'routine_flow',f.routine,f.revision,'upsert',
    json_object('routineId',f.routine,'projectId',r.project_id,'revision',f.revision,'detailRef','/api/projects/'||r.project_id||'/routines/'||r.id||'/flow')
  FROM routine_flows f JOIN routine_roots r ON r.id=f.routine
    JOIN record_scopes s ON s.table_name='routine_flows' AND s.key_json=json_array(f.routine) AND s.project=r.project_id AND s.root_kind='agent' AND s.root_id=r.agent
  WHERE s.visibility='project' OR s.account=$account
  UNION ALL
  SELECT 'routine_occurrence',o.id,o.observation_revision,'upsert',
    json_object('routineId',o.routine,'occurrenceId',o.id,'projectId',o.project,'dueAt',o.due_at,'scheduleRevision',o.schedule_revision,
      'scheduleKind',o.schedule_kind,'zone',o.zone,'zoneRevision',o.zone_revision,'state',o.state,'missedCount',o.missed_count,'taskId',o.task,
      'revision',o.observation_revision,'detailRef','/api/projects/'||o.project||'/routines/'||o.routine||'/runs','source',o.source)
  FROM routine_occurrences o JOIN routine_roots r ON r.id=o.routine AND r.project_id=o.project
    JOIN record_scopes s ON s.table_name='routine_occurrences' AND s.key_json=json_array(o.id) AND s.project=o.project AND s.root_kind='agent' AND s.root_id=r.agent
  WHERE s.visibility='project' OR s.account=$account"###);
    }
    Ok(format!("{prefix}, records AS ({body}) "))
}
