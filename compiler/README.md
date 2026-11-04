# Compiler container

This image processes one mounted job, writes a PDF and `result.json`, then exits. It does not connect to the backend or run a queue consumer.

## Build

From the repository root:

```sh
$ sudo docker build -f compiler/Dockerfile -t automemorydoll-compiler:local compiler
```

The build downloads the official full Tectonic 2022 default bundle from `https://data1.fullyjustified.net/tlextras-2022.0r0.tar`, verifies SHA-256 `425685e124746c15ba9bb8e0596bdaad98fce886afa347fbcf9ec0e9acd7fe79`, and installs the entire extracted bundle at `/bundle`. Network access is needed to build the image; the running compiler uses the bundle offline. The bundle is about 2.7 GB compressed, so allow space for the archive, extracted files, and image layers.

## Job files

Mount a directory at `/input` containing:

```text
template/template.tex
template/...other TeX support files
resources/...generation resources
data.json
```

`data.json` must contain a JSON object. Its top-level keys are MiniJinja variables. Strings are escaped for LaTeX unless the template author uses `|safe` for intentional raw TeX. From `template.tex`, resources can be referenced as `../resources/name.ext`.

Mount an empty, writable directory at `/output`. On success it contains `<UUID>.pdf` and `result.json` with `result: "ok"`, the PDF filename, and a short message. On failure the process exits nonzero and writes `result.json` with `result: "failed"`, `filename: null`, and an error message. A failed job leaves no PDF in that output directory. Use a fresh output directory for each run.

## Launch

Prepare absolute host paths. The image runs as UID/GID `65532:65532`, so that user must be able to write to the host directory mounted at `/output`. On a rootful Docker host, set up a fresh output directory with:

```sh
mkdir -p "$output_dir"
sudo chown 65532:65532 "$output_dir"
sudo chmod 700 "$output_dir"
```

Keep the output bind mount read-write (do not add `readonly`). If the compiler reports `cannot write result.json: output I/O error: Permission denied (os error 13)`, check the ownership and permissions of the **host** output directory. For a quick local test, `chmod 777 "$output_dir"` also allows writing, but the UID-owned directory above is preferable.

If you run the Docker CLI inside another container using the host's Docker socket, bind-mount source paths are resolved by the **host Docker daemon**. Put the input and output directories on the host and make them visible to the CLI container, ideally at the same absolute paths. A directory created only inside the CLI container (for example with `mktemp -d`) cannot be mounted into the sibling compiler container by the host daemon. Set the output directory permissions on the host.

```sh
docker run --rm --runtime=runsc\
  --network none --read-only --cap-drop ALL \
  --security-opt no-new-privileges \
  --mount "type=bind,source=$input_dir,target=/input,readonly" \
  --mount "type=bind,source=$output_dir,target=/output" \
  --tmpfs /tmp:rw,nosuid,nodev,mode=1777 \
  automemorydoll-compiler:local
```

The image runs as a non-root user. `/input` and the bundled TeX files are read-only at runtime; `/output` and the private `/tmp` mount are its writable locations. The image cannot select its own OCI runtime. Tectonic is configured with `SecurityStance::DisableInsecures` and shell escape disabled; filesystem isolation still depends on the container and gVisor boundaries.

## Smoke test

With Docker and `jq` installed, run:

```sh
sh compiler/tests/container-smoke.sh
```

This builds the image, runs a successful job with escaped data, `|safe`, a local class and a relative resource, then checks PDF bytes and the result manifest. It also checks non-object JSON and invalid TeX failures. The script transfers fixtures and results through temporary Docker volumes, so it works when the Docker daemon cannot see the CLI's temporary directory. Each compiler run uses `--network none`, a read-only root and input mount, and writable output and private temp mounts. To repeat under gVisor, set `CONTAINER_RUNTIME=runsc`.

For a local compiler check without Docker, set `SMOKE_MODE=local`, `COMPILER_BIN` to the built executable, and `TECTONIC_TEST_BUNDLE` to a directory containing the extracted full bundle. This checks the job flow but does not verify container isolation.
