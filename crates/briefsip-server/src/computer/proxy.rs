use serde::Deserialize;
use std::{
    net::{IpAddr, SocketAddr},
    sync::Arc,
    time::Duration,
};
use tokio::{
    io::copy_bidirectional,
    net::{TcpStream, UnixListener},
    sync::{watch, Semaphore},
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
        if host == t.hostname && (port == t.port || port == 443 && t.https_port.is_some()) {
            let mapped = if port == 443 {
                t.https_port.unwrap_or(port)
            } else {
                port
            };
            return Some(SocketAddr::from(([127, 0, 0, 1], mapped)));
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
    checked_address(&addresses)
}
fn checked_address(addresses: &[SocketAddr]) -> Option<SocketAddr> {
    if addresses.iter().any(|a| denied(a.ip())) {
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
        let slots = Arc::new(Semaphore::new(128));
        loop {
            tokio::select! {
                _ = stop.changed() => break,
                accepted = listener.accept() => {
                    let Ok((socket,_)) = accepted else { break; };
                    let Ok(slot) = slots.clone().try_acquire_owned() else { continue; };
                    let fixture = fixture.clone();
                    let mut stopped = stop.clone();
                    tokio::spawn(async move {
                        let slot = Arc::new(slot);
                        let shutdown = stopped.clone();
                        let service = hyper::service::service_fn(move |request| {
                            let fixture = fixture.clone();
                            let shutdown = shutdown.clone();
                            let slot = slot.clone();
                            async move {
                                Ok::<_, std::convert::Infallible>(handle(request, fixture, shutdown, slot).await.unwrap_or_else(|_| {
                                    response(502, "Proxy connection failed")
                                }))
                            }
                        });
                        let connection = hyper::server::conn::http1::Builder::new()
                            .max_buf_size(16384).serve_connection(hyper_util::rt::TokioIo::new(socket),service).with_upgrades();
                        tokio::select! { _ = stopped.changed() => {}, _ = tokio::time::timeout(Duration::from_secs(60),connection) => {} }
                    });
                }
            }
        }
    })
}
fn response(status: u16, body: &'static str) -> hyper::Response<axum::body::Body> {
    let mut response = hyper::Response::new(axum::body::Body::from(body));
    *response.status_mut() =
        hyper::StatusCode::from_u16(status).unwrap_or(hyper::StatusCode::BAD_GATEWAY);
    response.headers_mut().insert(
        "content-type",
        hyper::header::HeaderValue::from_static("text/plain"),
    );
    response.headers_mut().insert(
        "connection",
        hyper::header::HeaderValue::from_static("close"),
    );
    response
}
fn strip_headers(headers: &mut hyper::HeaderMap) {
    let names = headers
        .get("connection")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .split(',')
        .map(|v| v.trim().to_owned())
        .collect::<Vec<_>>();
    for name in names.iter().map(String::as_str).chain([
        "connection",
        "proxy-connection",
        "proxy-authorization",
        "proxy-authenticate",
        "keep-alive",
        "upgrade",
        "te",
        "trailer",
        "transfer-encoding",
    ]) {
        headers.remove(name);
    }
}
async fn handle(
    mut request: hyper::Request<hyper::body::Incoming>,
    fixture: Arc<Option<TestTarget>>,
    mut stop: watch::Receiver<bool>,
    slot: Arc<tokio::sync::OwnedSemaphorePermit>,
) -> std::io::Result<hyper::Response<axum::body::Body>> {
    let connect = request.method() == hyper::Method::CONNECT;
    let url = url::Url::parse(&if connect {
        format!("https://{}/", request.uri())
    } else {
        request.uri().to_string()
    });
    let (url, address) = if let Ok(url) = url {
        let host = url
            .host_str()
            .unwrap_or("")
            .trim_matches(['[', ']'])
            .trim_end_matches('.')
            .to_ascii_lowercase();
        let address = if url.username().is_empty()
            && url.password().is_none()
            && (connect && url.scheme() == "https" || !connect && url.scheme() == "http")
        {
            target(
                &host,
                url.port_or_known_default().unwrap_or(0),
                fixture.as_ref().as_ref(),
            )
            .await
        } else {
            None
        };
        (Some(url), address)
    } else {
        (None, None)
    };
    let (Some(url), Some(address)) = (url, address) else {
        return Ok(response(403, "Proxy request denied"));
    };
    let mut upstream =
        tokio::time::timeout(Duration::from_secs(5), TcpStream::connect(address)).await??;
    if connect {
        let upgraded = hyper::upgrade::on(&mut request);
        tokio::spawn(async move {
            let _slot = slot;
            if let Ok(connection) = upgraded.await {
                let mut client = hyper_util::rt::TokioIo::new(connection);
                tokio::select! {
                    _ = stop.changed() => {},
                    _ = tokio::time::timeout(Duration::from_secs(60),copy_bidirectional(&mut client, &mut upstream)) => {}
                }
            }
        });
        return Ok(hyper::Response::new(axum::body::Body::empty()));
    }
    let path = format!(
        "{}{}",
        url.path(),
        url.query().map(|q| format!("?{q}")).unwrap_or_default()
    );
    *request.uri_mut() = path.parse().map_err(|_| std::io::ErrorKind::InvalidData)?;
    strip_headers(request.headers_mut());
    let host = format!(
        "{}{}",
        url.host_str().unwrap_or(""),
        url.port().map(|p| format!(":{p}")).unwrap_or_default()
    );
    request.headers_mut().insert(
        "host",
        host.parse().map_err(|_| std::io::ErrorKind::InvalidData)?,
    );
    request.headers_mut().insert(
        "connection",
        hyper::header::HeaderValue::from_static("close"),
    );
    let (mut sender, connection) =
        hyper::client::conn::http1::handshake(hyper_util::rt::TokioIo::new(upstream))
            .await
            .map_err(std::io::Error::other)?;
    tokio::spawn(async move {
        let _slot = slot;
        tokio::select! { _ = stop.changed() => {}, _ = tokio::time::timeout(Duration::from_secs(60),connection) => {} }
    });
    let mut response = sender
        .send_request(request)
        .await
        .map_err(std::io::Error::other)?;
    strip_headers(response.headers_mut());
    response.headers_mut().insert(
        "connection",
        hyper::header::HeaderValue::from_static("close"),
    );
    Ok(response.map(axum::body::Body::new))
}
#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn proxy_denies_unsafe_http_and_connect_targets() -> crate::db::Result<()> {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let socket =
            std::env::temp_dir().join(format!("bs-proxy-{}.sock", uuid::Uuid::new_v4().simple()));
        let (stop, stopped) = watch::channel(false);
        let proxy = serve(UnixListener::bind(&socket)?, None, stopped);
        for (method, entries) in [
            (
                "CONNECT",
                &[
                    "127.0.0.1:80",
                    "[::1]:443",
                    "[::ffff:7f00:1]:443",
                    concat!("fixture.", "ts.net", ":443"),
                    "printer.local:80",
                    "example.test:22",
                ][..],
            ),
            (
                "GET",
                &[
                    "http://127.0.0.1/",
                    "http://[::1]/",
                    "http://192.168.1.1/",
                    "http://example.test:8080/",
                    "ftp://example.test/",
                    "http://u:p@example.test/",
                ][..],
            ),
        ] {
            for target in entries {
                let mut client = tokio::net::UnixStream::connect(&socket).await?;
                client.write_all(format!("{method} {target} HTTP/1.1\r\nHost: example.test\r\nConnection: close\r\n\r\n").as_bytes()).await?;
                let mut response = Vec::new();
                tokio::time::timeout(Duration::from_secs(3), client.read_to_end(&mut response))
                    .await??;
                assert!(
                    response.starts_with(b"HTTP/1.1 403"),
                    "{target}: {}",
                    String::from_utf8_lossy(&response)
                );
            }
        }
        let public = "93.184.216.34:443".parse()?;
        let other_public = "1.1.1.1:443".parse()?;
        let private = "10.0.0.1:443".parse()?;
        assert_eq!(checked_address(&[public, other_public]), Some(public));
        assert_eq!(checked_address(&[public, private]), None);
        assert_eq!(checked_address(&[private, public]), None);
        assert_eq!(checked_address(&[]), None);
        let _ = stop.send(true);
        proxy.await?;
        std::fs::remove_file(socket)?;
        Ok(())
    }

    #[tokio::test]
    async fn framing_and_checked_connect() -> crate::db::Result<()> {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let directory =
            std::env::temp_dir().join(format!("briefsip-proxy-check-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&directory)?;
        let upstream = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
        let port = upstream.local_addr()?.port();
        let service =
            axum::Router::new().fallback(move |request: axum::extract::Request| async move {
                if request.uri().path() == "/path" {
                    assert_eq!(
                        request.uri().path_and_query().map(|v| v.as_str()),
                        Some("/path?q=1")
                    );
                    assert_eq!(request.headers()["host"], format!("public.test:{port}"));
                    assert!(!request.headers().contains_key("proxy-authorization"));
                }
                let body = axum::body::to_bytes(request.into_body(), 1024)
                    .await
                    .unwrap_or_default();
                axum::body::Body::from(body)
            });
        let upstream_task = tokio::spawn(async move { axum::serve(upstream, service).await });
        let path = directory.join("proxy.sock");
        let (stop, stopped) = watch::channel(false);
        let proxy = serve(
            UnixListener::bind(&path)?,
            Some(TestTarget {
                hostname: "public.test".into(),
                port,
                https_port: None,
            }),
            stopped,
        );
        let mut client = tokio::net::UnixStream::connect(&path).await?;
        client.write_all(format!("POST http://public.test:{port}/path?q=1 HTTP/1.1\r\nHost: attacker.invalid\r\nProxy-Authorization: secret\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n3\r\nabc\r\n0\r\n\r\n").as_bytes()).await?;
        let mut response = Vec::new();
        tokio::time::timeout(Duration::from_secs(3), client.read_to_end(&mut response)).await??;
        assert!(response.starts_with(b"HTTP/1.1 200"));
        assert!(response.ends_with(b"abc"));
        let mut tunnel = tokio::net::UnixStream::connect(&path).await?;
        tunnel
            .write_all(
                format!("CONNECT public.test:{port} HTTP/1.1\r\nHost: public.test\r\n\r\nPOST / HTTP/1.1\r\nHost: public.test\r\nContent-Length: 3\r\nConnection: close\r\n\r\nxyz")
                    .as_bytes(),
            )
            .await?;
        let mut head = Vec::new();
        while !head.ends_with(b"\r\n\r\n") {
            head.push(tunnel.read_u8().await?);
        }
        assert!(head.starts_with(b"HTTP/1.1 200"));
        response.clear();
        tokio::time::timeout(Duration::from_secs(3), tunnel.read_to_end(&mut response)).await??;
        assert!(response.ends_with(b"xyz"));
        let mut active = tokio::net::UnixStream::connect(&path).await?;
        active
            .write_all(
                format!("CONNECT public.test:{port} HTTP/1.1\r\nHost: public.test\r\n\r\n")
                    .as_bytes(),
            )
            .await?;
        head.clear();
        tokio::time::timeout(Duration::from_secs(3), async {
            while !head.ends_with(b"\r\n\r\n") {
                head.push(active.read_u8().await?);
            }
            Ok::<_, std::io::Error>(())
        })
        .await??;
        assert!(head.starts_with(b"HTTP/1.1 200"));
        let _ = stop.send(true);
        proxy.await?;
        assert_eq!(
            tokio::time::timeout(Duration::from_secs(3), active.read(&mut [0u8; 1])).await??,
            0
        );
        upstream_task.abort();
        std::fs::remove_dir_all(directory)?;
        Ok(())
    }
    #[test]
    fn private_ranges_and_mapped_forms() -> crate::db::Result<()> {
        for ip in [
            "0.0.0.0",
            "0.255.255.255",
            "10.0.0.0",
            "10.255.255.255",
            "100.64.0.0",
            "100.127.255.255",
            "127.0.0.0",
            "127.255.255.255",
            "169.254.0.0",
            "169.254.255.255",
            "172.16.0.0",
            "172.31.255.255",
            "192.168.0.0",
            "192.168.255.255",
            "224.0.0.0",
            "239.255.255.255",
            "240.0.0.0",
            "255.255.255.255",
        ] {
            let ipv4: std::net::Ipv4Addr = ip.parse()?;
            assert!(denied(ipv4.into()), "{ip}");
            assert!(denied(ipv4.to_ipv6_mapped().into()), "{ip}");
            assert!(format!("::ffff:{ip}").parse().is_ok_and(denied), "{ip}");
        }
        for ip in [
            "::",
            "::1",
            "0:0:0:0:0:0:0:1",
            "fc00::",
            "fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff",
            "fe80::",
            "febf:ffff:ffff:ffff:ffff:ffff:ffff:ffff",
            "ff00::",
            "ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff",
        ] {
            assert!(ip.parse().is_ok_and(denied), "{ip}");
        }
        for ip in ["fe80::1%lo", "::ffff:127.0.0.1%lo", "invalid"] {
            assert!(ip.parse::<IpAddr>().is_err(), "{ip}");
        }
        for ip in [
            "1.0.0.0",
            "9.255.255.255",
            "11.0.0.0",
            "100.63.255.255",
            "100.128.0.0",
            "126.255.255.255",
            "128.0.0.0",
            "169.253.255.255",
            "169.255.0.0",
            "172.15.255.255",
            "172.32.0.0",
            "192.167.255.255",
            "192.169.0.0",
            "223.255.255.255",
            "8.8.8.8",
            "::ffff:8.8.8.8",
            "2001:4860:4860::8888",
            "fbff::",
            "fec0::",
        ] {
            assert!(ip.parse().is_ok_and(|v| !denied(v)), "{ip}");
        }
        for host in [
            "localhost",
            "printer.local",
            concat!("FIXTURE.", "TS.NET."),
            "local",
            "ts.net",
        ] {
            assert!(denied_host(host), "{host}");
        }
        for host in ["example.com", "local.example.com", "ts.net.example.com"] {
            assert!(!denied_host(host), "{host}");
        }
        Ok(())
    }
}
