#!/bin/bash

# Quick kill script - no password needed for user processes
echo "Killing all processes on port 3001..."
pkill -9 -f "node server.js" 2>/dev/null
fuser -k -9 3001/tcp 2>/dev/null
sleep 2

# Check status
if lsof -ti tcp:3001 2>/dev/null; then
    echo "⚠ Port 3001 still blocked (likely root process)"
    echo "Run manually: sudo kill -9 \$(sudo lsof -ti tcp:3001)"
else
    echo "✓ Port 3001 is free"
fi

# Start server directly
cd "$(dirname "$0")"
NODE_ENV=production node server.js
