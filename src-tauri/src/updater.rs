//! 应用更新只接受后端从固定发布源取得的版本；前端不能传下载地址或公钥。
use std::time::Duration;

use semver::Version;
use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;
use tauri_plugin_updater::{Update, UpdaterExt};
use tokio::sync::Mutex;

const RELEASE_API: &str = "https://api.github.com/repos/siatom/codovo/releases/latest";
const RELEASE_PAGE: &str = "https://github.com/siatom/codovo/releases/latest";
const ASSET_PREFIX: &str = "https://github.com/siatom/codovo/releases/download/";

#[derive(Default)]
pub struct UpdateState(Mutex<Option<Update>>);

#[derive(Deserialize)]
struct Release {
    tag_name: String,
    body: Option<String>,
    assets: Vec<Asset>,
}

#[derive(Deserialize)]
struct Asset {
    browser_download_url: String,
    size: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    version: String,
    notes: String,
    release_url: &'static str,
    size: Option<u64>,
    can_install: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateProgress {
    phase: &'static str,
    downloaded: u64,
    total: Option<u64>,
}

fn release_version(tag: &str) -> Option<Version> {
    Version::parse(tag.strip_prefix('v').unwrap_or(tag)).ok()
}

fn bundle_supports_install(debug: bool, bundle: Option<tauri::utils::config::BundleType>) -> bool {
    use tauri::utils::config::BundleType;
    !debug
        && matches!(
            bundle,
            Some(BundleType::App | BundleType::AppImage | BundleType::Nsis)
        )
}

fn supported_install() -> bool {
    // 开发版不能覆盖安装版；deb/rpm/MSI 和未打包的可执行文件交给发布页升级。
    bundle_supports_install(
        cfg!(debug_assertions),
        tauri::utils::platform::bundle_type(),
    )
}

#[tauri::command]
pub async fn app_update_check(
    app: tauri::AppHandle,
    state: tauri::State<'_, UpdateState>,
) -> Result<Option<UpdateInfo>, String> {
    // 和安装共用一把锁：检查不能在下载过程中替换正在确认的更新。
    let mut pending = state.0.try_lock().map_err(|_| "更新操作正在进行")?;
    let release: Release = reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .user_agent("Codovo-Updater")
        .build()
        .map_err(|e| e.to_string())?
        .get(RELEASE_API)
        .send()
        .await
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| e.to_string())?
        .json()
        .await
        .map_err(|e| e.to_string())?;
    let version = release_version(&release.tag_name).ok_or("发布版本号无效")?;
    if version <= app.package_info().version {
        *pending = None;
        return Ok(None);
    }
    // 旧发布可能没有 latest.json，或缺少本平台产物，仍可通过发布页手动升级。
    let update = if supported_install() {
        let handle = app.clone();
        app.updater_builder()
            .on_before_exit(move || {
                crate::cleanup(&handle);
                handle.cleanup_before_exit();
            })
            .timeout(Duration::from_secs(15))
            .build()
            .map_err(|e| e.to_string())?
            .check()
            .await
            .ok()
            .flatten()
            .filter(|u| {
                release_version(&u.version).as_ref() == Some(&version)
                    && u.download_url.as_str().starts_with(ASSET_PREFIX)
                    && !u.signature.trim().is_empty()
            })
    } else {
        None
    };
    let size = update.as_ref().and_then(|u| {
        release
            .assets
            .iter()
            .find(|a| a.browser_download_url == u.download_url.as_str())
            .map(|a| a.size)
    });
    let info = UpdateInfo {
        version: version.to_string(),
        notes: release.body.unwrap_or_default(),
        release_url: RELEASE_PAGE,
        size,
        can_install: update.is_some(),
    };
    *pending = update;
    Ok(Some(info))
}

