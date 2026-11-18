use std::{env, fs, path::Path};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let app = Path::new("../../app");
    let mut generated = String::new();
    let source = fs::read_to_string(app.join("schema.ts"))?;
    println!("cargo:rerun-if-changed=../../app/schema.ts");
    for name in [
        "migration",
        "migrationV2",
        "migrationV3",
        "migrationV4",
        "protectedWaitSchema",
        "taskSuccessorConstraint",
        "syncScopeSchema",
    ] {
        let marker = format!("const {name} = `");
        let sql = source
            .split_once(&marker)
            .ok_or("Missing schema constant")?
            .1
            .split_once("`;")
            .ok_or("Unclosed schema constant")?
            .0;
        if sql.contains("${") {
            return Err("Schema interpolation needs explicit Rust migration".into());
        }
        generated.push_str(&format!(
            "pub const {}: &str = {sql:?};\n",
            name.to_uppercase()
        ));
    }
    println!("cargo:rerun-if-changed=../../app/remote-agents.ts");
    let source = fs::read_to_string(app.join("remote-agents.ts"))?;
    let sql = source
        .split_once("db.exec(`")
        .ok_or("Missing remote-agent schema batch")?
        .1
        .split_once("`)")
        .ok_or("Unclosed remote-agent schema batch")?
        .0;
    if sql.contains("${") {
        return Err("Schema interpolation needs explicit Rust migration".into());
    }
    generated.push_str(&format!("pub const REMOTE: &str = {sql:?};\n"));
    fs::write(
        Path::new(&env::var("OUT_DIR")?).join("schema.rs"),
        generated,
    )?;
    Ok(())
}
