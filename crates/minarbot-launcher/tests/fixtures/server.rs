use std::{env, fs, io::{Read, Write}, net::TcpListener};

fn main() -> std::io::Result<()> {
    let version = fs::read_to_string("version.txt")?;
    let listener = TcpListener::bind(format!("127.0.0.1:{}", env::var("PORT").unwrap_or_default()))?;
    for connection in listener.incoming() {
        let mut connection = connection?;
        let mut request = [0; 4096];
        connection.read(&mut request)?;
        let body = format!("{{\"version\":\"{version}\",\"native\":true}}");
        write!(connection, "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n{:x}\r\n{}\r\n0\r\n\r\n", body.len(), body)?;
    }
    Ok(())
}
