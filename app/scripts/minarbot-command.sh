#!/bin/sh
set -eu
command=$1
shift
if [ "$command" = script ] && [ "${1:-}" = restore ]; then
  command=restore
  shift
fi
if [ -x ./bin/minarbot-server ]; then
  exec ./bin/minarbot-server "$command" "$@"
fi
exec cargo run --quiet --package minarbot-server -- "$command" "$@"
