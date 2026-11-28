//! Processes: whether one runs, when it started (which tells it from a
//! later process the OS gives the same id), and whether its environment
//! carries a launch token. macOS hides the environment of its own apps and
//! of builds signed with the `restrict` flag: that answers `None`, no
//! evidence either way. Their arguments stay readable.

/// Whether a process with this id exists, this user's or another's.
pub fn alive(pid: i32) -> bool {
    if pid <= 0 {
        return false;
    }
    let result = unsafe { libc::kill(pid, 0) };
    result == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

/// When a process started, in microseconds since the epoch; `None` when it is not running.
pub fn started(pid: i32) -> Option<u64> {
    if pid <= 0 {
        return None;
    }
    let mut info: libc::proc_bsdinfo = unsafe { std::mem::zeroed() };
    let size = std::mem::size_of::<libc::proc_bsdinfo>() as i32;
    let read = unsafe { libc::proc_pidinfo(pid, libc::PROC_PIDTBSDINFO, 0, &mut info as *mut _ as *mut libc::c_void, size) };
    if read != size {
        return None;
    }
    Some(info.pbi_start_tvsec * 1_000_000 + info.pbi_start_tvusec)
}

/// A process's arguments (after the executable path) and its environment; the environment is `None` when macOS hides it,
/// and the whole answer `None` when the process cannot be read.
fn procargs(pid: i32) -> Option<(Vec<String>, Option<Vec<String>>)> {
    let mut mib = [libc::CTL_KERN, libc::KERN_PROCARGS2, pid];
    let mut size: libc::size_t = 0;
    if unsafe { libc::sysctl(mib.as_mut_ptr(), 3, std::ptr::null_mut(), &mut size, std::ptr::null_mut(), 0) } != 0 || size < 4 {
        return None;
    }
    let mut buffer = vec![0u8; size];
    if unsafe { libc::sysctl(mib.as_mut_ptr(), 3, buffer.as_mut_ptr() as *mut libc::c_void, &mut size, std::ptr::null_mut(), 0) } != 0 {
        return None;
    }
    buffer.truncate(size);
    parse_procargs(&buffer)
}

/// Reads a `KERN_PROCARGS2` buffer: `argc`, the executable path, the NUL padding after it, exactly `argc` argument
/// strings (an empty argument included), then the environment up to the first empty string.
fn parse_procargs(buffer: &[u8]) -> Option<(Vec<String>, Option<Vec<String>>)> {
    let argc = i32::from_ne_bytes(buffer.get(0..4)?.try_into().ok()?).max(0) as usize;
    let mut at = 4;
    // The executable path, then its padding.
    at += buffer.get(at..)?.iter().position(|byte| *byte == 0)?;
    while buffer.get(at) == Some(&0) {
        at += 1;
    }
    let mut next = || -> Option<String> {
        let rest = buffer.get(at..).filter(|rest| !rest.is_empty())?;
        let length = rest.iter().position(|byte| *byte == 0).unwrap_or(rest.len());
        at += length + 1;
        Some(String::from_utf8_lossy(&rest[..length]).into_owned())
    };
    let mut argv = Vec::with_capacity(argc);
    for _ in 0..argc {
        argv.push(next()?);
    }
    let mut environment = Vec::new();
    while let Some(entry) = next().filter(|entry| !entry.is_empty()) {
        environment.push(entry);
    }
    // argv[0] names the program again.
    let arguments = argv.into_iter().skip(1).collect();
    // A restricted process shows its arguments alone: no variable a real environment always has.
    // The launch token is in it, or a variable a real environment always has: a helper the app started with a pared-down
    // environment that kept the token still shows it.
    let token = format!("{}=", crate::launch::TOKEN_VARIABLE);
    let shown =
        environment.iter().any(|entry| entry.starts_with("HOME=") || entry.starts_with("PATH=") || entry.starts_with("USER=") || entry.starts_with(&token));
    Some((arguments, shown.then_some(environment)))
}

/// A process's environment, `None` when it cannot be read.
fn environment(pid: i32) -> Option<Vec<String>> {
    procargs(pid)?.1
}

/// Whether one of a process's arguments is `argument`, whole.
pub fn holds_argument(pid: i32, argument: &str) -> bool {
    procargs(pid).is_some_and(|(arguments, _)| arguments.iter().any(|entry| entry == argument))
}

/// Whether a process's environment holds `marker` (`NAME=value`); `None` when it cannot be read.
pub fn carries(pid: i32, marker: &str) -> Option<bool> {
    environment(pid).map(|entries| entries.iter().any(|entry| entry == marker))
}

/// Every process of this user that carries the launch `token`, in its environment or, where macOS hides that, in its
/// arguments; `None` when the processes cannot be listed.
pub fn carrying(token: &str) -> Option<Vec<i32>> {
    let count = unsafe { libc::proc_listallpids(std::ptr::null_mut(), 0) };
    if count <= 0 {
        return None;
    }
    let mut pids = vec![0i32; count as usize + 64];
    let filled = unsafe { libc::proc_listallpids(pids.as_mut_ptr() as *mut libc::c_void, (pids.len() * std::mem::size_of::<i32>()) as i32) };
    if filled <= 0 {
        return None;
    }
    pids.truncate(filled as usize);
    let own = std::process::id() as i32;
    let marker = crate::launch::token_marker(token);
    let argument = crate::launch::token_argument(token);
    let holds = |pid: i32| match carries(pid, &marker) {
        Some(carried) => carried,
        None => holds_argument(pid, &argument),
    };
    Some(pids.into_iter().filter(|pid| *pid > 0 && *pid != own && holds(*pid)).collect())
}

#[cfg(test)]
mod tests {
    use super::parse_procargs;

    /// A `KERN_PROCARGS2` buffer as the kernel lays it out.
    fn buffer(path: &str, argv: &[&str], environment: &[&str]) -> Vec<u8> {
        let mut out = (argv.len() as i32).to_ne_bytes().to_vec();
        out.extend_from_slice(path.as_bytes());
        out.extend_from_slice(&[0, 0, 0, 0]);
        for entry in argv.iter().chain(environment) {
            out.extend_from_slice(entry.as_bytes());
            out.push(0);
        }
        out.extend_from_slice(&[0, 0]);
        out
    }

    #[test]
    fn keeps_an_empty_argument_and_the_environment_after_it() {
        let parsed = parse_procargs(&buffer("/bin/app", &["/bin/app", "-Greeting", "", "x"], &["E2E_DESKTOP_LAUNCH=tok", "HOME=/u"]));
        let (arguments, environment) = parsed.unwrap();
        assert_eq!(arguments, ["-Greeting", "", "x"]);
        assert_eq!(environment.unwrap(), ["E2E_DESKTOP_LAUNCH=tok", "HOME=/u"]);
    }

    #[test]
    fn reads_a_hidden_environment_as_none_and_keeps_the_arguments() {
        let (arguments, environment) = parse_procargs(&buffer("/System/App", &["/System/App", "-E2EDesktopLaunch=tok"], &[])).unwrap();
        assert_eq!(arguments, ["-E2EDesktopLaunch=tok"]);
        assert!(environment.is_none());
    }

    #[test]
    fn reads_an_environment_that_holds_only_the_launch_token() {
        let (_, environment) = parse_procargs(&buffer("/bin/helper", &["/bin/helper"], &["E2E_DESKTOP_LAUNCH=tok"])).unwrap();
        assert_eq!(environment.unwrap(), ["E2E_DESKTOP_LAUNCH=tok"]);
    }

    #[test]
    fn refuses_a_buffer_cut_short() {
        assert!(parse_procargs(&[1, 0]).is_none());
        let mut cut = buffer("/bin/app", &["/bin/app", "a", "b"], &[]);
        cut.truncate(14);
        assert!(parse_procargs(&cut).is_none());
    }
}
