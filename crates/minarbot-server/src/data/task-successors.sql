
CREATE TRIGGER IF NOT EXISTS task_successor_provenance BEFORE INSERT ON tasks WHEN NEW.predecessor_task IS NOT NULL AND NOT EXISTS(
  SELECT 1 FROM tasks previous JOIN projects project ON project.id=previous.project
  JOIN agent_authority home ON home.agent=NEW.agent AND home.owner_account=project.account
  JOIN agent_projects participation ON participation.project=project.id AND participation.agent=NEW.agent
  JOIN project_members member ON member.project=project.id AND member.account=NEW.initiator_account
  LEFT JOIN collaborator_agents assignment ON assignment.project=project.id AND assignment.account=member.account AND assignment.agent=NEW.agent
  LEFT JOIN provider_bindings binding ON binding.id=home.provider_binding
  WHERE previous.id=NEW.predecessor_task AND previous.state='transferred'
  AND previous.logical_turn=NEW.logical_turn AND previous.project=NEW.project AND previous.initiator_account=NEW.initiator_account
  AND home.home_device=NEW.home_device AND participation.deleted=0 AND member.deleted=0
  AND NEW.capability_revision=participation.revision
  AND minarbot_capability_digest(NEW.capability_snapshot_json)=minarbot_capability_digest(participation.capabilities_json)
  AND NEW.capability_digest=minarbot_capability_digest(participation.capabilities_json)
  AND NEW.assignment_revision=CASE WHEN member.role='owner' THEN member.grant_revision ELSE assignment.revision END
  AND (member.role='owner' OR assignment.enabled=1)
  AND NEW.provider_binding_id IS home.provider_binding
  AND (home.provider_binding IS NULL OR (binding.device=NEW.home_device AND binding.owner_account=project.account AND binding.revision=NEW.provider_binding_revision AND binding.owner_account=NEW.provider_binding_owner AND binding.readiness='ready'))
  AND (previous.provider_binding_owner IS NULL OR previous.provider_binding_owner=NEW.provider_binding_owner)
) BEGIN SELECT RAISE(ABORT,'invalid task successor provenance'); END;
