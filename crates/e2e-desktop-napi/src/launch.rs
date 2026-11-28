//! Launching an app: always a new instance, through LaunchServices
//! (`open -n`). The app gets launchd's environment plus the variables the
//! caller names, and never this process's environment, so the run's secrets
//! stay behind.

use crate::failure::{Failure, Outcome, codes};
use objc2::rc::Retained;
use objc2_app_kit::{NSRunningApplication, NSWorkspace};
use objc2_foundation::{NSDictionary, NSString, NSURL};
use serde::Serialize;
use std::io::Read;
use std::path::Path;
use std::process::{Command, Stdio};
use std::thread::sleep;
use std::time::{Duration, Instant};

/// The variable that carries a launch's token into the process it starts.
pub const TOKEN_VARIABLE: &str = "E2E_DESKTOP_LAUNCH";

/// The environment entry of a launch's token.
pub fn token_marker(token: &str) -> String {
    format!("{TOKEN_VARIABLE}={token}")
}

/// The argument that carries a launch's token into an app whose environment macOS hides: `-E2EDesktopLaunch=<token>`,
/// one entry, so no app reads the token as a file or a URL to open.
pub fn token_argument(token: &str) -> String {
    format!("-E2EDesktopLaunch={token}")
}

/// What `launch` was asked to start.
pub struct LaunchRequest {
    /// A `.app` bundle path, launched as it is.
    pub path: Option<String>,
    /// A bundle id or an app name, looked up among the installed apps.
    pub bundle_id: Option<String>,
    pub arguments: Vec<String>,
    /// The whole environment `open` runs with, which the app inherits.
    pub environment: Vec<(String, String)>,
    /// Marks the process the launch starts.
    pub token: String,
    pub activate: bool,
    /// The whole launch's budget: `open`, then the search for the process it started.
    pub timeout: Duration,
    /// How long the search for the process may take once `open` has exited, within `timeout`: a slow `open` (a cold
    /// start, Gatekeeper checking a new build) does not eat into it.
    pub claim: Duration,
    /// When the caller asked, which `timeout` counts from: the lookup and the signature check before `open` take time.
    pub asked: Instant,
    /// Names the launch, so `cancel_input` can stop it before `open` runs.
    pub input_id: Option<u32>,
}

/// The process a launch started.
#[derive(Serialize)]
pub struct Launched {
    pub pid: i32,
    pub app: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bundle_id: Option<String>,
    /// When the process started, in microseconds since the epoch, read as it was claimed: it tells the process from a
    /// later one the OS gives the same id.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub started: Option<f64>,
    /// The copies of the app that ran before the launch. An app that runs one copy at a time hands the launch to one
    /// of them and exits, which the caller can then say.
    pub running_before: Vec<i32>,
}

/// The folders an app named by its name is looked for in, in order.
fn app_folders() -> Vec<String> {
    let mut folders =
        vec!["/Applications".to_owned(), "/Applications/Utilities".to_owned(), "/System/Applications".to_owned(), "/System/Applications/Utilities".to_owned()];
    if let Ok(home) = std::env::var("HOME") {
        folders.push(format!("{home}/Applications"));
    }
    folders
}

/// The bundle of an installed app: by bundle id first, then by name in the usual folders, in any case, then by name
/// through LaunchServices.
fn installed(target: &str) -> Option<Retained<NSURL>> {
    let workspace = NSWorkspace::sharedWorkspace();
    if let Some(url) = workspace.URLForApplicationWithBundleIdentifier(&NSString::from_str(target)) {
        return Some(url);
    }
    let wanted = format!("{}.app", target.trim_end_matches(".app")).to_lowercase();
    for folder in app_folders() {
        let Ok(entries) = std::fs::read_dir(&folder) else { continue };
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_lowercase();
            if name == wanted {
                return Some(NSURL::fileURLWithPath(&NSString::from_str(&entry.path().to_string_lossy())));
            }
        }
    }
    // An app LaunchServices knows by name anywhere else, such as a build in a project's directory or a subfolder of
    // Applications. Deprecated for `URLForApplicationWithBundleIdentifier`, which takes no name.
    #[allow(deprecated)]
    let path = workspace.fullPathForApplication(&NSString::from_str(target))?;
    Some(NSURL::fileURLWithPath(&path))
}

/// The process ids of an app's copies running now.
pub fn running_copies(bundle_id: &str) -> Vec<i32> {
    NSRunningApplication::runningApplicationsWithBundleIdentifier(&NSString::from_str(bundle_id)).iter().map(|app| app.processIdentifier()).collect()
}

