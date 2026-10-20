//! 文本文件的编码检测与编解码。
//!
//! 编辑器读写都走这里：打开时按检测到的编码解码，保存时按**同一个**编码写回。
//! 之前读用 `from_utf8_lossy`、写固定 UTF-8，GBK / Big5 / UTF-16 的老工程
//! 一按 Ctrl+S 就会被替换字符（U+FFFD）覆盖，且不可逆——这是数据损坏，
//! 所以读写两端必须成对处理，不能只宽进严出。

use encoding_rs::{BIG5, EUC_KR, GB18030, GBK, SHIFT_JIS, WINDOWS_1252};

/// 支持回写的编码。刻意只收「老工程常见 + 能可靠往返」的这几种：
/// 每多一种就要多一套检测 / 往返验证，收益不大。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FileEncoding {
    Utf8,
    /// 带 BOM 的 UTF-8：读写都要把 BOM 当编码的一部分保留
    Utf8Bom,
    Utf16Le,
    Utf16Be,
    Gbk,
    /// GB18030。编码器能写四字节序列（GBK 的编码器只能覆盖双字节区），
    /// 所以必须用 `encoding_rs::GB18030` 而不是 `GBK`；两者解码侧一致。
    Gb18030,
    Big5,
    ShiftJis,
    EucKr,
    /// windows-1252 / ISO-8859-1。encoding_rs 按 WHATWG 把 ISO-8859-1 归到
    /// windows-1252（两者只差 0x80..=0x9F 的解释），所以两个变体共用同一个实现，
    /// 同样只是为了回写时保住用户原来的标签。
    Windows1252,
    Iso88591,
}

impl FileEncoding {
    /// 前后端传递用的稳定标签。检测结果要能原样回传给 `fs_write_file`，
    /// 所以标签必须跨进程一致，不能用 `Debug` 之类的派生名。
    pub fn label(self) -> &'static str {
        match self {
            FileEncoding::Utf8 => "utf-8",
            FileEncoding::Utf8Bom => "utf-8-bom",
            FileEncoding::Utf16Le => "utf-16le",
            FileEncoding::Utf16Be => "utf-16be",
            FileEncoding::Gbk => "gbk",
            FileEncoding::Gb18030 => "gb18030",
            FileEncoding::Big5 => "big5",
            FileEncoding::ShiftJis => "shift_jis",
            FileEncoding::EucKr => "euc-kr",
            FileEncoding::Windows1252 => "windows-1252",
            FileEncoding::Iso88591 => "iso-8859-1",
        }
    }

    pub fn from_label(label: &str) -> Option<Self> {
        Some(match label {
            "utf-8" => FileEncoding::Utf8,
            "utf-8-bom" => FileEncoding::Utf8Bom,
            "utf-16le" => FileEncoding::Utf16Le,
            "utf-16be" => FileEncoding::Utf16Be,
            "gbk" => FileEncoding::Gbk,
            // gb18030 与 GBK 共用实现，但标签各存各的
            "gb18030" | "gb-18030" => FileEncoding::Gb18030,
            "big5" => FileEncoding::Big5,
            // 老工程 / 别处工具常见的写法都收：Shift_JIS、Shift-JIS、SJIS、CP932
            "shift_jis" | "shift-jis" | "sjis" | "cp932" => FileEncoding::ShiftJis,
            "euc-kr" | "euckr" | "cp949" => FileEncoding::EucKr,
            "windows-1252" | "cp1252" => FileEncoding::Windows1252,
            "iso-8859-1" | "iso8859-1" => FileEncoding::Iso88591,
            _ => return None,
        })
    }
}

/// 只认 BOM。UTF-16 文本里到处是 NUL，会被 `looks_binary` 误判成二进制，
/// 所以调用方要先问一次 BOM 再决定要不要做二进制判定。
pub fn detect_bom(bytes: &[u8]) -> Option<FileEncoding> {
    let (encoding, _) = encoding_rs::Encoding::for_bom(bytes)?;
    if encoding == encoding_rs::UTF_8 {
        Some(FileEncoding::Utf8Bom)
    } else if encoding == encoding_rs::UTF_16LE {
        Some(FileEncoding::Utf16Le)
    } else if encoding == encoding_rs::UTF_16BE {
        Some(FileEncoding::Utf16Be)
    } else {
        None
    }
}

