//! 文本文件的编码检测与编解码。
//!
//! 编辑器读写都走这里：打开时按检测到的编码解码，保存时按**同一个**编码写回。
//! 之前读用 `from_utf8_lossy`、写固定 UTF-8，GBK / Big5 / UTF-16 的老工程
//! 一按 Ctrl+S 就会被替换字符（U+FFFD）覆盖，且不可逆——这是数据损坏，
//! 所以读写两端必须成对处理，不能只宽进严出。

use encoding_rs::{BIG5, GBK};

/// 支持回写的编码。刻意只收「中文老工程常见 + 能可靠往返」的这几种：
/// 每多一种就要多一套检测 / 往返验证，收益不大。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FileEncoding {
    Utf8,
    /// 带 BOM 的 UTF-8：读写都要把 BOM 当编码的一部分保留
    Utf8Bom,
    Utf16Le,
    Utf16Be,
    Gbk,
    Big5,
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
            FileEncoding::Big5 => "big5",
        }
    }

    pub fn from_label(label: &str) -> Option<Self> {
        Some(match label {
            "utf-8" => FileEncoding::Utf8,
            "utf-8-bom" => FileEncoding::Utf8Bom,
            "utf-16le" => FileEncoding::Utf16Le,
            "utf-16be" => FileEncoding::Utf16Be,
            "gbk" => FileEncoding::Gbk,
            "big5" => FileEncoding::Big5,
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
    let candidate = if guessed == GBK {
        FileEncoding::Gbk
    } else if guessed == BIG5 {
        FileEncoding::Big5
    } else {
        return None;
    };
    // 猜出来还要能干净解出来才算数：猜错时往往伴随非法序列
    decode(bytes, candidate).ok().map(|_| candidate)
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
        FileEncoding::Big5 => decode_legacy(bytes, BIG5, "Big5"),
    }
}

/// 按指定编码编码。有字符编不出来（比如往 GBK 文件里贴了 emoji）就报错，
/// **绝不悄悄丢弃或替换**——那正是这个 bug 的根源。
pub fn encode(text: &str, encoding: FileEncoding) -> Result<Vec<u8>, String> {
    match encoding {
        FileEncoding::Utf8 => Ok(text.as_bytes().to_vec()),
        FileEncoding::Utf8Bom => {
            let mut out = UTF8_BOM.to_vec();
            out.extend_from_slice(text.as_bytes());
            Ok(out)
        }
        FileEncoding::Utf16Le => encode_utf16(text, UTF16LE_BOM, true),
        FileEncoding::Utf16Be => encode_utf16(text, UTF16BE_BOM, false),
        FileEncoding::Gbk => encode_legacy(text, GBK, "GBK"),
        FileEncoding::Big5 => encode_legacy(text, BIG5, "Big5"),
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
            FileEncoding::Big5,
        ] {
            assert_eq!(FileEncoding::from_label(encoding.label()), Some(encoding));
        }
        assert_eq!(FileEncoding::from_label("latin1"), None);
    }
}
