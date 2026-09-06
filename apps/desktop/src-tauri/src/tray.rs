use crate::bridge_host::BridgeManager;
use std::sync::{Arc, Mutex};
use tauri::{
    AppHandle, CustomMenuItem, Manager, SystemTray, SystemTrayEvent, SystemTrayMenu,
    SystemTrayMenuItem,
};

pub fn build_tray() -> SystemTray {
    let status_item = CustomMenuItem::new("status", "【● FEAGLE WxBot 服务就绪 (6190)】").disabled();
    let open_item = CustomMenuItem::new("open", "打开控制台");
    let restart_item = CustomMenuItem::new("restart", "重启 Bridge 服务");
    let stop_item = CustomMenuItem::new("stop", "停止 Bridge 服务");
    let start_item = CustomMenuItem::new("start", "启动 Bridge 服务");
    let quit_item = CustomMenuItem::new("quit", "退出客户端");

    let tray_menu = SystemTrayMenu::new()
        .add_item(status_item)
        .add_native_item(SystemTrayMenuItem::Separator)
        .add_item(open_item)
        .add_item(start_item)
        .add_item(restart_item)
        .add_item(stop_item)
        .add_native_item(SystemTrayMenuItem::Separator)
        .add_item(quit_item);

    SystemTray::new().with_menu(tray_menu)
}

pub fn handle_tray_event(app: &AppHandle, event: SystemTrayEvent) {
    match event {
        SystemTrayEvent::LeftClick { .. } => {
            if let Some(window) = app.get_window("main") {
                if window.is_visible().unwrap_or(false) {
                    let _ = window.hide();
                } else {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }
        }
        SystemTrayEvent::MenuItemClick { id, .. } => {
            match id.as_str() {
                "open" => {
                    if let Some(window) = app.get_window("main") {
                        let _ = window.show();
                        let _ = window.set_focus();
                    }
                }
                "start" => {
                    let state = app.state::<Arc<Mutex<BridgeManager>>>().inner().clone();
                    if let Ok(mgr) = state.lock() {
                        let _ = mgr.start();
                    };
                }
                "restart" => {
                    let state = app.state::<Arc<Mutex<BridgeManager>>>().inner().clone();
                    if let Ok(mgr) = state.lock() {
                        let _ = mgr.restart();
                    };
                }
                "stop" => {
                    let state = app.state::<Arc<Mutex<BridgeManager>>>().inner().clone();
                    if let Ok(mgr) = state.lock() {
                        let _ = mgr.stop();
                    };
                }
                "quit" => {
                    let state = app.state::<Arc<Mutex<BridgeManager>>>().inner().clone();
                    if let Ok(mgr) = state.lock() {
                        let _ = mgr.stop();
                    };
                    app.exit(0);
                }
                _ => {}
            }
        }
        _ => {}
    }
}
