use automemorydoll_compiler::compile::compile_pdf;
use automemorydoll_compiler::job::Job;
use automemorydoll_compiler::output::{write_failure, write_success};
use automemorydoll_compiler::render::render_tex;
use std::path::{Path, PathBuf};

fn main() {
    let args: Vec<_> = std::env::args_os().collect();
    let input = args.get(1).map(Path::new).unwrap_or(Path::new("/input"));
    let output = args.get(2).map(Path::new).unwrap_or(Path::new("/output"));
    if let Err(message) = run(input, output) {
        eprintln!("{message}");
        if let Err(error) = write_failure(output, &message) {
            eprintln!("cannot write result.json: {error}");
        }
        std::process::exit(1);
    }
}

fn run(input: &Path, output: &Path) -> Result<(), String> {
    let job = Job::load(input).map_err(|error| error.to_string())?;
    let tex = render_tex(&job.source, &job.data).map_err(|error| error.to_string())?;
    let bundle = std::env::var_os("TECTONIC_BUNDLE_PATH")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("/bundle"));
    let scratch = std::env::var_os("TECTONIC_SCRATCH_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("/tmp/tectonic"));
    let pdf = compile_pdf(&tex, &input.join("template"), &bundle, &scratch)
        .map_err(|error| error.to_string())?;
    write_success(output, &pdf).map_err(|error| error.to_string())?;
    Ok(())
}
