use std::alloc::{alloc, dealloc, Layout};

// Simple WASM interface using the original Krakatau library
use serde::{Deserialize, Serialize};

// Include the original library with the expected path
mod krakatau_lib;

// Re-export the original library functionality
pub use krakatau_lib::*;

static mut RESPONSE_PTR: *mut u8 = std::ptr::null_mut();
static mut RESPONSE_LEN: usize = 0;

#[no_mangle]
pub extern "C" fn allocate_input_buffer(data_len: usize) -> *mut u8 {
    if data_len == 0 || data_len >= 65536 {
        return std::ptr::null_mut();
    }
    unsafe {
        let layout = Layout::array::<u8>(data_len).ok().unwrap();
        let ptr = alloc(layout);
        if ptr.is_null() { std::ptr::null_mut() } else { ptr }
    }
}

#[no_mangle]
pub extern "C" fn free_buffer(ptr: *mut u8, len: usize) {
    if ptr.is_null() || len == 0 { return; }
    unsafe {
        if let Some(layout) = Layout::array::<u8>(len).ok() {
            dealloc(ptr, layout);
        }
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

#[derive(Debug, Deserialize)]
pub struct AssembleRequest {
    pub file_path: String,
    pub source_code: String,
}

#[derive(Debug, Serialize)]
pub struct DecompileResponse {
    pub success: bool,
    pub file_path: String,
    pub output: Option<String>,
    pub error: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct AssembleResponse {
    pub success: bool,
    pub file_path: String,
    pub class_files: Option<Vec<ClassFileResult>>,
    pub error: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct ClassFileResult {
    pub name: Option<String>,
    pub base64_content: String,
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
    const CHARS: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut result = String::new();
    let mut i = 0;

    while i < data.len() {
        let b1 = data[i];
        let b2 = if i + 1 < data.len() { data[i + 1] } else { 0 };
        let b3 = if i + 2 < data.len() { data[i + 2] } else { 0 };

        let bitmap = ((b1 as u32) << 16) | ((b2 as u32) << 8) | (b3 as u32);

        result.push(CHARS[((bitmap >> 18) & 63) as usize] as char);
        result.push(CHARS[((bitmap >> 12) & 63) as usize] as char);
        result.push(if i + 1 < data.len() { CHARS[((bitmap >> 6) & 63) as usize] as char } else { '=' });
        result.push(if i + 2 < data.len() { CHARS[(bitmap & 63) as usize] as char } else { '=' });

        i += 3;
    }

    result
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
pub extern "C" fn assemble_json(
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
    let request: AssembleRequest = match serde_json::from_slice(json_data) {
        Ok(req) => req,
        Err(e) => {
            let error_response = AssembleResponse::error(
                "unknown".to_string(),
                format!("JSON parse error: {}", e),
            );
            return store_assemble_response(error_response);
        }
    };

    // Set up assembly options using original library types
    let opts = krakatau_lib::AssemblerOptions {};

    // Perform assembly using original library
    let response = match krakatau_lib::assemble(&request.source_code, opts) {
        Ok(classes) => {
            let mut class_results = Vec::new();

            for (name, data) in classes {
                let base64_content = encode_base64(&data);
                class_results.push(ClassFileResult {
                    name,
                    base64_content,
                });
            }

            AssembleResponse::success(request.file_path.clone(), class_results)
        }
        Err(err) => {
            AssembleResponse::error(
                request.file_path.clone(),
                format!("Assembly error: {:?}", err),
            )
        }
    };

    store_assemble_response(response)
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

    store_json_response(json_string)
}

fn store_assemble_response(response: AssembleResponse) -> i32 {
    // Serialize response to JSON
    let json_string = match serde_json::to_string(&response) {
        Ok(json) => json,
        Err(e) => {
            let fallback = AssembleResponse::error(
                "unknown".to_string(),
                format!("JSON serialization error: {}", e),
            );
            serde_json::to_string(&fallback).unwrap_or_default()
        }
    };

    store_json_response(json_string)
}

fn store_json_response(json_string: String) -> i32 {
    let json_bytes = json_string.into_bytes();
    let len = json_bytes.len();
    if len >= 524_288 { return -1; }

    unsafe {
        // free previous
        if !RESPONSE_PTR.is_null() && RESPONSE_LEN != 0 {
            if let Some(layout) = Layout::array::<u8>(RESPONSE_LEN).ok() {
                dealloc(RESPONSE_PTR, layout);
            }
        }

        let layout = match Layout::array::<u8>(len) { Ok(l) => l, Err(_) => return -1 };
        let ptr = alloc(layout);
        if ptr.is_null() { return -1; }

        std::ptr::copy_nonoverlapping(json_bytes.as_ptr(), ptr, len);
        RESPONSE_PTR = ptr;
        RESPONSE_LEN = len;
        len as i32
    }
}

#[no_mangle]
pub extern "C" fn free_response() {
    unsafe {
        if !RESPONSE_PTR.is_null() && RESPONSE_LEN != 0 {
            if let Some(layout) = Layout::array::<u8>(RESPONSE_LEN).ok() {
                dealloc(RESPONSE_PTR, layout);
            }
        }
        RESPONSE_PTR = std::ptr::null_mut();
        RESPONSE_LEN = 0;
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