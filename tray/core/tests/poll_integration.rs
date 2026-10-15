//! End-to-end polling against a real loopback HTTP listener: canned
//! `/__bili/status` + `/__bili/stats` responses, plus offline/error paths.

use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};

struct Canned {
    path: &'static str,
    status_code: u16,
    body: String,
}

fn start_mock(canned: Vec<Canned>) -> (u16, Arc<AtomicBool>) {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind ephemeral port");
    let port = listener.local_addr().unwrap().port();
    let running = Arc::new(AtomicBool::new(true));
    let r = running.clone();
    thread::spawn(move || {
        for stream in listener.incoming() {
            if !r.load(Ordering::Relaxed) {
                break;
            }
            handle_conn(stream.ok(), &canned);
        }
    });
    (port, running)
}

fn handle_conn(stream: Option<TcpStream>, canned: &[Canned]) {
    let mut stream = match stream {
        Some(s) => s,
        None => return,
    };
    let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
    let mut buf = Vec::new();
    let mut chunk = [0u8; 1024];
    // Read until the request head is complete.
    while !buf.windows(4).any(|w| w == b"\r\n\r\n") {
        match stream.read(&mut chunk) {
            Ok(0) => return,
            Ok(n) => buf.extend_from_slice(&chunk[..n]),
            Err(_) => return,
        }
    }
    let head = String::from_utf8_lossy(&buf);
    let path = head
        .lines()
        .next()
        .and_then(|l| l.split_whitespace().nth(1))
        .unwrap_or("");
    let entry = canned.iter().find(|c| c.path == path);
    let (code, body) = match entry {
        Some(e) => (e.status_code, e.body.clone()),
        None => (404, "{}".into()),
    };
    let resp = format!(
        "HTTP/1.1 {code} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    let _ = stream.write_all(resp.as_bytes());
    let _ = stream.flush();
}

const STATUS_OK: &str =
    r#"{"version":"0.1.197","diskVersion":"0.1.198","stale":false,"inFlight":0}"#;
const STATS_OK: &str = r#"{
  "sessions": [
    {"id":"ses_abc","title":"Claude Code","label":"claude","contextTokens":190000,"contextWindow":200000,"inputTokens":1000000,"cachedTokens":950000,"cacheSamples":7},
    {"id":"ses_def","contextTokens":55000,"inputTokens":0,"cachedTokens":0,"cacheSamples":0}
  ],
  "blindTunnels": {}, "unrecognizedPaths": {}, "conflicts": []
}"#;

#[test]
fn online_round_trip_parses_both_endpoints() {
    let (port, running) = start_mock(vec![
        Canned {
            path: "/__bili/status",
            status_code: 200,
            body: STATUS_OK.into(),
        },
        Canned {
            path: "/__bili/stats",
            status_code: 200,
            body: STATS_OK.into(),
        },
    ]);
    let cfg = bili_tray_core::config::Config {
        port,
        poll_ms: 5000,
        timeout_ms: 2000,
    };
    let state = bili_tray_core::stats::poll_once(&cfg);
    match state {
        bili_tray_core::TrayState::Online { status, stats } => {
            assert_eq!(status.version, "0.1.197");
            assert!(!status.stale);
            assert_eq!(stats.sessions.len(), 2);
            assert_eq!(stats.sessions[0].title.as_deref(), Some("Claude Code"));
            assert_eq!(stats.sessions[0].context_window, Some(200_000));
            assert_eq!(stats.sessions[1].id, "ses_def");
        }
        other => panic!("expected Online, got {other:?}"),
    }
    let tip = bili_tray_core::format::tooltip(&bili_tray_core::stats::poll_once(&cfg), port);
    assert!(tip.starts_with("bili v0.1.197 — 2 sessions"), "{tip}");
    running.store(false, Ordering::Relaxed);
}

#[test]
fn closed_port_is_offline_unreachable() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    drop(listener);
    let cfg = bili_tray_core::config::Config {
        port,
        poll_ms: 5000,
        timeout_ms: 500,
    };
    let t0 = Instant::now();
    let state = bili_tray_core::stats::poll_once(&cfg);
    assert!(t0.elapsed() < Duration::from_secs(2));
    match state {
        bili_tray_core::TrayState::Offline { detail } => assert_eq!(detail, "unreachable"),
        other => panic!("expected Offline, got {other:?}"),
    }
}

#[test]
fn http_error_surfaces_as_offline() {
    let (port, running) = start_mock(vec![Canned {
        path: "/__bili/status",
        status_code: 500,
        body: "boom".into(),
    }]);
    let cfg = bili_tray_core::config::Config {
        port,
        poll_ms: 5000,
        timeout_ms: 2000,
    };
    match bili_tray_core::stats::poll_once(&cfg) {
        bili_tray_core::TrayState::Offline { detail } => assert_eq!(detail, "http 500"),
        other => panic!("expected Offline, got {other:?}"),
    }
    running.store(false, Ordering::Relaxed);
}

#[test]
fn non_json_status_is_offline_bad_json() {
    let (port, running) = start_mock(vec![Canned {
        path: "/__bili/status",
        status_code: 200,
        body: "<html>not json</html>".into(),
    }]);
    let cfg = bili_tray_core::config::Config {
        port,
        poll_ms: 5000,
        timeout_ms: 2000,
    };
    match bili_tray_core::stats::poll_once(&cfg) {
        bili_tray_core::TrayState::Offline { detail } => assert_eq!(detail, "bad json"),
        other => panic!("expected Offline, got {other:?}"),
    }
    running.store(false, Ordering::Relaxed);
}

#[test]
fn unresponsive_server_times_out() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let running = Arc::new(AtomicBool::new(true));
    let r = running.clone();
    thread::spawn(move || {
        if let Ok(_held) = listener.accept() {
            // Accept but never answer until the client gives up.
            thread::sleep(Duration::from_millis(1500));
        }
        let _ = r;
    });
    let cfg = bili_tray_core::config::Config {
        port,
        poll_ms: 5000,
        timeout_ms: 300,
    };
    let t0 = Instant::now();
    let state = bili_tray_core::stats::poll_once(&cfg);
    let elapsed = t0.elapsed();
    assert!(elapsed < Duration::from_millis(1400), "took {elapsed:?}");
    match state {
        bili_tray_core::TrayState::Offline { detail } => assert_eq!(detail, "timed out"),
        other => panic!("expected Offline, got {other:?}"),
    }
    running.store(false, Ordering::Relaxed);
}
