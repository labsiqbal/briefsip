use std::{env, fs, path::Path};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut generated = String::new();
    for (name, file) in [
        ("MIGRATION", "data/legacy-v1.sql"),
        ("MIGRATIONV2", "data/legacy-v2.sql"),
        ("MIGRATIONV3", "data/legacy-v3.sql"),
        ("MIGRATIONV4", "data/legacy-v4.sql"),
        ("PROTECTEDWAITSCHEMA", "data/protected-waits.sql"),
        ("TASKSUCCESSORCONSTRAINT", "data/task-successors.sql"),
        ("SYNCSCOPESCHEMA", "data/sync-scopes.sql"),
        ("REMOTE", "computer/remote-agents.sql"),
    ] {
        println!("cargo:rerun-if-changed=src/{file}");
        let sql = fs::read_to_string(Path::new("src").join(file))?;
        generated.push_str(&format!("pub const {name}: &str = {sql:?};\n"));
    }
    fs::write(
        Path::new(&env::var("OUT_DIR")?).join("schema.rs"),
        generated,
    )?;
    Ok(())
}
