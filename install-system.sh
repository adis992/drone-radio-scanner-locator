#!/bin/bash

echo "Installing RTL-SDR Scanner System Dependencies..."

# Update package list
sudo apt-get update

# Install RTL-SDR drivers and tools
echo "Installing RTL-SDR tools..."
sudo apt-get install -y rtl-sdr librtlsdr-dev librtlsdr0

# Install audio processing tools
echo "Installing audio tools..."
sudo apt-get install -y sox libsox-fmt-all pulseaudio

# Install Python dependencies for signal processing
echo "Installing Python dependencies..."
sudo apt-get install -y python3 python3-pip python3-numpy python3-scipy

# Install additional signal processing tools
echo "Installing build tools..."
sudo apt-get install -y cmake build-essential git pkg-config

# Install WiFi scanning tool
echo "Installing wireless tools..."
sudo apt-get install -y wireless-tools iw

# Install Bluetooth tools
echo "Installing Bluetooth tools..."
sudo apt-get install -y bluetooth bluez bluez-tools

# Install dump1090-mutability for ADS-B (aircraft/drone detection on 1090 MHz)
echo "Installing dump1090-mutability for aircraft/drone detection..."
if ! command -v dump1090-mutability &>/dev/null; then
    sudo apt-get install -y dump1090-mutability
    if command -v dump1090-mutability &>/dev/null; then
        echo "✓ dump1090-mutability installed"
        # Stop the system service — our app runs it directly to avoid USB permission issues
        sudo systemctl stop dump1090-mutability 2>/dev/null || true
        sudo systemctl disable dump1090-mutability 2>/dev/null || true
        echo "  (system service disabled — app starts it directly)"
    else
        echo "⚠ dump1090-mutability not found in apt — trying to build from source..."
        if [ ! -d "dump1090" ]; then
            git clone https://github.com/mutability/dump1090.git
            cd dump1090
            make
            sudo cp dump1090 /usr/local/bin/dump1090-mutability
            cd ..
        fi
    fi
else
    echo "✓ dump1090-mutability already installed"
    # Disable system service (app runs it directly for correct USB permissions)
    sudo systemctl stop dump1090-mutability 2>/dev/null || true
    sudo systemctl disable dump1090-mutability 2>/dev/null || true
fi

# Install rtl_433 for IoT device detection
echo "Installing rtl_433 for IoT devices..."
if ! command -v rtl_433 &>/dev/null; then
    if apt-cache show rtl-433 &>/dev/null; then
        sudo apt-get install -y rtl-433
    elif [ ! -d "rtl_433" ]; then
        git clone https://github.com/merbanan/rtl_433.git
        cd rtl_433
        mkdir build && cd build
        cmake ..
        make
        sudo make install
        cd ../..
    fi
    echo "✓ rtl_433 installed"
else
    echo "✓ rtl_433 already installed"
fi

# Install multimon-ng for decoding digital transmissions
echo "Installing multimon-ng..."
if ! command -v multimon-ng &>/dev/null; then
    if apt-cache show multimon-ng &>/dev/null; then
        sudo apt-get install -y multimon-ng
    elif [ ! -d "multimon-ng" ]; then
        git clone https://github.com/EliasOenal/multimon-ng.git
        cd multimon-ng
        mkdir build && cd build
        cmake ..
        make
        sudo make install
        cd ../..
    fi
fi

# Blacklist DVB drivers to prevent conflicts with RTL-SDR
echo "Blacklisting DVB drivers..."
BLACKLIST_FILE="/etc/modprobe.d/blacklist-rtl.conf"
if ! grep -q "dvb_usb_rtl28xxu" "$BLACKLIST_FILE" 2>/dev/null; then
    echo "blacklist dvb_usb_rtl28xxu" | sudo tee -a "$BLACKLIST_FILE"
fi
sudo modprobe -r dvb_usb_rtl28xxu 2>/dev/null || true

# Add user to plugdev group for USB access
echo "Adding user to plugdev group..."
sudo usermod -a -G plugdev "$USER"

echo ""
echo "✅ System dependencies installation complete!"
echo ""
echo "Installed tools:"
command -v rtl_test           &>/dev/null && echo "  ✓ rtl_test (RTL-SDR)"            || echo "  ✗ rtl_test"
command -v rtl_power          &>/dev/null && echo "  ✓ rtl_power"                      || echo "  ✗ rtl_power"
command -v rtl_433            &>/dev/null && echo "  ✓ rtl_433 (IoT devices)"          || echo "  ✗ rtl_433"
command -v dump1090-mutability &>/dev/null && echo "  ✓ dump1090-mutability (ADS-B)"   || echo "  ✗ dump1090-mutability"
command -v sox                &>/dev/null && echo "  ✓ sox (audio)"                    || echo "  ✗ sox"
command -v iwlist             &>/dev/null && echo "  ✓ iwlist (WiFi)"                  || echo "  ✗ iwlist"
command -v hcitool            &>/dev/null && echo "  ✓ hcitool (Bluetooth)"            || echo "  ✗ hcitool"

echo "Please log out and log back in for group changes to take effect."
