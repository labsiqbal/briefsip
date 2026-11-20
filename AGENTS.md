# Minarbot

## App

From the repository root, install dependencies, lint, and build.

```sh
cd app
npm ci
npm run lint
npm run build
```

Run app tests with `npm test` from `app/`.

## Rust

From the repository root, run `cargo build --workspace` and `cargo test --workspace`.
Check formatting with `cargo fmt --check`.
Run `cargo clippy --workspace --all-targets -- -D warnings`.
Rust tests return `Result` and propagate errors with `?`. Avoid `unwrap` and `expect`.
On shared hosts, run Cargo and heavy test commands through `~/.cache/minarbot-cargo-slot.sh`.

## Issues

Claim the issue before editing with `Claimed by <agent>, branch t3/<slug>`.

Product context, history, and decisions live in local notes under `notes/` in the primary checkout listed in `~/workspace/INDEX.md`.
