use super::*;
use crate::config::WorkspaceConfig;
use std::{
    path::{Path, PathBuf},
    process::Stdio,
};
use tokio::io::AsyncReadExt;
#[path = "git_writes.rs"]
#[allow(dead_code)]
pub(crate) mod writes;
const CONFIG: [&str; 22] = [
    "-c",
    "core.hooksPath=/dev/null",
    "-c",
    "core.fsmonitor=false",
    "-c",
    "core.untrackedCache=false",
    "-c",
    "core.attributesFile=/dev/null",
    "-c",
    "core.splitIndex=false",
    "-c",
    "splitIndex.sharedIndexExpire=never",
    "-c",
    "commit.gpgSign=false",
    "-c",
    "protocol.allow=never",
    "-c",
    "credential.helper=",
    "-c",
    "core.fsync=objects,reference",
    "-c",
    "core.fsyncMethod=fsync",
];
async fn run(
    root: &Path,
    args: &[String],
    codes: &[i32],
    cap: usize,
    truncate: bool,
) -> Result<(Vec<u8>, i32, bool)> {
    run_input(root, args, codes, cap, truncate, &[], &[]).await
}
async fn run_input(
    root: &Path,
    args: &[String],
    codes: &[i32],
    cap: usize,
    truncate: bool,
    env: &[(&str, &str)],
    input: &[u8],
) -> Result<(Vec<u8>, i32, bool)> {
    use tokio::io::AsyncWriteExt;
    let mut child = tokio::process::Command::new("/usr/bin/git")
        .args(CONFIG)
        .args(args)
        .current_dir(root)
        .env_clear()
        .envs([
            ("PATH", "/usr/bin:/bin"),
            ("LANG", "C.UTF-8"),
            ("LC_ALL", "C.UTF-8"),
            ("GIT_TERMINAL_PROMPT", "0"),
            ("GIT_CONFIG_NOSYSTEM", "1"),
            ("GIT_CONFIG_GLOBAL", "/dev/null"),
            ("GIT_ATTR_NOSYSTEM", "1"),
            ("GIT_OPTIONAL_LOCKS", "0"),
            ("GIT_NO_REPLACE_OBJECTS", "1"),
        ])
        .envs(env.iter().copied())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|_| error(400, "Git operation failed or exceeded its output limit."))?;
    let stdout = child.stdout.take().ok_or_else(Failure::storage)?;
    let stderr = child.stderr.take().ok_or_else(Failure::storage)?;
    let mut stdin = child.stdin.take().ok_or_else(Failure::storage)?;
    let work = async {
        let write = async {
            let result = stdin.write_all(input).await;
            drop(stdin);
            result
        };
        let read = async {
            let mut bytes = Vec::new();
            stdout
                .take(cap as u64 + 1)
                .read_to_end(&mut bytes)
                .await
                .map_err(|_| Failure::storage())?;
            Ok::<_, Failure>(bytes)
        };
        let err = async {
            let mut bytes = Vec::new();
            stderr
                .take(512 * 1024 + 1)
                .read_to_end(&mut bytes)
                .await
                .map_err(|_| Failure::storage())?;
            Ok::<_, Failure>(bytes)
        };
        let (out, err, _write) = tokio::join!(read, err, write);
        let mut out = out?;
        let err = err?;
        let truncated = out.len() > cap;
        if truncated {
            child.kill().await.map_err(|_| Failure::storage())?;
            out.truncate(cap);
        }
        let status = child.wait().await.map_err(|_| Failure::storage())?;
        let code = status.code().unwrap_or(-1);
        if truncated && !truncate || !truncated && code != 0 && !codes.contains(&code) {
            return Err(error(
                400,
                std::str::from_utf8(&err)
                    .ok()
                    .map(str::trim)
                    .filter(|v| !v.is_empty())
                    .map(|s| s.chars().take(1000).collect::<String>())
                    .unwrap_or_else(|| {
                        "Git operation failed or exceeded its output limit.".to_owned()
                    }),
            ));
        }
        Ok((out, code, truncated))
    };
    match tokio::time::timeout(std::time::Duration::from_secs(15), work).await {
        Ok(result) => result,
        Err(_) => {
            let _ = child.kill().await;
            let _ = child.wait().await;
            Err(error(400,"Git operation stopped before completion. Inspect repository state before retrying."))
        }
    }
}
fn args(a: &[&str]) -> Vec<String> {
    a.iter().map(|s| (*s).to_owned()).collect()
}
async fn output(root: &Path, a: &[&str], codes: &[i32]) -> Result<String> {
    let (bytes, _, _) = run(root, &args(a), codes, 512 * 1024, false).await?;
    Ok(String::from_utf8(bytes)
        .map_err(|_| error(400, "Git output is not UTF-8."))?
        .trim_end()
        .to_owned())
}
struct Repo {
    directory: PathBuf,
    root: PathBuf,
    prefix: String,
    head: Option<String>,
    common: PathBuf,
    index: PathBuf,
}
async fn detect(root: &Path) -> Result<Option<Repo>> {
    workspace::open_directory(root).map_err(|_| {
        error(
            400,
            "Workspace directory unavailable or contains a symbolic link",
        )
    })?;
    let (bytes, code, _) = run(
        root,
        &args(&["rev-parse", "--is-inside-work-tree"]),
        &[128],
        512 * 1024,
        false,
    )
    .await?;
    if code == 128 || bytes != b"true\n" {
        return Ok(None);
    }
    let top = PathBuf::from(output(root, &["rev-parse", "--show-toplevel"], &[]).await?);
    workspace::open_directory(&top).map_err(|_| {
        error(
            400,
            "Workspace directory unavailable or contains a symbolic link",
        )
    })?;
    let prefix = root
        .strip_prefix(&top)
        .map_err(|_| error(400, "Workspace is outside its repository."))?
        .to_string_lossy()
        .into_owned();
    let common = output(
        root,
        &["rev-parse", "--path-format=absolute", "--git-common-dir"],
        &[],
    )
    .await?;
    workspace::open_directory(Path::new(&common)).map_err(|_| {
        error(
            400,
            "Workspace directory unavailable or contains a symbolic link",
        )
    })?;
    let index = PathBuf::from(
        output(
            root,
            &["rev-parse", "--path-format=absolute", "--git-path", "index"],
            &[],
        )
        .await?,
    );
    workspace::open_directory(index.parent().ok_or_else(Failure::storage)?).map_err(|_| {
        error(
            400,
            "Workspace directory unavailable or contains a symbolic link",
        )
    })?;
    if let Ok(meta) = std::fs::symlink_metadata(&index) {
        use std::os::unix::fs::MetadataExt;
        if !meta.is_file() || meta.nlink() != 1 {
            return Err(error(400, "Git index must be a regular file."));
        }
    }
    let head = output(root, &["rev-parse", "--verify", "--quiet", "HEAD"], &[1]).await?;
    if !head.is_empty()
        && (!(head.len() == 40 || head.len() == 64) || !head.bytes().all(|b| b.is_ascii_hexdigit()))
    {
        return Err(error(400, "Invalid repository HEAD."));
    }
    Ok(Some(Repo {
        directory: root.to_path_buf(),
        root: top,
        prefix,
        head: (!head.is_empty()).then_some(head),
        common: PathBuf::from(common),
        index,
    }))
}
fn path(value: &str) -> Result<&str> {
    if value.is_empty()
        || value.encode_utf16().count() > 2048
        || value
            .chars()
            .any(|c| c <= '\x1f' || c == '\x7f' || c == '\\')
        || value
            .split('/')
            .any(|p| p.is_empty() || p == "." || p == ".." || p.eq_ignore_ascii_case(".git"))
    {
        return Err(error(400,"Use a relative file path inside the workspace; Git metadata and links are unavailable."));
    }
    Ok(value)
}
async fn filters(repo: &Repo) -> Result<Vec<String>> {
    let (bytes, _, _) = run(
        &repo.directory,
        &args(&[
            "config",
            "--includes",
            "--null",
            "--name-only",
            "--get-regexp",
            r"^filter\..*\.(clean|smudge|process|required)$",
        ]),
        &[1],
        512 * 1024,
        false,
    )
    .await?;
    let source =
        std::str::from_utf8(&bytes).map_err(|_| error(400, "Unsupported Git filter name."))?;
    let mut drivers = std::collections::BTreeSet::new();
    for key in source.split('\0').filter(|s| !s.is_empty()) {
        let driver = key
            .rsplit_once('.')
            .map(|(a, _)| a)
            .ok_or_else(|| error(400, "Unsupported Git filter name."))?;
        if driver.chars().any(|c| c <= ' ' || c == '\x7f' || c == '=') {
            return Err(error(400, "Unsupported Git filter name."));
        }
        drivers.insert(driver);
    }
    Ok(drivers
        .into_iter()
        .flat_map(|d| {
            [
                "-c".to_owned(),
                format!("{d}.clean="),
                "-c".to_owned(),
                format!("{d}.smudge="),
                "-c".to_owned(),
                format!("{d}.process="),
                "-c".to_owned(),
                format!("{d}.required=false"),
            ]
        })
        .collect())
}
async fn changed(repo: &Repo) -> Result<Vec<Value>> {
    let mut a = filters(repo).await?;
    a.extend(args(&[
        "status",
        "--porcelain=v1",
        "-z",
        "--untracked-files=all",
        "--no-renames",
        "--",
        ".",
    ]));
    let (bytes, _, _) = run(&repo.directory, &a, &[], 512 * 1024, false).await?;
    let source = std::str::from_utf8(&bytes).map_err(|_| error(400, "Git output is not UTF-8."))?;
    let mut files = Vec::new();
    for row in source.split('\0').filter(|s| !s.is_empty()) {
        let code = row.get(..2).ok_or_else(Failure::storage)?;
        let file = row.get(3..).ok_or_else(Failure::storage)?;
        let file = if repo.prefix.is_empty() {
            file
        } else {
            file.strip_prefix(&format!("{}/", repo.prefix))
                .ok_or_else(|| error(400, "Workspace is outside its repository."))?
        };
        files.push(json!({"code":code,"path":path(file)?}));
        if files.len() > 1000 {
            return Err(error(
                400,
                "Status exceeds 1000 files. Bind a smaller workspace.",
            ));
        }
    }
    Ok(files)
}
pub async fn status(binding: Option<&WorkspaceConfig>) -> Result<Value> {
    let Some(binding) = binding else {
        return Ok(json!({"isRepo":false}));
    };
    let Some(repo) = detect(&binding.directory).await? else {
        return Ok(json!({"isRepo":false}));
    };
    let files = changed(&repo).await?;
    let branch = output(
        &repo.directory,
        &["symbolic-ref", "--quiet", "--short", "HEAD"],
        &[1],
    )
    .await?;
    let branches = output(
        &repo.directory,
        &[
            "for-each-ref",
            "--count=100",
            "--format=%(refname:short)",
            "refs/heads",
        ],
        &[],
    )
    .await?;
    let (bytes, _, _) = run(
        &repo.directory,
        &args(&["worktree", "list", "--porcelain", "-z"]),
        &[],
        512 * 1024,
        false,
    )
    .await?;
    let trees = std::str::from_utf8(&bytes).map_err(|_| Failure::storage())?;
    let worktrees: Vec<_> = trees
        .split("\0\0")
        .filter(|v| !v.is_empty())
        .take(100)
        .map(|r| {
            let p = r
                .split('\0')
                .find_map(|s| s.strip_prefix("worktree "))
                .unwrap_or("");
            let branch = r
                .split('\0')
                .find_map(|s| s.strip_prefix("branch "))
                .map(|s| s.strip_prefix("refs/heads/").unwrap_or(s));
            json!({"path":p,"branch":branch})
        })
        .collect();
    Ok(
        json!({"isRepo":true,"root":repo.root,"directory":repo.directory,"branch":(!branch.is_empty()).then_some(branch),"head":repo.head,"aheadCount":null,"behindCount":null,"dirtyCount":files.len(),"stagedCount":files.iter().filter(|f|text(f,"code")!="??"&&!text(f,"code").starts_with(' ')).count(),"unstagedCount":files.iter().filter(|f|text(f,"code")!="??"&&!text(f,"code").ends_with(' ')).count(),"untrackedCount":files.iter().filter(|f|f["code"]=="??").count(),"changedFiles":files,"localBranches":branches.lines().filter(|s|!s.is_empty()).collect::<Vec<_>>(),"worktrees":worktrees,"write":binding.write}),
    )
}
pub async fn diff(binding: &WorkspaceConfig, selected: Option<&str>) -> Result<Value> {
    if let Some(p) = selected {
        path(p)?;
    }
    let repo = detect(&binding.directory)
        .await?
        .ok_or_else(|| error(404, "Workspace is not a Git repository."))?;
    let files = if let Some(p) = selected {
        vec![p.to_owned()]
    } else {
        changed(&repo)
            .await?
            .iter()
            .map(|f| text(f, "path").to_owned())
            .collect()
    };
    let mut result = Vec::new();
    let mut binary = Vec::new();
    let mut truncated = false;
    for file in files {
        let exists = binding.directory.join(&file).try_exists().map_err(|_| {
            error(
                400,
                "Links and special files are unavailable in source control.",
            )
        })?;
        if exists {
            let (_, bytes) = workspace::download(&binding.directory, &file).map_err(|_| {
                error(
                    400,
                    "Links and special files are unavailable in source control.",
                )
            })?;
            if !is_text(&bytes) {
                binary.push(file);
                continue;
            }
        } else {
            let mut current = binding.directory.clone();
            for part in file.split('/') {
                current.push(part);
                match std::fs::symlink_metadata(&current) {
                    Ok(m) if m.file_type().is_symlink() => {
                        return Err(error(
                            400,
                            "Links and special files are unavailable in source control.",
                        ))
                    }
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => break,
                    _ => (),
                }
            }
        }
        let object = repo.head.as_ref().map(|head| {
            format!(
                "{head}:{}{}",
                if repo.prefix.is_empty() {
                    String::new()
                } else {
                    format!("{}/", repo.prefix)
                },
                file
            )
        });
        let tracked = if let Some(object) = &object {
            run(
                &repo.directory,
                &args(&["cat-file", "-e", object]),
                &[128],
                512 * 1024,
                false,
            )
            .await?
            .1 == 0
        } else {
            false
        };
        let mut a = filters(&repo).await?;
        if tracked {
            let object = object.as_deref().ok_or_else(Failure::storage)?;
            let (old, _, _) = run(
                &repo.directory,
                &args(&["cat-file", "blob", object]),
                &[],
                10 * 1024 * 1024,
                false,
            )
            .await?;
            if !is_text(&old) {
                binary.push(file);
                continue;
            }
            a.extend(args(&[
                "diff",
                "--relative",
                "--no-renames",
                "--no-color",
                "--no-ext-diff",
                "--no-textconv",
                "--unified=3",
                repo.head.as_deref().ok_or_else(Failure::storage)?,
                "--",
                &format!(":(literal){file}"),
            ]));
        } else if exists {
            a.extend(args(&[
                "diff",
                "--no-index",
                "--no-color",
                "--no-ext-diff",
                "--no-textconv",
                "--unified=3",
                "--",
                "/dev/null",
                &file,
            ]));
        } else {
            continue;
        }
        let (bytes, _, cap) = run(&repo.directory, &a, &[1], 256 * 1024, true).await?;
        if bytes
            .iter()
            .any(|b| *b < 9 || *b == 11 || *b == 12 || (*b >= 14 && *b < 32) || *b == 127)
        {
            return Err(error(400, "Diff contains unsupported control characters."));
        }
        result.extend(bytes);
        truncated |= cap;
        if result.len() >= 256 * 1024 {
            result.truncate(256 * 1024);
            truncated = true;
            break;
        }
    }
    Ok(
        json!({"path":selected,"text":String::from_utf8_lossy(&result),"truncated":truncated,"binaryFiles":binary}),
    )
}
fn is_text(bytes: &[u8]) -> bool {
    std::str::from_utf8(bytes).is_ok()
        && !bytes
            .iter()
            .any(|b| *b < 9 || *b == 11 || *b == 12 || (*b >= 14 && *b < 32) || *b == 127)
}
pub async fn log(binding: &WorkspaceConfig, limit: i64) -> Result<Value> {
    if !(1..=50).contains(&limit) {
        return Err(error(400, "Log limit must be between 1 and 50."));
    }
    let repo = detect(&binding.directory)
        .await?
        .ok_or_else(|| error(404, "Workspace is not a Git repository."))?;
    if repo.head.is_none() {
        return Ok(json!({"commits":[]}));
    }
    let mut a = args(&[
        "log",
        &format!("-{limit}"),
        "--format=%H%x00%an%x00%aI%x00%s%x00",
    ]);
    if !repo.prefix.is_empty() {
        a.extend(args(&["--", "."]));
    }
    let (bytes, _, _) = run(&repo.directory, &a, &[], 512 * 1024, false).await?;
    let source = std::str::from_utf8(&bytes).map_err(|_| Failure::storage())?;
    let records: Vec<_> = source.split('\0').collect();
    Ok(
        json!({"commits":records.chunks(4).filter(|r|r.len()==4).map(|r|json!({"hash":r[0].trim(),"author":r[1],"date":r[2],"subject":r[3]})).collect::<Vec<_>>()}),
    )
}
pub async fn handle(state: &AppState, req: Request, parts: &[&str]) -> Result<Response> {
    origin(state, &req)?;
    let agent = parts[2];
    {
        let db = state.database.lock().map_err(|_| Failure::storage())?;
        if !valid_id(agent)
            || one(&db.connection, "SELECT id FROM agents WHERE id=?", [agent])?.is_none()
        {
            return Err(error(404, "Agent not found."));
        }
    }
    let op = parts.get(4).copied().unwrap_or("status");
    let q = query(&req);
    if op == "checkpoints" && parts.len() == 7 {
        mutation(state, &req)?;
        if req.method() != Method::POST {
            return Err(error(404, "Route not found."));
        }
        let value = body(req, 64000).await?;
        if !value.is_object() {
            return Err(error(400, "JSON object is required."));
        }
        let id = text(&value, "id");
        if !valid_id(id) {
            return Err(error(400, "Invalid request ID."));
        }
        if !q.is_empty()
            || !keys(&value, &["id", "checkpointId", "digest"])
            || value["checkpointId"] != parts[5]
        {
            return Err(error(403, "Invalid checkpoint restoration request."));
        }
        {
            let db = state.database.lock().map_err(|_| Failure::storage())?;
            if one(
                &db.connection,
                "SELECT 1 FROM turns WHERE status='running' LIMIT 1",
                [],
            )?
            .is_some()
            {
                return Err(error(
                    409,
                    "Wait for or stop running agent work before restoring files.",
                ));
            }
        }
        let binding = super::panel::binding_for_turn(state, agent, parts[5])?.ok_or_else(|| {
            error(
                403,
                "Agent workspace is not connected by the host owner yet.",
            )
        })?;
        return Ok(json_response(
            200,
            writes::restore(
                state,
                &binding,
                id,
                &json!({"checkpointId":value["checkpointId"],"digest":value["digest"]}),
            )
            .await?,
        ));
    }
    if q.len() > 1
        || q.iter().any(|(k, _)| {
            k != if op == "diff" {
                "path"
            } else if op == "log" {
                "limit"
            } else {
                ""
            }
        })
    {
        return Err(error(400, "Invalid Git parameters."));
    }
    if req.method() != Method::GET {
        return Err(error(405, "Use GET for Git reads."));
    }
    let selected = if op == "checkpoints" {
        super::panel::binding_for_turn(state, agent, parts[5])?
    } else {
        let db = state.database.lock().map_err(|_| Failure::storage())?;
        Some(crate::data::agent_folders::effective(
            state,
            &db.connection,
            agent,
        )?)
    };
    let binding = selected.as_ref();
    let result = if op == "status" {
        status(binding).await?
    } else {
        let binding = binding.ok_or_else(|| {
            error(
                403,
                "Agent workspace is not connected by the host owner yet.",
            )
        })?;
        if op == "checkpoints" {
            writes::preview(state, binding, parts[5]).await?
        } else if op == "diff" {
            diff(binding, parameter(&q, "path")).await?
        } else {
            log(
                binding,
                parameter(&q, "limit").unwrap_or("50").parse().unwrap_or(0),
            )
            .await?
        }
    };
    Ok(json_response(200, result))
}

