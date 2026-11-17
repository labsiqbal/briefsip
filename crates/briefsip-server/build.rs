use std::{env, fs, path::Path};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let app = Path::new("../../app");
    let arch = match env::var("CARGO_CFG_TARGET_ARCH")?.as_str() {
        "x86_64" => "x64",
        "aarch64" => "arm64",
        _ => return Err("Avatar encoder supports Linux x64 and arm64".into()),
    };
    let relative = format!("node_modules/@img/sharp-libvips-linux-{arch}/lib");
    let native = app
        .join(&relative)
        .canonicalize()
        .map_err(|_| "Run npm ci in app before cargo build")?;
    let library = fs::read_dir(&native)?
        .filter_map(Result::ok)
        .map(|e| e.path())
        .find(|p| {
            p.file_name()
                .is_some_and(|n| n.to_string_lossy().starts_with("libvips-cpp.so."))
        })
        .ok_or("Missing Sharp libvips shared library")?;
    let out = std::path::PathBuf::from(env::var("OUT_DIR")?);
    for name in ["vips", "glib-2.0", "gobject-2.0"] {
        let link = out.join(format!("lib{name}.so"));
        if link.symlink_metadata().is_ok() {
            fs::remove_file(&link)?;
        }
        std::os::unix::fs::symlink(&library, link)?;
    }
    println!("cargo:rerun-if-changed={}", library.display());
    println!("cargo:rustc-link-search=native={}", out.display());
    for root in ["$ORIGIN/..", "$ORIGIN/../../app", "$ORIGIN/../../../app"] {
        println!("cargo:rustc-link-arg=-Wl,-rpath,{root}/{relative}");
    }
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
    for (file, name) in [
        ("agent-visibility.ts", "VISIBILITY"),
        ("agent-messages.ts", "MESSAGES"),
        ("agent-delegation.ts", "DELEGATION"),
        ("remote-agents.ts", "REMOTE"),
        ("room-chat.ts", "ROOMS"),
    ] {
        println!("cargo:rerun-if-changed=../../app/{file}");
        let source = fs::read_to_string(app.join(file))?;
        let sql = source
            .split_once("db.exec(`")
            .ok_or("Missing schema batch")?
            .1
            .split_once("`)")
            .ok_or("Unclosed schema batch")?
            .0;
        if sql.contains("${") {
            return Err("Schema interpolation needs explicit Rust migration".into());
        }
        generated.push_str(&format!("pub const {name}: &str = {sql:?};\n"));
    }
    fs::write(
        Path::new(&env::var("OUT_DIR")?).join("schema.rs"),
        generated,
    )?;
    Ok(())
}
