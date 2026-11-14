#!/usr/bin/env bash
set -euo pipefail

case "${1:-}" in
    api) entry=src/server.ts ;;
    worker) entry=src/worker/main.ts ;;
    *) echo 'Expected service: api or worker.' >&2; exit 2 ;;
esac
service=$1
shift
if (( $# > 1 )); then
    echo 'Usage: run-service.sh api|worker [username]' >&2
    exit 2
fi

cd -- "$(dirname -- "$0")/.."
node_path=${npm_node_execpath:-$(command -v node)}
if (( $# == 0 )); then
    exec "$node_path" --import tsx "$entry"
fi

service_uid=$(id -u -- "$1")
service_gid=$(id -g -- "$1")
service_home=$(getent passwd "$1" | cut -d: -f6)
if [[ "$service_uid" == 0 || "$service_gid" == 0 ]]; then
    echo 'The service account must have a non-root UID and GID.' >&2
    exit 1
fi

identity=("--reuid=$service_uid" "--regid=$service_gid")
if [[ "$service" == worker ]]; then
    identity+=("--groups=$(stat -c %g /var/run/docker.sock)")
else
    identity+=(--clear-groups)
fi
exec sudo -- setpriv "${identity[@]}" env "HOME=$service_home" "$node_path" --import tsx "$entry"