pub async fn project(state: &AppState, req: Request, parts: &[&str]) -> Result<Response> {
    if req.headers().contains_key("authorization")
        || req.headers().contains_key("origin") && !crate::data::origin(state, req.headers())
    {
        return Err(error(403, "Projects require the local Owner in Briefsip."));
    }
    if req.method() != Method::GET {
        return Err(error(400, "Invalid project parameters."));
    }
    let q = query(&req);
    let project = {
        let guard = state.database.lock().map_err(|_| Failure::storage())?;
        crate::data::projects::read(&guard.connection, parts[2])?
    };
    let folder = parameter(&q, "folder").or_else(|| {
        project["folders"]
            .as_array()
            .and_then(|v| v.first())
            .and_then(Value::as_str)
    });
    if q.iter()
        .any(|(k, _)| !["folder", "path", "limit"].contains(&k.as_str()))
        || !project["folders"]
            .as_array()
            .is_some_and(|a| a.iter().any(|v| v.as_str() == folder))
    {
        return Err(error(400, "Choose a project folder."));
    }
    let binding = WorkspaceConfig {
        agent: parts[2].into(),
        directory: PathBuf::from(folder.ok_or_else(|| error(400, "Choose a project folder."))?),
        write: false,
    };
    workspace::open_directory(&binding.directory).map_err(|_| {
        error(
            409,
            "Project folder is unavailable or contains a symbolic link.",
        )
    })?;
    let value = match parts.get(4).copied().unwrap_or("status") {
        "diff" => diff(&binding, parameter(&q, "path")).await?,
        "log" => {
            log(
                &binding,
                parameter(&q, "limit").unwrap_or("50").parse().unwrap_or(0),
            )
            .await?
        }
        _ => status(Some(&binding)).await?,
    };
    Ok(json_response(200, value))
}
