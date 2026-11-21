fn main() {
    println!("cargo:rerun-if-changed=../server-proto/obscura/v1/obscura.proto");
    println!("cargo:rerun-if-changed=../client-protocol/obscura/client/v1/client.proto");

    prost_build::compile_protos(
        &[
            "../server-proto/obscura/v1/obscura.proto",
            "../client-protocol/obscura/client/v1/client.proto",
        ],
        &["../server-proto", "../client-protocol"],
    )
    .expect("Failed to compile Obscura protobuf definitions");
}
