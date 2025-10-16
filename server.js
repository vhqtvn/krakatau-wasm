#!/usr/bin/env node

const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

class KrakatauServer {
    constructor() {
        this.wasmModule = null;
        this.wasmInstance = null;
        this.memory = null;
        this.initialized = false;

        // Configuration from environment variables
        this.endpoint = process.env.END_POINT || '/decompile';
        this.authUser = process.env.AUTH_USER;
        this.authPassword = process.env.AUTH_PASSWORD;
        this.authTokenHeader = process.env.AUTH_TOKEN_HEADER;
        this.authTokenValue = process.env.AUTH_TOKEN_VALUE;
        // Heroku automatically sets PORT, use it if available
        this.port = process.env.PORT || 3000;
        // For Heroku, bind to 0.0.0.0 to accept all connections
        this.host = process.env.HOST || '0.0.0.0';

        console.log(`Server configuration:`);
        console.log(`- Endpoint: ${this.endpoint}`);
        console.log(`- Port: ${this.port}`);
        console.log(`- Host: ${this.host}`);
        console.log(`- Basic Auth: ${this.authUser ? 'Enabled' : 'Disabled'}`);
        console.log(`- Token Auth: ${this.authTokenHeader ? 'Enabled' : 'Disabled'}`);
    }

    async initialize() {
        if (this.initialized) return;

        try {
            const wasmPath = path.join(__dirname, 'krak2.wasm');

            if (!fs.existsSync(wasmPath)) {
                throw new Error(`WASM file not found at ${wasmPath}. Please build the project first.`);
            }

            // Load the WASM module
            const wasmBuffer = fs.readFileSync(wasmPath);
            this.wasmModule = await WebAssembly.compile(wasmBuffer);

            // Create instance with minimal required imports
            this.wasmInstance = await WebAssembly.instantiate(this.wasmModule, {
                env: {
                    abort: () => { throw new Error('WASM abort'); }
                }
            });

            // Find WASM memory export
            for (const [name, exportItem] of Object.entries(this.wasmInstance.exports)) {
                if (exportItem instanceof WebAssembly.Memory) {
                    this.memory = exportItem;
                    break;
                }
            }

            if (!this.memory) {
                throw new Error('WASM module does not export memory');
            }

            // Check required functions
            const requiredFunctions = [
                'allocate_input_buffer',
                'decompile_json',
                'get_response_length',
                'get_response_ptr',
                'free_response'
            ];

            for (const func of requiredFunctions) {
                if (!this.wasmInstance.exports[func]) {
                    throw new Error(`Required function ${func} not found in WASM module`);
                }
            }

            console.log('Krakatau WASM module loaded successfully');
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

        try {
            // Convert class data to base64
            const base64Content = classData.toString('base64');

            // Create JSON request
            const request = {
                file_path: fileName,
                base64_content: base64Content,
                roundtrip,
                no_short_code_attr: noShortCodeAttr
            };

            const jsonString = JSON.stringify(request);
            const jsonBytes = new TextEncoder().encode(jsonString);

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
            throw new Error(`Decompilation failed: ${error.message}`);
        }
    }

    authenticate(req) {
        // Check basic authentication if configured
        if (this.authUser && this.authPassword) {
            const authHeader = req.headers['authorization'];
            if (!authHeader || !authHeader.startsWith('Basic ')) {
                return false;
            }

            try {
                const base64Credentials = authHeader.split(' ')[1];
                const credentials = Buffer.from(base64Credentials, 'base64').toString('ascii');
                const [username, password] = credentials.split(':');

                if (username !== this.authUser || password !== this.authPassword) {
                    return false;
                }
            } catch (error) {
                return false;
            }
        }

        // Check token authentication if configured
        if (this.authTokenHeader && this.authTokenValue) {
            const tokenValue = req.headers[this.authTokenHeader.toLowerCase()];
            if (tokenValue !== this.authTokenValue) {
                return false;
            }
        }

        return true;
    }

    async handleRequest(req, res) {
        let parsedUrl;
        try {
            parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
        } catch (error) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Invalid URL' }));
            return;
        }

        // Only handle the configured endpoint with POST
        if (req.method !== 'POST' || parsedUrl.pathname !== this.endpoint) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Not found' }));
            return;
        }

        // Check authentication
        if (!this.authenticate(req)) {
            res.writeHead(401, {
                'Content-Type': 'application/json',
                'WWW-Authenticate': this.authUser ? 'Basic realm="Krakatau Server"' : undefined
            });
            res.end(JSON.stringify({ error: 'Authentication required' }));
            return;
        }

        try {
            // Read the request body
            const chunks = [];
            for await (const chunk of req) {
                chunks.push(chunk);
            }
            const classData = Buffer.concat(chunks);

            if (classData.length === 0) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'No class file data provided' }));
                return;
            }

            // Validate that it's a class file
            if (classData.length < 4 || classData.readUInt32BE(0) !== 0xCAFEBABE) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Invalid class file format' }));
                return;
            }

            // Get filename from query parameter or use default
            const fileName = parsedUrl.searchParams.get('filename') || 'Unknown.class';

            // Parse decompilation options from query parameters
            const options = {
                roundtrip: parsedUrl.searchParams.get('roundtrip') === 'true',
                noShortCodeAttr: parsedUrl.searchParams.get('no_shortcodeattr') === 'true'
            };

            console.log(`Decompiling ${fileName} (${classData.length} bytes)`);

            // Perform decompilation
            const output = await this.decompile(classData, fileName, options);

            res.writeHead(200, {
                'Content-Type': 'text/plain; charset=utf-8',
                'Access-Control-Allow-Origin': '*'
            });
            res.end(output);

        } catch (error) {
            console.error('Error processing request:', error.message);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                error: 'Internal server error',
                message: error.message
            }));
        }
    }

    start() {
        const server = http.createServer((req, res) => this.handleRequest(req, res));

        server.listen(this.port, this.host, () => {
            console.log(`Krakatau decompilation server running on http://${this.host}:${this.port}`);
            console.log(`Decompilation endpoint: POST ${this.endpoint}`);
            console.log('Server ready to accept requests...');
        });

        server.on('error', (error) => {
            console.error('Server error:', error.message);
            process.exit(1);
        });

        return server;
    }
}

// Start the server
const server = new KrakatauServer();

try {
    server.start();
} catch (error) {
    console.error('Failed to start server:', error.message);
    process.exit(1);
}

// Handle graceful shutdown
process.on('SIGINT', () => {
    console.log('\nShutting down server...');
    process.exit(0);
});

process.on('SIGTERM', () => {
    console.log('\nShutting down server...');
    process.exit(0);
});