use automemorydoll_compiler::preview::render_preview;
use serde_json::Value;
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::process::Command;
use uuid::Uuid;

#[test]
fn render_in_child() {
    let Some(root) = std::env::var_os("PREVIEW_TEST_ROOT") else {
        return;
    };
    let root = std::path::PathBuf::from(root);
    render_preview(b"%PDF-fixture", &root.join("scratch"), &root.join("output")).unwrap();
}

#[test]
fn preview_publishes_only_after_both_converters_succeed() {
    for fail in [false, true] {
        let root = std::env::temp_dir().join(format!("amd-preview-{}", Uuid::new_v4()));
        fs::create_dir_all(root.join("bin")).unwrap();
        fs::create_dir(root.join("output")).unwrap();
        for (name, script) in [
            ("pdftoppm", "#!/bin/sh\n[ \"$1 $2 $3 $4 $5 $6 $7 $8\" = '-f 1 -l 1 -singlefile -scale-to 768 -png' ] || exit 3\nprintf png > \"${10}.png\"\n".to_string()),
            ("cwebp", if fail { "#!/bin/sh\nexit 9\n".to_string() } else { "#!/bin/sh\n[ \"$1 $2\" = '-q 80' ] || exit 3\nprintf 'RIFF1234WEBPfixture' > \"$5\"\n".to_string() }),
        ] {
            let path = root.join("bin").join(name);
            fs::write(&path, script).unwrap();
            fs::set_permissions(path, fs::Permissions::from_mode(0o700)).unwrap();
        }
        let result = Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "render_in_child", "--nocapture"])
            .env("PREVIEW_TEST_ROOT", &root)
            .env("PATH", root.join("bin"))
            .output()
            .unwrap();
        assert_eq!(
            result.status.success(),
            !fail,
            "{}",
            String::from_utf8_lossy(&result.stderr)
        );
        let output = root.join("output");
        assert_eq!(output.join("preview.webp").exists(), !fail);
        assert!(!fs::read_dir(&output).unwrap().any(|entry| {
            entry
                .unwrap()
                .path()
                .extension()
                .is_some_and(|ext| ext == "pdf")
        }));
        if !fail {
            let manifest: Value =
                serde_json::from_slice(&fs::read(output.join("result.json")).unwrap()).unwrap();
            assert_eq!(manifest["filename"], "preview.webp");
            assert_eq!(manifest["result"], "ok");
        }
        fs::remove_dir_all(root).unwrap();
    }
}

#[test]
fn real_renderer_uses_only_first_page_and_preserves_orientation() {
    if std::env::var_os("RUN_PREVIEW_RENDERER_TESTS").is_none() {
        eprintln!("set RUN_PREVIEW_RENDERER_TESTS=1 with pdftoppm, cwebp and dwebp available");
        return;
    }
    for (width, height) in [(300, 600), (600, 300)] {
        let root = std::env::temp_dir().join(format!("amd-real-preview-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let pdf = test_pdf(width, height);
        render_preview(&pdf, &root.join("scratch"), &root.join("output")).unwrap();
        let decoded = root.join("decoded.ppm");
        let result = Command::new("dwebp")
            .arg(root.join("output/preview.webp"))
            .arg("-ppm")
            .arg("-o")
            .arg(&decoded)
            .output()
            .unwrap();
        assert!(
            result.status.success(),
            "{}",
            String::from_utf8_lossy(&result.stderr)
        );
        let bytes = fs::read(decoded).unwrap();
        let header = String::from_utf8_lossy(&bytes[..bytes.len().min(100)]);
        let dimensions = if width < height { "384 768" } else { "768 384" };
        assert!(header.contains(dimensions), "{header}");
        // Page one is white and page two is black: verify the selected page independently.
        let pixels_start = bytes.windows(4).position(|w| w == b"255\n").unwrap() + 4;
        assert!(bytes[pixels_start..].iter().all(|value| *value > 245));
        assert!(!root.join("scratch/preview.pdf").exists());
        assert!(!root.join("scratch/preview-page.png").exists());
        fs::remove_dir_all(root).unwrap();
    }
}

fn test_pdf(width: u32, height: u32) -> Vec<u8> {
    let black = format!("0 0 0 rg 0 0 {width} {height} re f");
    let objects = [
        "<< /Type /Catalog /Pages 2 0 R >>".to_string(),
        "<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>".to_string(),
        format!("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 {width} {height}] /Contents 5 0 R >>"),
        format!("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 {width} {height}] /Contents 6 0 R >>"),
        "<< /Length 0 >>\nstream\n\nendstream".to_string(),
        format!("<< /Length {} >>\nstream\n{black}\nendstream", black.len()),
    ];
    let mut pdf = b"%PDF-1.4\n".to_vec();
    let mut offsets = vec![0];
    for (i, object) in objects.iter().enumerate() {
        offsets.push(pdf.len());
        pdf.extend_from_slice(format!("{} 0 obj\n{object}\nendobj\n", i + 1).as_bytes());
    }
    let xref = pdf.len();
    pdf.extend_from_slice(b"xref\n0 7\n0000000000 65535 f \n");
    for offset in &offsets[1..] {
        pdf.extend_from_slice(format!("{offset:010} 00000 n \n").as_bytes());
    }
    pdf.extend_from_slice(
        format!("trailer\n<< /Size 7 /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n").as_bytes(),
    );
    pdf
}

#[test]
fn cli_rejects_unknown_preview_arguments_before_loading_job() {
    let root = std::env::temp_dir().join(format!("amd-preview-args-{}", Uuid::new_v4()));
    fs::create_dir(&root).unwrap();
    let result = Command::new(env!("CARGO_BIN_EXE_automemorydoll-compiler"))
        .arg(root.join("missing-input"))
        .arg(&root)
        .arg("--unknown")
        .output()
        .unwrap();
    assert!(!result.status.success());
    let manifest: Value =
        serde_json::from_slice(&fs::read(root.join("result.json")).unwrap()).unwrap();
    assert_eq!(manifest["result"], "failed");
    assert!(manifest["message"].as_str().unwrap().contains("arguments"));
    fs::remove_dir_all(root).unwrap();
}
