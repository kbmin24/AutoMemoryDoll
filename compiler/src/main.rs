use automemorydoll_compiler::compile::compile_pdf;
use automemorydoll_compiler::job::Job;
use automemorydoll_compiler::output::{write_failure_at_stage, write_success};
use automemorydoll_compiler::preview::render_preview;
use automemorydoll_compiler::render::render_tex;
use std::path::{Path, PathBuf};

struct Failure {
    stage: &'static str,
    message: String,
}

impl Failure {
    fn service(error: impl std::fmt::Display) -> Self {
        eprintln!("{error}");
        Self {
            stage: "service",
            message: "The compilation service could not generate the document.".into(),
        }
    }
}

fn main() {
    let args: Vec<_> = std::env::args_os().collect();
    let input = args.get(1).map(Path::new).unwrap_or(Path::new("/input"));
    let output = args.get(2).map(Path::new).unwrap_or(Path::new("/output"));
    let preview = args.get(3).is_some_and(|arg| arg == "--preview");
    let result = if args.len() > 4 || (args.len() > 3 && !preview) {
        Err(Failure {
            stage: "input",
            message: "unknown compiler arguments".into(),
        })
    } else {
        run(input, output, preview)
    };
    if let Err(failure) = result {
        eprintln!("{}: {}", failure.stage, failure.message);
        if let Err(error) = write_failure_at_stage(output, &failure.message, Some(failure.stage)) {
            eprintln!("cannot write result.json: {error}");
        }
        std::process::exit(1);
    }
}

fn run(input: &Path, output: &Path, preview: bool) -> Result<(), Failure> {
    let job = Job::load(input).map_err(|error| Failure {
        stage: "input",
        message: error.to_string(),
    })?;
    let tex = render_tex(&job.source, &job.data).map_err(|error| Failure {
        stage: "templating",
        message: format!("{error:#}"),
    })?;
    let bundle = std::env::var_os("TECTONIC_BUNDLE_PATH")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("/bundle"));
    let scratch = std::env::var_os("TECTONIC_SCRATCH_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("/tmp/tectonic"));
    let pdf =
        compile_pdf(&tex, &input.join("template"), &bundle, &scratch).map_err(
            |error| match error.diagnostics() {
                Some(message) => Failure {
                    stage: "latex",
                    message: message.to_owned(),
                },
                None => Failure::service(error),
            },
        )?;
    if preview {
        render_preview(&pdf, &scratch, output).map_err(Failure::service)?;
    } else {
        write_success(output, &pdf).map_err(Failure::service)?;
    }
    Ok(())
}
