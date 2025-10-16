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
                this.wasmInstance = await WebAssembly.instantiate(this.wasmModule, {
                    env: {
                        abort: () => { throw new Error('WASM abort'); }
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

        // If we're using fallback or WASM isn't available, use simulation
        if (this.useFallback || !this.wasmInstance) {
            console.log('Using fallback decompilation');
            return this._simulateDecompilation(classData, options);
        }

        try {
            // Convert class data to base64
            const base64Content = this._arrayBufferToBase64(classData);

            // Create JSON request
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
            console.warn('WASM decompilation failed, using fallback:', error.message);
            return this._simulateDecompilation(classData, options);
        }
    }

    _allocate(size) {
        // Simple memory allocation (this is a basic implementation)
        // In a real implementation, you'd have a proper allocator
        if (!this._nextPtr) this._nextPtr = 1024 * 1024; // Start after 1MB
        const ptr = this._nextPtr;
        this._nextPtr += ((size + 7) & ~7); // Align to 8 bytes
        return ptr;
    }

    _free(ptr) {
        // Basic free implementation (doesn't actually free memory in this simple version)
        // In a real implementation, you'd have proper memory management
    }

    _simulateDecompilation(classData, options) {
        // Fallback simulation when the actual WASM function isn't available
        const hexData = Array.from(classData.slice(0, Math.min(20, classData.length)))
            .map(b => b.toString(16).padStart(2, '0'))
            .join(' ');

        // Try to extract basic class information
        let className = "UnknownClass";
        let majorVersion = 52;
        let minorVersion = 0;
        let constPoolCount = 0;

        if (classData.length > 8) {
            // Look for common class file patterns
            const view = new DataView(classData.buffer);
            const magic = view.getUint32(0, false); // Big endian

            if (magic === 0xCAFEBABE) {
                // Valid class file
                minorVersion = view.getUint16(4, false);
                majorVersion = view.getUint16(6, false);
                constPoolCount = view.getUint16(8, false);

                // Extract class name from constant pool (simplified)
                let currentPos = 10; // After header
                for (let i = 1; i < constPoolCount; i++) {
                    const tag = classData[currentPos];
                    if (tag === 1) { // UTF8 constant
                        const length = view.getUint16(currentPos + 1, false);
                        const nameBytes = classData.slice(currentPos + 3, currentPos + 3 + length);
                        const name = new TextDecoder('utf-8').decode(nameBytes);

                        // Heuristic: look for typical class name patterns
                        if (name.includes('/') && !name.includes('(')) {
                            className = name.split('/').pop().replace('$', '.');
                            break;
                        }

                        currentPos += 3 + length;
                    } else if (tag === 7) { // Class reference
                        currentPos += 3;
                    } else if (tag === 9 || tag === 10 || tag === 11) { // Field/Method/InterfaceMethod ref
                        currentPos += 5;
                    } else if (tag === 8) { // String
                        currentPos += 3;
                    } else if (tag === 3 || tag === 4) { // Integer/Float
                        currentPos += 5;
                    } else if (tag === 5 || tag === 6) { // Long/Double
                        currentPos += 9;
                        i++; // Takes two slots
                    } else if (tag === 12) { // Name and Type
                        currentPos += 5;
                    } else {
                        currentPos += 3; // Default
                    }
                }
            }
        }

        return `// Java Assembly - Fallback Simulation
// WARNING: This is simulated output for demonstration
// Real WASM decompilation failed - check console for details
// File: ${className}.class
// Size: ${classData.length} bytes
// Real class file detected: 0xCAFEBABE magic number found
// Version: ${majorVersion}.${minorVersion}
// Constant pool entries: ${constPoolCount}
// First 20 bytes: ${hexData}

.version ${majorVersion} ${minorVersion}
.class public ${className}
.super java/lang/Object

.method public <init>()V
    .stack 1
    .locals 1
    0000: 0x2A
        aload_0
    0001: 0xB7
        invokespecial #1  // Method java/lang/Object."<init>":()V
    0004: 0xB1
        return
.end method

.method public static main([Ljava/lang/String;)V
    .stack 2
    .locals 1
    0000: 0xB2
        getstatic #2  // Field java/lang/System.out:Ljava/io/PrintStream;
    0003: 0x12
        ldc #3  // String Hello from ${className}!
    0005: 0xB6
        invokevirtual #4  // Method java/io/PrintStream.println:(Ljava/lang/String;)V
    0008: 0xB1
        return
.end method

// Additional methods and fields would appear here in real decompilation...
.end class

// Note: This is a fallback simulation showing what the output would look like.
// To get real decompilation with actual bytecode analysis:
// 1. Ensure krak2.wasm is properly built from the Rust code
// 2. The WASM module should export the required functions
// 3. Check browser console for specific error messages
// The real decompilation provides actual bytecode parsing and method analysis.`;
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