/// 检测编码。顺序是「BOM → 合法 UTF-8 → chardetng 猜常见中文编码」：
/// 能干净解码才算数，认不出来就返回 `None`，让调用方明确报错——
/// 宁可开不了，也不能拿 lossy 的结果蒙混过去再写回磁盘。
pub fn detect(bytes: &[u8]) -> Option<FileEncoding> {
    if let Some(bom) = detect_bom(bytes) {
        return Some(bom);
    }
    // 合法 UTF-8 直接定案，不进猜测分支：否则短文本可能被猜成 GBK
    if std::str::from_utf8(bytes).is_ok() {
        return Some(FileEncoding::Utf8);
    }
    // 走到这里既不是 UTF-8 也没有 BOM，交给 chardetng 在常见编码里猜一个。
    // ISO-2022-JP / UTF-8 都关掉：前者不在支持列表里，后者上面已经排除了，
    // 留着只会让它把结果浪费在这两种上
    let mut detector = chardetng::EncodingDetector::new(chardetng::Iso2022JpDetection::Deny);
    detector.feed(bytes, true);
    // 不给 tld 提示：大陆 GBK 和港台 Big5 都要照顾，倾向任何一边都会漏另一边
    let guessed = detector.guess(None, chardetng::Utf8Detection::Deny);

    if guessed == GBK {
        // 猜成 GBK 的也可能是 GB18030：两者解码器同一个，但 GBK 编码器写不了四字节
        // 序列。这里试着重编一遍，写不回去就标成 gb18030，保存时才不会丢字符。
        let text = decode(bytes, FileEncoding::Gbk).ok()?;
        return Some(if encode(&text, FileEncoding::Gbk).is_ok() {
            FileEncoding::Gbk
        } else {
            FileEncoding::Gb18030
        });
    }

    let candidate = if guessed == BIG5 {
        FileEncoding::Big5
    } else if guessed == SHIFT_JIS {
        FileEncoding::ShiftJis
    } else if guessed == EUC_KR {
        FileEncoding::EucKr
    } else if guessed == WINDOWS_1252 && plausible_single_byte_text(bytes) {
        // 单字节西欧编码几乎「什么字节都能解」，不加这一道，任何二进制垃圾都会被
        // 猜成 windows-1252 然后当文本打开、一保存就毁掉原文件
        let text = decode(bytes, FileEncoding::Windows1252).ok()?;
        // windows-1252 里 0x80..=0x9F 有效字节解出来是标点（€、—、…），
        // 解成 C1 控制字符说明命中了没定义的字节，多半不是文本
        if text.chars().any(|c| ('\u{80}'..='\u{9F}').contains(&c)) {
            return None;
        }
        FileEncoding::Windows1252
    } else {
        return None;
    };
    // 猜出来还要能干净解出来才算数：猜错时往往伴随非法序列
    decode(bytes, candidate).ok().map(|_| candidate)
}

/// windows-1252 的兜底猜测定性检查：C0 控制字符比例过高就按二进制处理。
///
/// 真正的文本里制表 / 换行 / 换页之外的控制字符几乎不出现，而二进制文件头部
/// 常有一堆。阈值放得比较宽，宁可漏认（用户还能手动指定编码），也不要把
/// PNG / 压缩包当成西欧文本打开。
fn plausible_single_byte_text(bytes: &[u8]) -> bool {
    if bytes.is_empty() {
        return false;
    }
    let controls = bytes
        .iter()
        .filter(|byte| **byte < 0x20 && !matches!(**byte, b'\t' | b'\n' | b'\r' | 0x0C))
        .count();
    controls * 50 <= bytes.len()
}

/// 字节流开头是不是带了 BOM（UTF-8 / UTF-16LE / UTF-16BE）。
///
/// 返回值给前端保存时原样回传，决定写回时补不补 BOM；正文里的 BOM 由
/// `decode` 负责剥掉，不会混进编辑器内容。
pub fn has_bom(bytes: &[u8]) -> bool {
    detect_bom(bytes).is_some()
}

