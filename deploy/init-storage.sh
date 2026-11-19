#!/bin/sh
set -e

for identity in "$SERVICE_UID" "$SERVICE_GID"; do
    case "$identity" in
        ''|*[!0-9]*|0)
            echo 'Service UID/GID must be positive integers' >&2
            exit 1
            ;;
    esac
done

for directory in "$STORAGE_ROOT" "$LOG_DIR"; do
    test -d "$directory" && test ! -L "$directory"
    entries=$(ls -A "$directory")
    if [ -z "$entries" ]; then
        chown "$SERVICE_UID:$SERVICE_GID" "$directory"
        chmod 700 "$directory"
    fi

    if [ "$(stat -c '%u:%g:%a' "$directory")" != "$SERVICE_UID:$SERVICE_GID:700" ]; then
        echo 'Existing storage/log permissions do not match; migrate them explicitly' >&2
        exit 1
    fi
done
