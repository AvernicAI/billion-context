use crate::{SessionStats, TrayState, MAX_SESSION_LINES};

pub fn fmt_tokens(n: u64) -> String {
    if n < 1_000 {
        return n.to_string();
    }
    let (mut value, mut unit) = if n < 1_000_000 {
        (n as f64 / 1_000.0, "K")
    } else {
        (n as f64 / 1_000_000.0, "M")
    };
    if value >= 999.95 {
        value /= 1_000.0;
        unit = "M";
    }
    let rounded = value.round();
    if rounded >= 100.0 || value.fract() < 0.05 {
        format!("{rounded:.0}{unit}")
    } else {
        format!("{value:.1}{unit}")
    }
}

fn session_name(s: &SessionStats) -> String {
    if let Some(t) = s.title.as_deref().filter(|t| !t.is_empty()) {
        return t.to_string();
    }
    if let Some(l) = s.label.as_deref().filter(|l| !l.is_empty()) {
        return l.to_string();
    }
    let short: String = s.id.chars().take(16).collect();
    if s.id.len() > 16 {
        format!("{short}…")
    } else {
        short
    }
}

fn cache_pct(s: &SessionStats) -> Option<u64> {
    if s.cache_samples > 0 && s.input_tokens > 0 {
        Some((s.cached_tokens * 100 / s.input_tokens).min(100))
    } else {
        None
    }
}

fn pressure(s: &SessionStats) -> Option<f64> {
    s.context_window
        .filter(|w| *w > 0)
        .map(|w| s.context_tokens as f64 / w as f64)
}

pub fn session_line(s: &SessionStats) -> String {
    let mut line = format!("{} · ctx {}", session_name(s), fmt_tokens(s.context_tokens));
    if let Some(w) = s.context_window.filter(|w| *w > 0) {
        line.push_str(&format!("/{}", fmt_tokens(w)));
    }
    if let Some(pct) = cache_pct(s) {
        line.push_str(&format!(" · cache {pct}%"));
    }
    if pressure(s).is_some_and(|p| p >= 0.85) {
        line.push_str(" · ⚠ near limit");
    }
    line
}

/// Sessions ordered by context pressure (descending; windowless last by tokens).
pub fn sorted_sessions(stats: &[SessionStats]) -> Vec<&SessionStats> {
    let mut v: Vec<&SessionStats> = stats.iter().collect();
    v.sort_by(|a, b| {
        let pa = pressure(a);
        let pb = pressure(b);
        match (pa, pb) {
            (Some(x), Some(y)) => y.partial_cmp(&x).unwrap_or(std::cmp::Ordering::Equal),
            (Some(_), None) => std::cmp::Ordering::Less,
            (None, Some(_)) => std::cmp::Ordering::Greater,
            (None, None) => b.context_tokens.cmp(&a.context_tokens),
        }
    });
    v
}

