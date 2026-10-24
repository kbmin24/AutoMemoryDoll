use automemorydoll_compiler::compile::compile_pdf;
use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};
use uuid::Uuid;

struct TestDir(PathBuf);

impl TestDir {
    fn new() -> Self {
        let path =
            std::env::temp_dir().join(format!("automemorydoll-compile-test-{}", Uuid::new_v4()));
        fs::create_dir(&path).unwrap();
        Self(path)
    }

    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for TestDir {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).unwrap();
    }
}

fn bundle_path() -> Option<PathBuf> {
    let path = std::env::var_os("TECTONIC_TEST_BUNDLE").map(PathBuf::from);
    if path.is_none() {
        eprintln!("set TECTONIC_TEST_BUNDLE to run offline compilation tests");
    }
    path
}

#[test]
fn compiles_minimal_document_to_pdf() {
    let Some(bundle) = bundle_path() else { return };
    let root = TestDir::new();
    let template = root.path().join("template");
    let scratch = root.path().join("scratch");
    fs::create_dir(&template).unwrap();
    fs::create_dir(&scratch).unwrap();

    let pdf = compile_pdf(
        "\\documentclass{article}\\begin{document}Hello\\end{document}",
        &template,
        &bundle,
        &scratch,
    )
    .unwrap();
    assert!(pdf.starts_with(b"%PDF-"));
}

#[test]
fn compiles_local_class_and_relative_resource() {
    let Some(bundle) = bundle_path() else { return };
    let root = TestDir::new();
    let template = root.path().join("template");
    let resources = root.path().join("resources");
    let scratch = root.path().join("scratch");
    fs::create_dir(&template).unwrap();
    fs::create_dir(&resources).unwrap();
    fs::create_dir(&scratch).unwrap();
    fs::write(template.join("local.cls"), "\\LoadClass{article}\\endinput").unwrap();
    fs::write(resources.join("fragment.tex"), "Resource loaded.").unwrap();

    let pdf = compile_pdf(
        "\\documentclass{local}\\begin{document}\\input{../resources/fragment.tex}\\end{document}",
        &template,
        &bundle,
        &scratch,
    )
    .unwrap();
    assert!(pdf.starts_with(b"%PDF-"));
}

#[test]
fn shell_escape_cannot_create_a_file() {
    let Some(bundle) = bundle_path() else { return };
    let root = TestDir::new();
    let template = root.path().join("template");
    let scratch = root.path().join("scratch");
    let target = root.path().join("shell-escaped");
    fs::create_dir(&template).unwrap();
    fs::create_dir(&scratch).unwrap();
    let tex = format!(
        "\\documentclass{{article}}\\begin{{document}}\\immediate\\write18{{touch {}}}Hello\\end{{document}}",
        target.display()
    );

    let _ = compile_pdf(&tex, &template, &bundle, &scratch);
    assert!(!target.exists(), "TeX shell escape created a file");
}

#[test]
fn missing_support_file_has_a_readable_error() {
    let Some(bundle) = bundle_path() else { return };
    let root = TestDir::new();
    let template = root.path().join("template");
    let scratch = root.path().join("scratch");
    fs::create_dir(&template).unwrap();
    fs::create_dir(&scratch).unwrap();

    let error = compile_pdf(
        "\\documentclass{article}\\begin{document}\\input{absent-support-file.tex}\\end{document}",
        &template,
        &bundle,
        &scratch,
    )
    .unwrap_err()
    .to_string();
    assert!(error.contains("absent-support-file"), "{error}");
}

#[test]
fn command_writes_pdf_and_success_manifest() {
    let Some(bundle) = bundle_path() else { return };
    let root = TestDir::new();
    let input = root.path().join("input");
    let template = input.join("template");
    let output = root.path().join("output");
    let scratch = root.path().join("scratch");
    fs::create_dir_all(&template).unwrap();
    fs::create_dir(&output).unwrap();
    fs::create_dir(&scratch).unwrap();
    fs::write(
        template.join("template.tex"),
        "\\documentclass{article}\\begin{document}Hello {{ name }}\\end{document}",
    )
    .unwrap();
    fs::write(input.join("data.json"), r#"{"name":"Ada"}"#).unwrap();

    let status = std::process::Command::new(env!("CARGO_BIN_EXE_automemorydoll-compiler"))
        .arg(&input)
        .arg(&output)
        .env("TECTONIC_BUNDLE_PATH", &bundle)
        .env("TECTONIC_SCRATCH_DIR", &scratch)
        .status()
        .unwrap();
    assert!(status.success());
    let manifest: Value =
        serde_json::from_slice(&fs::read(output.join("result.json")).unwrap()).unwrap();
    assert_eq!(manifest["result"], "ok");
    let filename = manifest["filename"].as_str().unwrap();
    assert!(
        fs::read(output.join(filename))
            .unwrap()
            .starts_with(b"%PDF-")
    );
}
