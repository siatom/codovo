//! 测试用的假 OpenAI 端点：本地起一个 TcpListener，按顺序回放预设响应。
//!
//! 只在 `cargo test` 下编译。模型构造、SSE 解析、工具调用与落盘都能离线验证，
//! 不必真的连一个提供商。

use std::io::{Read, Write};
use std::net::TcpListener;

/// 把若干条 `data: ...` 拼成一份 SSE 响应，末尾自动补 `[DONE]`。
pub fn sse(events: &[&str]) -> String {
    let mut body = String::new();
    for event in events {
        body.push_str("data: ");
        body.push_str(event);
        body.push_str("\n\n");
    }
    body.push_str("data: [DONE]\n\n");
    format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n{body}")
}

/// 一份普通的 JSON 响应。
pub fn json(body: &str) -> String {
    format!(
        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        body.len(),
        body
    )
}

/// 起一个假端点，按顺序给每个连接回一份响应。返回 (base_url, 线程句柄)。
///
/// 用完记得 `join`：没消费掉的响应会让监听线程一直挂着。
pub fn serve(responses: Vec<String>) -> (String, std::thread::JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").expect("绑定端口");
    let port = listener.local_addr().unwrap().port();
    let handle = std::thread::spawn(move || {
        for response in responses {
            let Ok((mut stream, _)) = listener.accept() else {
                return;
            };
            read_request(&mut stream);
            let _ = stream.write_all(response.as_bytes());
            let _ = stream.flush();
        }
    });
    (format!("http://127.0.0.1:{port}/v1"), handle)
}

/// 把请求读干净再回：留半截正文会让对端看到连接被重置。
fn read_request(stream: &mut std::net::TcpStream) {
    let mut head = Vec::new();
    let mut buf = [0u8; 4096];
    loop {
        let read = stream.read(&mut buf).unwrap_or(0);
        if read == 0 {
            return;
        }
        head.extend_from_slice(&buf[..read]);
        let Some(end) = head.windows(4).position(|window| window == b"\r\n\r\n") else {
            continue;
        };
        let headers = String::from_utf8_lossy(&head[..end]).to_string();
        let length = headers
            .lines()
            .find_map(|line| {
                let (key, value) = line.split_once(':')?;
                if key.eq_ignore_ascii_case("content-length") {
                    value.trim().parse::<usize>().ok()
                } else {
                    None
                }
            })
            .unwrap_or(0);
        if head.len() >= end + 4 + length {
            return;
        }
    }
}
