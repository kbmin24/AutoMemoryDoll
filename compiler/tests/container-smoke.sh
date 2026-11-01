#!/bin/sh
set -eu

compiler_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
fixtures="$compiler_dir/tests/fixtures"
image=${IMAGE:-automemorydoll-compiler:smoke}
mode=${SMOKE_MODE:-container}

if ! command -v jq >/dev/null 2>&1; then
  echo 'container smoke test requires jq' >&2
  exit 2
fi

case "$mode" in
  container)
    if ! command -v docker >/dev/null 2>&1; then
      echo 'container smoke test requires Docker' >&2
      exit 2
    fi
    docker build --file "$compiler_dir/Dockerfile" --tag "$image" "$compiler_dir"
    ;;
  local)
    : "${COMPILER_BIN:?set COMPILER_BIN for local smoke testing}"
    : "${TECTONIC_TEST_BUNDLE:?set TECTONIC_TEST_BUNDLE for local smoke testing}"
    ;;
  *) echo "unknown SMOKE_MODE: $mode" >&2; exit 2 ;;
esac

work=$(mktemp -d)
volumes=''
cleanup() {
  for volume in $volumes; do
    docker volume rm "$volume" >/dev/null 2>&1 || true
  done
  rm -rf "$work"
}
trap 'cleanup' EXIT HUP INT TERM

run_job() {
  case_name=$1
  case_dir="$work/$case_name"
  mkdir -p "$case_dir/input" "$case_dir/output" "$case_dir/scratch"
  cp -R "$fixtures/$case_name/." "$case_dir/input/"
  chmod -R a+rX "$case_dir/input"
  chmod a+rwx "$case_dir/output" "$case_dir/scratch"

  if [ "$mode" = local ]; then
    TECTONIC_BUNDLE_PATH="$TECTONIC_TEST_BUNDLE" \
      TECTONIC_SCRATCH_DIR="$case_dir/scratch" \
      "$COMPILER_BIN" "$case_dir/input" "$case_dir/output"
  else
    input_volume=$(docker volume create)
    volumes="$volumes $input_volume"
    output_volume=$(docker volume create)
    volumes="$volumes $output_volume"
    tar -C "$case_dir/input" -cf - . | docker run --rm -i \
      --network none --user 0:0 --entrypoint tar \
      --mount "type=volume,source=$input_volume,target=/input" \
      "$image" -C /input -xf -
    docker run --rm --network none --user 0:0 --entrypoint chmod \
      --mount "type=volume,source=$output_volume,target=/output" \
      "$image" 777 /output
    if [ -n "${CONTAINER_RUNTIME:-}" ]; then
      set -- --runtime "$CONTAINER_RUNTIME"
    else
      set --
    fi
    if docker run --rm "$@" \
      --network none --read-only --cap-drop ALL \
      --security-opt no-new-privileges \
      --mount "type=volume,source=$input_volume,target=/input,readonly" \
      --mount "type=volume,source=$output_volume,target=/output" \
      --tmpfs /tmp:rw,nosuid,nodev,mode=1777 \
      "$image"; then
      job_status=0
    else
      job_status=$?
    fi
    docker run --rm --network none --user 0:0 --entrypoint tar \
      --mount "type=volume,source=$output_volume,target=/output,readonly" \
      "$image" -C /output -cf - . | tar -C "$case_dir/output" -xf -
    return "$job_status"
  fi
}

if ! run_job success; then
  echo 'success fixture failed to compile' >&2
  exit 1
fi
success_output="$work/success/output"
jq -e 'keys == ["filename", "message", "result"] and .result == "ok" and (.message | type == "string") and (.filename | test("^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\\.pdf$"))' \
  "$success_output/result.json" >/dev/null
pdf_name=$(jq -r .filename "$success_output/result.json")
[ "$(head -c 5 "$success_output/$pdf_name")" = '%PDF-' ]

for case_name in non-object invalid-tex; do
  if run_job "$case_name"; then
    echo "$case_name unexpectedly succeeded" >&2
    exit 1
  fi
  case_output="$work/$case_name/output"
  jq -e 'keys == ["filename", "message", "result"] and .result == "failed" and .filename == null and (.message | type == "string" and length > 0)' \
    "$case_output/result.json" >/dev/null
  if find "$case_output" -name '*.pdf' -print -quit | grep -q .; then
    echo "$case_name left a PDF behind" >&2
    exit 1
  fi
done

echo "smoke test passed ($mode)"
