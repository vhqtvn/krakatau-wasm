// Binary test version for debugging assembly
use serde::{Deserialize, Serialize};
use std::env;
use std::fs;
use std::process;

// We need to include the library modules directly for the binary
#[path = "../krakatau_lib/mod.rs"]
mod krakatau_lib;

// Import the original library functionality
use krakatau_lib::*;
use base64::Engine;

#[derive(Debug, Deserialize, Serialize)]
pub struct AssembleRequest {
    pub file_path: String,
    pub source_code: String,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct AssembleResponse {
    pub success: bool,
    pub file_path: String,
    pub class_files: Option<Vec<ClassFileResult>>,
    pub error: Option<String>,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct ClassFileResult {
    pub name: Option<String>,
    pub base64_content: String,
}

impl AssembleResponse {
    pub fn success(file_path: String, class_files: Vec<ClassFileResult>) -> Self {
        Self {
            success: true,
            file_path,
            class_files: Some(class_files),
            error: None,
        }
    }

    pub fn error(file_path: String, error: String) -> Self {
        Self {
            success: false,
            file_path,
            class_files: None,
            error: Some(error),
        }
    }
}

fn encode_base64(data: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(data)
}

fn assemble_json_json(request_json: &str) -> String {
    println!("Received JSON: {}", request_json);

    // Parse JSON
    let request: AssembleRequest = match serde_json::from_str(request_json) {
        Ok(req) => req,
        Err(e) => {
            let error_response = AssembleResponse::error(
                "unknown".to_string(),
                format!("JSON parse error: {}", e),
            );
            return serde_json::to_string(&error_response).unwrap_or_default();
        }
    };

    println!("Parsed request: file_path={}", request.file_path);

    // Set up assembly options using original library types
    let opts = AssemblerOptions {};

    println!("Calling original library assemble function...");

    // Perform assembly using original library
    let response = match assemble(&request.source_code, opts) {
        Ok(classes) => {
            println!("Assemble returned {} classes", classes.len());
            let mut class_results = Vec::new();

            for (name, data) in classes {
                let base64_content = encode_base64(&data);
                println!("Class: {:?}, size: {} bytes, base64: {} chars",
                    name, data.len(), base64_content.len());
                class_results.push(ClassFileResult {
                    name,
                    base64_content,
                });
            }

            AssembleResponse::success(request.file_path.clone(), class_results)
        }
        Err(err) => {
            println!("Assemble returned error: {:?}", err);
            AssembleResponse::error(
                request.file_path.clone(),
                format!("Assembly error: {:?}", err),
            )
        }
    };

    serde_json::to_string(&response).unwrap_or_default()
}

fn main() {
    let args: Vec<String> = env::args().collect();

    if args.len() != 2 {
        eprintln!("Usage: {} <assembly_file>", args[0]);
        process::exit(1);
    }

    let assembly_file = &args[1];

    // Check if assembly file exists
    if !fs::metadata(assembly_file).is_ok() {
        eprintln!("Error: Assembly file '{}' not found", assembly_file);
        process::exit(1);
    }

    println!("Reading assembly file: {}", assembly_file);

    // Read assembly source code
    let source_code = match fs::read_to_string(assembly_file) {
        Ok(code) => {
            println!("Read {} chars from assembly file", code.len());
            code
        }
        Err(e) => {
            eprintln!("Error reading assembly file: {}", e);
            process::exit(1);
        }
    };

    // Create JSON request
    let request = AssembleRequest {
        file_path: assembly_file.clone(),
        source_code,
    };

    let request_json = serde_json::to_string(&request).unwrap_or_default();
    println!("JSON request: {}", request_json);

    // Call assemble function
    println!("\n=== Calling assemble function ===");
    let response_json = assemble_json_json(&request_json);
    println!("=== Function returned ===\n");

    // Parse and display response
    match serde_json::from_str::<AssembleResponse>(&response_json) {
        Ok(response) => {
            if response.success {
                println!("SUCCESS: Assembled {}", response.file_path);
                if let Some(class_files) = response.class_files {
                    println!("Generated {} class files:", class_files.len());
                    for class_file in class_files {
                        println!("  - Class: {:?}, {} bytes (base64 encoded)",
                            class_file.name, class_file.base64_content.len());

                        // Optionally decode and write first 100 bytes to verify
                        if let Ok(decoded) = base64::engine::general_purpose::STANDARD.decode(&class_file.base64_content) {
                            println!("    First {} bytes: {:?}",
                                std::cmp::min(100, decoded.len()),
                                &decoded[..std::cmp::min(100, decoded.len())]);
                        }
                    }
                }
            } else {
                eprintln!("ERROR: {}", response.error.unwrap_or_default());
                process::exit(1);
            }
        }
        Err(e) => {
            eprintln!("ERROR: Failed to parse response JSON: {}", e);
            process::exit(1);
        }
    }
}