/// 探测换行符风格，返回 `LF` / `CRLF` / `CR`。
///
/// 只扫开头一段：超大文件全扫一遍不值得，而且同一文件里混用换行时也按出现最多的算。
/// 没有任何换行（单行文件 / 空文件）按 `LF` 处理，这是各编辑器的默认约定。
pub fn detect_eol(text: &str) -> &'static str {
    const SCAN_LEN: usize = 512 * 1024;
    let bytes = text.as_bytes();
    let limit = bytes.len().min(SCAN_LEN);
    let (mut crlf, mut lf, mut cr) = (0usize, 0usize, 0usize);
    let mut index = 0usize;
    while index < limit {
        match bytes[index] {
            b'\r' => {
                if index + 1 < limit && bytes[index + 1] == b'\n' {
                    crlf += 1;
                    index += 2;
                    continue;
                }
                cr += 1;
            }
            b'\n' => lf += 1,
            _ => {}
        }
        index += 1;
    }
    if crlf == 0 && lf == 0 && cr == 0 {
        return "LF";
    }
    if crlf >= lf && crlf >= cr {
        "CRLF"
    } else if lf >= cr {
        "LF"
    } else {
        "CR"
    }
}

/// 把任意换行风格（LF / CRLF / CR 混用也行）统一成 `target`。
///
/// 只在**写回**时用：读取时按 WP1 的约定保留原文，避免现有编辑器行为回归。
pub fn normalize_eol(text: &str, target: &str) -> String {
    let separator = match target {
        "CRLF" => "\r\n",
        "CR" => "\r",
        _ => "\n",
    };
    let mut out = String::with_capacity(text.len() + text.len() / 16);
    let mut chars = text.chars().peekable();
    while let Some(character) = chars.next() {
        match character {
            '\r' => {
                out.push_str(separator);
                if chars.peek() == Some(&'\n') {
                    chars.next();
                }
            }
            '\n' => out.push_str(separator),
            other => out.push(other),
        }
    }
    out
}

/// 按指定编码解码。非法序列一律报错，不做替换——替换出来的 U+FFFD 一旦写回
/// 就是永久损坏（这正是原 bug 的成因）。
pub fn decode(bytes: &[u8], encoding: FileEncoding) -> Result<String, String> {
    match encoding {
        FileEncoding::Utf8 => std::str::from_utf8(bytes)
            .map(str::to_owned)
            .map_err(|_| "文件不是合法的 UTF-8 文本".to_string()),
        FileEncoding::Utf8Bom => {
            let body = bytes.strip_prefix(UTF8_BOM).unwrap_or(bytes);
            std::str::from_utf8(body)
                .map(str::to_owned)
                .map_err(|_| "文件不是合法的 UTF-8 文本".to_string())
        }
        FileEncoding::Utf16Le => decode_utf16(bytes, UTF16LE_BOM, true),
        FileEncoding::Utf16Be => decode_utf16(bytes, UTF16BE_BOM, false),
        FileEncoding::Gbk => decode_legacy(bytes, GBK, "GBK"),
        // GB18030 用独立的编解码器，四字节序列也能解
        FileEncoding::Gb18030 => decode_legacy(bytes, GB18030, "GB18030"),
        FileEncoding::Big5 => decode_legacy(bytes, BIG5, "Big5"),
        FileEncoding::ShiftJis => decode_legacy(bytes, SHIFT_JIS, "Shift_JIS"),
        FileEncoding::EucKr => decode_legacy(bytes, EUC_KR, "EUC-KR"),
        FileEncoding::Windows1252 => decode_legacy(bytes, WINDOWS_1252, "windows-1252"),
        // WHATWG 把 ISO-8859-1 当作 windows-1252 的超集处理，两者共用同一个码表
        FileEncoding::Iso88591 => decode_legacy(bytes, WINDOWS_1252, "ISO-8859-1"),
    }
}

/// 解码「被截断的」字节流：只读文件前 8MB 时，最后一个字符可能被切成半截。
///
/// 这里的策略是**只裁掉尾部不完整的序列**（最多几个字节），不替换、不丢正文：
/// 先按正常流程严格解码，失败就逐个字节往回退再试。多字节编码（UTF-8 / GB18030
/// 四字节序列 / UTF-16 代理对）被切断时，缺口都在末尾。
pub fn decode_truncated(bytes: &[u8], encoding: FileEncoding) -> Result<String, String> {
    match decode(bytes, encoding) {
        Ok(text) => return Ok(text),
        // 单字节编码不会因为"截断在字符中间"失败；走到这里说明内容本身真的不合法
        Err(_) if matches!(encoding, FileEncoding::Windows1252 | FileEncoding::Iso88591) => {
            return decode(bytes, encoding);
        }
        Err(_) => {}
    }

    // UTF-8 一个字符最多 4 字节、GB18030 最多 4 字节、UTF-16 一个代理对最多 4 字节，
    // 退 4 个字节足够覆盖所有「尾巴被切掉」的情况
    for trim in 1..=4usize {
        if trim >= bytes.len() {
            break;
        }
        if let Ok(text) = decode(&bytes[..bytes.len() - trim], encoding) {
            return Ok(text);
        }
    }
    decode(bytes, encoding)
}

