# RTL-SDR Signal Scanner

Professional RF spectrum analyzer and signal detector using RTL-SDR USB dongles. Detects drones, IoT devices, Bluetooth, and all RF signals in real-time.

## Features

### 🚁 Comprehensive Device Detection
- **Aircraft & Drones**: ADS-B detection with altitude, speed, and location
- **IoT Devices**: 433/868/915 MHz sensors and wireless devices
- **Bluetooth**: All nearby Bluetooth devices
- **RF Signals**: General spectrum scanning across all frequencies
- **WiFi & Wireless**: 2.4GHz and 5.8GHz band monitoring

### 📡 Real-time Monitoring
- Live spectrum analyzer with FFT visualization
- Real-time device discovery and tracking
- Signal strength and distance estimation
- WebSocket-based instant updates

### 🎧 Audio Features
- **Live Listening**: Real-time audio demodulation
- **Recording**: Save any frequency to WAV files
- **Playback**: Review recorded signals
- Multiple modulation modes (FM, AM, NFM, WFM)

### 📊 Professional Interface
- Modern Material-UI design
- Real-time spectrum visualization
- Device statistics and analytics
- Filterable device list
- Recording management

## System Requirements

- Linux OS (Ubuntu/Debian recommended)
- RTL-SDR compatible USB dongle (RTL2832U chipset)
- Node.js 14+ and npm
- Python 3
- 2GB RAM minimum

## Supported RTL-SDR Devices

Your device **Realtek RTL2832UDVB with FCI 2580 tuner** is fully supported!

Compatible devices:
- Realtek RTL2832U/RTL2832UDVB
- Any RTL28xx chipset dongles
- Most USB TV tuners with RTL chipset

## Installation

### 1. Clone or navigate to the project
```bash
cd /home/noname/Desktop/drone_radio_tokivoki_all-freq-scann-locator
```

### 2. Run system dependencies installer
```bash
chmod +x install-system.sh
sudo ./install-system.sh
```

This installs:
- RTL-SDR drivers and tools
- dump1090 (ADS-B decoder)
- rtl_433 (IoT device decoder)
- multimon-ng (digital signal decoder)
- kalibrate-rtl (frequency calibration)
- Audio tools (sox, pulseaudio)

### 3. Install Node.js dependencies
```bash
# Install backend dependencies
npm install

# Install frontend dependencies
cd client
npm install
cd ..
```

### 4. Fix USB permissions (important!)
```bash
# Add udev rules for RTL-SDR
echo 'SUBSYSTEM=="usb", ATTRS{idVendor}=="0bda", ATTRS{idProduct}=="2838", GROUP="plugdev", MODE="0666", SYMLINK+="rtl_sdr"' | sudo tee /etc/udev/rules.d/20-rtlsdr.rules

# Reload udev rules
sudo udevadm control --reload-rules
sudo udevadm trigger

# Unplug and replug your RTL-SDR dongle
```

### 5. Configure environment
```bash
cp .env.example .env
# Edit .env if needed
```

## Usage

### Starting the Application

#### Development Mode (with hot reload)
```bash
# Terminal 1 - Backend server
npm run dev

# Terminal 2 - Frontend client
npm run client
```

#### Production Mode
```bash
# Build frontend
cd client
npm run build
cd ..

# Start server
npm start
```

Access the application at: **http://localhost:3001**

### Quick Start

1. **Check RTL-SDR Connection**: The header shows connection status
2. **Click "Start Full Scan"**: Begins scanning all frequencies
3. **View Detected Devices**: Cards appear as devices are found
4. **Listen Live**: Click speaker icon on any device
5. **Record**: Click record button to save signals
6. **Manage Recordings**: Click "Recordings" button to view/download

## Frequency Bands Scanned

### Drone Detection
- **1090 MHz**: ADS-B (aircraft/drone transponders)
- **2.4 GHz**: WiFi, drone control
- **5.8 GHz**: FPV video transmission
- **433 MHz**: RC control
- **915 MHz**: RC control (US)

### IoT Devices
- **433.92 MHz**: Weather stations, sensors
- **868 MHz**: European IoT (LoRa, etc.)
- **315 MHz**: US devices
- **915 MHz**: ISM band

### Other
- **27 MHz**: CB radio
- **49 MHz**: Baby monitors
- **144 MHz**: Ham radio 2m band
- **446 MHz**: PMR446

