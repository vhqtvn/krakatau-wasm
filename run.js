#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

async function run() {
    const args = process.argv.slice(2);

    if (args.length === 0) {
        console.error('Usage: node run.js <classfile>');
        process.exit(1);
    }

    const classFile = args[0];

    // Check if class file exists
    if (!fs.existsSync(classFile)) {
        console.error(`Error: Class file '${classFile}' not found`);
        process.exit(1);
    }

    // Path to the WASM file
    const wasmPath = path.join(__dirname, 'krak2.wasm');

    if (!fs.existsSync(wasmPath)) {
        console.error(`Error: WASM file not found at ${wasmPath}`);
        console.error('Please build the project first with: cargo build --release --target wasm32-unknown-unknown');
        process.exit(1);
    }

    try {
        // Read class file
        const classData = fs.readFileSync(classFile);

        // Read WASM file
        const wasmBuffer = fs.readFileSync(wasmPath);

        const wasmModule = await WebAssembly.compile(wasmBuffer);

        // Create instance
        const instance = await WebAssembly.instantiate(wasmModule, {
            env: {
                abort: () => {
                    console.error('WASM abort called');
                    throw new Error('WASM abort');
                }
            }
        });

        // Find WASM memory export
        let memory = null;
        for (const [name, exportItem] of Object.entries(instance.exports)) {
            if (exportItem instanceof WebAssembly.Memory) {
                memory = exportItem;
                break;
            }
        }

        if (!memory) {
            throw new Error('WASM module does not export memory');
        }

        // Convert class data to base64
        const base64Content = classData.toString('base64');

        // Create JSON request
        const request = {
            file_path: path.basename(classFile),
            base64_content: base64Content,
            roundtrip: false,
            no_short_code_attr: false
        };

        const jsonString = JSON.stringify(request);
        const jsonBytes = new TextEncoder().encode(jsonString);

        // Allocate memory for the JSON input
        if (instance.exports.allocate_input_buffer) {
            // Initialize the heap with a small allocation (workaround for heap initialization issue)
            instance.exports.allocate_input_buffer(10);

            const inputPtr = instance.exports.allocate_input_buffer(jsonBytes.length);
            if (inputPtr === 0) {
                throw new Error('Failed to allocate memory for input data');
            }

            // Copy JSON data to allocated memory
            const wasmMemory = new Uint8Array(memory.buffer);
            for (let i = 0; i < jsonBytes.length; i++) {
                wasmMemory[inputPtr + i] = jsonBytes[i];
            }

            // Call the decompile_json function
            if (instance.exports.decompile_json) {
                const result = instance.exports.decompile_json(inputPtr, jsonBytes.length);

                if (result < 0) {
                    throw new Error('WASM decompile_json function returned error');
                }

                // Get response length and pointer
                const responseLength = instance.exports.get_response_length();
                if (responseLength < 0) {
                    throw new Error('Failed to get response length');
                }

                const responsePtr = instance.exports.get_response_ptr();
                if (responsePtr === 0) {
                    throw new Error('Failed to get response pointer');
                }

                // Read response from WASM memory
                const responseMemory = new Uint8Array(memory.buffer);
                const responseBytes = responseMemory.slice(responsePtr, responsePtr + responseLength);

                // Parse and display response
                const responseString = new TextDecoder().decode(responseBytes);
                const response = JSON.parse(responseString);

                if (response.success) {
                    console.log(response.output);
                } else {
                    console.error(`Error: ${response.error || 'Unknown decompilation error'}`);
                    process.exit(1);
                }

                // Free the response
                instance.exports.free_response();
            } else {
                throw new Error('decompile_json function not found in WASM module');
            }
        } else {
            throw new Error('allocate_input_buffer function not found in WASM module');
        }

    } catch (error) {
        console.error('Error:', error.message);
        process.exit(1);
    }
}

run().catch(error => {
    console.error('Error:', error.message);
    process.exit(1);
});