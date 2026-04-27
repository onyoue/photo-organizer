use serde::Serialize;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum AppError {
    #[error("path is not a directory: {0}")]
    NotADirectory(String),

    #[error("io error: {0}")]
    Io(#[from] std::io::Error),

    #[error("image error: {0}")]
    Image(String),

    #[error("trash error: {0}")]
    Trash(String),

    #[error("destination already exists: {0}")]
    DestinationExists(String),

    #[error("source and destination are the same")]
    SameSourceAndDestination,
}

impl Serialize for AppError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(&self.to_string())
    }
}

pub type AppResult<T> = Result<T, AppError>;
