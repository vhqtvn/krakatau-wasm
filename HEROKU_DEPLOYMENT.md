# Heroku Deployment Guide

This guide explains how to deploy the Krakatau decompilation server to Heroku.

## Prerequisites

1. **Install Heroku CLI**: [Download and install](https://devcenter.heroku.com/articles/heroku-cli)
2. **Heroku Account**: Create a free account at [heroku.com](https://heroku.com)
3. **Node.js 14+**: Required for deployment
4. **Built WASM file**: Ensure `krak2.wasm` is built and committed to the repository

## Pre-deployment Setup

### 1. Build the WASM File

Before deploying to Heroku, you must build the WASM file locally:

```bash
# Install Rust and Cargo if not already installed
# Build the WASM target
cargo build --release --target wasm32-unknown-unknown

# The built file should be at:
# target/wasm32-unknown-unknown/release/krak2.wasm

# Copy it to the root directory
cp target/wasm32-unknown-unknown/release/krak2.wasm ./
```

### 2. Verify the WASM File

Ensure `krak2.wasm` exists in the repository root:

```bash
ls -la krak2.wasm
```

The `.gitignore` file is configured to allow `krak2.wasm` while ignoring other WASM files.

## Deployment Steps

### 1. Login to Heroku

```bash
heroku login
```

### 2. Create Heroku App

```bash
# Create a new Heroku app (replace with your app name)
heroku create your-app-name

# Or let Heroku generate a random name
heroku create
```

### 3. Set Environment Variables (Optional)

Configure authentication and settings:

```bash
# Basic authentication
heroku config:set AUTH_USER=your-username
heroku config:set AUTH_PASSWORD=your-password

# Token authentication
heroku config:set AUTH_TOKEN_HEADER=X-API-Key
heroku config:set AUTH_TOKEN_VALUE=your-secret-token

# Custom endpoint
heroku config:set END_POINT=/api/decompile
```

### 4. Deploy to Heroku

```bash
# Push to Heroku
git push heroku main

# Or if using a different branch
git push heroku your-branch:main
```

### 5. Open and Test the App

```bash
# Open the app in browser
heroku open

# Check logs
heroku logs --tail

# Test the decompilation endpoint
curl -X POST https://your-app-name.herokuapp.com/decompile \
  --data-binary @YourClass.class \
  -H "Content-Type: application/octet-stream"
```

## Configuration Options

The server supports the following environment variables:

| Variable | Description | Default |
|----------|-------------|---------|
| `PORT` | Server port (automatically set by Heroku) | 3000 |
| `HOST` | Server host | 0.0.0.0 |
| `END_POINT` | API endpoint path | /decompile |
| `AUTH_USER` | Basic auth username | disabled |
| `AUTH_PASSWORD` | Basic auth password | disabled |
| `AUTH_TOKEN_HEADER` | Token auth header name | disabled |
| `AUTH_TOKEN_VALUE` | Token auth header value | disabled |

## Example Usage

### Basic Request

```bash
curl -X POST https://your-app-name.herokuapp.com/decompile \
  --data-binary @YourClass.class \
  -H "Content-Type: application/octet-stream"
```

### With Filename

```bash
curl -X POST "https://your-app-name.herokuapp.com/decompile?filename=YourClass.class" \
  --data-binary @YourClass.class \
  -H "Content-Type: application/octet-stream"
```

### With Decompilation Options

```bash
curl -X POST "https://your-app-name.herokuapp.com/decompile?roundtrip=true" \
  --data-binary @YourClass.class \
  -H "Content-Type: application/octet-stream"
```

### With Authentication

```bash
# Basic Auth
curl -X POST https://your-app-name.herokuapp.com/decompile \
  --data-binary @YourClass.class \
  -H "Content-Type: application/octet-stream" \
  -u username:password

# Token Auth
curl -X POST https://your-app-name.herokuapp.com/decompile \
  --data-binary @YourClass.class \
  -H "Content-Type: application/octet-stream" \
  -H "X-API-Key: your-secret-token"
```

## Troubleshooting

### Common Issues

1. **Missing WASM file**: Ensure `krak2.wasm` is built and committed
2. **Build failures**: Check Heroku logs with `heroku logs --tail`
3. **Memory limits**: Large class files may exceed Heroku's memory limits
4. **Authentication**: Verify environment variables are set correctly

### Debug Commands

```bash
# Check app status
heroku ps

# View configuration
heroku config

# Monitor logs
heroku logs --tail

# Run one-off dyno for debugging
heroku run node server.js
```

## Scaling

For production use, consider:

1. **Upgrading dynos**: `heroku ps:scale web=standard-2x`
2. **Add-on services**: Consider logging, monitoring, and error tracking
3. **Custom domains**: Add custom domains through Heroku dashboard
4. **SSL certificates**: Automatic SSL provided by Heroku

## Security Considerations

1. **Authentication**: Use environment variables for auth credentials
2. **Rate limiting**: Consider implementing rate limiting for production
3. **Input validation**: The server validates class file format
4. **Monitoring**: Monitor logs for unusual activity