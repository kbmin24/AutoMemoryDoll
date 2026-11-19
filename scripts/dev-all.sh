#!/usr/bin/env bash
set -euo pipefail

if (( $# > 1 )); then
    echo 'Usage: npm run dev:all -- [username]' >&2
    exit 2
fi

if (( $# == 1 )); then
    sudo -v
fi

# Give each service its own process group so cleanup reaches its descendants.
set -m
pids=()

stop_services() {
    trap '' INT TERM HUP
    for pid in "${pids[@]}"; do
        kill -TERM -- "-$pid" 2>/dev/null || true
    done
    wait
}

trap stop_services EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP

npm run dev:backend -- "$@" </dev/null &
pids+=("$!")
npm run worker -- "$@" </dev/null &
pids+=("$!")
npm run dev:frontend </dev/null &
pids+=("$!")

wait -n "${pids[@]}"
