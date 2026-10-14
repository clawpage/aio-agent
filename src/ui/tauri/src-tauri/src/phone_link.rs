//! The phones plugged into this Mac, offered to the signed-in account's agent.
//!
//! The console (settings, "Link this Mac's phone") asks the control plane for a
//! device token and hands it here. This keeps the token in a file only this user
//! can read, installs the phone runtime on first use (`phone/install.sh`: Node.js,
//! mobile-mcp, adb, scrcpy, all pinned and checksummed) and runs
//! `phone-bridge.mjs`, which dials the control plane with the token
//! (`device-link-client.mjs`). The bridge runs while the app is open; its state
//! is reported to the console as `aio-device-link` events.
use serde::{Deserialize, Serialize};
use std::io::{BufRead, BufReader, Read};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Manager};

const CONSOLE: &str = "agent.clawpage.ai";
const LINK_URL: &str = "wss://agent.clawpage.ai/api/device-link/connect";
const STORE: &str = "device-link.json";

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Stored {
    token: String,
    link_id: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Report {
    state: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    link_id: Option<String>,
    name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    detail: Option<String>,
}

struct Inner {
    stored: Option<Stored>,
    child: Option<Child>,
    /// Bumped by every start and stop: a supervisor thread from an older one gives up.
    generation: u64,
    state: &'static str,
    detail: Option<String>,
}

#[derive(Clone)]
pub struct PhoneLink {
    app: AppHandle,
    name: String,
    inner: Arc<Mutex<Inner>>,
}

impl PhoneLink {
    pub fn new(app: AppHandle) -> Self {
        let link = PhoneLink {
            name: computer_name(),
            inner: Arc::new(Mutex::new(Inner { stored: None, child: None, generation: 0, state: "off", detail: None })),
            app,
        };
        let stored = link.store_path().and_then(|p| std::fs::read(p).ok()).and_then(|b| serde_json::from_slice::<Stored>(&b).ok());
        link.inner.lock().unwrap().stored = stored;
        link
    }

    /// A linked Mac offers its phones whenever the app is open.
    pub fn resume(&self) {
        if self.inner.lock().unwrap().stored.is_some() {
            self.start();
        }
    }

    /// A message from the console's main frame (already checked to be the console origin).
    pub fn message(&self, body: &str) {
        #[derive(Deserialize)]
        #[serde(tag = "type", rename_all = "camelCase")]
        enum Message {
            Status,
            #[serde(rename_all = "camelCase")]
            Link { token: String, link_id: String },
            Unlink,
        }
        match serde_json::from_str::<Message>(body) {
            Ok(Message::Status) => self.report(),
            Ok(Message::Link { token, link_id }) => {
                if !valid_token(&token) || !valid_link_id(&link_id) {
                    return;
                }
                self.stop();
                let stored = Stored { token, link_id };
                if let Err(err) = self.save(Some(&stored)) {
                    self.set("error", Some(format!("{err}")));
                    return;
                }
                self.inner.lock().unwrap().stored = Some(stored);
                self.start();
            }
            Ok(Message::Unlink) => self.forget(),
            Err(_) => {}
        }
    }

    /// Stop the bridge and forget the token (the console removed this Mac, or the server did).
    fn forget(&self) {
        self.stop();
        let _ = self.save(None);
        self.inner.lock().unwrap().stored = None;
        self.set("off", None);
    }

    pub fn stop(&self) {
        let child = {
            let mut inner = self.inner.lock().unwrap();
            inner.generation += 1;
            inner.child.take()
        };
        if let Some(mut child) = child {
            terminate(&mut child);
        }
    }

    fn start(&self) {
        let generation = {
            let mut inner = self.inner.lock().unwrap();
            inner.generation += 1;
            inner.generation
        };
        let link = self.clone();
        std::thread::spawn(move || link.supervise(generation));
    }

    fn current(&self, generation: u64) -> bool {
        self.inner.lock().unwrap().generation == generation
    }

    /// Install if needed, run the bridge, and run it again after it ends, until stopped.
    fn supervise(&self, generation: u64) {
        let mut backoff = 5;
        while self.current(generation) {
            let Some(stored) = self.inner.lock().unwrap().stored.clone() else { return };
            let paths = match self.install(generation) {
                Ok(paths) => paths,
                Err(err) => {
                    self.set("error", Some(err));
                    self.sleep(generation, 60);
                    continue;
                }
            };
            if !self.current(generation) {
                return;
            }
            self.set("starting", None);
            match self.run_bridge(generation, &stored, &paths) {
                Outcome::Revoked => {
                    if self.current(generation) {
                        self.stop();
                        let _ = self.save(None);
                        self.inner.lock().unwrap().stored = None;
                        self.set("revoked", None);
                    }
                    return;
                }
                Outcome::Exited(why) => {
                    if !self.current(generation) {
                        return;
                    }
                    self.set("error", Some(why));
                    self.sleep(generation, backoff);
                    backoff = (backoff * 2).min(120);
                }
            }
        }
    }

    fn sleep(&self, generation: u64, seconds: u64) {
        for _ in 0..seconds * 4 {
            if !self.current(generation) {
                return;
            }
            std::thread::sleep(Duration::from_millis(250));
        }
    }

    fn install(&self, generation: u64) -> Result<Paths, String> {
        let resources = self.app.path().resource_dir().map_err(|e| e.to_string())?.join("phone");
        let runtime = self.runtime_dir().ok_or("no data directory")?;
        let mut child = Command::new("/bin/sh")
            .arg(resources.join("install.sh"))
            .arg(&runtime)
            .arg(&resources)
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| e.to_string())?;
        let mut paths = Paths::default();
        let mut failure = None;
        for line in BufReader::new(child.stdout.take().unwrap()).lines().map_while(Result::ok) {
            let (kind, value) = line.split_once(' ').unwrap_or((line.as_str(), ""));
            match kind {
                "step" if self.current(generation) => self.set("preparing", Some(value.to_string())),
                "node" => paths.node = PathBuf::from(value),
                "adb" => paths.adb = PathBuf::from(value),
                "bridge" => paths.bridge = PathBuf::from(value),
                "error" => failure = Some(value.to_string()),
                _ => {}
            }
        }
        let ok = child.wait().map(|s| s.success()).unwrap_or(false);
        if !ok || paths.node.as_os_str().is_empty() || paths.bridge.as_os_str().is_empty() {
            return Err(failure.unwrap_or_else(|| "install failed".into()));
        }
        Ok(paths)
    }

    fn run_bridge(&self, generation: u64, stored: &Stored, paths: &Paths) -> Outcome {
        let mut command = Command::new(&paths.node);
        command
            .arg(&paths.bridge)
            .env("PA_PHONE_DIR", self.runtime_dir().unwrap_or_default())
            .env("PA_ADB", &paths.adb)
            .env("PA_PHONE_BRIDGE_PORT", "0")
            .env("PA_PHONE_BRIDGE_BIND", "127.0.0.1")
            .env("PHONE_BRIDGE_TOKEN", random_hex())
            .env("PA_DEVICE_LINK_URL", LINK_URL)
            .env("PA_DEVICE_LINK_TOKEN", &stored.token)
            .env("PA_DEVICE_NAME", &self.name)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let mut child = match command.spawn() {
            Ok(child) => child,
            Err(err) => return Outcome::Exited(err.to_string()),
        };
        let stdout = child.stdout.take().unwrap();
        let mut stderr = child.stderr.take().unwrap();
        {
            let mut inner = self.inner.lock().unwrap();
            if inner.generation != generation {
                drop(inner);
                terminate(&mut child);
                return Outcome::Exited("stopped".into());
            }
            inner.child = Some(child);
        }
        std::thread::spawn(move || {
            let mut sink = Vec::new();
            let _ = stderr.read_to_end(&mut sink);
        });
        let mut revoked = false;
        let mut last = String::new();
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            #[derive(Deserialize)]
            struct Log {
                svc: Option<String>,
                msg: Option<String>,
                state: Option<String>,
            }
            let Ok(log) = serde_json::from_str::<Log>(&line) else { continue };
            if log.svc.as_deref() != Some("phone-bridge") {
                continue;
            }
            match (log.msg.as_deref(), log.state.as_deref()) {
                (Some("link"), Some("revoked")) => revoked = true,
                (Some("link"), Some(state @ ("connecting" | "online" | "offline"))) if self.current(generation) => {
                    self.set(match state { "online" => "online", "offline" => "offline", _ => "connecting" }, None)
                }
                (Some(msg), _) if msg.starts_with("fatal") => last = msg.to_string(),
                _ => {}
            }
        }
        // The bridge closed its output: it is ending; collect it unless a stop already did.
        if let Some(mut child) = self.inner.lock().unwrap().child.take() {
            let _ = child.wait();
        }
        if revoked {
            Outcome::Revoked
        } else {
            Outcome::Exited(if last.is_empty() { "phone bridge stopped".into() } else { last })
        }
    }

    fn set(&self, state: &'static str, detail: Option<String>) {
        {
            let mut inner = self.inner.lock().unwrap();
            inner.state = state;
            inner.detail = detail;
        }
        self.report();
    }

    fn report(&self) {
        let report = {
            let inner = self.inner.lock().unwrap();
            Report {
                state: inner.state,
                link_id: inner.stored.as_ref().map(|s| s.link_id.clone()),
                name: self.name.clone(),
                detail: inner.detail.clone(),
            }
        };
        let Ok(json) = serde_json::to_string(&report) else { return };
        let Some(window) = self.app.get_webview_window("main") else { return };
        if window.url().ok().and_then(|u| u.host_str().map(str::to_owned)).as_deref() != Some(CONSOLE) {
            return;
        }
        let _ = window.eval(format!("window.dispatchEvent(new CustomEvent('aio-device-link',{{detail:{json}}}));"));
    }

    fn data_dir(&self) -> Option<PathBuf> {
        self.app.path().app_data_dir().ok()
    }

    fn runtime_dir(&self) -> Option<PathBuf> {
        self.data_dir().map(|d| d.join("phone"))
    }

    fn store_path(&self) -> Option<PathBuf> {
        self.data_dir().map(|d| d.join(STORE))
    }

    /// The token is a credential: a file only this user can read, replaced atomically.
    fn save(&self, stored: Option<&Stored>) -> std::io::Result<()> {
        use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
        let path = self.store_path().ok_or_else(|| std::io::Error::other("no data directory"))?;
        let Some(stored) = stored else {
            return match std::fs::remove_file(&path) {
                Err(err) if err.kind() != std::io::ErrorKind::NotFound => Err(err),
                _ => Ok(()),
            };
        };
        let dir = path.parent().unwrap();
        std::fs::create_dir_all(dir)?;
        std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))?;
        let tmp = path.with_extension("tmp");
        let mut file = std::fs::OpenOptions::new().write(true).create(true).truncate(true).mode(0o600).open(&tmp)?;
        std::io::Write::write_all(&mut file, &serde_json::to_vec(stored)?)?;
        std::fs::rename(tmp, path)
    }
}

