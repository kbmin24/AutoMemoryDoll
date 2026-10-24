use serde_json::json;
use std::error::Error;
use std::fmt;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};

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
    let filename = format!("{}.pdf", random_uuid()?);
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
    fs::create_dir_all(output)?;
    for entry in fs::read_dir(output)? {
        let entry = entry?;
        if entry.path().extension().is_some_and(|ext| ext == "pdf") {
            fs::remove_file(entry.path())?;
        }
    }
    write_manifest(output, "failed", None, message)
}

fn write_manifest(
    output: &Path,
    result: &str,
    filename: Option<&str>,
    message: &str,
) -> Result<(), OutputError> {
    let bytes = serde_json::to_vec(&json!({
        "result": result,
        "filename": filename,
        "message": message,
    }))?;
    let temp = output.join(format!(".result-{}.tmp", random_uuid()?));
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

fn random_uuid() -> io::Result<String> {
    let mut bytes = [0u8; 16];
    File::open("/dev/urandom")?.read_exact(&mut bytes)?;
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    Ok(format!(
        "{:02x}{:02x}{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}",
        bytes[0],
        bytes[1],
        bytes[2],
        bytes[3],
        bytes[4],
        bytes[5],
        bytes[6],
        bytes[7],
        bytes[8],
        bytes[9],
        bytes[10],
        bytes[11],
        bytes[12],
        bytes[13],
        bytes[14],
        bytes[15]
    ))
}
