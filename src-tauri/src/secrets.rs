//! API 密钥的落存储：交给操作系统的凭据库，不再明文写进前端 localStorage。
//!
//! - Windows → 凭据管理器
//! - macOS → 钥匙串
//! - Linux → Secret Service（gnome-keyring / KWallet 那套）
//!
//! 为什么不自己加密后落文件：主密钥也得放在某处——要么明文躺在旁边（等于没加密），
//! 要么每次启动让用户输密码解锁。系统凭据库是唯一既不额外要 UX、又是真加密的落点。
//! 顺带的好处是密钥从此不进 WebView、不进 localStorage、也不进 opencode.json。
//!
//! 一个提供商一条记录，条目名就是 provider id。密钥正文只在这个模块和发请求的地方
//! 出现，不回前端、不进日志。

use keyring::Entry;
use serde::Serialize;

/// 条目归类名。用户在系统凭据管理器 / 钥匙串里看到的就是它，所以用产品名。
const SERVICE: &str = "Codovo";

/// provider id 的长度上限。这几个平台对条目名的长度都有上限（Windows 是 256 字符
/// 量级），我们自己的 id 是 slug（十几个字符），这里只是别让脏数据把接口顶回来。
const MAX_ID_CHARS: usize = 128;

/// 把 keyring 的错误翻成能给用户看的话。平台相关的原文照带，不然「写入失败」四个字
/// 根本没法排查。
///
/// 收引用而不是值：`keyring::Error` 里挂着 `Box<dyn Error>`，没有 Clone，
/// 而 `Entry::store_status()` 给的就是个静态引用。
fn describe(error: &keyring::Error) -> String {
    use keyring::Error;
    match error {
        Error::NoStorageAccess(detail) | Error::PlatformFailure(detail) => {
            format!("系统钥匙串不可用：{detail}")
        }
        Error::NoDefaultStore | Error::NotSupportedByStore(_) => {
            "这台机器上没有可用的系统钥匙串（Linux 需要 Secret Service，\
             例如 gnome-keyring 或 KWallet）"
                .to_string()
        }
        other => format!("系统钥匙串操作失败：{other}"),
    }
}

/// 取某个提供商的凭据条目。id 非法时直接报错，不去碰系统接口。
fn entry(provider_id: &str) -> Result<Entry, String> {
    let id = provider_id.trim();
    if id.is_empty() || id.chars().count() > MAX_ID_CHARS {
        return Err(format!("非法的提供商 ID「{provider_id}」"));
    }
    Entry::new(SERVICE, id).map_err(|error| describe(&error))
}

/// 写入（或覆盖）一个提供商的密钥。空密钥按删除处理——界面上清空输入框就是不想留了。
pub fn set(provider_id: &str, key: &str) -> Result<(), String> {
    let key = key.trim();
    if key.is_empty() {
        return delete(provider_id);
    }
    entry(provider_id)?
        .set_password(key)
        .map_err(|error| describe(&error))
}

/// 读一个提供商的密钥。没存过返回 `None`（不是错误：本地模型本来就不需要密钥）。
pub fn get(provider_id: &str) -> Result<Option<String>, String> {
    match entry(provider_id)?.get_password() {
        Ok(key) => Ok(Some(key)),
        // 没存过不是错误：本地模型（Ollama 之类）本来就不需要密钥
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(other) => Err(describe(&other)),
    }
}

/// 删掉一个提供商的密钥。本来就没有也算成功——调用方要的结果是「现在没有了」。
pub fn delete(provider_id: &str) -> Result<(), String> {
    match entry(provider_id)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(other) => Err(describe(&other)),
    }
}

/// 系统钥匙串能不能用。Linux 上没有 Secret Service 时这里会失败，界面据此提示
/// 「密钥不会保存」，而不是让用户填完才发现存不上。
pub fn store_error() -> Option<String> {
    match Entry::store_status() {
        Ok(()) => None,
        Err(error) => Some(describe(error)),
    }
}

/// 查一批提供商里哪些存着密钥。前端拿它校正 localStorage 里的 `apiKeySet` 标记——
/// 那边只是个布尔位，钥匙串里的条目可能被用户在系统设置里删掉了。
///
/// **不返回失败**：钥匙串整个不可用是种正常状态（Linux 无 Secret Service），
/// 用 `store_error` 如实报告比让整个调用报错更好用。读单个条目时的意外错误
/// 按「没有密钥」算，界面会显示成未保存，用户重填一次即可。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SecretStatus {
    /// 系统钥匙串不可用时的原因；可用时为空串
    pub store_error: String,
    /// 确实存着密钥的 provider id
    pub available: Vec<String>,
}

#[tauri::command]
pub fn secret_set(provider_id: String, key: String) -> Result<(), String> {
    set(&provider_id, &key)
}

#[tauri::command]
pub fn secret_delete(provider_id: String) -> Result<(), String> {
    delete(&provider_id)
}

#[tauri::command]
pub fn secret_status(provider_ids: Vec<String>) -> SecretStatus {
    let store_error = store_error().unwrap_or_default();
    if !store_error.is_empty() {
        return SecretStatus {
            store_error,
            available: Vec::new(),
        };
    }
    SecretStatus {
        store_error,
        available: provider_ids
            .into_iter()
            .filter(|id| matches!(get(id), Ok(Some(_))))
            .collect(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn describe_explains_an_unavailable_store() {
        // Linux 上没有 Secret Service 时走这条：得把「装个 keyring 服务」的意思说清楚
        let text = describe(&keyring::Error::NoDefaultStore);
        assert!(text.contains("Secret Service"));
        let text = describe(&keyring::Error::NotSupportedByStore("nope".to_string()));
        assert!(text.contains("Secret Service"));
    }

    #[test]
    fn describe_keeps_the_platform_detail() {
        let text = describe(&keyring::Error::Invalid(
            "attr".to_string(),
            "boom".to_string(),
        ));
        assert!(text.contains("boom"));
        assert!(text.contains("系统钥匙串"));
    }

    #[test]
    fn entry_rejects_bad_provider_ids() {
        assert!(entry("").is_err());
        assert!(entry("   ").is_err());
        assert!(entry(&"x".repeat(MAX_ID_CHARS + 1)).is_err());
        // id 正常时不该被本地校验拦下（至于系统那边成不成是另一回事）
        assert!(entry(&"x".repeat(MAX_ID_CHARS)).is_ok());
    }

    #[test]
    fn empty_key_is_a_delete() {
        // 空密钥不该往凭据库里塞一条空记录，等价于清除
        assert!(set("codovo-test-empty", "   ").is_ok());
        // 清除一个本来就没有的条目也算成功
        assert!(delete("codovo-test-not-there").is_ok());
    }
}
