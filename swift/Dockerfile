FROM swift:6.1

# Install build dependencies (cmake needed for libsignal, nasm for BoringSSL)
RUN apt-get update && apt-get install -y \
    wget build-essential protobuf-compiler curl git cmake nasm \
    clang libclang-dev python3 pkg-config \
    && rm -rf /var/lib/apt/lists/*

# Build SQLite from source with snapshot support (required by GRDB)
RUN cd /tmp \
    && wget -q https://www.sqlite.org/2024/sqlite-autoconf-3450100.tar.gz \
    && tar xzf sqlite-autoconf-3450100.tar.gz \
    && cd sqlite-autoconf-3450100 \
    && CFLAGS="-DSQLITE_ENABLE_SNAPSHOT -DSQLITE_ENABLE_FTS5" ./configure --prefix=/usr --quiet > /dev/null 2>&1 \
    && make -j4 -s > /dev/null 2>&1 \
    && make install -s > /dev/null 2>&1 \
    && ldconfig \
    && rm -rf /tmp/sqlite-autoconf-*

# Install Rust
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
ENV PATH="/root/.cargo/bin:${PATH}"

# Pre-build libsignal FFI (so we don't rebuild every container run)
RUN cd /tmp \
    && git clone --depth 1 https://github.com/signalapp/libsignal.git \
    && cd libsignal/rust/bridge/ffi \
    && cargo build --release 2>&1 | tail -3 \
    && mkdir -p /usr/local/lib /usr/local/include/SignalFfi \
    && cp /tmp/libsignal/target/release/libsignal_ffi.a /usr/local/lib/ \
    && cp /tmp/libsignal/swift/Sources/SignalFfi/signal_ffi.h /usr/local/include/SignalFfi/ \
    && cp /tmp/libsignal/swift/Sources/SignalFfi/signal_ffi_testing.h /usr/local/include/SignalFfi/ \
    && cp /tmp/libsignal/swift/Sources/SignalFfi/module.modulemap /usr/local/include/SignalFfi/ \
    && ldconfig \
    && rm -rf /tmp/libsignal

WORKDIR /app
