use std::env;
use std::fs;
use std::net::{SocketAddr, TcpStream};
use std::os::windows::io::AsRawHandle;
use std::os::windows::process::CommandExt;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use windows::Win32::Foundation::{CloseHandle, HANDLE};
use windows::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, SetInformationJobObject,
    JobObjectExtendedLimitInformation, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
};

const CREATE_NO_WINDOW: u32 = 0x08000000;

#[derive(Debug, Clone, serde::Serialize)]
pub struct BridgeStatus {
    pub running: bool,
    pub port_ready: bool,
    pub pid: Option<u32>,
    pub port: u16,
    pub node_path: Option<String>,
    pub bridge_dir: Option<String>,
}

pub fn is_port_listening(port: u16) -> bool {
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    TcpStream::connect_timeout(&addr, Duration::from_millis(300)).is_ok()
}

pub struct JobGuard {
    job: HANDLE,
}

impl JobGuard {
    pub fn new() -> Result<Self, String> {
        unsafe {
            let job = CreateJobObjectW(None, None)
                .map_err(|e| format!("CreateJobObjectW failed: {:?}", e))?;
            let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                &info as *const _ as *const _,
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
            .map_err(|e| format!("SetInformationJobObject failed: {:?}", e))?;
            Ok(Self { job })
        }
    }

    pub fn assign_process(&self, child: &Child) -> Result<(), String> {
        unsafe {
            let handle = HANDLE(child.as_raw_handle() as _);
            AssignProcessToJobObject(self.job, handle)
                .map_err(|e| format!("AssignProcessToJobObject failed: {:?}", e))?;
            Ok(())
        }
    }
}

impl Drop for JobGuard {
    fn drop(&mut self) {
        unsafe {
            if !self.job.is_invalid() {
                let _ = CloseHandle(self.job);
            }
        }
    }
}

unsafe impl Send for JobGuard {}
unsafe impl Sync for JobGuard {}

use std::io::{BufRead, BufReader};
use std::thread;

pub struct BridgeManager {
    child: Arc<Mutex<Option<Child>>>,
    job_guard: Option<Arc<JobGuard>>,
    port: u16,
    node_path: Option<PathBuf>,
    bridge_dir: Option<PathBuf>,
    logs: Arc<Mutex<Vec<String>>>,
}

impl BridgeManager {
    pub fn new(port: u16) -> Self {
        let (node_path, bridge_dir) = Self::detect_environment();
        let job_guard = match JobGuard::new() {
            Ok(guard) => Some(Arc::new(guard)),
            Err(err) => {
                eprintln!("[FEAGLE-DESKTOP] Failed to initialize JobObject: {}", err);
                None
            }
        };

        Self {
            child: Arc::new(Mutex::new(None)),
            job_guard,
            port,
            node_path,
            bridge_dir,
            logs: Arc::new(Mutex::new(Vec::new())),
        }
    }

    pub fn get_logs(&self) -> Vec<String> {
        let logs_lock = self.logs.lock().unwrap();
        logs_lock.clone()
    }

    pub fn append_log(&self, msg: String) {
        let mut logs_lock = self.logs.lock().unwrap();
        if logs_lock.len() > 1000 {
            logs_lock.remove(0);
        }
        logs_lock.push(msg);
    }

    fn detect_environment() -> (Option<PathBuf>, Option<PathBuf>) {
        let bridge_dir = Self::find_bridge_dir();
        let node_path = Self::find_node_runtime(&bridge_dir);
        (node_path, bridge_dir)
    }

    fn find_bridge_dir() -> Option<PathBuf> {
        let mut candidates = Vec::new();
        if let Ok(cwd) = env::current_dir() {
            candidates.push(cwd.clone());
            candidates.push(cwd.join("apps").join("bridge"));
            let mut curr = cwd.clone();
            for _ in 0..8 {
                if let Some(parent) = curr.parent() {
                    candidates.push(parent.join("apps").join("bridge"));
                    curr = parent.to_path_buf();
                } else {
                    break;
                }
            }
        }
        if let Ok(exe) = env::current_exe() {
            if let Some(parent) = exe.parent() {
                candidates.push(parent.to_path_buf());
                candidates.push(parent.join("apps").join("bridge"));
                let mut curr = parent.to_path_buf();
                for _ in 0..8 {
                    if let Some(p) = curr.parent() {
                        candidates.push(p.to_path_buf());
                        candidates.push(p.join("apps").join("bridge"));
                        curr = p.to_path_buf();
                    } else {
                        break;
                    }
                }
            }
        }

        for path in candidates {
            let entry = path.join("src").join("index.js");
            if entry.is_file() {
                return Some(path);
            }
            let entry_rel = path.join("apps").join("bridge").join("src").join("index.js");
            if entry_rel.is_file() {
                return Some(path.join("apps").join("bridge"));
            }
        }
        None
    }

