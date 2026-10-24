use automemorydoll_compiler::job::Job;
use automemorydoll_compiler::output::{write_failure, write_success};
use serde_json::{Value, json};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

static NEXT_ID: AtomicU64 = AtomicU64::new(0);

struct TestDir(PathBuf);

impl TestDir {
    fn new() -> Self {
        let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!(
            "automemorydoll-job-contract-{}-{id}",
            std::process::id()
        ));
        fs::create_dir(&path).unwrap();
        Self(path)
    }

    fn path(&self) -> &Path {
        &self.0
    }

    fn job(&self, data: &str) {
        fs::create_dir(self.path().join("template")).unwrap();
        fs::write(
            self.path().join("template/template.tex"),
            "Hello {{ name }}",
        )
        .unwrap();
        fs::write(self.path().join("data.json"), data).unwrap();
    }
}

impl Drop for TestDir {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).unwrap();
    }
}

#[test]
fn loads_template_and_object_data_without_rewriting_keys() {
    let root = TestDir::new();
    root.job(r#"{"name":"Ada","profile.name":"Grace","count":3}"#);

    let job = Job::load(root.path()).unwrap();
    assert_eq!(job.source, "Hello {{ name }}");
    assert_eq!(job.data["name"], json!("Ada"));
    assert_eq!(job.data["profile.name"], json!("Grace"));
    assert_eq!(job.data["count"], json!(3));
}

#[test]
fn rejects_missing_template() {
    let root = TestDir::new();
    fs::write(root.path().join("data.json"), "{}").unwrap();
    let error = Job::load(root.path()).unwrap_err().to_string();
    assert!(error.contains("template.tex"), "{error}");
}

#[test]
fn rejects_missing_and_invalid_json() {
    let root = TestDir::new();
    root.job("{");
    let error = Job::load(root.path()).unwrap_err().to_string();
    assert!(error.contains("data.json"), "{error}");

    fs::remove_file(root.path().join("data.json")).unwrap();
    let error = Job::load(root.path()).unwrap_err().to_string();
    assert!(error.contains("data.json"), "{error}");
}

#[test]
fn rejects_non_object_json() {
    for data in ["[]", "null", "42", "\"text\""] {
        let root = TestDir::new();
        root.job(data);
        let error = Job::load(root.path()).unwrap_err().to_string();
        assert!(error.contains("object"), "{data}: {error}");
    }
}

#[test]
fn success_writes_uuid_pdf_and_exact_manifest_fields() {
    let output = TestDir::new();
    let pdf_path = write_success(output.path(), b"%PDF-test").unwrap();
    let name = pdf_path.file_name().unwrap().to_str().unwrap();
    assert!(looks_like_uuid_pdf(name), "{name}");
    assert_eq!(fs::read(&pdf_path).unwrap(), b"%PDF-test");

    let manifest: Value =
        serde_json::from_slice(&fs::read(output.path().join("result.json")).unwrap()).unwrap();
    assert_eq!(manifest.as_object().unwrap().len(), 3);
    assert_eq!(manifest["result"], "ok");
    assert_eq!(manifest["filename"], name);
    assert!(manifest["message"].as_str().unwrap().contains("PDF"));
}

#[test]
fn failure_removes_pdf_and_writes_exact_manifest_fields() {
    let output = TestDir::new();
    fs::write(output.path().join("partial.pdf"), b"partial").unwrap();
    write_failure(output.path(), "bad input").unwrap();
    assert!(!output.path().join("partial.pdf").exists());
    let manifest: Value =
        serde_json::from_slice(&fs::read(output.path().join("result.json")).unwrap()).unwrap();
    assert_eq!(manifest.as_object().unwrap().len(), 3);
    assert_eq!(manifest["result"], "failed");
    assert!(manifest["filename"].is_null());
    assert_eq!(manifest["message"], "bad input");
}

#[test]
fn command_reports_job_failure_with_nonzero_exit() {
    let input = TestDir::new();
    let output = TestDir::new();
    input.job("[]");
    let status = std::process::Command::new(env!("CARGO_BIN_EXE_automemorydoll-compiler"))
        .arg(input.path())
        .arg(output.path())
        .status()
        .unwrap();
    assert!(!status.success());
    let manifest: Value =
        serde_json::from_slice(&fs::read(output.path().join("result.json")).unwrap()).unwrap();
    assert_eq!(manifest["result"], "failed");
    assert!(manifest["message"].as_str().unwrap().contains("object"));
}

fn looks_like_uuid_pdf(name: &str) -> bool {
    let Some(uuid) = name.strip_suffix(".pdf") else {
        return false;
    };
    let bytes = uuid.as_bytes();
    bytes.len() == 36
        && bytes.iter().enumerate().all(|(i, c)| {
            if [8, 13, 18, 23].contains(&i) {
                *c == b'-'
            } else {
                c.is_ascii_hexdigit()
            }
        })
        && bytes[14] == b'4'
        && matches!(bytes[19], b'8' | b'9' | b'a' | b'b')
}
