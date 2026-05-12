# RTL-SDR Scanner - Quick Setup Guide

## 🚀 Quick Start (Run This First!)

```bash
cd /home/noname/Desktop/drone_radio_tokivoki_all-freq-scann-locator
chmod +x setup.sh
./setup.sh
```

The setup script will:
1. Fix file permissions
2. Clean up any broken installations
3. Install system dependencies (RTL-SDR tools)
4. Install Node.js dependencies
5. Configure USB permissions
6. Test your RTL-SDR device

## ⚠️ Permission Issues Fix

If you encountered permission errors during npm install:

```bash
cd /home/noname/Desktop/drone_radio_tokivoki_all-freq-scann-locator
sudo chown -R $USER:$USER .
sudo rm -rf node_modules client/node_modules package-lock.json client/package-lock.json
npm install
cd client && npm install && cd ..
```

## 📡 Starting the Application

### Option 1: Production Mode (Recommended)
```bash
./start.sh
```
Access at: http://localhost:3001

### Option 2: Development Mode (with auto-reload)
```bash
./start-dev.sh
```
Backend: http://localhost:3001
Frontend: http://localhost:3000

### Option 3: Manual Start
```bash
# Terminal 1 - Backend
node server.js

# Terminal 2 - Frontend (optional, for development)
cd client && npm start
```

## 🔧 Troubleshooting

### RTL-SDR Not Detected

```bash
# Check if device is connected
lsusb | grep Realtek

# Test device
rtl_test -t

# Remove DVB driver (if blocking)
sudo rmmod dvb_usb_rtl28xxu

# Fix permissions
sudo chmod 666 /dev/bus/usb/*/\*
```

### "Lost Bytes" Error

This is normal with some RTL-SDR dongles. The app handles it automatically, but you can:

1. Use a USB 2.0 port (not 3.0)
2. Increase USB buffer:
```bash
echo 512 | sudo tee /sys/module/usbcore/parameters/usbfs_memory_mb
```

### Permission Denied on USB

```bash
# Add udev rules
echo 'SUBSYSTEM=="usb", ATTRS{idVendor}=="0bda", ATTRS{idProduct}=="2838", GROUP="plugdev", MODE="0666"' | sudo tee /etc/udev/rules.d/20-rtlsdr.rules

# Reload rules
sudo udevadm control --reload-rules
sudo udevadm trigger

# Add user to plugdev group
sudo usermod -a -G plugdev $USER

# Log out and log back in
```

### Port Already in Use

```bash
# Find what's using port 3001
sudo lsof -i :3001

# Kill the process
sudo kill -9 <PID>

# Or change port in .env
echo "PORT=3002" >> .env
```

### Missing System Dependencies

```bash
# Run system installer
sudo apt-get update
sudo apt-get install -y rtl-sdr librtlsdr-dev sox build-essential cmake git
```

## 📦 What Was Created

```
drone_radio_tokivoki_all-freq-scann-locator/
├── server.js                 # Backend API server
├── package.json             # Backend dependencies
├── setup.sh                 # Complete setup script
├── start.sh                 # Production start script
├── start-dev.sh            # Development start script
├── install-system.sh       # System dependencies installer
├── .env.example            # Environment template
├── .gitignore              # Git ignore rules
├── README.md               # Full documentation
├── SETUP.md                # This file
├── recordings/             # Audio recordings (created on first run)
├── logs/                   # Application logs
├── captures/               # Raw IQ captures
└── client/                 # React frontend
    ├── public/
    ├── src/
    │   ├── App.js          # Main application
    │   ├── App.css         # Styling
    │   └── index.js        # Entry point
    └── package.json        # Frontend dependencies
```

## 🎯 Features Ready to Use

### Automatic Detection
- ✅ Aircraft & Drones (ADS-B 1090 MHz)
- ✅ IoT Devices (433/868/915 MHz)
- ✅ Bluetooth devices
- ✅ WiFi & wireless (2.4/5.8 GHz)
- ✅ RF signals (all frequencies)

### Real-time Features
- ✅ Live spectrum analyzer
- ✅ Signal strength monitoring
- ✅ Distance estimation
- ✅ Device identification

### Audio Features
- ✅ Live listening (click speaker icon)
- ✅ Recording (click record button)
- ✅ Playback (in recordings drawer)
- ✅ Multiple modulation modes

## 🔍 Verifying Your RTL-SDR

Your device (Realtek RTL2832UDVB with FCI 2580 tuner) is fully supported!

Check it's working:
```bash
rtl_test -t
```

Expected output:
```
Found 1 device(s):
  0:  Realtek, Rtl2832UDVB, SN: 0
Using device 0: Dexatek DK DVB-T Dongle
Found FCI 2580 tuner
```

## 📚 Full Documentation

See README.md for:
- Complete feature list
- API documentation
- Advanced configuration
- Frequency bands
- Legal notices

## 🆘 Still Having Issues?

1. Make sure RTL-SDR is plugged in
2. Run: `./setup.sh` (it fixes most issues)
3. Restart your computer
4. Check README.md for detailed troubleshooting

## 🎉 Ready to Go!

Once setup is complete:
```bash
./start.sh
```

Then open your browser to: **http://localhost:3001**

Click **"Start Full Scan"** and watch as devices are detected in real-time!