/// The bundle id of a bundle on disk.
fn bundle_id_of(url: &NSURL) -> Option<String> {
    let path = url.path()?.to_string();
    let plist = Path::new(&path).join("Contents/Info.plist");
    let dictionary: Option<Retained<NSDictionary<NSString, objc2::runtime::AnyObject>>> =
        unsafe { objc2::msg_send![objc2::class!(NSDictionary), dictionaryWithContentsOfFile: &*NSString::from_str(&plist.to_string_lossy())] };
    let value = dictionary?.objectForKey(&NSString::from_str("CFBundleIdentifier"))?;
    let string = value.downcast::<NSString>().ok()?;
    Some(string.to_string())
}

/// Whether macOS hides the environment of the bundle's process from other
/// processes, from its signature (`codesign -dvv`).
fn hides_environment(bundle: &str) -> bool {
    let output =
        Command::new("/usr/bin/codesign").arg("-dvv").arg(bundle).env_clear().stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::piped()).output();
    let Ok(output) = output else { return false };
    hidden_by(&String::from_utf8_lossy(&output.stderr))
}

/// Whether a signature, as `codesign -dvv` prints it, is one whose process
/// macOS hides the environment of: Apple's own apps (a platform identifier),
/// Apple's App Store apps (Numbers, Pages, Xcode: signed by Apple Mac OS
/// Application Signing, with no platform identifier), and builds signed with
/// the `restrict` flag. Every Mac App Store app carries that signature, so
/// each gets the token as an argument too, which the claim reads only when
/// the environment is hidden.
fn hidden_by(signature: &str) -> bool {
    signature.lines().any(|line| {
        line.starts_with("Platform identifier=")
            || line == "Authority=Apple Mac OS Application Signing"
            || (line.starts_with("CodeDirectory ") && line.contains("restrict"))
    })
}

/// Starts a new instance of the app with `open -n`, run with exactly the
/// environment given (LaunchServices hands the app the environment of the
/// process that asks), and finds the process it started: the new copy whose
/// environment carries the launch token. An app whose environment macOS
/// hides also gets the token as its last argument
/// (`-E2EDesktopLaunch=<token>`, which AppKit ignores), which stays readable. A copy
/// with neither is never taken: it may be one the user opened meanwhile.
pub fn launch(request: LaunchRequest) -> Outcome<Launched> {
    let started = request.asked;
    let run = crate::input::TypingRun::start(request.input_id);
    let url = match (&request.path, &request.bundle_id) {
        (Some(path), _) => {
            if !Path::new(path).join("Contents/Info.plist").exists() {
                return Err(Failure::refused(codes::APP_NOT_FOUND, format!("{path} is not an app bundle")));
            }
            NSURL::fileURLWithPath(&NSString::from_str(path))
        }
        (None, Some(target)) => {
            installed(target).ok_or_else(|| Failure::refused(codes::APP_NOT_FOUND, format!("no installed app has the name or bundle id \"{target}\"")))?
        }
        (None, None) => return Err(Failure::refused(codes::INVALID_ARGS, "a launch needs a bundle path or a bundle id")),
    };
    let bundle = url.path().map(|path| path.to_string()).ok_or_else(|| Failure::refused(codes::APP_NOT_FOUND, "the app has no path on disk"))?;
    let bundle_id = bundle_id_of(&url).ok_or_else(|| Failure::refused(codes::APP_NOT_FOUND, format!("{bundle} declares no CFBundleIdentifier")))?;
    let before = running_copies(&bundle_id);
    let token = request.token.clone();

    let mut command = Command::new("/usr/bin/open");
    command.env_clear().envs(request.environment.iter().map(|(name, value)| (name.as_str(), value.as_str())));
    command.arg("-n");
    if !request.activate {
        command.arg("-g");
    }
    command.arg("--env").arg(token_marker(&token));
    command.arg(&bundle).arg("--args").args(&request.arguments);
    if hides_environment(&bundle) {
        command.arg(token_argument(&token));
    }
    command.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::piped());
    // The lookup and `codesign` above can take a while: an app the caller gave up on is never started.
    if run.cancelled() || started.elapsed() >= request.timeout {
        return Err(Failure::refused(codes::TIMEOUT, format!("the launch of {bundle} was given up before open ran")));
    }
    let mut child = command.spawn().map_err(|error| Failure::refused(codes::INTERNAL, format!("could not run open: {error}")))?;
    loop {
        match child.try_wait() {
            Ok(Some(status)) if status.success() => break,
            Ok(Some(_)) => {
                let mut stderr = String::new();
                if let Some(mut pipe) = child.stderr.take() {
                    let _ = pipe.read_to_string(&mut stderr);
                }
                return Err(Failure::refused(codes::ACTION_FAILED, format!("open could not start {bundle}: {}", stderr.trim()))
                    .with_details(serde_json::json!({ "kind": "not_started" })));
            }
            Ok(None) if started.elapsed() >= request.timeout => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(Failure::unconfirmed(codes::TIMEOUT, format!("opening {bundle} did not finish in time")));
            }
            Ok(None) => sleep(Duration::from_millis(10)),
            Err(error) => return Err(Failure::unconfirmed(codes::INTERNAL, format!("open failed: {error}"))),
        }
    }

    let marker = token_marker(&token);
    let claim_until = (Instant::now() + request.claim).min(started + request.timeout);
    loop {
        let fresh: Vec<i32> = running_copies(&bundle_id).into_iter().filter(|pid| !before.contains(pid)).collect();
        for pid in &fresh {
            let ours = match crate::process::carries(*pid, &marker) {
                Some(carried) => carried,
                None => crate::process::holds_argument(*pid, &token_argument(&token)),
            };
            if ours {
                return Ok(launched(*pid, &bundle, &bundle_id, before));
            }
        }
        if Instant::now() >= claim_until {
            return Err(unclaimed(&bundle, &before));
        }
        sleep(Duration::from_millis(50));
    }
}

