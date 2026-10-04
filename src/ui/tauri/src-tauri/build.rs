fn main() {
    // Android 15+ devices may use 16 KB memory pages (and Google Play requires it): align
    // the library's segments for them. Here rather than in .cargo/config.toml, because the
    // Android build sets RUSTFLAGS, which overrides target rustflags there.
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("android") {
        println!("cargo:rustc-link-arg=-Wl,-z,max-page-size=16384");
    }
    tauri_build::build()
}
