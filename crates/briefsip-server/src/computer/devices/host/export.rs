use super::*;

impl Host {
    pub(super) fn recovery_key(&self, source: &Value) -> Result<keys::Private> {
        let authority = id(&source["authorityGeneration"])?;
        let generation = revision(&source["deviceGeneration"], 1)?;
        let (reference, public): (String, String) = self
            .db
            .query_row(
                "SELECT signing_ref,signing_public_key FROM device_enrollment_keys WHERE authority_generation=? AND device_generation=?",
                params![authority, generation],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?
            .ok_or_else(keys::unavailable)?;
        let key = self.key(&reference, false, false)?;
        if B64.encode(key.public()) != public {
            return Err(keys::unavailable());
        }
        Ok(key)
    }

    pub(super) fn export_recovery(&mut self, body: &Value) -> Result<Value> {
        fields(
            body,
            &[
                "taskId",
                "actionIds",
                "requestId",
                "recoveryGeneration",
                "withContent",
            ],
        )?;
        let task = id(&body["taskId"])?;
        let request = id(&body["requestId"])?;
        let generation = id(&body["recoveryGeneration"])?;
        let with_content = match body.get("withContent") {
            None => false,
            Some(Value::Bool(value)) => *value,
            Some(_) => return Err(invalid_selection()),
        };
        let actions = body["actionIds"]
            .as_array()
            .filter(|actions| {
                (1..=8).contains(&actions.len()) && (!with_content || actions.len() == 1)
            })
            .ok_or_else(invalid_selection)?;
        let mut actions = actions.iter().map(id).collect::<Result<Vec<_>>>()?;
        actions.sort_unstable();
        if actions.windows(2).any(|pair| pair[0] == pair[1]) {
            return Err(invalid_selection());
        }
        self.acquire_executor()?;
        let rows = actions
            .iter()
            .map(|action| {
                let row = journal::latest_row(&self.db, action)?;
                let saved = journal::intent(&row)?;
                Ok((row, saved))
            })
            .collect::<Result<Vec<_>>>()?;
        let source = &rows[0].1["ownership"];
        for (row, saved) in &rows {
            if row["task_id"] != task
                || saved["taskId"] != task
                || saved["ownership"]["authorityGeneration"] != source["authorityGeneration"]
                || saved["ownership"]["deviceGeneration"] != source["deviceGeneration"]
            {
                return Err(fail(
                    403,
                    "recovery_scope_denied",
                    "Recovery action has a different source.",
                ));
            }
        }
        let key = self.recovery_key(source)?;
        let device = json!(self.identity.device_id);
        let mut entries = Vec::with_capacity(rows.len());
        let mut stops = Vec::new();
        let mut watermark = 0;
        for (row, saved) in &rows {
            let evidence = if saved.get("knownResolutionId").is_some() {
                journal::reported(row, saved)?
            } else {
                self.recovery_report(row, saved)?
            };
            if let Some(stop) = evidence.get("stopEvidence") {
                stops.push(stop.clone());
            }
            let sequence = revision(&evidence["journalSequence"], 1)?;
            watermark = watermark.max(sequence);
            let action = text(row, "action_id");
            let previous: Option<String> = self
                .db
                .query_row(
                    "SELECT entry_json FROM device_recovery_entries WHERE action_id=? AND journal_sequence=?",
                    params![action, sequence],
                    |row| row.get(0),
                )
                .optional()?;
            if let Some(previous) = previous {
                entries.push(crate::web::parse_json(previous.as_bytes())?);
                continue;
            }
            let entry = recovery_entry(row, saved, &evidence, source, &device, &key)?;
            // A signature covers the serialized result reference, including field order.
            self.db.execute(
                "INSERT INTO device_recovery_entries VALUES (?,?,?)",
                params![action, sequence, entry.to_string()],
            )?;
            entries.push(entry);
        }
        let envelope = json!({
            "v":1,"sourceAuthority":source["authorityGeneration"],"sourceDeviceId":device,
            "sourceDeviceGeneration":source["deviceGeneration"],"watermark":watermark,
            "entries":entries,"stopEvidence":stops
        });
        let signature = key.sign(&crate::tasks::device_recovery_body(
            &generation,
            &request,
            &envelope,
        ))?;
        let mut result = json!({"requestId":request,"recoveryGeneration":generation,"envelope":envelope,"signature":signature});
        if db::canonical(&result).len() > LIMIT {
            return Err(export_too_large());
        }
        if with_content {
            let row = &rows[0].0;
            let content = row["result_json"].as_str().ok_or_else(|| {
                fail(
                    409,
                    "result_missing",
                    "Result content is not available yet.",
                )
            })?;
            if content.len() > RESULT_LIMIT {
                return Err(export_too_large());
            }
            result["resultContent"] = crate::web::parse_json(content.as_bytes())?;
            if db::canonical(&result).len() > RESULT_LIMIT {
                return Err(export_too_large());
            }
        }
        Ok(result)
    }
}

fn invalid_selection() -> Failure {
    fail(
        400,
        "invalid_recovery_envelope",
        "Choose one to eight unique actions.",
    )
}

fn export_too_large() -> Failure {
    fail(
        413,
        "payload_too_large",
        "Recovery export exceeds the limit.",
    )
}

fn recovery_entry(
    row: &Value,
    saved: &Value,
    evidence: &Value,
    source: &Value,
    device: &Value,
    key: &keys::Private,
) -> Result<Value> {
    if let Some(marker) = evidence.get("noMarkerEvidence") {
        let mut entry = marker["entry"].clone();
        entry["signature"] = marker["signature"].clone();
        return Ok(entry);
    }
    let mut entry = json!({
        "taskId":row["task_id"],"actionId":row["action_id"],"sequence":row["sequence"],
        "executorGeneration":saved["ownership"]["executorGeneration"],"actionKind":row["action_kind"],
        "payloadDigest":row["payload_digest"],"intentDigest":row["intent_digest"],"grantRevision":row["grant_revision"],
        "state":evidence["state"],"effectStatus":evidence["effectStatus"],"journalSequence":evidence["journalSequence"]
    });
    if row["action_kind"] == "provider" {
        entry["bindingId"] = row["binding_id"].clone();
        entry["bindingRevision"] = row["binding_revision"].clone();
    }
    if let Some(reference) = evidence.get("resultRef") {
        entry["resultRef"] = reference.clone();
        entry["resultDigest"] = evidence["resultDigest"].clone();
    }
    entry["signature"] = key
        .sign(&crate::tasks::device_journal_body(
            &source["authorityGeneration"],
            device,
            &source["deviceGeneration"],
            &entry,
        ))?
        .into();
    Ok(entry)
}
