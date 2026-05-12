#!/bin/bash
# Watch server log in real-time
echo "==========================="
echo "  Watching Server Activity"
echo "==========================="
echo ""
echo "Server running at: http://localhost:3001"
echo "Open the URL in browser to see auto-start!"
echo ""
echo "Press Ctrl+C to stop watching"
echo ""
tail -f /tmp/server.log
