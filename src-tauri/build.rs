fn main() {
    // generate_context!() embeds the icons but only re-runs when this crate
    // recompiles, so rebuild when they change or `tauri dev` keeps the old icon.
    println!("cargo:rerun-if-changed=icons");
    tauri_build::build()
}
