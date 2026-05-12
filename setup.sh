#!/bin/bash

echo "================================================"
echo "   RTL-SDR Scanner - Setup Script"
echo "================================================"
echo ""
echo "This script will set up your RTL-SDR scanner application"
echo ""

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Step 1: Fix permissions
echo -e "${YELLOW}Step 1: Fixing file permissions...${NC}"
cd /home/noname/Desktop/drone_radio_tokivoki_all-freq-scann-locator
sudo chown -R $USER:$USER .
sudo chmod -R 755 .
echo -e "${GREEN}✓ Permissions fixed${NC}"
echo ""

# Step 2: Clean up old installations
echo -e "${YELLOW}Step 2: Cleaning up old node_modules...${NC}"
rm -rf node_modules package-lock.json
rm -rf client/node_modules client/package-lock.json
echo -e "${GREEN}✓ Cleanup complete${NC}"
echo ""

# Step 3: Install system dependencies
echo -e "${YELLOW}Step 3: Installing system dependencies...${NC}"
echo "This will install RTL-SDR drivers, dump1090, rtl_433, and other tools"
read -p "Install system dependencies? (y/n) " -n 1 -r
echo
if [[ $REPLY =~ ^[Yy]$ ]]; then
    chmod +x install-system.sh
    ./install-system.sh
    echo -e "${GREEN}✓ System dependencies installed${NC}"
else
    echo -e "${YELLOW}⚠ Skipping system dependencies${NC}"
fi
echo ""

# Step 4: Install backend dependencies
echo -e "${YELLOW}Step 4: Installing backend Node.js dependencies...${NC}"
npm install --no-optional
if [ $? -eq 0 ]; then
    echo -e "${GREEN}✓ Backend dependencies installed${NC}"
else
    echo -e "${RED}✗ Backend dependencies failed${NC}"
    echo "Trying with --legacy-peer-deps..."
    npm install --legacy-peer-deps --no-optional
fi
echo ""

# Step 5: Install frontend dependencies
echo -e "${YELLOW}Step 5: Installing frontend dependencies...${NC}"
cd client
npm install --legacy-peer-deps
if [ $? -eq 0 ]; then
    echo -e "${GREEN}✓ Frontend dependencies installed${NC}"
else
    echo -e "${RED}✗ Frontend install failed — retrying...${NC}"
    npm install --legacy-peer-deps --force
fi
cd ..
echo ""

# Step 6: Create necessary directories
echo -e "${YELLOW}Step 6: Creating directories...${NC}"
mkdir -p recordings logs captures
echo -e "${GREEN}✓ Directories created${NC}"
echo ""

# Step 7: Setup environment
echo -e "${YELLOW}Step 7: Setting up environment...${NC}"
if [ ! -f ".env" ]; then
    cp .env.example .env
    echo -e "${GREEN}✓ .env file created${NC}"
else
    echo -e "${YELLOW}⚠ .env already exists${NC}"
fi
echo ""

# Step 8: Fix RTL-SDR USB permissions
echo -e "${YELLOW}Step 8: Configuring RTL-SDR USB access...${NC}"
echo 'SUBSYSTEM=="usb", ATTRS{idVendor}=="0bda", ATTRS{idProduct}=="2838", GROUP="plugdev", MODE="0666", SYMLINK+="rtl_sdr"' | sudo tee /etc/udev/rules.d/20-rtlsdr.rules > /dev/null
sudo udevadm control --reload-rules
sudo udevadm trigger
sudo usermod -a -G plugdev $USER
echo -e "${GREEN}✓ USB permissions configured${NC}"
echo ""

# Step 9: Blacklist DVB drivers
echo -e "${YELLOW}Step 9: Blacklisting DVB drivers...${NC}"
BLACKLIST_CONF="/etc/modprobe.d/rtlsdr-blacklist.conf"
cat << 'EOF' | sudo tee "$BLACKLIST_CONF" > /dev/null
# RTL-SDR — blacklist DVB modules so the dongle is usable by rtl_sdr/rtl_fm/dump1090
blacklist dvb_usb_rtl28xxu
blacklist rtl2832
blacklist rtl2830
blacklist dvb_usb_v2
blacklist dvb_core
EOF
sudo rmmod dvb_usb_rtl28xxu 2>/dev/null || true
sudo rmmod rtl2832 2>/dev/null || true
echo -e "${GREEN}✓ DVB drivers blacklisted${NC}"
echo ""

