use serde_json::{Map, Value};
use std::error::Error;
use std::fmt;
use std::fs;
use std::io;
use std::path::Path;

#[derive(Debug)]
pub struct Job {
    pub source: String,
    pub data: Map<String, Value>,
}

#[derive(Debug)]
pub enum JobError {
    Read {
        file: &'static str,
        source: io::Error,
    },
    InvalidJson(serde_json::Error),
    NonObjectData,
}

impl fmt::Display for JobError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Read { file, source } => write!(f, "cannot read {file}: {source}"),
            Self::InvalidJson(source) => write!(f, "invalid data.json: {source}"),
            Self::NonObjectData => write!(f, "data.json must contain a JSON object"),
        }
    }
}

impl Error for JobError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Read { source, .. } => Some(source),
            Self::InvalidJson(source) => Some(source),
            Self::NonObjectData => None,
        }
    }
}

impl Job {
    pub fn load(root: &Path) -> Result<Self, JobError> {
        let source = fs::read_to_string(root.join("template/template.tex")).map_err(|source| {
            JobError::Read {
                file: "template/template.tex",
                source,
            }
        })?;
        let json = fs::read(root.join("data.json")).map_err(|source| JobError::Read {
            file: "data.json",
            source,
        })?;
        let data: Value = serde_json::from_slice(&json).map_err(JobError::InvalidJson)?;
        let Value::Object(data) = data else {
            return Err(JobError::NonObjectData);
        };
        Ok(Self { source, data })
    }
}
