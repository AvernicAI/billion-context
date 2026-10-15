use std::io::{Read, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::time::Duration;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum NetError {
    Unreachable(String),
    Timeout,
    Io(String),
    HttpStatus(u16),
    Malformed,
}

impl NetError {
    pub fn detail(&self) -> String {
        match self {
            NetError::Unreachable(_) => "unreachable".into(),
            NetError::Timeout => "timed out".into(),
            NetError::Io(_) => "connection error".into(),
            NetError::HttpStatus(code) => format!("http {code}"),
            NetError::Malformed => "bad response".into(),
        }
    }
}

impl std::fmt::Display for NetError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.detail())
    }
}

pub fn split_base(base: &str) -> Result<(String, u16), NetError> {
    let rest = base.strip_prefix("http://").ok_or(NetError::Malformed)?;
    let rest = rest.trim_end_matches('/');
    let mut parts = rest.rsplitn(2, ':');
    let port = parts
        .next()
        .and_then(|p| p.parse::<u16>().ok())
        .filter(|p| *p >= 1)
        .ok_or(NetError::Malformed)?;
    let host = parts.next().ok_or(NetError::Malformed)?;
    if host.is_empty() {
        return Err(NetError::Malformed);
    }
    Ok((host.to_string(), port))
}

/// Minimal HTTP/1.1 GET over a direct TCP connection. No TLS, no proxy env
/// handling on purpose: the only caller is 127.0.0.1, and honoring
/// HTTP_PROXY here would break exactly the users who run proxies globally.
fn map_io(e: std::io::Error) -> NetError {
    // Deadline expiry surfaces as ErrorKind::TimedOut on some platforms
    // and as raw EAGAIN (os error 11; WSAEWOULDBLOCK 10035 on Windows) on
    // others — and the mapping has been observed to vary between runs of
    // the same binary. This crate never enables non-blocking mode itself,
    // so any EAGAIN here can only be our own read/write deadline expiring.
    if e.kind() == std::io::ErrorKind::TimedOut
        || e.kind() == std::io::ErrorKind::WouldBlock
        || matches!(e.raw_os_error(), Some(11) | Some(10035))
    {
        NetError::Timeout
    } else {
        NetError::Io(e.to_string())
    }
}

pub fn get(base: &str, path: &str, timeout: Duration) -> Result<Vec<u8>, NetError> {
    let (host, port) = split_base(base)?;
    let addr_str = format!("{host}:{port}");
    let first = addr_str
        .to_socket_addrs()
        .map_err(|e| NetError::Unreachable(e.to_string()))?
        .next()
        .ok_or_else(|| NetError::Unreachable(addr_str.clone()))?;
    let mut stream = TcpStream::connect_timeout(&first, timeout)
        .map_err(|_| NetError::Unreachable(addr_str.clone()))?;
    stream
        .set_read_timeout(Some(timeout))
        .and(stream.set_write_timeout(Some(timeout)))
        .map_err(|e| NetError::Io(e.to_string()))?;

    let request = format!(
        "GET {path} HTTP/1.1\r\nHost: {addr_str}\r\nConnection: close\r\nAccept: application/json\r\nUser-Agent: bili-tray/{}\r\n\r\n",
        env!("CARGO_PKG_VERSION")
    );
    stream.write_all(request.as_bytes()).map_err(map_io)?;

    let mut raw = Vec::new();
    stream.read_to_end(&mut raw).map_err(map_io)?;

    let text = String::from_utf8_lossy(&raw);
    let (head, body) = text.split_once("\r\n\r\n").ok_or(NetError::Malformed)?;
    let code = head
        .lines()
        .next()
        .and_then(|l| l.split_whitespace().nth(1))
        .and_then(|c| c.parse::<u16>().ok())
        .ok_or(NetError::Malformed)?;
    if code != 200 {
        return Err(NetError::HttpStatus(code));
    }
    Ok(body.as_bytes().to_vec())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn split_base_parses_host_and_port() {
        assert_eq!(
            split_base("http://127.0.0.1:8787"),
            Ok(("127.0.0.1".into(), 8787))
        );
        assert_eq!(
            split_base("http://localhost:9000/"),
            Ok(("localhost".into(), 9000))
        );
        assert!(matches!(
            split_base("https://127.0.0.1:8787"),
            Err(NetError::Malformed)
        ));
        assert!(matches!(
            split_base("http://127.0.0.1:"),
            Err(NetError::Malformed)
        ));
        assert!(matches!(
            split_base("http://:8787"),
            Err(NetError::Malformed)
        ));
    }
}
