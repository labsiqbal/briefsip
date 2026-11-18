UPDATE devices SET status='revoked',revision=revision+1;
UPDATE device_sessions SET revoked=1;
UPDATE link_challenges SET consumed=1;
