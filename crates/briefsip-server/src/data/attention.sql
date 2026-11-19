CREATE INDEX IF NOT EXISTS attention_questions ON questions(turn,id) WHERE answer IS NULL;
CREATE INDEX IF NOT EXISTS attention_app_approvals ON composio_calls(turn,call_id) WHERE state='approval';
CREATE INDEX IF NOT EXISTS attention_harness_approvals ON harness_approvals(turn,id) WHERE state='approval';
CREATE INDEX IF NOT EXISTS attention_computer_waits ON computer_waits(turn,call_id) WHERE state='waiting';

CREATE VIEW IF NOT EXISTS conversation_attention AS
WITH requests(turn,kind,request) AS (
    SELECT turn,'question',id FROM questions WHERE answer IS NULL
    UNION ALL
    SELECT turn,'app',call_id FROM composio_calls WHERE state='approval'
    UNION ALL
    SELECT turn,'harness',id FROM harness_approvals WHERE state='approval'
    UNION ALL
    SELECT turn,'computer',call_id FROM computer_waits WHERE state='waiting'
)
SELECT coalesce(th.agent,t.agent) AS agent,t.thread,t.channel,t.seq,t.id AS turn,
       coalesce(r.root,t.id) AS focus,requests.kind,requests.request
FROM requests
JOIN turns t ON t.id=requests.turn
LEFT JOIN threads th ON th.id=t.thread
LEFT JOIN channels c ON c.id=t.channel
LEFT JOIN room_turns r ON r.turn=t.id
LEFT JOIN agent_visibility v ON v.agent=coalesce(th.agent,t.agent)
WHERE coalesce(th.archived,0)=0 AND coalesce(th.deleted,0)=0 AND coalesce(c.archived,0)=0
  AND (t.channel IS NOT NULL OR coalesce(v.hidden,0)=0)
  AND CASE requests.kind
    WHEN 'question' THEN t.paused=1 AND t.status IN('queued','interrupted')
    WHEN 'app' THEN t.status='queued'
    WHEN 'harness' THEN t.status='running'
    WHEN 'computer' THEN t.status NOT IN('done','cancelled')
  END;

CREATE INDEX IF NOT EXISTS attention_finished ON turns(attention_finished_at DESC)
WHERE attention_finished_at IS NOT NULL;

CREATE TRIGGER IF NOT EXISTS attention_turn_finished AFTER UPDATE OF status ON turns
WHEN NEW.status IN('done','failed') AND OLD.status NOT IN('done','failed')
BEGIN
    UPDATE turns SET attention_finished_at=unixepoch() WHERE seq=NEW.seq;
END;