#[derive(Debug, Clone, PartialEq)]
pub struct Line {
    pub id: String,
    pub text: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct MenuModel {
    pub header: Line,
    pub sessions: Vec<Line>,
    pub more: Option<Line>,
    pub port_info: Line,
}

fn header_text(state: &TrayState) -> String {
    match state {
        TrayState::Offline { .. } => "billion-context: offline".into(),
        TrayState::Online { status, .. } => {
            let mut t = format!("billion-context v{}", status.version);
            if status.stale {
                let disk = status.disk_version.as_deref().unwrap_or("newer");
                t.push_str(&format!(" · restart pending (disk v{disk})"));
            }
            if let Some(reason) = &status.advisory_reason {
                let short: String = reason.chars().take(60).collect();
                t.push_str(&format!(" · advisory: {short}"));
            }
            t
        }
    }
}

pub fn tooltip(state: &TrayState, port: u16) -> String {
    match state {
        TrayState::Offline { detail } => {
            format!("bili offline — 127.0.0.1:{port}: {detail}")
        }
        TrayState::Online { status, stats } => {
            let mut t = format!("bili v{}", status.version);
            if stats.sessions.is_empty() {
                t.push_str(" — idle");
                return t;
            }
            let n = stats.sessions.len();
            t.push_str(&format!(" — {n} session{}", if n == 1 { "" } else { "s" }));
            let sessions = sorted_sessions(&stats.sessions);
            match sessions
                .first()
                .and_then(|s| s.context_window.filter(|w| *w > 0))
            {
                Some(w) => {
                    let top = sessions.first().expect("checked above");
                    t.push_str(&format!(
                        " · peak ctx {}/{}",
                        fmt_tokens(top.context_tokens),
                        fmt_tokens(w)
                    ));
                }
                None => {
                    let total: u64 = stats.sessions.iter().map(|s| s.context_tokens).sum();
                    t.push_str(&format!(" · Σ ctx {}", fmt_tokens(total)));
                }
            }
            let cached: u64 = stats
                .sessions
                .iter()
                .filter(|s| s.cache_samples > 0 && s.input_tokens > 0)
                .map(|s| s.cached_tokens)
                .sum();
            let input: u64 = stats
                .sessions
                .iter()
                .filter(|s| s.cache_samples > 0 && s.input_tokens > 0)
                .map(|s| s.input_tokens)
                .sum();
            let pct = cached.checked_mul(100).and_then(|c| c.checked_div(input));
            if let Some(pct) = pct {
                t.push_str(&format!(" · cache {}%", pct.min(100)));
            }
            t
        }
    }
}

pub fn menu_model(state: &TrayState, port: u16) -> MenuModel {
    let header = Line {
        id: "header".into(),
        text: header_text(state),
    };
    let mut sessions = Vec::new();
    let mut more = None;
    if let TrayState::Online { stats, .. } = state {
        let ordered = sorted_sessions(&stats.sessions);
        for (i, s) in ordered.iter().take(MAX_SESSION_LINES).enumerate() {
            sessions.push(Line {
                id: format!("s{i}"),
                text: session_line(s),
            });
        }
        if ordered.len() > MAX_SESSION_LINES {
            more = Some(Line {
                id: "more".into(),
                text: format!(
                    "…and {} more in the dashboard",
                    ordered.len() - MAX_SESSION_LINES
                ),
            });
        }
    }
    let port_info = match state {
        TrayState::Offline { .. } => Line {
            id: "port-info".into(),
            text: format!("port {port} — waiting for bili"),
        },
        TrayState::Online { .. } => Line {
            id: "port-info".into(),
            text: format!("port {port}"),
        },
    };
    MenuModel {
        header,
        sessions,
        more,
        port_info,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{BiliStats, BiliStatus};

    fn sess(
        id: &str,
        ctx: u64,
        win: Option<u64>,
        input: u64,
        cached: u64,
        samples: u64,
    ) -> SessionStats {
        SessionStats {
            id: id.into(),
            label: None,
            title: None,
            context_tokens: ctx,
            context_window: win,
            input_tokens: input,
            cached_tokens: cached,
            cache_samples: samples,
        }
    }

    #[test]
    fn token_format_table() {
        assert_eq!(fmt_tokens(0), "0");
        assert_eq!(fmt_tokens(999), "999");
        assert_eq!(fmt_tokens(1_500), "1.5K");
        assert_eq!(fmt_tokens(12_345), "12.3K");
        assert_eq!(fmt_tokens(412_000), "412K");
        assert_eq!(fmt_tokens(1_200_000), "1.2M");
        assert_eq!(fmt_tokens(2_000_000), "2M");
    }

    #[test]
    fn session_line_full() {
        let s = sess("ses_abcd", 412_000, Some(200_000), 1_000_000, 960_000, 10);
        assert_eq!(
            session_line(&s),
            "ses_abcd · ctx 412K/200K · cache 96% · ⚠ near limit"
        );
    }

    #[test]
    fn session_line_bare() {
        let s = sess("ses_x", 832, None, 0, 0, 0);
        assert_eq!(session_line(&s), "ses_x · ctx 832");
    }

    #[test]
    fn name_prefers_title_over_label_over_id() {
        let mut s = sess("very-long-session-id-1234567890", 100, None, 0, 0, 0);
        assert_eq!(session_line(&s), "very-long-sessio… · ctx 100");
        s.label = Some("pi".into());
        assert_eq!(session_line(&s), "pi · ctx 100");
        s.title = Some("Claude Code".into());
        assert_eq!(session_line(&s), "Claude Code · ctx 100");
    }

    #[test]
    fn token_format_rounds_up_at_boundary() {
        assert_eq!(fmt_tokens(99_960), "100K");
        assert_eq!(fmt_tokens(999_950_000), "1.0M");
    }

    #[test]
    fn offline_tooltip_and_menu() {
        let st = TrayState::Offline {
            detail: "unreachable".into(),
        };
        assert_eq!(
            tooltip(&st, 8787),
            "bili offline — 127.0.0.1:8787: unreachable"
        );
        let m = menu_model(&st, 8787);
        assert_eq!(m.header.text, "billion-context: offline");
        assert!(m.sessions.is_empty());
        assert_eq!(m.port_info.text, "port 8787 — waiting for bili");
    }

    #[test]
    fn idle_tooltip() {
        let st = TrayState::Online {
            status: BiliStatus {
                version: "0.1.197".into(),
                disk_version: None,
                stale: false,
                advisory_reason: None,
            },
            stats: BiliStats::default(),
        };
        assert_eq!(tooltip(&st, 8787), "bili v0.1.197 — idle");
    }

    #[test]
    fn online_tooltip_peak_and_cache() {
        let st = TrayState::Online {
            status: BiliStatus {
                version: "0.1.197".into(),
                disk_version: None,
                stale: false,
                advisory_reason: None,
            },
            stats: BiliStats {
                sessions: vec![
                    sess("a", 100_000, Some(200_000), 1_000, 900, 5),
                    sess("b", 190_000, Some(200_000), 1_000, 950, 5),
                    sess("c", 50_000, None, 1_000, 990, 5),
                ],
            },
        };
        assert_eq!(
            tooltip(&st, 8787),
            "bili v0.1.197 — 3 sessions · peak ctx 190K/200K · cache 94%"
        );
        let m = menu_model(&st, 8787);
        assert_eq!(
            m.sessions[0].text,
            "b · ctx 190K/200K · cache 95% · ⚠ near limit"
        );
        assert_eq!(m.sessions[1].text, "a · ctx 100K/200K · cache 90%");
        assert_eq!(m.sessions[2].text, "c · ctx 50K · cache 99%");
    }

    #[test]
    fn stale_header_shows_disk_version() {
        let st = TrayState::Online {
            status: BiliStatus {
                version: "0.1.197".into(),
                disk_version: Some("0.1.198".into()),
                stale: true,
                advisory_reason: None,
            },
            stats: BiliStats::default(),
        };
        assert_eq!(
            header_text(&st),
            "billion-context v0.1.197 · restart pending (disk v0.1.198)"
        );
    }

    #[test]
    fn overflow_collapses_into_more_line() {
        let mut sessions = Vec::new();
        for i in 0..11 {
            sessions.push(sess(
                &format!("sess-{i:02}"),
                (i as u64) * 1000,
                None,
                0,
                0,
                0,
            ));
        }
        let st = TrayState::Online {
            status: BiliStatus {
                version: "v".into(),
                disk_version: None,
                stale: false,
                advisory_reason: None,
            },
            stats: BiliStats { sessions },
        };
        let m = menu_model(&st, 8787);
        assert_eq!(m.sessions.len(), MAX_SESSION_LINES);
        assert_eq!(
            m.more.as_ref().unwrap().text,
            "…and 3 more in the dashboard"
        );
    }
}