## Fixing "Lost Bytes" Error

The error you're seeing is normal with some RTL-SDR dongles. To fix:

```bash
# 1. Reduce sample rate
rtl_test -s 1024000

# 2. Check USB port
# Use USB 2.0 port (not USB 3.0)

# 3. Adjust USB buffer
echo 0 | sudo tee /sys/module/usbcore/parameters/usbfs_memory_mb
echo 512 | sudo tee /sys/module/usbcore/parameters/usbfs_memory_mb

# 4. The app automatically handles this
```

## Troubleshooting

### RTL-SDR not detected
```bash
# Check device
rtl_test -t

# Check if kernel driver is blocking
lsmod | grep dvb

# Blacklist DVB drivers
sudo sh -c 'echo "blacklist dvb_usb_rtl28xxu" >> /etc/modprobe.d/blacklist-rtl.conf'
sudo rmmod dvb_usb_rtl28xxu
```

### No audio output
```bash
# Test audio
speaker-test -c2

# Check PulseAudio
pulseaudio --check
pulseaudio --start
```

### Permission denied
```bash
# Add user to plugdev group
sudo usermod -a -G plugdev $USER

# Log out and log back in
```

### Port already in use
```bash
# Change port in .env file
PORT=3002
```

## Advanced Configuration

### Custom Frequency Scanning

Edit `server.js` and modify the frequencies array:

```javascript
const frequencies = [
    { freq: 123456789, label: 'Custom Frequency' },
    // Add more frequencies
];
```

### Adjust Gain

```bash
# List available gains
rtl_test

# Set gain in .env
RTL_GAIN=20
```

### Recording Settings

Edit `.env`:
```
RECORDING_SAMPLE_RATE=48000  # Higher = better quality
RECORDING_BITRATE=16         # 16 or 24 bit
```

## Project Structure

```
.
├── server.js              # Backend API server
├── package.json           # Backend dependencies
├── install-system.sh      # System setup script
├── .env.example          # Environment template
├── recordings/           # Saved audio files
├── logs/                 # Application logs
├── captures/            # Raw IQ captures
└── client/              # React frontend
    ├── public/
    ├── src/
    │   ├── App.js       # Main application
    │   ├── App.css      # Styling
    │   └── index.js     # Entry point
    └── package.json     # Frontend dependencies
```

## API Endpoints

### REST API
- `GET /api/devices` - Get all detected devices
- `GET /api/recordings` - List recordings
- `GET /api/rtl-test` - Check RTL-SDR status
- `POST /api/scan/start` - Start scanning
- `POST /api/scan/stop/:scanId` - Stop scan
- `GET /api/device/:id` - Get device details
- `GET /recordings/:filename` - Download recording

### WebSocket
- `start_scan` - Begin full scan
- `stop_scan` - Stop scanning
- `listen_live` - Start live audio
- `stop_live` - Stop live audio
- `start_recording` - Begin recording
- `stop_recording` - Stop recording

## Performance Tips

1. **USB 2.0**: Use USB 2.0 ports for better stability
2. **Sample Rate**: Lower sample rates reduce CPU usage
3. **Gain**: Auto gain (-10) works best for most scenarios
4. **Antenna**: Use appropriate antenna for frequencies
5. **Cooling**: Ensure dongle has airflow to prevent overheating

## Legal Notice

⚠️ **Important**: 
- Only scan frequencies you are authorized to monitor
- Do not interfere with licensed communications
- Respect privacy and local regulations
- Aircraft tracking is for educational purposes only
- Some frequencies require licenses to transmit

## GitHub Tools Used

This project integrates:
- **dump1090** - ADS-B decoder for aircraft
- **rtl_433** - IoT device decoder
- **multimon-ng** - Digital transmission decoder
- **kalibrate-rtl** - Frequency calibration
- All from official GitHub repositories

## Contributing

Feel free to contribute improvements:
1. Fork the repository
2. Create feature branch
3. Submit pull request

## Support

For issues with:
- RTL-SDR: Check rtl-sdr.com
- Device detection: Verify frequencies and antenna
- Performance: Adjust sample rates and buffers

## License

MIT License - Free to use and modify

## Credits

Built with:
- Node.js & Express
- React & Material-UI
- RTL-SDR tools
- WebSocket for real-time communication
- Various open-source SDR projects

---

**Enjoy professional RF spectrum analysis! 🚁📡**