#[tauri::command]
pub async fn app_update_install(
    app: tauri::AppHandle,
    state: tauri::State<'_, UpdateState>,
    version: String,
    progress: Channel<UpdateProgress>,
) -> Result<(), String> {
    if !supported_install() {
        return Err("当前安装方式请从发布页升级".into());
    }
    let mut pending = state.0.try_lock().map_err(|_| "更新操作正在进行")?;
    let update = pending.as_mut().ok_or("请先检查更新")?;
    if update.version != version {
        return Err("更新版本已变化，请重新检查".into());
    }
    update.timeout = Some(Duration::from_secs(600));
    let mut downloaded = 0;
    // download 返回前由官方插件验证签名，失败时绝不进入 install。
    let bytes = update
        .download(
            |chunk, total| {
                downloaded += chunk as u64;
                let _ = progress.send(UpdateProgress {
                    phase: "downloading",
                    downloaded,
                    total,
                });
            },
            || {},
        )
        .await
        .map_err(|e| format!("下载或签名验证失败：{e}"))?;
    let _ = progress.send(UpdateProgress {
        phase: "installing",
        downloaded,
        total: Some(downloaded),
    });
    update
        .install(bytes)
        .map_err(|e| format!("安装更新失败：{e}"))?;
    *pending = None;
    // restart 走应用现有 ExitRequested 清理，回收终端、助手与预览子进程。
    app.restart();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_release_tags_and_compares_semver() {
        assert_eq!(release_version("v0.3.0"), release_version("0.3.0"));
        assert!(release_version("v0.10.0") > release_version("v0.9.0"));
        assert!(release_version("v1.0.0") > release_version("v1.0.0-beta.1"));
        assert!(release_version("latest").is_none());
        assert!(release_version("v0.3").is_none());
    }

    #[test]
    fn development_builds_cannot_install_updates() {
        if cfg!(debug_assertions) {
            assert!(!supported_install());
        }
    }

    #[test]
    fn unsupported_packages_only_offer_release_page() {
        use tauri::utils::config::BundleType;
        for bundle in [BundleType::Deb, BundleType::Rpm, BundleType::Msi] {
            assert!(!bundle_supports_install(false, Some(bundle)));
        }
        for bundle in [BundleType::App, BundleType::AppImage, BundleType::Nsis] {
            assert!(!bundle_supports_install(true, Some(bundle.clone())));
            assert!(bundle_supports_install(false, Some(bundle)));
        }
        assert!(!bundle_supports_install(false, None));
    }

    // 走官方插件真实的 HTTP 下载与验签路径；不调用 install，不接触本机应用。
    async fn download_fixture(
        payload: Vec<u8>,
        signature: &str,
        version: &str,
    ) -> Result<Vec<u8>, String> {
        use std::io::{Read, Write};
        use std::net::TcpListener;
        use std::time::Instant;

        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let address = listener.local_addr().unwrap();
        let manifest = serde_json::json!({
            "version": version,
            "platforms": {"test": {"url": format!("http://{address}/artifact"), "signature": signature}}
        }).to_string();
        let server = std::thread::spawn(move || {
            let deadline = Instant::now() + Duration::from_secs(30);
            let mut served = 0;
            while served < 2 && Instant::now() < deadline {
                match listener.accept() {
                    Ok((mut stream, _)) => {
                        stream.set_nonblocking(false).unwrap();
                        stream
                            .set_read_timeout(Some(Duration::from_secs(10)))
                            .unwrap();
                        let mut request = [0; 4096];
                        let count = stream.read(&mut request).unwrap();
                        let is_manifest = String::from_utf8_lossy(&request[..count])
                            .starts_with("GET /manifest ");
                        let body = if is_manifest {
                            manifest.as_bytes()
                        } else {
                            &payload
                        };
                        write!(
                            stream,
                            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                            body.len()
                        )
                        .unwrap();
                        stream.write_all(body).unwrap();
                        served += 1;
                    }
                    Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                        std::thread::sleep(Duration::from_millis(10))
                    }
                    Err(e) => panic!("fixture server: {e}"),
                }
            }
        });
        let mut context = tauri::test::mock_context(tauri::test::noop_assets());
        context.config_mut().plugins.0.insert(
            "updater".into(),
            serde_json::json!({
                "pubkey": include_str!("../test-fixtures/updater/public-key.txt").trim(),
                "requireSignedVersion": true,
                "dangerousInsecureTransportProtocol": true
            }),
        );
        let app = tauri::test::mock_builder()
            .plugin(tauri_plugin_updater::Builder::new().build())
            .build(context)
            .unwrap();
        let result = async {
            let update = app
                .updater_builder()
                .target("test")
                .endpoints(vec![format!("http://{address}/manifest").parse().unwrap()])
                .map_err(|e| e.to_string())?
                .timeout(Duration::from_secs(10))
                .build()
                .map_err(|e| e.to_string())?
                .check()
                .await
                .map_err(|e| e.to_string())?
                .ok_or("fixture has no update")?;
            update
                .download(|_, _| {}, || {})
                .await
                .map_err(|e| e.to_string())
        }
        .await;
        server.join().unwrap();
        result
    }

    #[tokio::test]
    async fn official_updater_accepts_signed_artifact_and_rejects_tampering() {
        let payload = include_bytes!("../test-fixtures/updater/payload.txt").to_vec();
        let signature = include_str!("../test-fixtures/updater/payload.sig").trim();
        assert_eq!(
            download_fixture(payload.clone(), signature, "99.0.0")
                .await
                .unwrap(),
            payload
        );
        assert!(download_fixture(b"tampered".to_vec(), signature, "99.0.0")
            .await
            .is_err());
        assert!(download_fixture(payload.clone(), "", "99.0.0")
            .await
            .is_err());
        assert!(download_fixture(payload, signature, "100.0.0")
            .await
            .is_err());
    }
}
