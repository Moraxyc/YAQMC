//! Recoverable local data/credential staging. Secret values never enter the journal.
use crate::credentials::{CredentialError, CredentialStore};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct DataJournal {
    pub data_root: PathBuf,
    pub cache_root: PathBuf,
    pub namespaces: Vec<String>,
}

#[derive(Default, Serialize, Deserialize)]
struct CredentialJournal {
    created: Vec<String>,
    deleted: Vec<String>,
}

pub struct CredentialOverlay {
    original: Arc<dyn CredentialStore>,
    path: PathBuf,
    journal: Mutex<CredentialJournal>,
    namespaces: Vec<String>,
}

impl CredentialOverlay {
    pub fn new(
        original: Arc<dyn CredentialStore>,
        directory: &Path,
        namespaces: Vec<String>,
    ) -> Self {
        Self {
            original,
            path: directory.join("credentials.json"),
            journal: Mutex::new(CredentialJournal::default()),
            namespaces,
        }
    }
    fn persist(&self, journal: &CredentialJournal) -> Result<(), CredentialError> {
        super::atomic_json(&self.path, journal).map_err(|_| CredentialError::OperationFailed)
    }
}

impl CredentialStore for CredentialOverlay {
    fn load(&self, account: &str) -> Result<Option<String>, CredentialError> {
        if !owned_account(account, &self.namespaces) {
            return Err(CredentialError::OperationFailed);
        }
        let journal = self.journal.lock().unwrap_or_else(|p| p.into_inner());
        if journal.deleted.iter().any(|a| a == account) {
            return Ok(None);
        }
        self.original.load(account)
    }
    fn save(&self, account: &str, secret: &str) -> Result<(), CredentialError> {
        if !owned_account(account, &self.namespaces) {
            return Err(CredentialError::OperationFailed);
        }
        let mut journal = self.journal.lock().unwrap_or_else(|p| p.into_inner());
        if self.original.load(account)?.is_some() {
            return Err(CredentialError::OperationFailed);
        }
        journal.created.push(account.to_owned());
        self.persist(&journal)?;
        self.original.save(account, secret)
    }
    fn delete(&self, account: &str) -> Result<(), CredentialError> {
        if !owned_account(account, &self.namespaces) {
            return Err(CredentialError::OperationFailed);
        }
        let mut journal = self.journal.lock().unwrap_or_else(|p| p.into_inner());
        if !journal.deleted.iter().any(|a| a == account) {
            journal.deleted.push(account.to_owned());
        }
        self.persist(&journal)
    }
}

pub fn recover_credentials(
    directory: &Path,
    credentials: &dyn CredentialStore,
    committed: bool,
) -> Result<(), String> {
    let path = directory.join("credentials.json");
    if !path.exists() {
        return Ok(());
    }
    let journal: CredentialJournal =
        serde_json::from_slice(&fs::read(&path).map_err(|_| "update-journal-unreadable")?)
            .map_err(|_| "update-journal-invalid")?;
    let data: DataJournal = serde_json::from_slice(
        &fs::read(directory.join("data-journal.json")).map_err(|_| "update-journal-unreadable")?,
    )
    .map_err(|_| "update-journal-invalid")?;
    if journal
        .created
        .iter()
        .chain(&journal.deleted)
        .any(|a| !owned_account(a, &data.namespaces))
    {
        return Err("update-credential-journal-invalid".into());
    }
    let accounts = if committed {
        &journal.deleted
    } else {
        &journal.created
    };
    for account in accounts {
        credentials
            .delete(account)
            .map_err(|_| "update-credential-cleanup-failed")?;
    }
    fs::remove_file(path).map_err(|_| "update-journal-cleanup-failed".into())
}

fn owned_account(account: &str, namespaces: &[String]) -> bool {
    let Some((namespace, handle)) = account
        .strip_prefix("plugin-component:")
        .and_then(|s| s.split_once(':'))
    else {
        return false;
    };
    super::valid_sha256(namespace)
        && namespaces.iter().any(|n| n == namespace)
        && handle.strip_prefix("cred_").is_some_and(|h| {
            h.len() == 48
                && h.bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        })
}

fn is_link(metadata: &fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        metadata.file_attributes() & 0x400 != 0
    }
    #[cfg(not(windows))]
    {
        metadata.file_type().is_symlink()
    }
}

pub fn copy_tree(source: &Path, target: &Path) -> Result<(), String> {
    if !source.exists() {
        return Ok(());
    }
    let metadata = fs::symlink_metadata(source).map_err(|_| "update-data-unreadable")?;
    if is_link(&metadata) {
        return Err("update-data-link-denied".into());
    }
    if metadata.is_file() {
        fs::create_dir_all(target.parent().ok_or("update-data-path-invalid")?)
            .map_err(|_| "update-data-write-failed")?;
        fs::copy(source, target).map_err(|_| "update-data-copy-failed")?;
        fs::OpenOptions::new()
            .write(true)
            .open(target)
            .and_then(|f| f.sync_all())
            .map_err(|_| "update-data-sync-failed")?;
    } else if metadata.is_dir() {
        fs::create_dir_all(target).map_err(|_| "update-data-write-failed")?;
        for entry in fs::read_dir(source).map_err(|_| "update-data-unreadable")? {
            let entry = entry.map_err(|_| "update-data-unreadable")?;
            copy_tree(&entry.path(), &target.join(entry.file_name()))?;
        }
    } else {
        return Err("update-data-type-denied".into());
    }
    Ok(())
}