    fn find_node_runtime(bridge_dir: &Option<PathBuf>) -> Option<PathBuf> {
        // 1. Try system PATH
        if let Ok(output) = Command::new("node").arg("-v").output() {
            if output.status.success() {
                return Some(PathBuf::from("node"));
            }
        }

        // 2. Try isolated .tools/node
        if let Some(dir) = bridge_dir {
            let repo_root = dir.parent().and_then(|p| p.parent()).unwrap_or(dir.as_path());
            let tools_node = repo_root.join(".tools").join("node").join("node.exe");
            if tools_node.is_file() {
                return Some(tools_node);
            }

            // Check nested folder in .tools/node
            let tools_dir = repo_root.join(".tools").join("node");
            if tools_dir.is_dir() {
                if let Ok(entries) = fs::read_dir(&tools_dir) {
                    for entry in entries.flatten() {
                        let candidate = entry.path().join("node.exe");
                        if candidate.is_file() {
                            return Some(candidate);
                        }
                    }
                }
            }
        }

        None
    }

    pub fn is_ready(&self) -> bool {
        is_port_listening(self.port)
    }

    pub fn start(&self) -> Result<u32, String> {
        // 如果 6190 端口已在监听（例如通过外部已启动的进程或端口映射），直接标记就绪，避免 EADDRINUSE 崩溃
        if is_port_listening(self.port) {
            self.append_log(format!("[FEAGLE-DESKTOP] 端口 {} 已就绪 (外部已运行或端口转发活跃)", self.port));
            return Ok(0);
        }

        let mut child_lock = self.child.lock().unwrap();
        if let Some(ref mut c) = *child_lock {
            match c.try_wait() {
                Ok(None) => return Ok(c.id()),
                _ => *child_lock = None,
            }
        }

        let bridge_dir = self.bridge_dir.as_ref().ok_or_else(|| {
            "未检测到 apps/bridge 目录，请检查仓库完整性。".to_string()
        })?;
        let node_bin = self.node_path.as_ref().ok_or_else(|| {
            "未检测到 Node.js 运行环境，请先安装 Node.js 或运行 .\\feagle.cmd env。".to_string()
        })?;

        let entry = bridge_dir.join("src").join("index.js");
        if !entry.is_file() {
            return Err(format!("找不到 Bridge 入口文件: {}", entry.display()));
        }

        let mut cmd = Command::new(node_bin);
        cmd.arg("src/index.js")
            .current_dir(bridge_dir)
            .creation_flags(CREATE_NO_WINDOW)
            .env("PORT", self.port.to_string())
            .env("BOT_DASHBOARD_PORT", self.port.to_string())
            .env("NODE_ENV", "production")
            .env("DATA_DIR", "./data")
            .env("MNEMOSYNE_PORT", "18010")
            .env("MNEMOSYNE_LOCAL", "true")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        let mut child = cmd.spawn().map_err(|e| format!("启动 Node.js 失败: {:?}", e))?;
        let pid = child.id();

        // 捕获并记录 stdout 与 stderr 日志
        if let Some(stdout) = child.stdout.take() {
            let logs_clone = Arc::clone(&self.logs);
            thread::spawn(move || {
                let reader = BufReader::new(stdout);
                for line in reader.lines().flatten() {
                    let mut l = logs_clone.lock().unwrap();
                    if l.len() > 1000 {
                        l.remove(0);
                    }
                    l.push(format!("[STDOUT] {}", line));
                }
            });
        }

        if let Some(stderr) = child.stderr.take() {
            let logs_clone = Arc::clone(&self.logs);
            thread::spawn(move || {
                let reader = BufReader::new(stderr);
                for line in reader.lines().flatten() {
                    let mut l = logs_clone.lock().unwrap();
                    if l.len() > 1000 {
                        l.remove(0);
                    }
                    l.push(format!("[STDERR] {}", line));
                }
            });
        }

        if let Some(ref guard) = self.job_guard {
            if let Err(e) = guard.assign_process(&child) {
                eprintln!("[FEAGLE-DESKTOP] Warning: failed to assign child to JobObject: {}", e);
            }
        }

        *child_lock = Some(child);
        self.append_log(format!("[FEAGLE-DESKTOP] Bridge 服务已拉起 (PID: {}, 端口: {})", pid, self.port));
        Ok(pid)
    }

    pub fn stop(&self) -> Result<(), String> {
        let mut child_lock = self.child.lock().unwrap();
        if let Some(ref mut c) = *child_lock {
            let _ = c.kill();
            let _ = c.wait();
        }
        *child_lock = None;
        println!("[FEAGLE-DESKTOP] Bridge 服务已停止");
        Ok(())
    }

    pub fn restart(&self) -> Result<u32, String> {
        let _ = self.stop();
        std::thread::sleep(std::time::Duration::from_millis(600));
        self.start()
    }

    pub fn get_status(&self) -> BridgeStatus {
        let mut child_lock = self.child.lock().unwrap();
        let mut running = false;
        let mut pid = None;

        if let Some(ref mut c) = *child_lock {
            match c.try_wait() {
                Ok(None) => {
                    running = true;
                    pid = Some(c.id());
                }
                _ => {
                    *child_lock = None;
                }
            }
        }

        let port_ready = is_port_listening(self.port);

        BridgeStatus {
            running: running || port_ready,
            port_ready,
            pid,
            port: self.port,
            node_path: self.node_path.as_ref().map(|p| p.to_string_lossy().to_string()),
            bridge_dir: self.bridge_dir.as_ref().map(|p| p.to_string_lossy().to_string()),
        }
    }
}
