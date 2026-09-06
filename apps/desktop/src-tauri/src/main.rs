#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod bridge_host;
mod tray;

use bridge_host::{BridgeManager, BridgeStatus};
use std::sync::{Arc, Mutex};
use tauri::State;

#[tauri::command]
fn get_bridge_status(state: State<Arc<Mutex<BridgeManager>>>) -> Result<BridgeStatus, String> {
    let mgr = state.lock().map_err(|e| e.to_string())?;
    Ok(mgr.get_status())
}

#[tauri::command]
fn start_bridge(state: State<Arc<Mutex<BridgeManager>>>) -> Result<u32, String> {
    let mgr = state.lock().map_err(|e| e.to_string())?;
    mgr.start()
}

#[tauri::command]
fn stop_bridge(state: State<Arc<Mutex<BridgeManager>>>) -> Result<(), String> {
    let mgr = state.lock().map_err(|e| e.to_string())?;
    mgr.stop()
}

#[tauri::command]
fn restart_bridge(state: State<Arc<Mutex<BridgeManager>>>) -> Result<u32, String> {
    let mgr = state.lock().map_err(|e| e.to_string())?;
    mgr.restart()
}

#[tauri::command]
fn get_bridge_logs(state: State<Arc<Mutex<BridgeManager>>>) -> Result<Vec<String>, String> {
    let mgr = state.lock().map_err(|e| e.to_string())?;
    Ok(mgr.get_logs())
}

#[tauri::command]
fn check_bridge_ready(state: State<Arc<Mutex<BridgeManager>>>) -> Result<bool, String> {
    let mgr = state.lock().map_err(|e| e.to_string())?;
    Ok(mgr.is_ready())
}

fn main() {
    let bridge_mgr = Arc::new(Mutex::new(BridgeManager::new(6190)));

    // 启动 Bridge 后台进程
    if let Ok(mgr) = bridge_mgr.lock() {
        if let Err(err) = mgr.start() {
            eprintln!("[FEAGLE-DESKTOP] 启动 Bridge 失败: {}", err);
        }
    }

    let bridge_mgr_for_exit = Arc::clone(&bridge_mgr);

    let app = tauri::Builder::default()
        .manage(bridge_mgr)
        .system_tray(tray::build_tray())
        .on_system_tray_event(tray::handle_tray_event)
        .invoke_handler(tauri::generate_handler![
            get_bridge_status,
            check_bridge_ready,
            start_bridge,
            stop_bridge,
            restart_bridge,
            get_bridge_logs
        ])
        .on_window_event(|event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event.event() {
                // 点击窗口右上角叉号时最小化到系统托盘，不直接退出后台服务
                let _ = event.window().hide();
                api.prevent_close();
            }
        })
        .build(tauri::generate_context!())
        .expect("初始化 FEAGLE WxBot 客户端失败");

    app.run(move |_app_handle, event| {
        if let tauri::RunEvent::ExitRequested { .. } = event {
            if let Ok(mgr) = bridge_mgr_for_exit.lock() {
                let _ = mgr.stop();
            }
        }
    });
}
