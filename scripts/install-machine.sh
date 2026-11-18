#!/bin/sh
set -eu
umask 077
usage() { echo "Usage: install-machine.sh --source ORIGIN --token TOKEN [--port 4317] [--name NAME] [--serve] [--dry-run]" >&2; exit 2; }
source= port=4317 name= serve=0 dry=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --source) [ "$#" -ge 2 ] || usage; source=$2; shift 2 ;;
    --token) [ "$#" -ge 2 ] || usage; token=$2; shift 2 ;;
    --port) [ "$#" -ge 2 ] || usage; port=$2; shift 2 ;;
    --name) [ "$#" -ge 2 ] || usage; name=$2; shift 2 ;;
    --serve) serve=1; shift ;;
    --dry-run) dry=1; shift ;;
    *) usage ;;
  esac
done
[ -n "$source" ] && [ -n "${token-}" ] || usage
case "$source" in *'?'*|*'#'*|https://*/*|http://127.0.0.1:*/*|http://\[::1\]:*/*) echo 'Source must be an exact HTTPS origin (HTTP allowed only on loopback).' >&2; exit 1 ;; http://127.0.0.1:*|http://\[::1\]:*|https://*) ;; *) echo 'Source must be HTTPS (HTTP allowed only on loopback).' >&2; exit 1 ;; esac
[ "${#token}" -eq 47 ] || { echo 'Install token is invalid.' >&2; exit 1; }
case "$token" in bsi_[A-Za-z0-9_-]*) ;; *) echo 'Install token is invalid.' >&2; exit 1 ;; esac
case "$port" in ''|*[!0-9]*) echo 'Invalid port.' >&2; exit 1 ;; esac
[ "$port" -ge 1 ] && [ "$port" -le 65535 ] || { echo 'Invalid port.' >&2; exit 1; }
home=${HOME-}; case "$home" in /*) ;; *) echo 'HOME must be an absolute path.' >&2; exit 1 ;; esac
root=$home/.local/share/briefsip; releases=$root/releases; config=$home/.config/briefsip; envfile=$config/launcher.env; unit=$home/.config/systemd/user/briefsip.service
if [ "$dry" -eq 1 ]; then
  printf '%s\n' \
    'Check Linux, curl, tar, sha256sum and user systemd.' \
    'Download and verify a Rust release archive; limit 1 GiB, SHA-256 and manifest verification.' \
    'Install bin/briefsip-server and bin/briefsip-launcher; preserve provider configuration.' \
    'Write ~/.config/briefsip/launcher.json and env file (0600); install briefsip.service.' \
    'systemctl --user daemon-reload' \
    'systemctl --user enable --now briefsip.service' \
    'Wait for http://127.0.0.1:PORT/api/environment and advertised origin.' \
    'POST source/api/install/pairing-code with Bearer [redacted] (consumes token).' \
    'POST local/api/environment to set display name; POST local/api/machines to pair both ways.' \
    'Run: tailscale serve --bg --https=PORT http://127.0.0.1:PORT'
  exit 0
fi
for command in curl tar sha256sum systemctl; do command -v "$command" >/dev/null 2>&1 || { echo "$command is required." >&2; exit 1; }; done
[ "$(uname -s)" = Linux ] || { echo 'Linux is required.' >&2; exit 1; }
mkdir -p "$releases" "$root/scripts" "$root/data" "$config" "$(dirname "$unit")"
if [ ! -e "$envfile" ]; then
  printf '%s\n' '# Add provider accounts in Settings > Provider accounts.' '# Optional literal dotenv values for headless operation.' > "$envfile"
  chmod 600 "$envfile"
fi
stage=$(mktemp -d "$releases/.install.XXXXXX"); archive=$stage/release.tar.gz
trap 'rm -rf "$stage"' EXIT HUP INT TERM
headers=$stage/headers
curl -fsSL -D "$headers" -H "Authorization: Bearer $token" -o "$archive" "$source/api/install/release"
id=$(sed -n 's/^x-briefsip-release:[[:space:]]*//Ip' "$headers" | tr -d '\r' | tail -n 1)
sha=$(sed -n 's/^x-briefsip-sha256:[[:space:]]*//Ip' "$headers" | tr -d '\r' | tail -n 1)
size=$(sed -n 's/^x-briefsip-size:[[:space:]]*//Ip' "$headers" | tr -d '\r' | tail -n 1)
case "$id" in ''|*[!A-Za-z0-9.-]*) echo 'Invalid release metadata.' >&2; exit 1 ;; esac
case "$sha" in ''|*[!a-f0-9]*) echo 'Invalid release metadata.' >&2; exit 1 ;; esac
case "$size" in ''|*[!0-9]*) echo 'Invalid release metadata.' >&2; exit 1 ;; esac
[ "$size" -le 1073741824 ] || { echo 'Invalid release metadata.' >&2; exit 1; }
[ "${#sha}" -eq 64 ] && [ "$(wc -c < "$archive")" -eq "$size" ] || { echo 'Release integrity check failed.' >&2; exit 1; }
printf '%s  %s\n' "$sha" "$archive" | sha256sum -c - >/dev/null || { echo 'Release integrity check failed.' >&2; exit 1; }
tar -tzf "$archive" | while IFS= read -r entry; do
  case "$entry" in
    ''|/*|../*|*/../*) echo 'Unsafe archive entry.' >&2; exit 1 ;;
  esac
done
tar -tvzf "$archive" | while IFS= read -r entry; do
  case "$entry" in -*|d*) ;; *) echo 'Unsafe archive entry.' >&2; exit 1 ;; esac
done
tar -xzf "$archive" -C "$stage" --no-same-owner --no-same-permissions --keep-directory-symlink
if find "$stage" \( -type l -o -type b -o -type c -o -type p \) -print -quit | grep -q .; then echo 'Release archive contains unsupported entries.' >&2; exit 1; fi
[ -x "$stage/bin/briefsip-server" ] && [ -x "$stage/bin/briefsip-launcher" ] || { echo 'Release lacks Rust binaries.' >&2; exit 1; }
[ -f "$stage/release.json" ] || { echo 'Release manifest missing.' >&2; exit 1; }
release=$releases/$id
[ ! -e "$release" ] && mv "$stage" "$release" || true
stage=
ln -sfn "$id" "$releases/current"
cp "$release/machine/uninstall-machine.sh" "$root/scripts/uninstall-machine.sh"
cat > "$root/scripts/start.sh" <<EOF
#!/bin/sh
set -eu
exec "$releases/current/bin/briefsip-launcher" --config "$config/launcher.json"
EOF
chmod 700 "$root/scripts/start.sh" "$root/scripts/uninstall-machine.sh"
printf '%s\n' "{\"dataDir\":\"$root/data\",\"envFile\":\"$envfile\",\"releasesDir\":\"$releases\",\"port\":$port}" > "$config/launcher.json"
cat > "$unit" <<EOF
[Unit]
Description=Briefsip Rust server launcher
After=network.target

[Service]
Type=simple
ExecStart=$root/scripts/start.sh
Restart=on-failure
RestartSec=2

[Install]
WantedBy=default.target
EOF
systemctl --user daemon-reload
systemctl --user enable --now briefsip.service
local=http://127.0.0.1:$port
ready=0
for _ in $(seq 1 240); do if curl -fsS --max-time 1 "$local/api/environment" >/dev/null 2>&1; then ready=1; break; fi; sleep 0.5; done
[ "$ready" -eq 1 ] || { echo 'Briefsip did not become healthy. Check systemctl --user status briefsip.service.' >&2; exit 1; }
case "$name" in *[!A-Za-z0-9._-]*|'') name=$(hostname);; esac
if ! curl -fsS --max-time 10 "$local/api/machines" | grep -Fq '"origin":"'"$source"'"'; then
  request_id=$(cat /proc/sys/kernel/random/uuid)
  curl -fsS --max-time 15 -X POST -H "Origin: $local" -H 'Content-Type: application/json' \
    --data '{"id":"'"$request_id"'","name":"'"$name"'"}' "$local/api/environment" >/dev/null
  pairing=$(curl -fsS --max-time 15 -X POST -H "Authorization: Bearer $token" -H 'Content-Type: application/json' \
    --data '{}' "$source/api/install/pairing-code")
  code=$(printf '%s' "$pairing" | sed -n 's/.*"code":"\([A-Z0-9]*\)".*/\1/p')
  case "$code" in ????????????) : ;; *) echo 'Source returned an invalid pairing code.' >&2; exit 1 ;; esac
  request_id=$(cat /proc/sys/kernel/random/uuid)
  curl -fsS --max-time 30 -X POST -H "Origin: $local" -H 'Content-Type: application/json' \
    --data '{"id":"'"$request_id"'","origin":"'"$source"'","code":"'"$code"'"}' "$local/api/machines" >/dev/null
fi
[ "$serve" -eq 0 ] || echo 'Tailscale Serve must be configured separately for this installation.'
printf '%s\n' "Briefsip Rust release installed: $id" "Data: $root/data" "Service: briefsip.service"
