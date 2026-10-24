use automemorydoll_compiler::job::Job;
use automemorydoll_compiler::output::write_failure;
use std::path::Path;

fn main() {
    let args: Vec<_> = std::env::args_os().collect();
    let input = args.get(1).map(Path::new).unwrap_or(Path::new("/input"));
    let output = args.get(2).map(Path::new).unwrap_or(Path::new("/output"));
    let message = match Job::load(input) {
        Ok(_) => "PDF compilation is not implemented yet".to_string(),
        Err(error) => error.to_string(),
    };
    eprintln!("{message}");
    if let Err(error) = write_failure(output, &message) {
        eprintln!("cannot write result.json: {error}");
    }
    std::process::exit(1);
}
