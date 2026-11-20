//! Reopen native attachment references without resuming network work or changing pending records.
use crate::send_outbox::{validate_file_reference, StoredSendContent};
use std::{fs::File, path::Path};

#[derive(Debug, PartialEq)]
pub(crate) struct AttachmentUnavailable;

impl std::fmt::Display for AttachmentUnavailable {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("Attachment unavailable. Please cancel and upload again.")
    }
}

impl std::error::Error for AttachmentUnavailable {}

/// Keep the opened handles for the executor; do not validate and then reopen by path later.
/// All files are opened before returning, so a failed gallery cannot start a partial retry.
pub(crate) fn open_attachments(
    content: &StoredSendContent,
) -> Result<Vec<File>, AttachmentUnavailable> {
    let descriptors = content.files();
    if descriptors.is_empty() { return Err(AttachmentUnavailable); }
    descriptors.into_iter().map(|descriptor| {
        validate_file_reference(&descriptor.path).map_err(|_| AttachmentUnavailable)?;
        let path = Path::new(&descriptor.path);
        // URI sources require platform handles, not filesystem interpretation.
        if !path.is_absolute() { return Err(AttachmentUnavailable); }
        let file = File::open(path).map_err(|_| AttachmentUnavailable)?;
        let metadata = file.metadata().map_err(|_| AttachmentUnavailable)?;
        if !metadata.is_file() || metadata.len() != descriptor.size { return Err(AttachmentUnavailable); }
        Ok(file)
    }).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;

    fn content(paths: &[(&str, u64)]) -> StoredSendContent {
        serde_json::from_value(serde_json::json!({"type":"GALLERY", "files":paths.iter().enumerate().map(|(i,(path,size))| {
            serde_json::json!({"intent":"FILE", "partId":i.to_string(), "path":path, "name":path, "mimeType":"application/octet-stream", "size":size})
        }).collect::<Vec<_>>()})).unwrap()
    }

    #[test]
    fn reopens_persisted_paths_in_order_without_runtime_registry() {
        let root = tempfile::tempdir().unwrap();
        std::fs::write(root.path().join("first"), b"one").unwrap();
        std::fs::write(root.path().join("second"), b"two!").unwrap();
        let mut files = open_attachments(&content(&[(root.path().join("first").to_str().unwrap(),3),(root.path().join("second").to_str().unwrap(),4)])).unwrap();
        let mut value = String::new();
        files[1].read_to_string(&mut value).unwrap();
        assert_eq!(value, "two!");
    }

    #[test]
    fn external_original_files_are_read_only_references() {
        let external = tempfile::tempdir().unwrap();
        let path = external.path().join("original.bin");
        std::fs::write(&path, b"original").unwrap();
        let before = std::fs::read_dir(external.path()).unwrap().count();
        let files = open_attachments(&content(&[(path.to_str().unwrap(), 8)])).unwrap();
        drop(files);
        assert_eq!(std::fs::read(&path).unwrap(), b"original");
        assert_eq!(std::fs::read_dir(external.path()).unwrap().count(), before);
    }

    #[test]
    fn provider_uris_require_the_platform_handle_resolver() {
        assert!(open_attachments(&content(&[("content://provider/document/42", 4)])).is_err());
        assert!(open_attachments(&content(&[("relative/file", 4)])).is_err());
    }

    #[test]
    fn missing_changed_or_non_filesystem_sources_fail_the_whole_gallery() {
        let root = tempfile::tempdir().unwrap();
        std::fs::write(root.path().join("present"), b"one").unwrap();
        for paths in [vec![("present",3),("missing",1)], vec![("present",4)], vec![("../outside",1)]] {
            let absolute: Vec<_> = paths.iter().map(|(path, size)| (root.path().join(path).to_string_lossy().into_owned(), *size)).collect();
            let refs: Vec<_> = absolute.iter().map(|(path, size)| (path.as_str(), *size)).collect();
            assert!(matches!(open_attachments(&content(&refs)), Err(AttachmentUnavailable)));
        }
    }
}
