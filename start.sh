#!/bin/bash

echo "========================================"
echo "   RTL-SDR Scanner - Quick Start"
echo "========================================"
echo ""

# ── Kill anything holding required ports ─────────────────────────────────────
PORTS=(3001)

echo "Cleaning up ports and old processes..."

# Kill any node server.js processes
pkill -9 -f "node server.js" 2>/dev/null && echo "  Killed node server processes" || true

for PORT in "${PORTS[@]}"; do
    # Try without sudo first
    PIDS=$(lsof -ti tcp:"$PORT" 2>/dev/null || true)
    if [ -n "$PIDS" ]; then
        echo "  Killing processes on port $PORT: $PIDS"
        kill -9 $PIDS 2>/dev/null || true
        sleep 1
    fi
    
    # Final check
    if lsof -ti tcp:"$PORT" 2>/dev/null; then
        echo "  ⚠ Warning: Port $PORT still in use (may be root process - will retry)"
        # Try one more time with force
        fuser -k -9 $PORT/tcp 2>/dev/null || true
        sleep 1
    fi
    
    if lsof -ti tcp:"$PORT" 2>/dev/null; then
        echo "  ⚠ Port $PORT blocked - continuing anyway"
    else
        echo "  ✓ Port $PORT is free"
    fi
done

# Kill stale RTL/scanner processes that would block the device
for proc in rtl_fm rtl_power rtl_sdr rtl_433 rtl_tcp dump1090-mutability dump1090; do
    if pgrep -x "$proc" > /dev/null 2>&1; then
        echo "  Killing stale: $proc"
        pkill -9 -x "$proc" 2>/dev/null || true
    fi
done
sleep 0.5

# Unload DVB kernel modules that grab the dongle before rtl_sdr can
# This is the main cause of "usb_claim_interface error -6"
echo "  Unloading DVB kernel modules..."
for mod in dvb_usb_rtl28xxu rtl2832 rtl2830 dvb_usb_v2; do
    if lsmod | grep -q "^$mod"; then
        sudo modprobe -r "$mod" 2>/dev/null \
            && echo "    Removed kernel module: $mod" \
            || echo "    Could not remove: $mod (non-fatal, continuing)"
    fi
done
# Sysfs unbind fallback — works even if rmmod fails
for drvpath in /sys/bus/usb/drivers/dvb_usb_rtl28xxu/*; do
    [ -e "$drvpath/uevent" ] && echo "$(basename $drvpath)" | sudo tee /sys/bus/usb/drivers/dvb_usb_rtl28xxu/unbind >/dev/null 2>&1 && echo "    Unbound via sysfs: $(basename $drvpath)"
done 2>/dev/null || true

echo ""

# ── Check if RTL-SDR is connected ─────────────────────────────────────────────
echo "Checking RTL-SDR device..."
RTL_OUTPUT=$(rtl_test -t 2>&1 || true)
if echo "$RTL_OUTPUT" | grep -q "Found"; then
    echo "✓ RTL-SDR device detected!"
else
    echo "⚠ RTL-SDR device not found or busy — server will still start."
    echo "  If you see usb_claim_interface errors, replug the dongle."
fi

# Check if dependencies are installed
if [ ! -d "node_modules" ]; then
    echo ""
    echo "Installing dependencies..."
    npm install
fi

if [ ! -d "client/node_modules" ]; then
    echo ""
    echo "Installing client dependencies..."
    cd client
    npm install
    cd ..
fi

# Create necessary directories
mkdir -p recordings logs captures

# Fix ownership if directories are owned by root (try without sudo first)
for dir in recordings logs captures; do
    if [ -d "$dir" ] && [ "$(stat -c '%U' $dir 2>/dev/null)" = "root" ]; then
        echo "  Warning: $dir is owned by root - attempting to fix..."
        # Try to remove and recreate
        rm -rf "$dir" 2>/dev/null && mkdir -p "$dir" && echo "  ✓ Recreated $dir with correct ownership" || echo "  ✗ Could not fix $dir - you may need to run: sudo chown -R \$USER:\$USER $dir"
    fi
done

# Try to fix any root-owned files in logs
if [ -d "logs" ]; then
    find logs -type f -user root 2>/dev/null | while read file; do
        rm -f "$file" 2>/dev/null || echo "  Warning: Could not remove root-owned log file: $file"
    done
fi

# Copy .env if not exists
if [ ! -f ".env" ]; then
    cp .env.example .env
    echo "✓ Created .env file"
fi

# Build client
echo ""
echo "Building React frontend..."
cd client

# Remove old build directories completely
echo "  Cleaning old builds..."
rm -rf build-temp build-old 2>/dev/null || true

# Build to temporary directory
mkdir -p build-temp
echo "  Building to temporary directory..."
BUILD_PATH=build-temp DISABLE_ESLINT_PLUGIN=true npm run build

# Handle build directory replacement
if [ -d "build" ]; then
    # Try to remove old build
    rm -rf build 2>/dev/null || {
        echo "  Old build has permission issues, renaming..."
        mv build "build-old-$$" 2>/dev/null || true
    }
fi

# Move new build into place
mv build-temp build 2>/dev/null && echo "  ✓ Build completed successfully" || {
    echo "  ✗ Build move failed, but will try to serve anyway"
    # If move failed, try to use build-temp directly
    if [ ! -d "build" ] && [ -d "build-temp" ]; then
        ln -sf build-temp build 2>/dev/null
    fi
}
cd ..

# Start server
echo ""
echo "========================================"
echo "   Starting RTL-SDR Scanner Server"
echo "========================================"
echo ""
echo "Access the application at:"
echo "👉 http://localhost:3001"
echo ""
echo "Press Ctrl+C to stop the server"
echo ""

NODE_ENV=production sudo -E node server.js
