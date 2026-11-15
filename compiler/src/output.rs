use serde_json::json;
use std::error::Error;
use std::fmt;
use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use uuid::Uuid;

#[derive(Debug)]
pub enum OutputError {
    Io(io::Error),
    Json(serde_json::Error),
}

impl fmt::Display for OutputError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Io(source) => write!(f, "output I/O error: {source}"),
            Self::Json(source) => write!(f, "result manifest error: {source}"),
        }
    }
}

impl Error for OutputError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Io(source) => Some(source),
            Self::Json(source) => Some(source),
        }
    }
}

impl From<io::Error> for OutputError {
    fn from(source: io::Error) -> Self {
        Self::Io(source)
    }
}

impl From<serde_json::Error> for OutputError {
    fn from(source: serde_json::Error) -> Self {
        Self::Json(source)
    }
}

pub fn write_success(output: &Path, pdf: &[u8]) -> Result<PathBuf, OutputError> {
    fs::create_dir_all(output)?;
    let filename = format!("{}.pdf", Uuid::new_v4());
    let path = output.join(&filename);
    let temp = output.join(format!(".{filename}.tmp"));
    let result = (|| {
        write_new_file(&temp, pdf)?;
        fs::rename(&temp, &path)?;
        write_manifest(output, "ok", Some(&filename), "PDF generated")?;
        Ok(path.clone())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temp);
        let _ = fs::remove_file(&path);
    }
    result
}

pub fn write_failure(output: &Path, message: &str) -> Result<(), OutputError> {
    write_failure_at_stage(output, message, None)
}

pub fn write_failure_at_stage(
    output: &Path,
    message: &str,
    stage: Option<&str>,
) -> Result<(), OutputError> {
    fs::create_dir_all(output)?;
    for entry in fs::read_dir(output)? {
        let entry = entry?;
        if entry
            .path()
            .extension()
            .is_some_and(|ext| ext == "pdf" || ext == "webp")
        {
            fs::remove_file(entry.path())?;
        }
    }
    let characters: Vec<_> = message.chars().collect();
    let bounded = if characters.len() > 8000 {
        format!(
            "[truncated]\n{}",
            characters[characters.len() - 7988..]
                .iter()
                .collect::<String>()
        )
    } else {
        message.to_owned()
    };
    write_manifest_at_stage(output, "failed", None, &bounded, stage)
}

pub(crate) fn write_manifest(
    output: &Path,
    result: &str,
    filename: Option<&str>,
    message: &str,
) -> Result<(), OutputError> {
    write_manifest_at_stage(output, result, filename, message, None)
}

fn write_manifest_at_stage(
    output: &Path,
    result: &str,
    filename: Option<&str>,
    message: &str,
    stage: Option<&str>,
) -> Result<(), OutputError> {
    let mut manifest = json!({
        "result": result,
        "filename": filename,
        "message": message,
    });
    if let Some(stage) = stage {
        manifest["stage"] = json!(stage);
    }
    let bytes = serde_json::to_vec(&manifest)?;
    let temp = output.join(format!(".result-{}.tmp", Uuid::new_v4()));
    let result = (|| {
        write_new_file(&temp, &bytes)?;
        fs::rename(&temp, output.join("result.json"))?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temp);
    }
    result
}

fn write_new_file(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let mut file = OpenOptions::new().write(true).create_new(true).open(path)?;
    file.write_all(bytes)?;
    file.sync_all()
}
