use serde::Deserialize;
use std::{
    net::{IpAddr, SocketAddr},
    sync::Arc,
    time::Duration,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpStream, UnixListener, UnixStream},
    sync::watch,
};

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TestTarget {
    pub hostname: String,
    pub port: u16,
    pub https_port: Option<u16>,
}
impl TestTarget {
    pub fn valid(&self) -> bool {
        self.hostname.ends_with(".test")
            && self
                .hostname
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b".-".contains(&b))
            && self.port > 0
            && self.https_port.is_none_or(|p| p > 0)
    }
}
pub fn denied(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v) => {
            let n = u32::from(v);
            [
                (0, 8),
                (0x0a000000, 8),
                (0x64400000, 10),
                (0x7f000000, 8),
                (0xa9fe0000, 16),
                (0xac100000, 12),
                (0xc0a80000, 16),
                (0xe0000000, 4),
                (0xf0000000, 4),
            ]
            .iter()
            .any(|(base, bits)| n >> (32 - bits) == base >> (32 - bits))
        }
        IpAddr::V6(v) => {
            if let Some(ip) = v.to_ipv4_mapped() {
                return denied(IpAddr::V4(ip));
            }
            let n = u128::from(v);
            v.is_unspecified()
                || v.is_loopback()
                || n >> 121 == 0x7e
                || n >> 118 == 0x3fa
                || n >> 120 == 0xff
        }
    }
}
fn denied_host(host: &str) -> bool {
    let h = host.trim_end_matches('.').to_ascii_lowercase();
    h == "localhost"
        || h == "local"
        || h.ends_with(".local")
        || h == "ts.net"
        || h.ends_with(".ts.net")
}
async fn target(host: &str, port: u16, fixture: Option<&TestTarget>) -> Option<SocketAddr> {
    if let Some(t) = fixture {
        if host == t.hostname && (port == t.port || Some(port) == t.https_port) {
            return Some(SocketAddr::from(([127, 0, 0, 1], port)));
        }
    }
    if denied_host(host) || ![80, 443].contains(&port) {
        return None;
    }
    let addresses = tokio::time::timeout(
        Duration::from_secs(5),
        tokio::net::lookup_host((host, port)),
    )
    .await
    .ok()?
    .ok()?
    .collect::<Vec<_>>();
    if addresses.is_empty() || addresses.iter().any(|a| denied(a.ip())) {
        return None;
    }
    addresses.first().copied()
}
pub fn serve(
    listener: UnixListener,
    fixture: Option<TestTarget>,
    mut stop: watch::Receiver<bool>,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let fixture = Arc::new(fixture);
        loop {
            tokio::select! {_=stop.changed()=>break,accepted=listener.accept()=>{let Ok((socket,_))=accepted else{break;};let fixture=fixture.clone();let mut stopped=stop.clone();tokio::spawn(async move{tokio::select!{_=stopped.changed()=>{},_=handle(socket,fixture.as_ref().as_ref())=>{}}});}}
        }
    })
}
async fn handle(mut client: UnixStream, fixture: Option<&TestTarget>) -> std::io::Result<()> {
    let operation = async {
        let mut bytes = Vec::new();
        let mut byte = [0];
        while !bytes.ends_with(b"\r\n\r\n") {
            if bytes.len() >= 16384 {
                return Err(std::io::ErrorKind::InvalidData.into());
            }
            client.read_exact(&mut byte).await?;
            bytes.push(byte[0]);
        }
        let header = String::from_utf8_lossy(&bytes);
        let mut lines = header.split("\r\n");
        let first = lines
            .next()
            .unwrap_or("")
            .split_whitespace()
            .collect::<Vec<_>>();
        if first.len() != 3 {
            return Err(std::io::ErrorKind::InvalidData.into());
        }
        let connect = first[0] == "CONNECT";
        let url = if connect {
            url::Url::parse(&format!("https://{}/", first[1]))
        } else {
            url::Url::parse(first[1])
        };
        let (url, address) = if let Ok(url) = url {
            let host = url.host_str().unwrap_or("").trim_matches(['[', ']']);
            let port = url.port_or_known_default().unwrap_or(0);
            let addr = if url.username().is_empty()
                && url.password().is_none()
                && (connect && url.scheme() == "https" || !connect && url.scheme() == "http")
            {
                target(host, port, fixture).await
            } else {
                None
            };
            (Some(url), addr)
        } else {
            (None, None)
        };
        let (Some(url), Some(address)) = (url, address) else {
            client.write_all(b"HTTP/1.1 403 Forbidden\r\nContent-Length: 20\r\nConnection: close\r\n\r\nProxy request denied").await?;
            return Ok(());
        };
        let mut upstream = TcpStream::connect(address).await?;
        if connect {
            client
                .write_all(b"HTTP/1.1 200 Connection Established\r\n\r\n")
                .await?;
        } else {
            let mut head = format!(
                "{} {}{} HTTP/1.1\r\n",
                first[0],
                url.path(),
                url.query().map(|v| format!("?{v}")).unwrap_or_default()
            );
            let connections = lines
                .clone()
                .filter_map(|l| l.split_once(':'))
                .find(|(k, _)| k.eq_ignore_ascii_case("connection"))
                .map(|(_, v)| {
                    v.split(',')
                        .map(|s| s.trim().to_ascii_lowercase())
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            for line in lines {
                if let Some((name, _)) = line.split_once(':') {
                    let name = name.to_ascii_lowercase();
                    if ![
                        "host",
                        "connection",
                        "proxy-connection",
                        "proxy-authorization",
                        "proxy-authenticate",
                        "keep-alive",
                        "upgrade",
                        "te",
                        "trailer",
                        "transfer-encoding",
                    ]
                    .contains(&name.as_str())
                        && !connections.contains(&name)
                    {
                        head.push_str(line);
                        head.push_str("\r\n");
                    }
                }
            }
            let host = url.host_str().unwrap_or("");
            head.push_str(&format!(
                "Host: {host}{}\r\nConnection: close\r\n\r\n",
                url.port().map(|p| format!(":{p}")).unwrap_or_default()
            ));
            upstream.write_all(head.as_bytes()).await?;
        }
        tokio::io::copy_bidirectional(&mut client, &mut upstream).await?;
        Ok(())
    };
    tokio::time::timeout(Duration::from_secs(120), operation)
        .await
        .unwrap_or_else(|_| Err(std::io::ErrorKind::TimedOut.into()))
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn private_ranges_and_mapped_forms() {
        for ip in [
            "0.1.2.3",
            "10.0.0.1",
            "100.64.0.1",
            "127.0.0.1",
            "169.254.1.1",
            "172.16.1.1",
            "192.168.1.1",
            "224.0.0.1",
            "240.0.0.1",
            "::",
            "::1",
            "fc00::1",
            "fe80::1",
            "ff00::1",
            "::ffff:127.0.0.1",
        ] {
            assert!(ip.parse().is_ok_and(denied), "{ip}");
        }
        for ip in [
            "1.1.1.1",
            "100.63.255.255",
            "172.15.255.255",
            "2606:4700:4700::1111",
        ] {
            assert!(ip.parse().is_ok_and(|v| !denied(v)), "{ip}");
        }
    }
}
