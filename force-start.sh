#!/bin/bash

# Kill root process on port 3001
echo "Killing root process on port 3001..."
ROOT_PID=$(sudo lsof -ti tcp:3001 2>/dev/null)
if [ -n "$ROOT_PID" ]; then
    sudo kill -9 $ROOT_PID
    echo "✓ Killed process $ROOT_PID"
    sleep 2
fi

# Now run the main start script
cd "$(dirname "$0")"
./start.sh
