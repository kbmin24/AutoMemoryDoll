use std::error::Error;
use std::fmt;
use std::fs;
use std::path::Path;
use tectonic::driver::{OutputFormat, ProcessingSessionBuilder};
use tectonic::status::NoopStatusBackend;
use tectonic_bridge_core::{SecuritySettings, SecurityStance};
use tectonic_bundles::dir::DirBundle;

#[derive(Debug)]
pub struct CompileError(String);

impl fmt::Display for CompileError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl Error for CompileError {}

pub fn compile_pdf(
    tex: &str,
    template_dir: &Path,
    bundle_path: &Path,
    scratch_dir: &Path,
) -> Result<Vec<u8>, CompileError> {
    if !bundle_path.is_dir() {
        return Err(CompileError(format!(
            "local TeX bundle directory is unavailable: {}",
            bundle_path.display()
        )));
    }
    fs::create_dir_all(scratch_dir).map_err(|error| {
        CompileError(format!("cannot create private TeX scratch area: {error}"))
    })?;

    let mut status = NoopStatusBackend::default();
    let mut builder = ProcessingSessionBuilder::new_with_security(SecuritySettings::new(
        SecurityStance::DisableInsecures,
    ));
    builder
        .primary_input_buffer(tex.as_bytes())
        .tex_input_name("template.tex")
        .filesystem_root(template_dir)
        .format_name("latex")
        .format_cache_path(scratch_dir)
        .output_format(OutputFormat::Pdf)
        .do_not_write_output_files()
        .shell_escape_disabled()
        .bundle(Box::new(DirBundle::new(bundle_path)));

    let mut session = builder
        .create(&mut status)
        .map_err(|error| CompileError(format!("cannot start TeX compilation: {error:#}")))?;
    let result = session.run(&mut status);
    let mut files = session.into_file_data();
    if let Err(error) = result {
        let log = files
            .remove("template.log")
            .map(|file| String::from_utf8_lossy(&file.data).into_owned())
            .unwrap_or_default();
        let detail = log
            .lines()
            .filter(|line| line.starts_with('!') || line.contains("not found"))
            .take(4)
            .collect::<Vec<_>>()
            .join(" ");
        return Err(CompileError(format!(
            "TeX compilation failed: {error:#}; {detail}"
        )));
    }
    files
        .remove("template.pdf")
        .map(|file| file.data)
        .ok_or_else(|| CompileError("TeX compilation produced no PDF".into()))
}