fn remove_owned(path: &Path) -> Result<(), String> {
    if !path.exists() {
        return Ok(());
    }
    let meta = fs::symlink_metadata(path).map_err(|_| "update-data-unreadable")?;
    if is_link(&meta) {
        return Err("update-data-link-denied".into());
    }
    if meta.is_dir() {
        fs::remove_dir_all(path)
    } else {
        fs::remove_file(path)
    }
    .map_err(|_| "update-data-remove-failed".into())
}

impl DataJournal {
    pub fn prepare(&self, directory: &Path) -> Result<(), String> {
        for namespace in &self.namespaces {
            if !super::valid_sha256(namespace) {
                return Err("update-namespace-invalid".into());
            }
            for suffix in ["kv.json", "credentials.json"] {
                let name = format!("{namespace}.{suffix}");
                copy_tree(
                    &self.data_root.join(&name),
                    &directory.join("backup-data").join(&name),
                )?;
                copy_tree(
                    &self.data_root.join(&name),
                    &directory.join("data").join(&name),
                )?;
            }
            copy_tree(
                &self.cache_root.join(namespace),
                &directory.join("backup-cache").join(namespace),
            )?;
            copy_tree(
                &self.cache_root.join(namespace),
                &directory.join("cache").join(namespace),
            )?;
        }
        super::atomic_json(&directory.join("data-journal.json"), self)
    }
    pub fn install(&self, directory: &Path, restore: bool) -> Result<(), String> {
        for namespace in &self.namespaces {
            if !super::valid_sha256(namespace) {
                return Err("update-namespace-invalid".into());
            }
            for suffix in ["kv.json", "credentials.json"] {
                let name = format!("{namespace}.{suffix}");
                let target = self.data_root.join(&name);
                let source = directory
                    .join(if restore { "backup-data" } else { "data" })
                    .join(&name);
                if source.exists() {
                    super::atomic_bytes(
                        &target,
                        &fs::read(source).map_err(|_| "update-data-unreadable")?,
                    )?;
                } else {
                    remove_owned(&target)?;
                }
            }
            let target = self.cache_root.join(namespace);
            remove_owned(&target)?;
            copy_tree(
                &directory
                    .join(if restore { "backup-cache" } else { "cache" })
                    .join(namespace),
                &target,
            )?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::credentials::MemoryCredentialStore;

    #[test]
    fn credentials_commit_and_rollback_use_handles_without_journaling_secrets() {
        for committed in [false, true] {
            let root = tempfile::tempdir().unwrap();
            let namespace = "a".repeat(64);
            let old = format!("plugin-component:{namespace}:cred_{}", "b".repeat(48));
            let new = format!("plugin-component:{namespace}:cred_{}", "c".repeat(48));
            let store = Arc::new(MemoryCredentialStore::default());
            store.save(&old, "old-private-secret").unwrap();
            let data = DataJournal {
                data_root: root.path().join("real"),
                cache_root: root.path().join("cache"),
                namespaces: vec![namespace.clone()],
            };
            data.prepare(root.path()).unwrap();
            let overlay = CredentialOverlay::new(store.clone(), root.path(), vec![namespace]);
            overlay.save(&new, "new-private-secret").unwrap();
            overlay.delete(&old).unwrap();
            assert!(overlay.load(&old).unwrap().is_none());
            assert_eq!(
                store.load(&old).unwrap().as_deref(),
                Some("old-private-secret"),
                "deletion is deferred"
            );
            let journal = fs::read_to_string(root.path().join("credentials.json")).unwrap();
            assert!(!journal.contains("private-secret"));
            assert!(overlay
                .delete(&format!(
                    "plugin-component:{}:cred_{}",
                    "f".repeat(64),
                    "b".repeat(48)
                ))
                .is_err());
            recover_credentials(root.path(), store.as_ref(), committed).unwrap();
            assert_eq!(store.load(&old).unwrap().is_some(), !committed);
            assert_eq!(store.load(&new).unwrap().is_some(), committed);
            recover_credentials(root.path(), store.as_ref(), committed).unwrap();
        }
    }

    #[test]
    fn local_data_stays_staged_and_recovery_is_repeatable() {
        let root = tempfile::tempdir().unwrap();
        let directory = root.path().join("transaction");
        let namespace = "a".repeat(64);
        let name = format!("{namespace}.kv.json");
        let data = DataJournal {
            data_root: root.path().join("real"),
            cache_root: root.path().join("cache"),
            namespaces: vec![namespace],
        };
        fs::create_dir_all(&data.data_root).unwrap();
        fs::write(data.data_root.join(&name), b"old").unwrap();
        data.prepare(&directory).unwrap();
        fs::write(directory.join("data").join(&name), b"new").unwrap();
        assert_eq!(fs::read(data.data_root.join(&name)).unwrap(), b"old");
        data.install(&directory, false).unwrap();
        assert_eq!(fs::read(data.data_root.join(&name)).unwrap(), b"new");
        for _ in 0..2 {
            data.install(&directory, true).unwrap();
            assert_eq!(fs::read(data.data_root.join(&name)).unwrap(), b"old");
        }
    }
}
