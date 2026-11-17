use super::*;
pub fn review(db: &Connection, turn: &Value, args: &Value) -> Result<Value> {
    if !closed(args, &["kind", "review"])
        || !["code", "ui", "file", "routine"].contains(&string(args, "kind"))
        || string(args, "review").trim().is_empty()
        || string(args, "review").encode_utf16().count() > 2000
    {
        return Ok(json!({"verified":false,"error":"Invalid verification review."}));
    }
    let id = string(turn, "id");
    let evidence = if string(args, "kind") == "routine" {
        exists(db,"SELECT 1 FROM flow_tool_calls WHERE turn=? AND json_extract(call,'$.function.name')='read_routine'",[id])?
    } else {
        exists(db,"SELECT 1 FROM verification_artifacts WHERE turn=?",[id])? || exists(db,"SELECT 1 FROM flow_tool_calls WHERE turn=? AND json_extract(call,'$.function.name') IN ('read_attachment','read_workspace_file','open_file_in_panel')",[id])?
    };
    if !evidence {
        return Ok(
            json!({"verified":false,"missing":format!("Run the relevant {} check before recording the review.",string(args,"kind"))}),
        );
    }
    db.execute("INSERT INTO turn_verification(turn,review,kind,stamp) VALUES(?,?,?,?) ON CONFLICT(turn) DO UPDATE SET review=excluded.review,kind=excluded.kind,stamp=excluded.stamp",params![id,string(args,"review"),string(args,"kind"),iso(db,0)?])?;
    Ok(json!({"verified":true,"evidenceInWorkLog":true}))
}