enum Outcome {
    Revoked,
    Exited(String),
}

#[derive(Default)]
struct Paths {
    node: PathBuf,
    adb: PathBuf,
    bridge: PathBuf,
}

/// SIGTERM lets the bridge stop mobile-mcp and scrcpy on its way out; it is killed if it lingers.
fn terminate(child: &mut Child) {
    let pid = child.id() as i32;
    unsafe {
        libc::kill(pid, libc::SIGTERM);
    }
    for _ in 0..20 {
        if let Ok(Some(_)) = child.try_wait() {
            return;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    let _ = child.kill();
    let _ = child.wait();
}

fn valid_token(token: &str) -> bool {
    token.len() == 46 && token.starts_with("dl_") && token[3..].bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

fn valid_link_id(id: &str) -> bool {
    id.len() == 30 && id.starts_with("dlink_") && id[6..].bytes().all(|b| b.is_ascii_hexdigit())
}

fn random_hex() -> String {
    let mut bytes = [0u8; 32];
    if let Ok(mut f) = std::fs::File::open("/dev/urandom") {
        let _ = f.read_exact(&mut bytes);
    }
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// This Mac's name as the user set it in System Settings.
fn computer_name() -> String {
    Command::new("/usr/sbin/scutil")
        .args(["--get", "ComputerName"])
        .output()
        .ok()
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "Mac".into())
}
