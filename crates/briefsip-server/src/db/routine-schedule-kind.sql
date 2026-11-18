WITH historical AS MATERIALIZED (
    SELECT o.id,
           (SELECT json_extract(result_json,'$.data') FROM receipts
            WHERE json_extract(result_json,'$.receipt.recordId')=o.routine
              AND json_extract(result_json,'$.receipt.recordRevision')<=o.schedule_revision
              AND json_type(result_json,'$.data.interval_ms') IS NOT NULL
            ORDER BY json_extract(result_json,'$.receipt.recordRevision') DESC LIMIT 1) AS config,
           r.interval_ms
    FROM routine_occurrences o JOIN routines r ON r.id=o.routine
)
UPDATE routine_occurrences AS o
SET schedule_kind=coalesce(json_extract(h.config,'$.schedule.kind'),
    CASE WHEN (CASE WHEN h.config IS NULL THEN h.interval_ms ELSE json_extract(h.config,'$.interval_ms') END)
         IS NULL THEN 'instant' ELSE 'interval' END)
FROM historical h WHERE h.id=o.id;
