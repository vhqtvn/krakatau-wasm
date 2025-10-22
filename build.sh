#!/bin/bash

# Build script for Krakatau WASM on Heroku
echo "Building Krakatau WASM..."

# Check if Rust is installed
if ! command -v cargo &> /dev/null; then
    echo "Installing Rust..."
    curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
    source ~/.cargo/env
fi

# Add wasm32 target
echo "Adding wasm32-unknown-unknown target..."
rustup target add wasm32-unknown-unknown

# Build the WASM file
echo "Building krak2.wasm..."
cargo build --release --target wasm32-unknown-unknown --lib

# Copy the built file to the root directory
if [ -f "target/wasm32-unknown-unknown/release/krakatau2.wasm" ]; then
    cp target/wasm32-unknown-unknown/release/krakatau2.wasm ./krak2.wasm
    echo "Successfully built krak2.wasm ($(ls -lh krak2.wasm | awk '{print $5}'))"
else
    echo "ERROR: Failed to build krakatau2.wasm"
    exit 1
fi