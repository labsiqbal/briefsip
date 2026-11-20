UPDATE turn_waits SET status='closed' WHERE status='waiting';
INSERT INTO flow_tool_calls(turn,call_id,call,result,after_output,after_action)
    SELECT w.turn,w.call_id,w.call,json_object('status',w.status,'error',CASE w.status WHEN 'expired' THEN 'Event wait expired without receiving an event.' ELSE 'Event wait closed by workspace restore; its connection is no longer valid.' END),w.after_output,w.after_action
    FROM turn_waits w WHERE w.status IN ('expired','closed') AND NOT EXISTS (SELECT 1 FROM flow_tool_calls f WHERE f.turn=w.turn AND f.call_id=w.call_id) ORDER BY w.rowid;
