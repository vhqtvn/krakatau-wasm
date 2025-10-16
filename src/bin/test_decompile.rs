// Binary test version for debugging decompilation
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
pub struct DecompileRequest {
    pub file_path: String,
    pub base64_content: String,
    #[serde(default)]
    pub roundtrip: bool,
    #[serde(default)]
    pub no_short_code_attr: bool,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct DecompileResponse {
    pub success: bool,
    pub file_path: String,
    pub output: Option<String>,
    pub error: Option<String>,
}

impl DecompileResponse {
    pub fn success(file_path: String, output: String) -> Self {
        Self {
            success: true,
            file_path,
            output: Some(output),
            error: None,
        }
    }

    pub fn error(file_path: String, error: String) -> Self {
        Self {
            success: false,
            file_path,
            output: None,
            error: Some(error),
        }
    }
}

fn decode_base64(input: &str) -> Result<Vec<u8>, &'static str> {
    let input = input.trim();
    if input.is_empty() {
        return Ok(Vec::new());
    }

    // Remove padding
    let input = input.trim_end_matches('=');

    let mut result = Vec::new();
    let mut buffer = 0u32;
    let mut bits = 0;

    for &c in input.as_bytes() {
        let val = if c >= b'A' && c <= b'Z' {
            c - b'A'
        } else if c >= b'a' && c <= b'z' {
            c - b'a' + 26
        } else if c >= b'0' && c <= b'9' {
            c - b'0' + 52
        } else if c == b'+' {
            62
        } else if c == b'/' {
            63
        } else {
            return Err("Invalid base64 character");
        };

        buffer = (buffer << 6) | (val as u32);
        bits += 6;

        if bits >= 8 {
            bits -= 8;
            result.push((buffer >> bits) as u8);
            buffer &= (1 << bits) - 1;
        }
    }

    Ok(result)
}

fn decompile_json_json(request_json: &str) -> String {
    println!("Received JSON: {}", request_json);

    // Parse JSON
    let request: DecompileRequest = match serde_json::from_str(request_json) {
        Ok(req) => req,
        Err(e) => {
            let error_response = DecompileResponse::error(
                "unknown".to_string(),
                format!("JSON parse error: {}", e),
            );
            return serde_json::to_string(&error_response).unwrap_or_default();
        }
    };

    println!("Parsed request: file_path={}, roundtrip={}, no_short_code_attr={}",
        request.file_path, request.roundtrip, request.no_short_code_attr);

    // Decode base64 content
    let class_data = match decode_base64(&request.base64_content) {
        Ok(data) => {
            println!("Successfully decoded {} bytes from base64", data.len());
            data
        },
        Err(e) => {
            let error_response = DecompileResponse::error(
                request.file_path.clone(),
                format!("Base64 decode error: {}", e),
            );
            return serde_json::to_string(&error_response).unwrap_or_default();
        }
    };

    // Set up decompilation options using original library types
    let opts = DisassemblerOptions {
        roundtrip: request.roundtrip,
    };
    let parse_opts = ParserOptions {
        no_short_code_attr: request.no_short_code_attr,
    };

    println!("Calling original library disassemble function...");

    // Perform real decompilation using original library
    let response = match disassemble(&class_data, parse_opts, opts) {
        Ok((_name, out)) => {
            println!("Disassemble returned {} bytes of output", out.len());
            // Convert the output bytes to UTF-8 string
            match String::from_utf8(out) {
                Ok(output) => {
                    println!("Successfully converted output to UTF-8 string ({} chars)", output.len());
                    DecompileResponse::success(request.file_path.clone(), output)
                }
                Err(e) => {
                    println!("Failed to convert output to UTF-8: {}", e);
                    DecompileResponse::error(
                        request.file_path.clone(),
                        format!("Output encoding error: {}", e),
                    )
                }
            }
        }
        Err(err) => {
            println!("Disassemble returned error: {:?}", err);
            DecompileResponse::error(
                request.file_path.clone(),
                format!("Decompilation error: {:?}", err),
            )
        }
    };

    serde_json::to_string(&response).unwrap_or_default()
}

fn main() {
    let args: Vec<String> = env::args().collect();

    if args.len() != 2 {
        eprintln!("Usage: {} <classfile>", args[0]);
        process::exit(1);
    }

    let class_file = &args[1];

    // Check if class file exists
    if !fs::metadata(class_file).is_ok() {
        eprintln!("Error: Class file '{}' not found", class_file);
        process::exit(1);
    }

    println!("Reading class file: {}", class_file);

    // Read class file
    let class_data = match fs::read(class_file) {
        Ok(data) => {
            println!("Read {} bytes from class file", data.len());
            data
        }
        Err(e) => {
            eprintln!("Error reading class file: {}", e);
            process::exit(1);
        }
    };

    // Convert to base64
    let base64_content = base64::engine::general_purpose::STANDARD.encode(&class_data);
    println!("Converted to base64: {} chars", base64_content.len());

    // Create JSON request
    let request = DecompileRequest {
        file_path: class_file.clone(),
        base64_content,
        roundtrip: false,
        no_short_code_attr: false,
    };

    let request_json = serde_json::to_string(&request).unwrap_or_default();
    println!("JSON request: {}", request_json);

    // Call decompile function
    println!("\n=== Calling decompile function ===");
    let response_json = decompile_json_json(&request_json);
    println!("=== Function returned ===\n");

    // Parse and display response
    match serde_json::from_str::<DecompileResponse>(&response_json) {
        Ok(response) => {
            if response.success {
                println!("SUCCESS: Decompiled {}", response.file_path);
                println!("Output:\n{}", response.output.unwrap_or_default());
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