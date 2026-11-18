UPDATE project_members SET deleted=1,grant_revision=grant_revision+1 WHERE role<>'owner';
UPDATE collaborator_agents SET enabled=0,revision=revision+1;
UPDATE invitations SET state='revoked',revision=revision+1;
UPDATE mail_outbox SET state='revoked',ciphertext=X'',next_attempt=NULL;