# Step 10: Test RTL-SDR
echo -e "${YELLOW}Step 10: Testing RTL-SDR device...${NC}"
if rtl_test -t 2>&1 | grep -q "Found"; then
    echo -e "${GREEN}✓ RTL-SDR device detected!${NC}"
    rtl_test -t 2>&1 | grep -E "Found|Realtek|tuner"
else
    echo -e "${RED}✗ RTL-SDR device not found${NC}"
    echo "Please:"
    echo "  1. Make sure your RTL-SDR dongle is plugged in"
    echo "  2. Try a different USB port (USB 2.0 preferred)"
    echo "  3. Unplug and replug the device"
    echo "  4. Run: lsusb | grep Realtek"
fi
echo ""

# Step 11: setcap on RTL binaries (no sudo needed at runtime)
echo -e "${YELLOW}Step 11: Setting capabilities on RTL tools (no sudo at runtime)...${NC}"
for bin in rtl_fm rtl_power rtl_sdr rtl_433 rtl_tcp dump1090-mutability; do
    binpath="$(command -v "$bin" 2>/dev/null || true)"
    if [ -n "$binpath" ]; then
        sudo setcap 'cap_net_raw+ep' "$binpath" 2>/dev/null \
            && echo -e "  ${GREEN}✓${NC} cap_net_raw: $binpath" \
            || echo -e "  ${YELLOW}⚠${NC} could not setcap: $binpath"
    fi
done
HCITOOL="$(command -v hcitool 2>/dev/null || true)"
if [ -n "$HCITOOL" ]; then
    sudo setcap 'cap_net_raw,cap_net_admin+eip' "$HCITOOL" 2>/dev/null \
        && echo -e "  ${GREEN}✓${NC} cap: $HCITOOL" \
        || true
fi
echo ""

# Step 12: Wireshark/dumpcap for packet capture / sniffing
echo -e "${YELLOW}Step 12: Configuring packet capture (sniffing) permissions...${NC}"
if ! command -v wireshark &>/dev/null && ! command -v tshark &>/dev/null; then
    echo "  wireshark/tshark not installed. Installing..."
    echo "wireshark-common wireshark-common/install-setuid boolean true" | sudo debconf-set-selections
    sudo DEBIAN_FRONTEND=noninteractive apt-get install -y wireshark tshark 2>/dev/null || \
        echo -e "  ${YELLOW}⚠${NC} Install failed — run: sudo apt install wireshark tshark"
fi
if getent group wireshark > /dev/null 2>&1; then
    sudo usermod -aG wireshark "$USER"
    DUMPCAP="$(command -v dumpcap 2>/dev/null || true)"
    if [ -n "$DUMPCAP" ]; then
        sudo chgrp wireshark "$DUMPCAP"
        sudo chmod 750 "$DUMPCAP"
        sudo setcap 'cap_net_raw,cap_net_admin=eip' "$DUMPCAP" 2>/dev/null
        echo -e "  ${GREEN}✓${NC} dumpcap: wireshark group + caps set"
    fi
    echo -e "  ${GREEN}✓${NC} Added $USER to wireshark group"
fi
echo ""

echo "================================================"
echo -e "${GREEN}   Setup Complete!${NC}"
echo "================================================"
echo ""
echo "Next steps:"
echo "  1. Unplug and replug your RTL-SDR dongle"
echo "  2. Log out and log back in (for group permissions)"
echo "  3. Run: ./start.sh"
echo ""
echo "Or for development mode:"
echo "  NODE_ENV=development ./start-dev.sh"
echo ""
echo "Logs will appear in: ./logs/scanner-<date>.log"
echo ""