/// 按指定编码编码。有字符编不出来（比如往 GBK 文件里贴了 emoji）就报错，
/// **绝不悄悄丢弃或替换**——那正是这个 bug 的根源。
pub fn encode(text: &str, encoding: FileEncoding) -> Result<Vec<u8>, String> {
    encode_with(text, encoding, None, None)
}

/// 带换行与 BOM 策略的编码。
///
/// - `eol` 给了就把正文统一成该风格（LF / CRLF / CR）；没给则原样写。
/// - `has_bom` 给了就按它决定 BOM：`true` 补上（UTF-8 / UTF-16 才有意义），
///   `false` 去掉（`utf-8-bom` 会退化成普通 UTF-8）。没给则沿用编码标签本身的
///   默认语义（`utf-8-bom` / UTF-16 带 BOM，其余不带），保持旧调用方的行为。
///
/// UTF-16 **没有 BOM** 时几乎无法再被自动识别（正文里全是 NUL，会被当成二进制），
/// 所以 `has_bom = false` 对 UTF-16 不生效，仍然写入 BOM。
pub fn encode_with(
    text: &str,
    encoding: FileEncoding,
    eol: Option<&str>,
    has_bom: Option<bool>,
) -> Result<Vec<u8>, String> {
    let target = match eol.map(str::trim) {
        None | Some("") => None,
        Some(value) if value.eq_ignore_ascii_case("LF") => Some("LF"),
        Some(value) if value.eq_ignore_ascii_case("CRLF") => Some("CRLF"),
        Some(value) if value.eq_ignore_ascii_case("CR") => Some("CR"),
        Some(other) => return Err(format!("不支持的换行符: {other}")),
    };
    let text = match target {
        Some(eol) => normalize_eol(text, eol),
        None => text.to_string(),
    };

    let default_bom = matches!(
        encoding,
        FileEncoding::Utf8Bom | FileEncoding::Utf16Le | FileEncoding::Utf16Be
    );
    // UTF-16 必须带 BOM，见上面的注释
    let bom = match encoding {
        FileEncoding::Utf16Le | FileEncoding::Utf16Be => true,
        _ => has_bom.unwrap_or(default_bom),
    };

    match encoding {
        FileEncoding::Utf8 | FileEncoding::Utf8Bom => {
            let mut out = Vec::with_capacity(text.len() + 3);
            if bom {
                out.extend_from_slice(UTF8_BOM);
            }
            out.extend_from_slice(text.as_bytes());
            Ok(out)
        }
        // 标签是 utf-16xx 时 BOM 已由 `encode_utf16` 补上，这里不再重复
        FileEncoding::Utf16Le => encode_utf16(&text, UTF16LE_BOM, true),
        FileEncoding::Utf16Be => encode_utf16(&text, UTF16BE_BOM, false),
        FileEncoding::Gbk => encode_legacy(&text, GBK, "GBK"),
        FileEncoding::Gb18030 => encode_legacy(&text, GB18030, "GB18030"),
        FileEncoding::Big5 => encode_legacy(&text, BIG5, "Big5"),
        FileEncoding::ShiftJis => encode_legacy(&text, SHIFT_JIS, "Shift_JIS"),
        FileEncoding::EucKr => encode_legacy(&text, EUC_KR, "EUC-KR"),
        FileEncoding::Windows1252 => encode_legacy(&text, WINDOWS_1252, "windows-1252"),
        FileEncoding::Iso88591 => encode_legacy(&text, WINDOWS_1252, "ISO-8859-1"),
    }
}

const UTF8_BOM: &[u8] = &[0xEF, 0xBB, 0xBF];
const UTF16LE_BOM: &[u8] = &[0xFF, 0xFE];
const UTF16BE_BOM: &[u8] = &[0xFE, 0xFF];

