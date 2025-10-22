// Krakatau WASM Interface
class KrakatauDecompiler {
    constructor() {
        this.wasmModule = null;
        this.wasmInstance = null;
        this.memory = null;
        this.initialized = false;
    }

    async initialize() {
        if (this.initialized) return;

        try {
            // Load the WASM module
            const response = await fetch('krak2.wasm');
            if (!response.ok) {
                throw new Error(`Failed to load WASM module: ${response.status}`);
            }

            const wasmBytes = await response.arrayBuffer();
            this.wasmModule = await WebAssembly.compile(wasmBytes);

            // Create instance with minimal required imports
            try {
                // 4 MiB initial, 1 GiB max
                const page = 64 * 1024;                       // 64 KiB
                const mem = new WebAssembly.Memory({
                    initial: 4 * 1024 * 1024 / page,          // pages = bytes / 64KiB
                    maximum: 1024 * 1024 * 1024 / page
                });

                this.wasmInstance = await WebAssembly.instantiate(this.wasmModule, {
                    env: {
                        abort: () => { throw new Error('WASM abort'); },
                        memory: mem
                    }
                });

                // Find WASM memory export
                if (this.wasmInstance.exports.memory) {
                    this.memory = this.wasmInstance.exports.memory;
                } else {
                    // Create memory if not exported
                    this.memory = new WebAssembly.Memory({ initial: 100, maximum: 1000 });
                }

                console.log('Krakatau WASM module loaded successfully');
            } catch (error) {
                console.warn('WASM instantiation failed, using fallback simulation:', error.message);
                this.useFallback = true;
            }

            this.initialized = true;
        } catch (error) {
            throw new Error(`Failed to initialize Krakatau: ${error.message}`);
        }
    }

    async decompile(classData, fileName, options = {}) {
        if (!this.initialized) {
            await this.initialize();
        }

        const {
            roundtrip = false,
            noShortCodeAttr = false
        } = options;

        // If WASM isn't available, throw error
        if (this.useFallback || !this.wasmInstance) {
            throw new Error('WASM module not available. Please ensure krak2.wasm is properly loaded.');
        }

        try {
            // Convert class data to base64
            const base64Content = this._arrayBufferToBase64(classData);

            // Create JSON request matching run.js format
            const request = {
                file_path: fileName,
                base64_content: base64Content,
                roundtrip,
                no_short_code_attr: noShortCodeAttr
            };

            const jsonString = JSON.stringify(request);
            const jsonBytes = new TextEncoder().encode(jsonString);

            // Check if WASM exports the required functions
            if (!this.wasmInstance.exports.allocate_input_buffer ||
                !this.wasmInstance.exports.decompile_json ||
                !this.wasmInstance.exports.get_response_length ||
                !this.wasmInstance.exports.get_response_ptr ||
                !this.wasmInstance.exports.free_response) {
                throw new Error('Required WASM functions not exported');
            }

            // Initialize the heap with a small allocation (workaround for heap initialization issue)
            this.wasmInstance.exports.allocate_input_buffer(10);

            // Allocate input buffer
            const inputPtr = this.wasmInstance.exports.allocate_input_buffer(jsonBytes.length);
            if (inputPtr === 0) {
                throw new Error('Failed to allocate WASM memory for input');
            }

            // Copy JSON data to WASM memory
            const wasmMemory = new Uint8Array(this.memory.buffer);
            for (let i = 0; i < jsonBytes.length; i++) {
                wasmMemory[inputPtr + i] = jsonBytes[i];
            }

            // Call the decompile_json function
            const result = this.wasmInstance.exports.decompile_json(inputPtr, jsonBytes.length);

            if (result < 0) {
                throw new Error('WASM decompile_json function returned error');
            }

            // Get response length and pointer
            const responseLength = this.wasmInstance.exports.get_response_length();
            if (responseLength < 0) {
                throw new Error('Failed to get response length from WASM');
            }

            const responsePtr = this.wasmInstance.exports.get_response_ptr();
            if (responsePtr === 0) {
                throw new Error('Failed to get response pointer from WASM');
            }

            // Read response from WASM memory
            const responseMemory = new Uint8Array(this.memory.buffer);
            const responseBytes = responseMemory.slice(responsePtr, responsePtr + responseLength);

            // Parse and return response
            const responseString = new TextDecoder().decode(responseBytes);
            const response = JSON.parse(responseString);

            // Free the response
            this.wasmInstance.exports.free_response();

            if (!response.success) {
                throw new Error(response.error || 'Unknown decompilation error');
            }

            return response.output;

        } catch (error) {
            throw new Error(`WASM decompilation failed: ${error.message}`);
        }
    }

    async assemble(sourceCode, fileName, options = {}) {
        if (!this.initialized) {
            await this.initialize();
        }

        // If WASM isn't available, throw error
        if (this.useFallback || !this.wasmInstance) {
            throw new Error('WASM module not available. Please ensure krak2.wasm is properly loaded.');
        }

        try {
            // Create JSON request matching run.js format
            const request = {
                file_path: fileName,
                source_code: sourceCode
            };

            const jsonString = JSON.stringify(request);
            const jsonBytes = new TextEncoder().encode(jsonString);

            // Check if WASM exports the required functions
            if (!this.wasmInstance.exports.allocate_input_buffer ||
                !this.wasmInstance.exports.assemble_json ||
                !this.wasmInstance.exports.get_response_length ||
                !this.wasmInstance.exports.get_response_ptr ||
                !this.wasmInstance.exports.free_response) {
                throw new Error('Required WASM functions not exported');
            }

            // Initialize the heap with a small allocation (workaround for heap initialization issue)
            this.wasmInstance.exports.allocate_input_buffer(10);

            // Allocate input buffer
            const inputPtr = this.wasmInstance.exports.allocate_input_buffer(jsonBytes.length);
            if (inputPtr === 0) {
                throw new Error('Failed to allocate WASM memory for input');
            }

            // Copy JSON data to WASM memory
            const wasmMemory = new Uint8Array(this.memory.buffer);
            for (let i = 0; i < jsonBytes.length; i++) {
                wasmMemory[inputPtr + i] = jsonBytes[i];
            }

            // Call the assemble_json function
            const result = this.wasmInstance.exports.assemble_json(inputPtr, jsonBytes.length);

            if (result < 0) {
                throw new Error('WASM assemble_json function returned error');
            }

            // Get response length and pointer
            const responseLength = this.wasmInstance.exports.get_response_length();
            if (responseLength < 0) {
                throw new Error('Failed to get response length from WASM');
            }

            const responsePtr = this.wasmInstance.exports.get_response_ptr();
            if (responsePtr === 0) {
                throw new Error('Failed to get response pointer from WASM');
            }

            // Read response from WASM memory
            const responseMemory = new Uint8Array(this.memory.buffer);
            const responseBytes = responseMemory.slice(responsePtr, responsePtr + responseLength);

            // Parse and return response
            const responseString = new TextDecoder().decode(responseBytes);
            const response = JSON.parse(responseString);

            // Free the response
            this.wasmInstance.exports.free_response();

            if (!response.success) {
                throw new Error(response.error || 'Unknown assembly error');
            }

            return response;

        } catch (error) {
            throw new Error(`WASM assembly failed: ${error.message}`);
        }
    }
  
    _arrayBufferToBase64(buffer) {
        let binary = '';
        const bytes = new Uint8Array(buffer);
        const len = bytes.byteLength;
        for (let i = 0; i < len; i++) {
            binary += String.fromCharCode(bytes[i]);
        }
        return btoa(binary);
    }
}

// Export for global use
window.KrakatauDecompiler = KrakatauDecompiler;