/// The failure of a launch none of whose new processes carries its token, with the copies that ran before it: the
/// caller reads them from `running_before` to say a running copy may have taken the launch.
fn unclaimed(bundle: &str, before: &[i32]) -> Failure {
    Failure::unconfirmed(codes::TIMEOUT, format!("{bundle} was opened, but no new process carries this launch's token"))
        .with_details(serde_json::json!({ "kind": "unclaimed", "running_before": before }))
}

fn launched(pid: i32, bundle: &str, bundle_id: &str, running_before: Vec<i32>) -> Launched {
    let name = NSRunningApplication::runningApplicationWithProcessIdentifier(pid).and_then(|app| app.localizedName()).map(|name| name.to_string());
    let app = name.unwrap_or_else(|| Path::new(bundle).file_stem().map(|stem| stem.to_string_lossy().into_owned()).unwrap_or_default());
    Launched { pid, app, bundle_id: Some(bundle_id.to_owned()), started: crate::process::started(pid).map(|started| started as f64), running_before }
}

#[cfg(test)]
mod tests {
    use super::{Launched, hidden_by, token_argument, unclaimed};

    #[test]
    fn names_the_copies_that_ran_before_the_launch() {
        let launched = |running_before| Launched { pid: 7, app: "Form".to_owned(), bundle_id: None, started: None, running_before };
        assert_eq!(serde_json::to_value(launched(vec![3, 5])).unwrap(), serde_json::json!({ "pid": 7, "app": "Form", "running_before": [3, 5] }));
        assert_eq!(serde_json::to_value(launched(vec![])).unwrap(), serde_json::json!({ "pid": 7, "app": "Form", "running_before": [] }));
    }

    #[test]
    fn names_the_copies_that_ran_before_an_unclaimed_launch() {
        let failure = unclaimed("Form.app", &[3, 5]);
        assert_eq!(failure.details, Some(serde_json::json!({ "kind": "unclaimed", "running_before": [3, 5] })));
        assert_eq!(unclaimed("Form.app", &[]).details, Some(serde_json::json!({ "kind": "unclaimed", "running_before": [] })));
    }

    #[test]
    fn spells_the_launch_token_as_one_argument() {
        assert_eq!(token_argument("8ff2bdfb-142f"), "-E2EDesktopLaunch=8ff2bdfb-142f");
    }

    #[test]
    fn tells_which_signatures_hide_the_environment() {
        // Calculator, Numbers (an Apple App Store app), a `restrict` build, and a third-party Developer ID app.
        assert!(hidden_by("Platform identifier=27\nAuthority=macOS Software Signing\n"));
        assert!(hidden_by(
            "CodeDirectory v=20500 size=1 flags=0x12000(library-validation,runtime) hashes=1\nAuthority=Apple Mac OS Application Signing\nTeamIdentifier=JCRTNEU7GK\n"
        ));
        assert!(hidden_by("CodeDirectory v=20400 size=1 flags=0x800(restrict) hashes=1\n"));
        assert!(!hidden_by("CodeDirectory v=20500 size=1 flags=0x10000(runtime) hashes=1\nAuthority=Developer ID Application: Slack Technologies\n"));
    }
}