/// UTF-16 解码：先剥 BOM，再逐单元手解。
///
/// 刻意不用 `encoding_rs` 的 `decode`：它会在 UTF-16 上再做一次 BOM 嗅探 / 补 BOM，
/// 和这里「BOM 自成一种编码、必须原样保留」的语义打架；手解只有这几行，还更清楚。
fn decode_utf16(bytes: &[u8], bom: &[u8], little_endian: bool) -> Result<String, String> {
    let body = bytes.strip_prefix(bom).unwrap_or(bytes);
    if body.len() % 2 != 0 {
        return Err("UTF-16 文本的长度不是偶数，无法解码".to_string());
    }
    let units = body.chunks_exact(2).map(|pair| {
        if little_endian {
            u16::from_le_bytes([pair[0], pair[1]])
        } else {
            u16::from_be_bytes([pair[0], pair[1]])
        }
    });
    // 非法代理对（落单的 D800..DFFF）会在这里报错，不静默替换
    std::char::decode_utf16(units)
        .collect::<Result<String, _>>()
        .map_err(|_| "UTF-16 文本里有非法代理对，无法解码".to_string())
}

/// UTF-16 编码：把 BOM 补回去，其余按字节手拼
fn encode_utf16(text: &str, bom: &[u8], little_endian: bool) -> Result<Vec<u8>, String> {
    let mut out = bom.to_vec();
    for unit in text.encode_utf16() {
        let bytes = if little_endian {
            unit.to_le_bytes()
        } else {
            unit.to_be_bytes()
        };
        out.extend_from_slice(&bytes);
    }
    Ok(out)
}

fn decode_legacy(
    bytes: &[u8],
    encoding: &'static encoding_rs::Encoding,
    name: &str,
) -> Result<String, String> {
    let (text, _, had_errors) = encoding.decode(bytes);
    if had_errors {
        return Err(format!("文件不是合法的 {name} 文本（检测到的编码可能不准）"));
    }
    Ok(text.into_owned())
}

