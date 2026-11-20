#!/bin/sh
set -eu
[ "$#" -le 1 ] || { echo 'Usage: uninstall-machine.sh [--purge]' >&2; exit 2; }
purge=0
[ "$#" -eq 1 ] && [ "$1" = --purge ] && purge=1 || [ "$#" -eq 0 ] || { echo 'Usage: uninstall-machine.sh [--purge]' >&2; exit 2; }
home=${HOME-}; case "$home" in /*) ;; *) echo 'HOME must be absolute.' >&2; exit 1 ;; esac
root=$home/.local/share/minarbot; config=$home/.config/minarbot; unit=$home/.config/systemd/user/minarbot.service
systemctl --user disable --now minarbot.service 2>/dev/null || true
rm -f "$unit" "$root/scripts/start.sh" "$root/scripts/uninstall-machine.sh"
systemctl --user daemon-reload
if [ "$purge" -eq 1 ]; then rm -rf "$root" "$config"; echo 'Minarbot installation and data removed.'; else echo "Minarbot stopped. Data kept at $root and $config."; fi
