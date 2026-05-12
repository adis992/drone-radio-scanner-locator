#!/bin/bash

# Kill any existing server processes (including root-owned ones)
echo "Stopping any running servers..."

# Try to kill without sudo first
pkill -f "node server.js" 2>/dev/null && echo "  ✓ Stopped user processes"

# Check if port is still in use by root process
ROOT_PID=$(sudo lsof -ti tcp:3001 2>/dev/null)
if [ -n "$ROOT_PID" ]; then
    echo "  Found root-owned process on port 3001 (PID: $ROOT_PID)"
    sudo kill -9 $ROOT_PID 2>/dev/null && echo "  ✓ Stopped root process" || echo "  ✗ Could not stop root process"
fi

sleep 1

# Start the server
echo ""
echo "Starting RTL-SDR Scanner..."
cd "$(dirname "$0")"
NODE_ENV=production node server.js
