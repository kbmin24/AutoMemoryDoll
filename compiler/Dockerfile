FROM rust:1.98-trixie AS build

RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential cmake pkg-config \
    libfontconfig1-dev libfreetype-dev libgraphite2-dev \
    libharfbuzz-dev libicu-dev libpng-dev zlib1g-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY src ./src
RUN cargo build --release --locked

FROM debian:trixie-slim AS bundle

RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*

# Official full Tectonic 2022 default bundle. The digest pins the exact archive.
RUN curl --fail --location --retry 3 \
      https://data1.fullyjustified.net/tlextras-2022.0r0.tar -o /tmp/bundle.tar \
    && echo '425685e124746c15ba9bb8e0596bdaad98fce886afa347fbcf9ec0e9acd7fe79  /tmp/bundle.tar' | sha256sum --check - \
    && mkdir /bundle \
    && tar -xf /tmp/bundle.tar -C /bundle \
    && rm /tmp/bundle.tar

FROM debian:trixie-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    libfontconfig1 libfreetype6 libgraphite2-3 libharfbuzz0b \
    libicu76 libpng16-16t64 zlib1g \
    && rm -rf /var/lib/apt/lists/*

COPY --from=build /src/target/release/automemorydoll-compiler /usr/local/bin/automemorydoll-compiler
COPY --from=bundle /bundle/ /bundle/

ENV TECTONIC_BUNDLE_PATH=/bundle \
    TECTONIC_SCRATCH_DIR=/tmp/tectonic \
    HOME=/tmp
USER 65532:65532
ENTRYPOINT ["/usr/local/bin/automemorydoll-compiler"]
