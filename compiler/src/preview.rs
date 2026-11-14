use crate::output::write_manifest;
use std::fs;
use std::path::Path;
use std::process::{Command, Stdio};

pub fn render_preview(pdf: &[u8], scratch: &Path, output: &Path) -> Result<(), String> {
    fs::create_dir_all(scratch).map_err(|error| error.to_string())?;
    fs::create_dir_all(output).map_err(|error| error.to_string())?;
    let pdf_path = scratch.join("preview.pdf");
    let prefix = scratch.join("preview-page");
    let png = prefix.with_extension("png");
    let temporary = output.join(".preview.webp.tmp");
    let final_image = output.join("preview.webp");
    let result = (|| {
        fs::write(&pdf_path, pdf).map_err(|error| error.to_string())?;
        let status = Command::new("pdftoppm")
            .args([
                "-f",
                "1",
                "-l",
                "1",
                "-singlefile",
                "-scale-to",
                "768",
                "-png",
            ])
            .arg(&pdf_path)
            .arg(&prefix)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map_err(|error| format!("cannot start preview renderer: {error}"))?;
        if !status.success() {
            return Err("PDF preview rendering failed".into());
        }
        let status = Command::new("cwebp")
            .args(["-q", "80"])
            .arg(&png)
            .arg("-o")
            .arg(&temporary)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map_err(|error| format!("cannot start WebP encoder: {error}"))?;
        if !status.success() {
            return Err("WebP preview encoding failed".into());
        }
        fs::rename(&temporary, &final_image).map_err(|error| error.to_string())?;
        write_manifest(output, "ok", Some("preview.webp"), "Preview generated")
            .map_err(|error| error.to_string())?;
        Ok(())
    })();
    let _ = fs::remove_file(pdf_path);
    let _ = fs::remove_file(png);
    let _ = fs::remove_file(temporary);
    if result.is_err() {
        let _ = fs::remove_file(final_image);
    }
    result
}
