#!/bin/sh
set -eu
command=$1
shift
if [ "$command" = script ] && [ "${1:-}" = restore ]; then
  command=restore
  shift
fi
if [ -x ./bin/briefsip-server ]; then
  exec ./bin/briefsip-server "$command" "$@"
fi
exec cargo run --quiet --package briefsip-server -- "$command" "$@"
