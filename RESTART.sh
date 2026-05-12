#!/bin/bash
# Quick restart script - use this after making changes

echo "========================================="
echo "   Quick Restart - RTL-SDR Scanner"
echo "========================================="
echo ""

# Kill everything
echo "🔴 Stopping all processes..."
pkill -9 -f "node server.js" 2>/dev/null
pkill -9 -f "rtl_" 2>/dev/null
sleep 1

# Clear log
rm -f /tmp/server.log

# Start server
cd "$(dirname "$0")"
echo "🟢 Starting server..."
NODE_ENV=production node server.js > /tmp/server.log 2>&1 &
SERVER_PID=$!

sleep 2

# Check status
if ps -p $SERVER_PID > /dev/null; then
    echo "✅ Server running (PID: $SERVER_PID)"
    echo "📡 URL: http://localhost:3001"
    echo ""
    echo "📊 To watch logs live: ./WATCH_LOG.sh"
    echo ""
    echo "Recent log:"
    tail -5 /tmp/server.log
else
    echo "❌ Server failed to start!"
    echo "Check /tmp/server.log for errors"
    exit 1
fi
