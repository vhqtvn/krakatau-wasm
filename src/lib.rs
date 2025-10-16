// Simple WASM interface using the original Krakatau library
use serde::{Deserialize, Serialize};

// Include the original library with the expected path
mod krakatau_lib;

// Re-export the original library functionality
pub use krakatau_lib::*;

// Simple heap-based memory management
static mut HEAP_OFFSET: usize = 0;
static mut RESPONSE_PTR: *mut u8 = std::ptr::null_mut();
static mut RESPONSE_LEN: usize = 0;

// Get the heap base from the WASM linker
extern "C" {
    static __heap_base: u8;
}

fn simple_allocate(size: usize) -> *mut u8 {
    unsafe {
        let heap_base = &__heap_base as *const u8 as usize;
        if HEAP_OFFSET == 0 {
            HEAP_OFFSET = heap_base;
        }

        // Align to 8 bytes for better compatibility
        let aligned_size = ((size + 7) / 8) * 8;

        // Check if we have enough memory (simple bounds check)
        let memory_size = 128 * 1024 * 1024; // 128MB
        if HEAP_OFFSET + aligned_size > heap_base + memory_size {
            return std::ptr::null_mut();
        }

        let ptr = HEAP_OFFSET as *mut u8;
        HEAP_OFFSET += aligned_size;
        ptr
    }
}

#[derive(Debug, Deserialize)]
pub struct DecompileRequest {
    pub file_path: String,
    pub base64_content: String,
    #[serde(default)]
    pub roundtrip: bool,
    #[serde(default)]
    pub no_short_code_attr: bool,
}

#[derive(Debug, Serialize)]
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

#[no_mangle]
pub extern "C" fn allocate_input_buffer(data_len: usize) -> *mut u8 {
    if data_len == 0 {
        return std::ptr::null_mut();
    }

    if data_len >= 65536 {
        return std::ptr::null_mut(); // Error: input too large
    }

    simple_allocate(data_len)
}

#[no_mangle]
pub extern "C" fn decompile_json(
    json_ptr: *const u8,
    json_len: usize,
) -> i32 {
    if json_ptr.is_null() || json_len == 0 {
        return -1; // Error: null or empty input
    }

    // Read JSON input directly from provided pointer
    let json_data = unsafe {
        std::slice::from_raw_parts(json_ptr, json_len)
    };

    // Parse JSON
    let request: DecompileRequest = match serde_json::from_slice(json_data) {
        Ok(req) => req,
        Err(e) => {
            let error_response = DecompileResponse::error(
                "unknown".to_string(),
                format!("JSON parse error: {}", e),
            );
            return store_response(error_response);
        }
    };

    // Decode base64 content
    let class_data = match decode_base64(&request.base64_content) {
        Ok(data) => data,
        Err(e) => {
            let error_response = DecompileResponse::error(
                request.file_path.clone(),
                format!("Base64 decode error: {}", e),
            );
            return store_response(error_response);
        }
    };

    // Set up decompilation options using original library types
    let opts = krakatau_lib::DisassemblerOptions {
        roundtrip: request.roundtrip,
    };
    let parse_opts = krakatau_lib::ParserOptions {
        no_short_code_attr: request.no_short_code_attr,
    };

    // Perform real decompilation using original library
    let response = match krakatau_lib::disassemble(&class_data, parse_opts, opts) {
        Ok((_name, out)) => {
            // Convert the output bytes to UTF-8 string
            match String::from_utf8(out) {
                Ok(output) => {
                    DecompileResponse::success(request.file_path.clone(), output)
                }
                Err(e) => {
                    DecompileResponse::error(
                        request.file_path.clone(),
                        format!("Output encoding error: {}", e),
                    )
                }
            }
        }
        Err(err) => {
            DecompileResponse::error(
                request.file_path.clone(),
                format!("Decompilation error: {:?}", err),
            )
        }
    };
    store_response(response)
}

#[no_mangle]
pub extern "C" fn get_response_length() -> i32 {
    unsafe {
        RESPONSE_LEN as i32
    }
}

#[no_mangle]
pub extern "C" fn get_response_ptr() -> *const u8 {
    unsafe {
        RESPONSE_PTR
    }
}

#[no_mangle]
pub extern "C" fn free_response() {
    unsafe {
        RESPONSE_LEN = 0;
        RESPONSE_PTR = std::ptr::null_mut();
        // Note: We don't actually free the memory in this simple allocator
    }
}

fn store_response(response: DecompileResponse) -> i32 {
    // Serialize response to JSON
    let json_string = match serde_json::to_string(&response) {
        Ok(json) => json,
        Err(e) => {
            let fallback = DecompileResponse::error(
                "unknown".to_string(),
                format!("JSON serialization error: {}", e),
            );
            serde_json::to_string(&fallback).unwrap_or_default()
        }
    };

    let json_bytes = json_string.into_bytes();
    let len = json_bytes.len();

    // Store in allocated memory
    unsafe {
        if len >= 65536 {
            return -1; // Error: response too large
        }

        // Allocate memory for response
        let response_buffer = simple_allocate(len);

        // Copy data to allocated buffer
        let response_slice = std::slice::from_raw_parts_mut(response_buffer, len);
        response_slice.copy_from_slice(&json_bytes);
        RESPONSE_PTR = response_buffer;
        RESPONSE_LEN = len;

        len as i32
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