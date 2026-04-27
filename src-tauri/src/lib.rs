mod commands;
mod core;
mod error;
mod models;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            commands::folder::open_folder,
            commands::thumbnail::ensure_thumbnail,
            commands::fileops::trash_bundle,
            commands::fileops::move_bundle,
            commands::fileops::copy_bundle,
            commands::fileops::open_path,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
