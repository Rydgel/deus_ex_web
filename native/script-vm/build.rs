// The module runs inside the script runtime's object arena
// (src/runtime/script-object-arena.mjs): it imports that memory, and its
// shadow stack and statics occupy the arena's reserved low 2 MiB. The stack
// pointer is exported so the host can restore it after an import throws
// through Wasm frames, and __heap_base so the host can check that the statics
// fit below the reserved region (Rust 1.99 no longer exports it by default).
fn main() {
    if std::env::var("CARGO_CFG_TARGET_ARCH").as_deref() == Ok("wasm32") {
        println!("cargo:rustc-link-arg=--import-memory");
        println!("cargo:rustc-link-arg=--stack-first");
        println!("cargo:rustc-link-arg=-zstack-size=1048576");
        println!("cargo:rustc-link-arg=--export=__stack_pointer");
        println!("cargo:rustc-link-arg=--export=__heap_base");
    }
}
