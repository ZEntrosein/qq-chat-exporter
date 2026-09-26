use std::path::{Component, Path, PathBuf};

/// 把主导出文件及其实际引用的资源打包为 ZIP。
///
/// 资源路径必须相对于 `base_dir`，无效或不存在的资源会被跳过。
/// 文件复制在阻塞线程中流式完成，避免把大文件整体读入内存。
pub async fn create_zip_with_resources(
    base_dir: PathBuf,
    main_file: PathBuf,
    resource_rel_paths: Vec<String>,
    zip_path: PathBuf,
) -> Result<(), String> {
    tokio::task::spawn_blocking(move || -> Result<(), String> {
        let file = std::fs::File::create(&zip_path).map_err(|e| e.to_string())?;
        let mut zip = zip::ZipWriter::new(file);
        let options = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated);
        let main_name = main_file
            .file_name()
            .map(|name| name.to_string_lossy().to_string())
            .ok_or_else(|| "无效的主文件名".to_string())?;
        zip.start_file(&main_name, options)
            .map_err(|e| e.to_string())?;
        let mut main = std::fs::File::open(&main_file).map_err(|e| e.to_string())?;
        std::io::copy(&mut main, &mut zip).map_err(|e| e.to_string())?;

        for rel in resource_rel_paths {
            let rel_path = Path::new(&rel);
            if rel_path.is_absolute()
                || rel_path.components().any(|component| {
                    matches!(
                        component,
                        Component::ParentDir | Component::RootDir | Component::Prefix(_)
                    )
                })
            {
                continue;
            }
            let src = base_dir.join(rel_path);
            let Ok(mut src) = std::fs::File::open(&src) else {
                continue;
            };
            let entry_name = rel.replace('\\', "/");
            if zip.start_file(&entry_name, options).is_err() {
                continue;
            }
            let _ = std::io::copy(&mut src, &mut zip);
        }
        zip.finish().map_err(|e| e.to_string())?;
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::create_zip_with_resources;
    use std::io::Read;

    #[tokio::test]
    async fn archive_contains_main_file_and_only_safe_existing_resources() {
        let root = std::env::temp_dir().join(format!(
            "qce-export-archive-{}",
            uuid::Uuid::new_v4().simple()
        ));
        let base = root.join("source");
        let resources = base.join("resources").join("images");
        std::fs::create_dir_all(&resources).unwrap();
        std::fs::write(base.join("chat.html"), "<html>chat</html>").unwrap();
        std::fs::write(resources.join("one.txt"), "resource").unwrap();
        std::fs::write(root.join("outside.txt"), "outside").unwrap();
        let archive = root.join("chat.zip");

        create_zip_with_resources(
            base.clone(),
            base.join("chat.html"),
            vec![
                "resources/images/one.txt".to_string(),
                "resources/images/missing.txt".to_string(),
                "../outside.txt".to_string(),
            ],
            archive.clone(),
        )
        .await
        .unwrap();

        let mut zip = zip::ZipArchive::new(std::fs::File::open(&archive).unwrap()).unwrap();
        assert_eq!(zip.len(), 2);
        let mut html = String::new();
        zip.by_name("chat.html")
            .unwrap()
            .read_to_string(&mut html)
            .unwrap();
        assert_eq!(html, "<html>chat</html>");
        let mut resource = String::new();
        zip.by_name("resources/images/one.txt")
            .unwrap()
            .read_to_string(&mut resource)
            .unwrap();
        assert_eq!(resource, "resource");
        assert!(zip.by_name("outside.txt").is_err());

        std::fs::remove_dir_all(root).unwrap();
    }
}
