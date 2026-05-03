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
            commands::thumbnail::generate_thumbnails,
            commands::fileops::trash_bundle,
            commands::fileops::move_bundle,
            commands::fileops::copy_bundle,
            commands::fileops::open_path,
            commands::sidecar::get_bundle_sidecar,
            commands::sidecar::save_bundle_sidecar,
            commands::sidecar::set_bundle_rating,
            commands::sidecar::set_bundle_flag,
            commands::sidecar::set_bundle_tags,
            commands::settings::get_app_settings,
            commands::settings::save_app_settings,
            commands::settings::open_with_raw_developer,
            commands::settings::cycle_active_raw_developer,
            commands::gallery::share_gallery,
            commands::gallery::list_galleries,
            commands::gallery::fetch_gallery_feedback,
            commands::gallery::delete_gallery,
            commands::gallery::delete_galleries_bulk,
            commands::gallery::get_gallery_stats,
            commands::gallery::recompute_gallery_stats,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