fn encode_legacy(
    text: &str,
    encoding: &'static encoding_rs::Encoding,
    name: &str,
) -> Result<Vec<u8>, String> {
    let (body, _, had_errors) = encoding.encode(text);
    if had_errors {
        return Err(format!("文件里有字符无法用 {name} 保存，请另存为 UTF-8"));
    }
    Ok(body.into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 一段中文，三种编码都能表达，用来验往返
    const CN: &str = "这是一个使用旧编码的中文文本，用来验证编码检测与往返保存。";

    /// 一段繁体中文，只有 Big5 能表达（GBK 编不出这些繁体字），用来验 Big5 往返
    const CN_TRAD: &str = "這是一個使用舊編碼的中文文字檔，用來驗證編碼偵測與往返儲存。";

    /// 日文 / 韩文 / 西欧样本：验证新增编码的往返
    const JA: &str = "これは日本語のテキストです。文字コードの往復を確認します。";
    const KO: &str = "이것은 한국어 텍스트입니다. 인코딩 왕복을 확인합니다.";
    const FR: &str = "Café déjà vu : naïve façade, € 12 — très bien.";

    #[test]
    fn detects_and_round_trips_utf8() {
        let bytes = CN.as_bytes();
        assert_eq!(detect(bytes), Some(FileEncoding::Utf8));
        assert_eq!(decode(bytes, FileEncoding::Utf8).unwrap(), CN);
        assert_eq!(encode(CN, FileEncoding::Utf8).unwrap(), bytes);
    }

    #[test]
    fn keeps_and_strips_the_utf8_bom() {
        let mut bytes = UTF8_BOM.to_vec();
        bytes.extend_from_slice(CN.as_bytes());

        assert_eq!(detect(&bytes), Some(FileEncoding::Utf8Bom));
        // BOM 不该跑到正文里去
        assert_eq!(decode(&bytes, FileEncoding::Utf8Bom).unwrap(), CN);
        assert_eq!(encode(CN, FileEncoding::Utf8Bom).unwrap(), bytes);
    }

    #[test]
    fn round_trips_gbk_and_big5() {
        // 用编码器自己造样本：只要检测认得出、解码再编码能回到原字节，就说明往返成立
        let gbk = encode(CN, FileEncoding::Gbk).unwrap();
        assert_eq!(detect(&gbk), Some(FileEncoding::Gbk), "GBK 样本没被认出来");
        assert_eq!(decode(&gbk, FileEncoding::Gbk).unwrap(), CN);

        let big5 = encode(CN_TRAD, FileEncoding::Big5).unwrap();
        assert_eq!(detect(&big5), Some(FileEncoding::Big5), "Big5 样本没被认出来");
        assert_eq!(decode(&big5, FileEncoding::Big5).unwrap(), CN_TRAD);
    }

    #[test]
    fn round_trips_utf16_both_endians() {
        let le = encode(CN, FileEncoding::Utf16Le).unwrap();
        assert_eq!(detect(&le), Some(FileEncoding::Utf16Le));
        assert_eq!(decode(&le, FileEncoding::Utf16Le).unwrap(), CN);

        let be = encode(CN, FileEncoding::Utf16Be).unwrap();
        assert_eq!(detect(&be), Some(FileEncoding::Utf16Be));
        assert_eq!(decode(&be, FileEncoding::Utf16Be).unwrap(), CN);

        // 手工拼一份 "hi" 的 UTF-16LE（BOM + 两字节 little-endian），确认 BOM 被剥掉
        assert_eq!(
            decode(&[0xFF, 0xFE, b'h', 0x00, b'i', 0x00], FileEncoding::Utf16Le).unwrap(),
            "hi"
        );
    }

    #[test]
    fn refuses_to_encode_characters_the_legacy_codepage_cannot_hold() {
        // emoji 不在 GBK / Big5 里：必须报错，不能丢字
        let error = encode("hi 😀", FileEncoding::Gbk).unwrap_err();
        assert!(error.contains("GBK"), "{error}");
        assert!(encode("hi 😀", FileEncoding::Big5).is_err());
        // UTF-8 没有这种限制
        assert!(encode("hi 😀", FileEncoding::Utf8).is_ok());
    }

    #[test]
    fn refuses_bytes_it_cannot_recognise() {
        // 随机的非 UTF-8 字节：既没有 BOM 也不是能干净解出的 GBK / Big5
        let junk = [0xF8u8, 0x80, 0x80, 0x80, 0xFE, 0xFF, 0x01, 0x02];
        assert_eq!(detect(&junk), None, "认不出来就该返回 None，交给上层报错");
    }

    #[test]
    fn labels_are_stable_and_parse_back() {
        for encoding in [
            FileEncoding::Utf8,
            FileEncoding::Utf8Bom,
            FileEncoding::Utf16Le,
            FileEncoding::Utf16Be,
            FileEncoding::Gbk,
            FileEncoding::Gb18030,
            FileEncoding::Big5,
            FileEncoding::ShiftJis,
            FileEncoding::EucKr,
            FileEncoding::Windows1252,
            FileEncoding::Iso88591,
        ] {
            assert_eq!(FileEncoding::from_label(encoding.label()), Some(encoding));
        }
        // 常见别名也要认
        assert_eq!(FileEncoding::from_label("sjis"), Some(FileEncoding::ShiftJis));
        assert_eq!(
            FileEncoding::from_label("cp1252"),
            Some(FileEncoding::Windows1252)
        );
        assert_eq!(FileEncoding::from_label("latin1"), None);
    }

    #[test]
    fn detects_eol_variants() {
        assert_eq!(detect_eol("a\r\nb\r\n"), "CRLF");
        assert_eq!(detect_eol("a\nb\n"), "LF");
        assert_eq!(detect_eol("a\rb\r"), "CR");
        // 单行 / 空文件按 LF 处理
        assert_eq!(detect_eol("no newline"), "LF");
        assert_eq!(detect_eol(""), "LF");
        // 混用时按出现最多的算
        assert_eq!(detect_eol("a\r\nb\r\nc\n"), "CRLF");
        assert_eq!(detect_eol("a\nb\nc\r\n"), "LF");
    }

    #[test]
    fn normalizes_eol_in_both_directions() {
        assert_eq!(normalize_eol("a\nb", "CRLF"), "a\r\nb");
        assert_eq!(normalize_eol("a\r\nb", "CRLF"), "a\r\nb");
        assert_eq!(normalize_eol("a\rb", "CRLF"), "a\r\nb");
        assert_eq!(normalize_eol("a\r\nb", "LF"), "a\nb");
        assert_eq!(normalize_eol("a\r\nb", "CR"), "a\rb");
        // 幂等：已经是目标风格时不能越换越长
        assert_eq!(
            normalize_eol(&normalize_eol("a\r\nb", "CRLF"), "CRLF"),
            "a\r\nb"
        );
    }

    #[test]
    fn round_trips_gb18030_japanese_korean_and_western_cp1252() {
        // GB18030 的 4 字节序列用 GBK 编解码器也能往返
        const GB18030_ONLY: &str = "GB18030 扩展字符：𠀀（四字节序列）";
        let gb18030 = encode(GB18030_ONLY, FileEncoding::Gb18030).unwrap();
        assert_eq!(
            decode(&gb18030, FileEncoding::Gb18030).unwrap(),
            GB18030_ONLY
        );
        // 自动检测要认出这是 GB18030 而不是 GBK：GBK 编码器写不回四字节序列
        assert_eq!(detect(&gb18030), Some(FileEncoding::Gb18030));

        let sjis = encode(JA, FileEncoding::ShiftJis).unwrap();
        assert_eq!(decode(&sjis, FileEncoding::ShiftJis).unwrap(), JA);
        assert_eq!(detect(&sjis), Some(FileEncoding::ShiftJis));

        let euc_kr = encode(KO, FileEncoding::EucKr).unwrap();
        assert_eq!(decode(&euc_kr, FileEncoding::EucKr).unwrap(), KO);
        assert_eq!(detect(&euc_kr), Some(FileEncoding::EucKr));

        let cp1252 = encode(FR, FileEncoding::Windows1252).unwrap();
        assert_eq!(decode(&cp1252, FileEncoding::Windows1252).unwrap(), FR);
        assert_eq!(
            decode(&cp1252, FileEncoding::Iso88591).unwrap(),
            FR,
            "ISO-8859-1 与 windows-1252 共用码表"
        );

        // 单字节编码兜底猜测定性检查：真文本认得出，二进制垃圾不能被认成西欧文本
        assert_eq!(detect(&cp1252), Some(FileEncoding::Windows1252));
        assert_eq!(detect(&[0xF8u8, 0x80, 0x80, 0x80, 0xFE, 0xFF, 0x01, 0x02]), None);
    }

    #[test]
    fn truncated_decoding_drops_only_the_broken_tail() {
        // UTF-8：切掉「好」的最后一个字节
        let mut utf8 = "前文好".as_bytes().to_vec();
        utf8.pop();
        assert_eq!(
            decode_truncated(&utf8, FileEncoding::Utf8).unwrap(),
            "前文",
            "UTF-8 尾部半截字符应该被裁掉，不能整份失败"
        );

        // UTF-16LE：切出奇数长度（半个代码单元）
        let utf16 = encode("前文好", FileEncoding::Utf16Le).unwrap();
        let cut = &utf16[..utf16.len() - 1];
        assert_eq!(
            decode_truncated(cut, FileEncoding::Utf16Le).unwrap(),
            "前文"
        );

        // GBK：切掉「好」的第二个字节
        let mut gbk = encode("前文好", FileEncoding::Gbk).unwrap();
        gbk.pop();
        assert_eq!(decode_truncated(&gbk, FileEncoding::Gbk).unwrap(), "前文");
    }

    #[test]
    fn writes_the_requested_eol_and_bom() {
        // 传了 eol：正文按目标风格写；没传就原样
        let bytes = encode_with("a\nb", FileEncoding::Utf8, Some("CRLF"), None).unwrap();
        assert_eq!(bytes, b"a\r\nb");
        let bytes = encode_with("a\r\nb", FileEncoding::Utf8, Some("CR"), None).unwrap();
        assert_eq!(bytes, b"a\rb");

        // UTF-8 BOM：默认（不传）带 BOM，显式 false 去掉，显式 true 保留
        assert_eq!(
            encode_with("hi", FileEncoding::Utf8Bom, None, None).unwrap(),
            [UTF8_BOM, b"hi"].concat()
        );
        assert_eq!(
            encode_with("hi", FileEncoding::Utf8Bom, None, Some(false)).unwrap(),
            b"hi"
        );
        assert_eq!(
            encode_with("hi", FileEncoding::Utf8, None, Some(true)).unwrap(),
            [UTF8_BOM, b"hi"].concat()
        );

        // 不认识的换行标签要明确报错，不能悄悄按 LF 写
        assert!(encode_with("a", FileEncoding::Utf8, Some("CRLFish"), None).is_err());
    }

    #[test]
    fn has_bom_only_for_real_boms() {
        assert!(has_bom(&[UTF8_BOM, b"h"].concat()));
        assert!(has_bom(&[0xFF, 0xFE, b'h', 0x00]));
        assert!(!has_bom(b"plain"));
        assert!(!has_bom(&[0xEF, 0xBB]));
    }
}
