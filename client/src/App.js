import React, { useState, useEffect, useRef } from 'react';
import {
  ThemeProvider,
  createTheme,
  CssBaseline,
  Container,
  Grid,
  Paper,
  Typography,
  Button,
  Card,
  CardContent,
  CardActions,
  Chip,
  Box,
  IconButton,
  LinearProgress,
  Drawer,
  List,
  ListItem,
  ListItemText,
  ListItemIcon,
  Divider,
  Select,
  MenuItem,
  FormControl,
  InputLabel,
  Tooltip,
  Switch,
  FormControlLabel
} from '@mui/material';
import {
  PlayArrow,
  Stop,
  FiberManualRecord,
  Radar,
  SignalCellularAlt,
  Bluetooth,
  Flight,
  FlightTakeoff,
  GraphicEq,
  Mic,
  VolumeUp,
  Download,
  Refresh,
  MyLocation,
  DevicesOther,
  RadioButtonChecked,
  Storage,
  Warning,
  Navigation,
  Map as MapIcon,
  Info,
  Wifi,
  Router,
  SensorsOff,
  Videocam,
  Lock,
  LockOpen,
  Shield,
  GpsFixed
} from '@mui/icons-material';
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip as RechartsTooltip,
  ResponsiveContainer
} from 'recharts';
import axios from 'axios';
import moment from 'moment';
import './App.css';

const darkTheme = createTheme({
  palette: {
    mode: 'dark',
    primary: {
      main: '#00d4ff',
    },
    secondary: {
      main: '#ff00ff',
    },
    background: {
      default: '#0a0e27',
      paper: '#151b38',
    },
  },
});

function App() {
  const [scanning, setScanning] = useState(false);
  const [devices, setDevices] = useState([]);
  const [spectrum, setSpectrum] = useState([]);
  const [recordings, setRecordings] = useState([]);
  const [liveAudio, setLiveAudio] = useState(null);
  const [activeRecordings, setActiveRecordings] = useState(() => new Map()); // frequency -> {recordingId, label}
  const [btmonActive, setBtmonActive] = useState(false);
  const [btmonEvents, setBtmonEvents] = useState([]);
  const [rtlConnected, setRtlConnected] = useState(false);
  const [stats, setStats] = useState({
    totalDevices: 0,
    drones: 0,
    iot: 0,
    bluetooth: 0,
    other: 0
  });
  const [filter, setFilter] = useState('all');
  const [selectedDevice, setSelectedDevice] = useState(null);
  const [autoPairBt, setAutoPairBt] = useState(true);
  const [radiusFilter, setRadiusFilter] = useState(false); // default OFF — filtriraj samo kad eksplicitno uključiš
  const MAX_RADIUS_M = 500000; // 500 km — pokriva cijeli domet RTL-SDR antene
  const [wifiDevices, setWifiDevices] = useState([]);
  const [drawerOpen, setDrawerOpen] = useState(false);
  
  // Scanner group states
  const [scannerStatus, setScannerStatus] = useState({
    adsb: false,
    iot: false,
    general: false,
    bluetooth: false,
    wifi: false,
    drone: false   // dedicated drone scanner
  });

  // Live terminal logs
  const [logs, setLogs] = useState([]);
  const terminalRef = useRef(null);
  
  // Geolocation state
  const [baseLocation, setBaseLocation] = useState(null);
  const [locationPermission, setLocationPermission] = useState('prompt'); // 'granted', 'denied', 'prompt'
  
  const wsRef = useRef(null);

  // WebSocket connection with auto-reconnect
  useEffect(() => {
    let ws;
    let reconnectTimer;

    const connect = () => {
      ws = new WebSocket(`ws://${window.location.hostname}:3001`);

      ws.onopen = () => {
        console.log('WebSocket connected');
        wsRef.current = ws;
      };

      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          handleWebSocketMessage(data);
        } catch (e) {}
      };

      ws.onerror = () => {};

      ws.onclose = () => {
        wsRef.current = null;
        reconnectTimer = setTimeout(connect, 3000);
      };
    };

    connect();

    return () => {
      clearTimeout(reconnectTimer);
      if (ws) ws.close();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Get geolocation for base position
  useEffect(() => {
    // Default location: WEB TEC d.o.o. Gradačac, Bosnia and Herzegovina
    const defaultLocation = {
      lat: 44.8520108,
      lon: 18.5064763
    };

    // Try to get actual geolocation, but use default as fallback
    if ('geolocation' in navigator) {
      navigator.geolocation.getCurrentPosition(
        (position) => {
          const location = {
            lat: position.coords.latitude,
            lon: position.coords.longitude
          };
          setBaseLocation(location);
          setLocationPermission('granted');
          
          console.log(`📍 Using actual GPS location: ${location.lat.toFixed(6)}, ${location.lon.toFixed(6)}`);
          
          // Send to server
          fetch('/api/location/base', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(location)
          }).then(r => r.json())
            .then(data => console.log('✓ Base location set on server:', data))
            .catch(err => console.error('Failed to set base location:', err));
        },
        (error) => {
          console.warn('Geolocation denied or unavailable, using default location (WEB TEC Gradačac)');
          setBaseLocation(defaultLocation);
          setLocationPermission('denied');
          
          // Send default location to server
          fetch('/api/location/base', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(defaultLocation)
          }).then(r => r.json())
            .then(data => console.log('✓ Default base location set:', data))
            .catch(err => console.error('Failed to set base location:', err));
        },
        {
          enableHighAccuracy: true,
          timeout: 5000,
          maximumAge: 300000 // 5 minutes cache
        }
      );
    } else {
      // Browser doesn't support geolocation, use default
      console.warn('Geolocation not supported, using default location (WEB TEC Gradačac)');
      setBaseLocation(defaultLocation);
      setLocationPermission('denied');
      
      // Send default location to server
      fetch('/api/location/base', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(defaultLocation)
      }).then(r => r.json())
        .then(data => console.log('✓ Default base location set:', data))
        .catch(err => console.error('Failed to set base location:', err));
    }
  }, []);

  // Check RTL-SDR connection
  useEffect(() => {
    checkRTLConnection();
    const interval = setInterval(checkRTLConnection, 10000);
    return () => clearInterval(interval);
  }, []);

  // Auto-pair BT device on select
  useEffect(() => {
    if (!autoPairBt) return;
    if (!selectedDevice) return;
    if (selectedDevice.type !== 'bluetooth' || !selectedDevice.address) return;
    pairBtDevice(selectedDevice.address);
    setTimeout(() => {
      if (!btmonActive) startBtMon();
    }, 3000);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedDevice]);

  // Update stats
  useEffect(() => {
    const newStats = {
      totalDevices: devices.length,
      drones: devices.filter(d => d.type === 'aircraft/drone' || d.category === 'drone').length,
      iot: devices.filter(d => d.type === 'iot_device').length,
      bluetooth: devices.filter(d => d.type === 'bluetooth').length,
      other: devices.filter(d => !['aircraft/drone', 'iot_device', 'bluetooth'].includes(d.type) && d.category !== 'drone').length
    };
    setStats(newStats);
  }, [devices]);

  const checkRTLConnection = async () => {
    try {
      const response = await axios.get('/api/rtl-test');
      setRtlConnected(response.data.connected);
    } catch (error) {
      setRtlConnected(false);
    }
  };

  const handleWebSocketMessage = (data) => {
    switch (data.type) {
      case 'device_detected':
        setDevices(prev => {
          // For ADS-B: update existing aircraft by ICAO, otherwise add new
          const key = data.device.icao || data.device.id;
          const idx = prev.findIndex(d => (d.icao && d.icao === key) || d.id === data.device.id);
          if (idx >= 0) {
            const updated = [...prev];
            updated[idx] = { ...prev[idx], ...data.device };
            return updated;
          }
          return [...prev, data.device];
        });
        break;
      case 'devices_cleared':
        setDevices([]);
        break;
      case 'spectrum_data':
        setSpectrum(data.spectrum.map((value, index) => ({
          frequency: index * 1000,
          power: value
        })));
        break;
      case 'scan_started':
        setScanning(true);
        break;
      case 'scan_stopped':
        setScanning(false);
        break;
      case 'recording_started':
        setActiveRecordings(prev => {
          const updated = new Map(prev);
          updated.set(data.frequency, { recordingId: data.recordingId, label: data.deviceLabel });
          return updated;
        });
        break;
      case 'recording_stopped':
        setActiveRecordings(prev => {
          const updated = new Map(prev);
          // Remove by recordingId (iterate through all entries)
          for (const [freq, info] of updated.entries()) {
            if (info.recordingId === data.recordingId) {
              updated.delete(freq);
              break;
            }
          }
          return updated;
        });
        loadRecordings();
        break;
      case 'recording_error':
        setActiveRecordings(prev => {
          const updated = new Map(prev);
          for (const [freq, info] of updated.entries()) {
            if (info.recordingId === data.recordingId) {
              updated.delete(freq);
              break;
            }
          }
          return updated;
        });
        break;
      case 'live_audio_started':
        setLiveAudio(data.frequency);
        break;
      case 'live_audio_stopped':
        setLiveAudio(null);
        break;
      case 'btmon_started':
        setBtmonActive(true);
        console.log('[BTMON] Bluetooth monitoring started');
        break;
      case 'btmon_stopped':
        setBtmonActive(false);
        console.log('[BTMON] Bluetooth monitoring stopped');
        break;
      case 'btmon_event':
        setBtmonEvents(prev => {
          const newEvents = [...prev, data];
          if (newEvents.length > 100) return newEvents.slice(-100);
          return newEvents;
        });
        break;
      case 'bt_pair_started':
        console.log(`[BT-PAIR] Pairing with ${data.address}...`);
        alert(`🔄 Starting auto-pairing with ${data.address}\n\n` +
              `This will take ~10 seconds.\n` +
              `Please confirm pairing on your device when prompted!`);
        break;
      case 'bt_pair_info':
        alert(`⚠️ ${data.message}\n\nCheck your device screen and accept the pairing request!`);
        break;
      case 'bt_pair_success':
        alert(`✅ SUCCESS!\n\n${data.message}\n\nBluetooth monitoring will start automatically.`);
        break;
      case 'bt_pair_error':
        alert(`❌ Pairing Failed\n\n${data.message}\n\nMake sure your device is:\n- In pairing mode\n- Within range (5m)\n- Not already paired with another device`);
        break;
      case 'wifi_devices':
        setWifiDevices(data.devices || []);
        break;
      case 'log':
        // Real-time log from server
        setLogs(prev => {
          const newLogs = [...prev, { timestamp: data.timestamp, level: data.level, message: data.message }];
          // Keep last 500 logs
          if (newLogs.length > 500) return newLogs.slice(-500);
          return newLogs;
        });
        // Auto-scroll terminal to bottom
        setTimeout(() => {
          if (terminalRef.current) {
            terminalRef.current.scrollTop = terminalRef.current.scrollHeight;
          }
        }, 10);
        break;
      case 'scanner_state_sync':
        // Sync scanner state on reconnect/page refresh
        if (data.scanners) {
          setScannerStatus(data.scanners);
        }
        if (data.devices && Array.isArray(data.devices)) {
          setDevices(data.devices);
        }
        break;
      case 'scanner_status':
        // Individual scanner status update
        if (data.scanner) {
          setScannerStatus(prev => ({ ...prev, [data.scanner]: data.active }));
        }
        break;
      default:
        break;
    }
  };

  const startScanner = (scannerType) => {
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: `start_scan_${scannerType}` }));
      setScannerStatus(prev => ({ ...prev, [scannerType]: true }));
    }
  };

  const stopScanner = (scannerType) => {
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: `stop_scan_${scannerType}` }));
      setScannerStatus(prev => ({ ...prev, [scannerType]: false }));
    }
  };

  // Auto-detect FM mode based on frequency
  const getModulationMode = (frequency) => {
    if (!frequency) return 'wbfm';
    const freqMHz = frequency / 1e6;
    
    // FM Broadcast (88-108 MHz) = WBFM
    if (freqMHz >= 88 && freqMHz <= 108) return 'wbfm';
    
    // VHF/UHF (30-3000 MHz) = NFM (walkie-talkies, PMR446, LPD, CB, GMRS, etc.)
    if (freqMHz >= 30 && freqMHz <= 3000) return 'fm';  // 'fm' = NFM in rtl_fm
    
    // HF/Shortwave (< 30 MHz) = AM
    if (freqMHz < 30) return 'am';
    
    // Default = WBFM
    return 'wbfm';
  };

  const startLiveAudio = (frequency, mode, deviceLabel) => {
    if (!frequency) {
      console.error('Cannot start live audio: no frequency specified');
      return;
    }
    // If already listening to another device, stop it first automatically
    if (liveAudio && liveAudio !== frequency) {
      console.log(`[LIVE] Stopping current audio (${(liveAudio / 1e6).toFixed(3)} MHz) to start new...`);
      stopLiveAudio();
      // Wait a bit for cleanup before starting new
      setTimeout(() => {
        const detectedMode = mode || getModulationMode(frequency);
        console.log(`[LIVE] Starting audio: ${(frequency/1e6).toFixed(3)} MHz mode=${detectedMode}`);
        if (wsRef.current) {
          wsRef.current.send(JSON.stringify({
            type: 'listen_live',
            frequency: frequency,
            mode: detectedMode
          }));
        }
      }, 300);
      return;
    }
    const detectedMode = mode || getModulationMode(frequency);
    console.log(`[LIVE] Starting audio: ${(frequency/1e6).toFixed(3)} MHz mode=${detectedMode}`);
    if (wsRef.current) {
      wsRef.current.send(JSON.stringify({
        type: 'listen_live',
        frequency: frequency,
        mode: detectedMode
      }));
    }
  };

  const stopLiveAudio = () => {
    if (wsRef.current) {
      wsRef.current.send(JSON.stringify({
        type: 'stop_live'
      }));
    }
  };

  const startBtMon = () => {
    if (wsRef.current) {
      wsRef.current.send(JSON.stringify({ type: 'start_btmon' }));
    }
  };

  const stopBtMon = () => {
    if (wsRef.current) {
      wsRef.current.send(JSON.stringify({ type: 'stop_btmon' }));
    }
  };

  const pairBtDevice = (address) => {
    if (!address) {
      console.error('[BT-PAIR] No address provided');
      return;
    }
    if (wsRef.current) {
      wsRef.current.send(JSON.stringify({
        type: 'pair_bt_device',
        address: address
      }));
    }
  };

  const startRecording = (frequency, mode, deviceLabel) => {
    if (!frequency) {
      console.error('Cannot start recording: no frequency specified');
      return;
    }
    // Check if already recording this device
    if (activeRecordings.has(frequency)) {
      alert(`Already recording ${deviceLabel || (frequency/1e6).toFixed(3) + ' MHz'}!`);
      return;
    }
    // Check if recording another device (only 1 RTL device)
    if (activeRecordings.size > 0) {
      const current = Array.from(activeRecordings.values())[0];
      alert(`Already recording ${current.label || 'another device'}! Stop it first.`);
      return;
    }
    const detectedMode = mode || getModulationMode(frequency);
    console.log(`[REC] Starting recording: ${(frequency/1e6).toFixed(3)} MHz mode=${detectedMode}`);
    if (wsRef.current) {
      wsRef.current.send(JSON.stringify({
        type: 'start_recording',
        frequency: frequency,
        mode: detectedMode,
        label: deviceLabel || `${(frequency/1e6).toFixed(3)}MHz`
      }));
    }
  };

  const stopRecording = (frequency) => {
    const recordingInfo = activeRecordings.get(frequency);
    if (wsRef.current && recordingInfo) {
      wsRef.current.send(JSON.stringify({
        type: 'stop_recording',
        recordingId: recordingInfo.recordingId
      }));
    }
  };

  const loadRecordings = async () => {
    try {
      const response = await axios.get('/api/recordings');
      setRecordings(response.data);
    } catch (error) {
      console.error('Error loading recordings:', error);
    }
  };

  useEffect(() => {
    loadRecordings();
  }, []);

  const getDeviceIcon = (type) => {
    switch (type) {
      case 'aircraft/drone':
        return <Flight />;
      case 'bluetooth':
        return <Bluetooth />;
      case 'iot_device':
        return <DevicesOther />;
      case 'rf_signal':
        return <RadioButtonChecked />;
      default:
        return <SignalCellularAlt />;
    }
  };

  const getSignalColor = (strength) => {
    if (typeof strength === 'number') {
      // RSSI values in dB
      if (strength > -50) return 'success';
      if (strength > -70) return 'warning';
      return 'error';
    }
    
    if (typeof strength === 'string') {
      // Distance-based color (for ~XXXm or ~X.Xkm format)
      if (strength.includes('m') && !strength.includes('km')) {
        const meters = parseInt(strength.replace(/[^\d]/g, ''));
        if (meters < 100) return 'success';
        if (meters < 500) return 'warning';
        return 'error';
      }
      if (strength.includes('km')) {
        const km = parseFloat(strength.replace(/[^\d.]/g, ''));
        if (km < 1) return 'warning';
        return 'error';
      }
    }
    
    switch (strength) {
      case 'strong':
      case 'very_close':
        return 'success';
      case 'medium':
      case 'close':
        return 'warning';
      default:
        return 'error';
    }
  };

  const getDistanceText = (distance) => {
    if (typeof distance === 'string') {
      return distance.replace(/_/g, ' ').toUpperCase();
    }
    return distance;
  };

  const rssiToPercent = (rssi) => {
    // Convert RSSI (dB) to percentage (0-100%)
    // Typical range: -100 dB (0%) to -40 dB (100%)
    if (typeof rssi !== 'number') return 0;
    const min = -100;
    const max = -40;
    const percent = ((rssi - min) / (max - min)) * 100;
    return Math.max(0, Math.min(100, percent));
  };

  const getBearingDirection = (bearing) => {
    if (bearing == null) return 'Unknown';
    const directions = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
    const index = Math.round(bearing / 22.5) % 16;
    return `${directions[index]} (${Math.round(bearing)}°)`;
  };

  const openOnMap = (device) => {
    if (device.estimatedLocation) {
      const { lat, lon } = device.estimatedLocation;
      // Google Maps URL with marker
      const url = `https://www.google.com/maps?q=${lat},${lon}&z=16`;
      window.open(url, '_blank');
    } else if (device.lat && device.lon) {
      // For ADS-B devices with real coordinates
      const url = `https://www.google.com/maps?q=${device.lat},${device.lon}&z=10`;
      window.open(url, '_blank');
    } else {
      alert('Location not available. Enable geolocation or wait for device to be detected again.');
    }
  };

  const haversineMeters = (lat1, lon1, lat2, lon2) => {
    const R = 6371000;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLon/2)**2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  };

  const getDeviceDistanceM = (device) => {
    // GPS koordinate (ADS-B letjelice) - najpreciznije
    if (device.latitude && device.longitude && baseLocation) {
      return haversineMeters(baseLocation.lat, baseLocation.lon, device.latitude, device.longitude);
    }
    // RF signali i IoT: koristimo serversku procjenu (±50% greška, ali bolje nego nista)
    if (device.distanceMeters) return device.distanceMeters;
    return null; // nepoznato → uvijek prikaži
  };

  const filteredDevices = devices.filter(device => {
    if (filter === 'drone_rf') {
      if (device.category !== 'drone') return false;
    } else if (filter.startsWith('drone_group_')) {
      const group = filter.replace('drone_group_', '');
      if (device.droneGroup !== group) return false;
    } else if (filter !== 'all' && device.type !== filter) return false;
    // Radius filter NE važi za avione (ADS-B) i drone RF signale — oni su uvijek daleko
    const isAircraftOrDrone = device.type === 'aircraft/drone' || device.category === 'drone';
    if (radiusFilter && !isAircraftOrDrone) {
      const distM = getDeviceDistanceM(device);
      if (distM !== null && distM > MAX_RADIUS_M) return false;
    }
    return true;
  });

  return (
    <ThemeProvider theme={darkTheme}>
      <CssBaseline />
      <Box sx={{ display: 'flex' }}>
        <Container maxWidth="xl" sx={{ mt: 4, mb: 4 }}>
          {/* Header */}
          <Paper sx={{ p: 3, mb: 3, background: 'linear-gradient(135deg, #1e3c72 0%, #2a5298 100%)' }}>
            <Grid container alignItems="center" spacing={2}>
              <Grid item>
                <Radar sx={{ fontSize: 48, color: '#00d4ff' }} />
              </Grid>
              <Grid item xs>
                <Typography variant="h3" component="h1" gutterBottom>
                  RTL-SDR Signal Scanner
                </Typography>
                <Typography variant="body1" color="text.secondary">
                  Real-time RF Spectrum Analyzer & Device Detector
                </Typography>
                {baseLocation && (
                  <Typography variant="caption" sx={{ display: 'block', mt: 1, color: '#00d4ff' }}>
                    📍 Base Location: {baseLocation.lat.toFixed(6)}, {baseLocation.lon.toFixed(6)} 
                    {locationPermission === 'granted' ? ' (GPS)' : ' (Default: WEB TEC Gradačac)'}
                  </Typography>
                )}
              </Grid>
              <Grid item>
                <Chip
                  icon={rtlConnected ? <SignalCellularAlt /> : <Warning />}
                  label={rtlConnected ? 'RTL-SDR Connected' : 'RTL-SDR Disconnected'}
                  color={rtlConnected ? 'success' : 'error'}
                  sx={{ mr: 2 }}
                />
                {scanning && (
                  <Chip
                    icon={<FiberManualRecord sx={{ animation: 'pulse 1.5s infinite' }} />}
                    label="SCANNING"
                    color="error"
                    sx={{ mr: 2 }}
                  />
                )}
                {liveAudio && (
                  <Chip
                    icon={<VolumeUp />}
                    label={`🔊 LIVE: ${(liveAudio / 1e6).toFixed(3)} MHz`}
                    color="warning"
                    onDelete={stopLiveAudio}
                    sx={{ 
                      mr: 2,
                      animation: 'pulse 2s infinite',
                      '@keyframes pulse': {
                        '0%, 100%': { opacity: 1 },
                        '50%': { opacity: 0.7 }
                      }
                    }}
                  />
                )}
                {btmonActive && (
                  <Chip
                    icon={<Bluetooth />}
                    label="🎧 BT Monitor Active"
                    color="info"
                    onDelete={stopBtMon}
                    sx={{ mr: 2 }}
                  />
                )}
                <Button
                  variant="outlined"
                  size="small"
                  startIcon={<Bluetooth />}
                  onClick={() => btmonActive ? stopBtMon() : startBtMon()}
                  sx={{ mr: 1 }}
                >
                  {btmonActive ? 'Stop' : 'Start'} BT Monitor
                </Button>
              </Grid>
            </Grid>
          </Paper>

          {/* Control Panel - Scanner Groups */}
          <Paper sx={{ p: 3, mb: 3 }}>
            <Typography variant="h6" sx={{ mb: 2 }}>Scanner Groups — Manual Control</Typography>
            <Grid container spacing={2}>
              {/* ADS-B Aircraft */}
              <Grid item xs={12} sm={6} md={3}>
                <Card sx={{ background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)' }}>
                  <CardContent>
                    <Box sx={{ display: 'flex', alignItems: 'center', mb: 1 }}>
                      <Flight sx={{ mr: 1 }} />
                      <Typography variant="h6">Aircraft / ADS-B</Typography>
                    </Box>
                    <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1 }}>
                      1090 MHz · dump1090-mutability
                    </Typography>
                    <Chip label="✓ Aktivirano" color="success" size="small" sx={{ mb: 0.5, background: '#4caf50' }} />
                    {scannerStatus.adsb ? (
                      <Chip icon={<FiberManualRecord />} label={`AKTIVAN — ${devices.filter(d => d.type === 'aircraft/drone' && d.protocol === 'ADS-B').length} AC`} color="success" size="small" sx={{ mb: 1, ml: 0.5 }} />
                    ) : (
                      <Chip label="Stopped" color="default" size="small" sx={{ mb: 1, ml: 0.5 }} />
                    )}
                  </CardContent>
                  <CardActions>
                    {!scannerStatus.adsb ? (
                      <Button size="small" startIcon={<PlayArrow />} onClick={() => startScanner('adsb')} fullWidth>
                        Start ADS-B
                      </Button>
                    ) : (
                      <Button size="small" color="error" startIcon={<Stop />} onClick={() => stopScanner('adsb')} fullWidth>
                        Stop ADS-B
                      </Button>
                    )}
                  </CardActions>
                </Card>
              </Grid>

              {/* IoT/Drones */}
              <Grid item xs={12} sm={6} md={3}>
                <Card sx={{ background: 'linear-gradient(135deg, #f093fb 0%, #f5576c 100%)' }}>
                  <CardContent>
                    <Box sx={{ display: 'flex', alignItems: 'center', mb: 1 }}>
                      <DevicesOther sx={{ mr: 1 }} />
                      <Typography variant="h6">IoT Devices</Typography>
                    </Box>
                    <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1 }}>
                      433/868/915 MHz sensors
                    </Typography>
                    <Chip label="✓ Works with DVB-T" color="success" size="small" sx={{ mb: 0.5, background: '#4caf50' }} />
                    {scannerStatus.iot ? (
                      <Chip icon={<FiberManualRecord />} label="ACTIVE" color="success" size="small" sx={{ mb: 1 }} />
                    ) : (
                      <Chip label="Stopped" color="default" size="small" sx={{ mb: 1 }} />
                    )}
                  </CardContent>
                  <CardActions>
                    {!scannerStatus.iot ? (
                      <Button size="small" startIcon={<PlayArrow />} onClick={() => startScanner('iot')} fullWidth>
                        Start
                      </Button>
                    ) : (
                      <Button size="small" color="error" startIcon={<Stop />} onClick={() => stopScanner('iot')} fullWidth>
                        Stop
                      </Button>
                    )}
                  </CardActions>
                </Card>
              </Grid>

              {/* Walkie-Talkie/PMR446 */}
              <Grid item xs={12} sm={6} md={3}>
                <Card sx={{ background: 'linear-gradient(135deg, #4facfe 0%, #00f2fe 100%)' }}>
                  <CardContent>
                    <Box sx={{ display: 'flex', alignItems: 'center', mb: 1 }}>
                      <RadioButtonChecked sx={{ mr: 1 }} />
                      <Typography variant="h6">Walkie-Talkie</Typography>
                    </Box>
                    <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1 }}>
                      PMR446 (446 MHz), LPD, CB
                    </Typography>
                    <Chip label="✓ Works with DVB-T" color="success" size="small" sx={{ mb: 0.5, background: '#4caf50' }} />
                    {scannerStatus.general ? (
                      <Chip icon={<FiberManualRecord />} label="ACTIVE" color="success" size="small" sx={{ mb: 1 }} />
                    ) : (
                      <Chip label="Stopped" color="default" size="small" sx={{ mb: 1 }} />
                    )}
                  </CardContent>
                  <CardActions>
                    {!scannerStatus.general ? (
                      <Button size="small" startIcon={<PlayArrow />} onClick={() => startScanner('general')} fullWidth>
                        Start
                      </Button>
                    ) : (
                      <Button size="small" color="error" startIcon={<Stop />} onClick={() => stopScanner('general')} fullWidth>
                        Stop
                      </Button>
                    )}
                  </CardActions>
                </Card>
              </Grid>

              {/* Bluetooth */}
              <Grid item xs={12} sm={6} md={3}>
                <Card sx={{ background: 'linear-gradient(135deg, #fa709a 0%, #fee140 100%)' }}>
                  <CardContent>
                    <Box sx={{ display: 'flex', alignItems: 'center', mb: 1 }}>
                      <Bluetooth sx={{ mr: 1 }} />
                      <Typography variant="h6">Bluetooth</Typography>
                    </Box>
                    <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1 }}>
                      BT 2.4 GHz devices
                    </Typography>
                    {scannerStatus.bluetooth ? (
                      <Chip icon={<FiberManualRecord />} label="ACTIVE" color="success" size="small" sx={{ mb: 1 }} />
                    ) : (
                      <Chip label="Stopped" color="default" size="small" sx={{ mb: 1 }} />
                    )}
                  </CardContent>
                  <CardActions>
                    {!scannerStatus.bluetooth ? (
                      <Button size="small" startIcon={<PlayArrow />} onClick={() => startScanner('bluetooth')} fullWidth>
                        Start
                      </Button>
                    ) : (
                      <Button size="small" color="error" startIcon={<Stop />} onClick={() => stopScanner('bluetooth')} fullWidth>
                        Stop
                      </Button>
                    )}
                  </CardActions>
                </Card>
              </Grid>

              {/* WiFi */}
              <Grid item xs={12} sm={6} md={3}>
                <Card sx={{ background: 'linear-gradient(135deg, #1a1a2e 0%, #16213e 50%, #0f3460 100%)', border: '1px solid #00d4ff44' }}>
                  <CardContent>
                    <Box sx={{ display: 'flex', alignItems: 'center', mb: 1 }}>
                      <Wifi sx={{ mr: 1, color: '#00d4ff' }} />
                      <Typography variant="h6" sx={{ color: '#00d4ff' }}>WiFi Scan</Typography>
                    </Box>
                    <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1 }}>
                      Mreže, kamere, sumnjivi AP
                    </Typography>
                    {scannerStatus.wifi ? (
                      <Chip icon={<FiberManualRecord />} label={`ACTIVE — ${wifiDevices.length} mreža`} color="success" size="small" sx={{ mb: 1 }} />
                    ) : (
                      <Chip label="Stopped" color="default" size="small" sx={{ mb: 1 }} />
                    )}
                    {wifiDevices.filter(d => d.suspicious).length > 0 && (
                      <Chip label={`⚠️ ${wifiDevices.filter(d => d.suspicious).length} sumnjivo`} color="error" size="small" sx={{ mb: 1, ml: 0.5 }} />
                    )}
                  </CardContent>
                  <CardActions>
                    {!scannerStatus.wifi ? (
                      <Button size="small" startIcon={<PlayArrow />} onClick={() => startScanner('wifi')} fullWidth sx={{ color: '#00d4ff' }}>
                        Start
                      </Button>
                    ) : (
                      <Button size="small" color="error" startIcon={<Stop />} onClick={() => stopScanner('wifi')} fullWidth>
                        Stop
                      </Button>
                    )}
                  </CardActions>
                </Card>
              </Grid>

              {/* Drone Scanner — dedicated drone-only sweep */}
              <Grid item xs={12} sm={6} md={3}>
                <Card sx={{ background: 'linear-gradient(135deg, #1a0800 0%, #3d1500 100%)', border: '2px solid #ff980066' }}>
                  <CardContent>
                    <Box sx={{ display: 'flex', alignItems: 'center', mb: 1 }}>
                      <FlightTakeoff sx={{ mr: 1, color: '#ff9800' }} />
                      <Typography variant="h6" sx={{ color: '#ff9800' }}>Drone Scanner</Typography>
                    </Box>
                    <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 0.5 }}>
                      433 / 868 / 900 / 915 MHz · 1.2 GHz
                    </Typography>
                    <Chip label="5 grupa: hobby · pro · FPV · LR · vojni" size="small" sx={{ mb: 0.5, fontSize: '0.62rem', background: '#2a1000', color: '#ff9800', border: '1px solid #ff980044' }} />
                    {scannerStatus.drone ? (
                      <Chip icon={<FiberManualRecord />} label={`AKTIVAN — ${devices.filter(d => d.category === 'drone' && d.droneGroup).length} signala`} color="warning" size="small" sx={{ mb: 1, display: 'block' }} />
                    ) : (
                      <Chip label="Stopped" color="default" size="small" sx={{ mb: 1 }} />
                    )}
                  </CardContent>
                  <CardActions>
                    {!scannerStatus.drone ? (
                      <Button size="small" startIcon={<PlayArrow />} onClick={() => startScanner('drone')} fullWidth sx={{ color: '#ff9800', fontWeight: 'bold' }}>
                        Start Drone Scan
                      </Button>
                    ) : (
                      <Button size="small" color="error" startIcon={<Stop />} onClick={() => stopScanner('drone')} fullWidth>
                        Stop
                      </Button>
                    )}
                  </CardActions>
                </Card>
              </Grid>
            </Grid>

            {/* Actions Row */}
            <Box sx={{ mt: 2, display: 'flex', gap: 2, alignItems: 'center' }}>
              <Button
                variant="outlined"
                startIcon={<Refresh />}
                onClick={() => {
                  setDevices([]);
                  if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
                    wsRef.current.send(JSON.stringify({ type: 'clear_devices' }));
                  }
                }}
              >
                Clear Devices
              </Button>
              <FormControl sx={{ minWidth: 200 }}>
                <InputLabel>Filter</InputLabel>
                <Select
                  value={filter}
                  label="Filter"
                  onChange={(e) => setFilter(e.target.value)}
                  size="small"
                >
                  <MenuItem value="all">All Devices</MenuItem>
                  <MenuItem value="aircraft/drone">Aircraft (ADS-B)</MenuItem>
                  <MenuItem value="drone_rf">Drones — svi RF signali</MenuItem>
                  <MenuItem value="drone_group_hobby">🚁 Drones — Hobby/Mali</MenuItem>
                  <MenuItem value="drone_group_pro">📡 Drones — Profesionalni</MenuItem>
                  <MenuItem value="drone_group_fpv">🏎️ Drones — FPV Racing</MenuItem>
                  <MenuItem value="drone_group_longrange">🗺️ Drones — Long Range</MenuItem>
                  <MenuItem value="drone_group_military">⚔️ Drones — Vojni/Taktički</MenuItem>
                  <MenuItem value="iot_device">IoT</MenuItem>
                  <MenuItem value="rf_signal">RF/PMR446</MenuItem>
                  <MenuItem value="bluetooth">Bluetooth</MenuItem>
                </Select>
              </FormControl>
              <FormControlLabel
                control={
                  <Switch
                    checked={autoPairBt}
                    onChange={(e) => setAutoPairBt(e.target.checked)}
                    color="primary"
                    size="small"
                  />
                }
                label={
                  <Typography variant="body2" sx={{ color: autoPairBt ? '#00d4ff' : 'text.secondary', fontWeight: autoPairBt ? 'bold' : 'normal' }}>
                    <Bluetooth sx={{ fontSize: 14, mr: 0.5, verticalAlign: 'middle' }} />
                    Auto-Pair BT
                  </Typography>
                }
              />
              <Tooltip title={`Prikazuj samo uređaje unutar ${MAX_RADIUS_M}m od serverske lokacije`}>
                <FormControlLabel
                  control={
                    <Switch
                      checked={radiusFilter}
                      onChange={(e) => setRadiusFilter(e.target.checked)}
                      color="warning"
                      size="small"
                    />
                  }
                  label={
                    <Typography variant="body2" sx={{ color: radiusFilter ? '#ffa726' : 'text.secondary', fontWeight: radiusFilter ? 'bold' : 'normal' }}>
                      <MyLocation sx={{ fontSize: 14, mr: 0.5, verticalAlign: 'middle' }} />
                      Radius {MAX_RADIUS_M}m
                    </Typography>
                  }
                />
              </Tooltip>
              <Box sx={{ flexGrow: 1 }} />
              <Button
                variant="outlined"
                startIcon={<Storage />}
                onClick={() => setDrawerOpen(true)}
              >
                Recordings ({recordings.length})
              </Button>
            </Box>
          </Paper>

          {/* AI Scan Suggestions */}
          {rtlConnected && (
            <Paper sx={{ p: 2, mb: 3, background: 'linear-gradient(135deg, #134e5e 0%, #71b280 100%)' }}>
              <Box sx={{ display: 'flex', alignItems: 'center', mb: 1 }}>
                <GraphicEq sx={{ mr: 1, color: '#0f0' }} />
                <Typography variant="h6" sx={{ color: '#fff' }}>AI Scan Recommendations</Typography>
              </Box>
              <Typography variant="body2" sx={{ mb: 1, color: '#ddd' }}>
                {(() => {
                  const hour = new Date().getHours();
                  if (hour >= 6 && hour < 12) {
                    return '🌅 Jutro — Pokreni ADS-B za avione i IoT za senzore. Droni aktivni od ranog jutra.';
                  } else if (hour >= 12 && hour < 18) {
                    return '☀️ Poslijepodne — Vrhunac IoT, Bluetooth i dronova. Pokreni ADS-B + General scanner.';
                  } else if (hour >= 18 && hour < 22) {
                    return '🌆 Veče — Tokivoki i PMR446 aktivni. Pokreni General scanner. ADS-B noćni letovi.';
                  } else {
                    return '🌙 Noć — Manji RF promet. IoT senzori i ADS-B cargo letovi aktivni.';
                  }
                })()}
              </Typography>
              <Typography variant="caption" sx={{ display: 'block', mb: 1, color: '#4caf50', fontSize: '0.7rem' }}>
                ✅ ADS-B aktivan — dump1090-mutability instaliran. Pokreni "Start ADS-B" za detekciju aviona na 1090 MHz.
              </Typography>
              <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}>
                {(() => {
                  const hour = new Date().getHours();
                  const suggestions = [];
                  suggestions.push({ label: 'ADS-B Avioni', type: 'adsb' });
                  if (hour >= 10 && hour < 20) suggestions.push({ label: 'IoT', type: 'iot' });
                  if (hour >= 16 && hour < 23) suggestions.push({ label: 'Walkie-Talkie', type: 'general' });
                  suggestions.push({ label: 'Bluetooth', type: 'bluetooth' });
                  suggestions.push({ label: 'Dronovi (General)', type: 'general' });
                  return [...new Map(suggestions.map(s => [s.type, s])).values()].map(s => (
                    <Chip
                      key={s.type}
                      label={`Start ${s.label}`}
                      size="small"
                      onClick={() => startScanner(s.type)}
                      disabled={scannerStatus[s.type]}
                      sx={{ 
                        background: scannerStatus[s.type] ? '#555' : '#00d4ff', 
                        color: scannerStatus[s.type] ? '#888' : '#000', 
                        fontWeight: 'bold',
                        cursor: scannerStatus[s.type] ? 'default' : 'pointer',
                        '&:hover': { background: scannerStatus[s.type] ? '#555' : '#00ffaa' }
                      }}
                    />
                  ));
                })()}
              </Box>
            </Paper>
          )}

          {/* Live Terminal Console */}
          <Paper sx={{ p: 2, mb: 3, background: '#000', border: '1px solid #00d4ff' }}>
            <Box sx={{ display: 'flex', alignItems: 'center', mb: 1 }}>
              <Typography variant="h6" sx={{ color: '#00d4ff', fontFamily: 'monospace', flexGrow: 1 }}>
                ▶ Live Terminal
              </Typography>
              <Button size="small" onClick={() => setLogs([])} sx={{ color: '#00d4ff' }}>
                Clear
              </Button>
            </Box>
            <Box
              ref={terminalRef}
              sx={{
                fontFamily: 'monospace',
                fontSize: '0.75rem',
                color: '#0f0',
                background: '#000',
                p: 1,
                height: '300px',
                overflowY: 'auto',
                border: '1px solid #333',
                borderRadius: 1,
                '&::-webkit-scrollbar': { width: '8px' },
                '&::-webkit-scrollbar-track': { background: '#111' },
                '&::-webkit-scrollbar-thumb': { background: '#00d4ff', borderRadius: '4px' }
              }}
            >
              {logs.length === 0 && (
                <Box sx={{ color: '#666', textAlign: 'center', mt: 10 }}>
                  Waiting for scanner logs...
                </Box>
              )}
              {logs.map((log, idx) => {
                const levelColor = log.level === 'ERROR' ? '#f44' : log.level === 'WARN' ? '#fa0' : log.level === 'INFO' ? '#0f0' : '#0af';
                return (
                  <Box key={idx} sx={{ mb: 0.3 }}>
                    <span style={{ color: '#666' }}>[{log.timestamp}]</span>{' '}
                    <span style={{ color: levelColor, fontWeight: 'bold' }}>[{log.level}]</span>{' '}
                    <span style={{ color: log.message.includes('New aircraft') || log.message.includes('signal') || log.message.includes('detected') ? '#ff0' : '#0f0' }}>
                      {log.message}
                    </span>
                  </Box>
                );
              })}
            </Box>
          </Paper>

          {/* Stats Cards */}
          <Grid container spacing={3} sx={{ mb: 3 }}>
            <Grid item xs={12} sm={6} md={2.4}>
              <Card sx={{ background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)' }}>
                <CardContent>
                  <Typography color="text.secondary" gutterBottom>
                    Total Devices
                  </Typography>
                  <Typography variant="h3">
                    {stats.totalDevices}
                  </Typography>
                </CardContent>
              </Card>
            </Grid>
            <Grid item xs={12} sm={6} md={2.4}>
              <Card sx={{ background: 'linear-gradient(135deg, #f093fb 0%, #f5576c 100%)' }}>
                <CardContent>
                  <Typography color="text.secondary" gutterBottom>
                    Drones/Aircraft
                  </Typography>
                  <Typography variant="h3">
                    {stats.drones}
                  </Typography>
                </CardContent>
              </Card>
            </Grid>
            <Grid item xs={12} sm={6} md={2.4}>
              <Card sx={{ background: 'linear-gradient(135deg, #4facfe 0%, #00f2fe 100%)' }}>
                <CardContent>
                  <Typography color="text.secondary" gutterBottom>
                    IoT Devices
                  </Typography>
                  <Typography variant="h3">
                    {stats.iot}
                  </Typography>
                </CardContent>
              </Card>
            </Grid>
            <Grid item xs={12} sm={6} md={2.4}>
              <Card sx={{ background: 'linear-gradient(135deg, #43e97b 0%, #38f9d7 100%)' }}>
                <CardContent>
                  <Typography color="text.secondary" gutterBottom>
                    Bluetooth
                  </Typography>
                  <Typography variant="h3">
                    {stats.bluetooth}
                  </Typography>
                </CardContent>
              </Card>
            </Grid>
            <Grid item xs={12} sm={6} md={2.4}>
              <Card sx={{ background: 'linear-gradient(135deg, #fa709a 0%, #fee140 100%)' }}>
                <CardContent>
                  <Typography color="text.secondary" gutterBottom>
                    Other Signals
                  </Typography>
                  <Typography variant="h3">
                    {stats.other}
                  </Typography>
                </CardContent>
              </Card>
            </Grid>
          </Grid>

          {/* Spectrum Analyzer */}
          {spectrum.length > 0 && (
            <Paper sx={{ p: 3, mb: 3 }}>
              <Typography variant="h5" gutterBottom>
                <GraphicEq sx={{ mr: 1, verticalAlign: 'middle' }} />
                Live Spectrum Analyzer
              </Typography>
              <ResponsiveContainer width="100%" height={200}>
                <AreaChart data={spectrum}>
                  <defs>
                    <linearGradient id="colorPower" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#00d4ff" stopOpacity={0.8}/>
                      <stop offset="95%" stopColor="#00d4ff" stopOpacity={0}/>
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis dataKey="frequency" />
                  <YAxis />
                  <RechartsTooltip />
                  <Area type="monotone" dataKey="power" stroke="#00d4ff" fillOpacity={1} fill="url(#colorPower)" />
                </AreaChart>
              </ResponsiveContainer>
            </Paper>
          )}

          {/* ── ADS-B AIRCRAFT PANEL ─────────────────────────────────────── */}
          {devices.filter(d => d.type === 'aircraft/drone' && d.protocol === 'ADS-B').length > 0 && (
            <Paper sx={{ p: 3, mb: 3, background: 'linear-gradient(135deg, #0d1b2a 0%, #1b3a5c 100%)', border: '1px solid #667eea55' }}>
              <Typography variant="h5" gutterBottom sx={{ color: '#aad4ff', display: 'flex', alignItems: 'center', gap: 1 }}>
                <Flight sx={{ color: '#667eea' }} /> ADS-B Aircraft Tracker
                <Chip size="small" label={`${devices.filter(d => d.type === 'aircraft/drone' && d.protocol === 'ADS-B').length} aircraft`} color="primary" sx={{ ml: 1, background: '#667eea' }} />
              </Typography>
              <Box sx={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.82rem' }}>
                  <thead>
                    <tr style={{ color: '#aad4ff', borderBottom: '1px solid #334' }}>
                      <th style={{ textAlign: 'left', padding: '6px 8px' }}>ICAO / Callsign</th>
                      <th style={{ textAlign: 'center', padding: '6px 8px' }}>Altitude (ft / m)</th>
                      <th style={{ textAlign: 'center', padding: '6px 8px' }}>Speed (kt)</th>
                      <th style={{ textAlign: 'center', padding: '6px 8px' }}>Track</th>
                      <th style={{ textAlign: 'center', padding: '6px 8px' }}>Squawk</th>
                      <th style={{ textAlign: 'center', padding: '6px 8px' }}>Distance</th>
                      <th style={{ textAlign: 'center', padding: '6px 8px' }}>Bearing</th>
                      <th style={{ textAlign: 'center', padding: '6px 8px' }}>GPS</th>
                      <th style={{ textAlign: 'center', padding: '6px 8px' }}>Seen</th>
                    </tr>
                  </thead>
                  <tbody>
                    {devices
                      .filter(d => d.type === 'aircraft/drone' && d.protocol === 'ADS-B')
                      .sort((a, b) => {
                        if (a.distance && b.distance) return (a.distanceMeters || 99999) - (b.distanceMeters || 99999);
                        return new Date(b.timestamp) - new Date(a.timestamp);
                      })
                      .map(ac => (
                        <tr key={ac.id} style={{ borderBottom: '1px solid #1a2a3a', color: '#cce4ff' }}>
                          <td style={{ padding: '6px 8px', fontWeight: 'bold', fontFamily: 'monospace' }}>
                            <Flight sx={{ fontSize: 14, mr: 0.5, verticalAlign: 'middle', color: ac.onGround ? '#fa4' : '#667eea' }} />
                            {ac.icao}
                            {ac.onGround && <span style={{ color: '#fa4', fontSize: '0.72em', marginLeft: 4 }}>🛬 TLO</span>}
                            {ac.callsign && ac.callsign.trim() && (
                              <span style={{ color: '#00d4ff', marginLeft: 6 }}>{ac.callsign.trim()}</span>
                            )}
                          </td>
                          <td style={{ padding: '6px 8px', textAlign: 'center' }}>
                            {ac.altitude != null
                              ? <span style={{ color: ac.altitude > 10000 ? '#4af' : ac.altitude > 3000 ? '#fa4' : '#f64' }}>
                                  {ac.altitude.toLocaleString()} ft
                                  <span style={{ color: '#888', fontSize: '0.75em', marginLeft: 4 }}>({Math.round(ac.altitude * 0.3048).toLocaleString()}m)</span>
                                </span>
                              : <span style={{ color: '#555' }}>—</span>}
                          </td>
                          <td style={{ padding: '6px 8px', textAlign: 'center' }}>
                            {ac.speed != null ? `${ac.speed} kt` : <span style={{ color: '#555' }}>—</span>}
                          </td>
                          <td style={{ padding: '6px 8px', textAlign: 'center' }}>
                            {ac.track != null
                              ? <span>
                                  <Navigation sx={{ fontSize: 14, transform: `rotate(${ac.track}deg)`, color: '#00d4ff', verticalAlign: 'middle' }} />
                                  {' '}{ac.track}°
                                </span>
                              : <span style={{ color: '#555' }}>—</span>}
                          </td>
                          <td style={{ padding: '6px 8px', textAlign: 'center', fontFamily: 'monospace' }}>
                            {ac.squawk
                              ? <span style={{ color: ac.squawk === '7500' || ac.squawk === '7600' || ac.squawk === '7700' ? '#f44' : '#aaa' }}>
                                  {ac.squawk}
                                  {ac.squawk === '7700' && ' ⚠️ EMERGENCY'}
                                  {ac.squawk === '7500' && ' ⚠️ HIJACK'}
                                  {ac.squawk === '7600' && ' ⚠️ RADIO FAIL'}
                                </span>
                              : <span style={{ color: '#555' }}>—</span>}
                          </td>
                          <td style={{ padding: '6px 8px', textAlign: 'center' }}>
                            {ac.distance
                              ? <span style={{ color: '#4af' }}>{ac.distance}</span>
                              : <span style={{ color: '#555' }}>—</span>}
                          </td>
                          <td style={{ padding: '6px 8px', textAlign: 'center' }}>
                            {ac.bearing != null
                              ? <span>{getBearingDirection(ac.bearing)}</span>
                              : <span style={{ color: '#555' }}>—</span>}
                          </td>
                          <td style={{ padding: '6px 8px', textAlign: 'center' }}>
                            {ac.latitude != null && ac.longitude != null
                              ? <Button
                                  size="small"
                                  startIcon={<MyLocation />}
                                  onClick={() => window.open(`https://www.google.com/maps?q=${ac.latitude},${ac.longitude}&z=12`, '_blank')}
                                  sx={{ fontSize: '0.7rem', p: '2px 5px', color: '#00d4ff', minWidth: 0 }}
                                >
                                  {ac.latitude.toFixed(4)},{ac.longitude.toFixed(4)}
                                </Button>
                              : <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.3, alignItems: 'center' }}>
                                  <span style={{ color: '#555', fontSize: '0.72rem' }}>{ac.onGround ? '🛬 Na tlu' : 'GPS čeka…'}</span>
                                  <Button
                                    size="small"
                                    onClick={() => window.open(`https://www.flightradar24.com/${ac.icao.toLowerCase()}`, '_blank')}
                                    sx={{ fontSize: '0.62rem', p: '1px 4px', color: '#fa0', minWidth: 0, lineHeight: 1.2 }}
                                  >
                                    FR24 →
                                  </Button>
                                  <Button
                                    size="small"
                                    onClick={() => window.open(`https://globe.adsbexchange.com/?icao=${ac.icao.toLowerCase()}`, '_blank')}
                                    sx={{ fontSize: '0.62rem', p: '1px 4px', color: '#0af', minWidth: 0, lineHeight: 1.2 }}
                                  >
                                    ADSB-X →
                                  </Button>
                                </Box>}
                          </td>
                          <td style={{ padding: '6px 8px', textAlign: 'center', color: '#666', fontSize: '0.75rem' }}>
                            {moment(ac.timestamp).format('HH:mm:ss')}
                          </td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </Box>
            </Paper>
          )}

          {/* ── DRONE GROUPS PANEL ─────────────────────────────────────────── */}
          <Paper sx={{ p: 3, mb: 3, background: 'linear-gradient(135deg, #0d0a00 0%, #1a1000 100%)', border: '2px solid #ff980044' }}>
            <Box sx={{ display: 'flex', alignItems: 'center', mb: 1, gap: 1, flexWrap: 'wrap' }}>
              <FlightTakeoff sx={{ color: '#ff9800', fontSize: 28 }} />
              <Typography variant="h5" sx={{ color: '#ff9800' }}>Drone Detekcija — Grupe</Typography>
              <Chip size="small" label={`${devices.filter(d => d.droneGroup).length} grupnih signala`} color="warning" />
              {!scannerStatus.drone ? (
                <Button size="small" variant="outlined" startIcon={<PlayArrow />}
                  onClick={() => startScanner('drone')}
                  sx={{ color: '#ff9800', borderColor: '#ff9800', ml: 1 }}>
                  Pokreni Drone Scanner
                </Button>
              ) : (
                <Chip icon={<FiberManualRecord />} label="DRONE SCAN AKTIVAN" color="warning" size="small" />
              )}
            </Box>
            <Typography variant="caption" sx={{ display: 'block', mb: 2, color: '#888', fontSize: '0.72rem' }}>
              ⚠️ RTL-SDR pokriva do ~1.75 GHz &nbsp;|&nbsp; 2.4 GHz / 5.8 GHz DJI i FPV zahtijevaju HackRF/USRP &nbsp;|&nbsp;
              RTL-SDR detektuje kretanje na: 433 / 868 / 900 / 915 MHz i 1.2 GHz
            </Typography>

            <Grid container spacing={1.5}>
              {/* ── HOBBY ── */}
              <Grid item xs={12} sm={6} lg={2.4}>
                <Card sx={{ background: 'linear-gradient(135deg, #061a06 0%, #0d3a0d 100%)', height: '100%', border: '1px solid #4caf5033' }}>
                  <CardContent sx={{ pb: '8px !important' }}>
                    <Typography variant="subtitle1" sx={{ color: '#4caf50', fontWeight: 'bold', mb: 0.5 }}>🚁 Mali / Hobistički</Typography>
                    <Typography variant="caption" sx={{ color: '#888', display: 'block', mb: 1, fontSize: '0.65rem' }}>
                      DJI Mini 1/2/3/4 Pro, Spark, Autel EVO Nano, Holy Stone, SJRC, Hubsan
                    </Typography>
                    {[
                      { f: '433 MHz', ok: true,  l: 'RC link (stariji modeli)' },
                      { f: '1.2 GHz', ok: true,  l: 'FPV analog video' },
                      { f: '2.4 GHz', ok: false, l: 'DJI OcuSync (treba HackRF)' },
                      { f: '5.8 GHz', ok: false, l: 'DJI video (treba HackRF)' },
                    ].map(r => (
                      <Box key={r.f} sx={{ display: 'flex', alignItems: 'center', mb: 0.4 }}>
                        <Chip label={r.f} size="small" sx={{ fontSize: '0.58rem', minWidth: 60, mr: 0.5, py: 0, height: 18,
                          background: r.ok ? '#0d3a0d' : '#1a0000', color: r.ok ? '#4caf50' : '#f44', border: `1px solid ${r.ok ? '#4caf5044' : '#f4433644'}` }} />
                        <Typography sx={{ fontSize: '0.62rem', color: r.ok ? '#888' : '#444' }}>{r.ok ? '✓' : '✗'} {r.l}</Typography>
                      </Box>
                    ))}
                    <Box sx={{ mt: 1, display: 'flex', gap: 0.5, flexWrap: 'wrap' }}>
                      <Chip label="Domet 1–7 km" size="small" sx={{ fontSize: '0.58rem', background: '#0d2a0d', color: '#4caf50', height: 18 }} />
                      {devices.filter(d => d.droneGroup === 'hobby').length > 0 &&
                        <Chip label={`🔴 ${devices.filter(d => d.droneGroup === 'hobby').length} SIGNAL`} size="small" color="error" sx={{ fontSize: '0.58rem', height: 18 }} />}
                    </Box>
                  </CardContent>
                </Card>
              </Grid>

              {/* ── PRO ── */}
              <Grid item xs={12} sm={6} lg={2.4}>
                <Card sx={{ background: 'linear-gradient(135deg, #00060d 0%, #001a4a 100%)', height: '100%', border: '1px solid #2196f333' }}>
                  <CardContent sx={{ pb: '8px !important' }}>
                    <Typography variant="subtitle1" sx={{ color: '#42a5f5', fontWeight: 'bold', mb: 0.5 }}>📡 Profesionalni</Typography>
                    <Typography variant="caption" sx={{ color: '#888', display: 'block', mb: 1, fontSize: '0.65rem' }}>
                      DJI Mavic 3 Enterprise, Matrice 300/350 RTK, Autel EVO II Pro, Skydio 2+
                    </Typography>
                    {[
                      { f: '868 MHz', ok: true,  l: 'Telemetrija EU' },
                      { f: '915 MHz', ok: true,  l: 'Telemetrija global' },
                      { f: '1.2 GHz', ok: true,  l: 'Video downlink' },
                      { f: '2.4 GHz', ok: false, l: 'OcuSync 3 (treba HackRF)' },
                      { f: '5.8 GHz', ok: false, l: 'HD video (treba HackRF)' },
                    ].map(r => (
                      <Box key={r.f} sx={{ display: 'flex', alignItems: 'center', mb: 0.4 }}>
                        <Chip label={r.f} size="small" sx={{ fontSize: '0.58rem', minWidth: 60, mr: 0.5, py: 0, height: 18,
                          background: r.ok ? '#001240' : '#1a0000', color: r.ok ? '#42a5f5' : '#f44', border: `1px solid ${r.ok ? '#2196f344' : '#f4433644'}` }} />
                        <Typography sx={{ fontSize: '0.62rem', color: r.ok ? '#888' : '#444' }}>{r.ok ? '✓' : '✗'} {r.l}</Typography>
                      </Box>
                    ))}
                    <Box sx={{ mt: 1, display: 'flex', gap: 0.5, flexWrap: 'wrap' }}>
                      <Chip label="Domet 7–15 km" size="small" sx={{ fontSize: '0.58rem', background: '#001230', color: '#42a5f5', height: 18 }} />
                      {devices.filter(d => d.droneGroup === 'pro').length > 0 &&
                        <Chip label={`🔴 ${devices.filter(d => d.droneGroup === 'pro').length} SIGNAL`} size="small" color="error" sx={{ fontSize: '0.58rem', height: 18 }} />}
                    </Box>
                  </CardContent>
                </Card>
              </Grid>

              {/* ── FPV ── */}
              <Grid item xs={12} sm={6} lg={2.4}>
                <Card sx={{ background: 'linear-gradient(135deg, #1a0500 0%, #4a1200 100%)', height: '100%', border: '1px solid #ff572233' }}>
                  <CardContent sx={{ pb: '8px !important' }}>
                    <Typography variant="subtitle1" sx={{ color: '#ff7043', fontWeight: 'bold', mb: 0.5 }}>🏎️ FPV Racing</Typography>
                    <Typography variant="caption" sx={{ color: '#888', display: 'block', mb: 1, fontSize: '0.65rem' }}>
                      Racing quads, freestyle, TinyWhoop — ELRS, FrSky, TBS Crossfire
                    </Typography>
                    {[
                      { f: '433 MHz', ok: true,  l: 'ELRS / TBS Crossfire RC' },
                      { f: '868 MHz', ok: true,  l: 'ELRS EU RC link' },
                      { f: '915 MHz', ok: true,  l: 'ELRS US/global' },
                      { f: '1.2 GHz', ok: true,  l: 'Analog FPV video' },
                      { f: '5.8 GHz', ok: false, l: 'FPV/DJI O3 (treba HackRF)' },
                    ].map(r => (
                      <Box key={r.f} sx={{ display: 'flex', alignItems: 'center', mb: 0.4 }}>
                        <Chip label={r.f} size="small" sx={{ fontSize: '0.58rem', minWidth: 60, mr: 0.5, py: 0, height: 18,
                          background: r.ok ? '#3a1000' : '#1a0000', color: r.ok ? '#ff7043' : '#f44', border: `1px solid ${r.ok ? '#ff572244' : '#f4433644'}` }} />
                        <Typography sx={{ fontSize: '0.62rem', color: r.ok ? '#888' : '#444' }}>{r.ok ? '✓' : '✗'} {r.l}</Typography>
                      </Box>
                    ))}
                    <Box sx={{ mt: 1, display: 'flex', gap: 0.5, flexWrap: 'wrap' }}>
                      <Chip label="Domet 0.5–50 km (ELRS)" size="small" sx={{ fontSize: '0.58rem', background: '#2a0a00', color: '#ff7043', height: 18 }} />
                      {devices.filter(d => d.droneGroup === 'fpv').length > 0 &&
                        <Chip label={`🔴 ${devices.filter(d => d.droneGroup === 'fpv').length} SIGNAL`} size="small" color="error" sx={{ fontSize: '0.58rem', height: 18 }} />}
                    </Box>
                  </CardContent>
                </Card>
              </Grid>

              {/* ── LONG RANGE ── */}
              <Grid item xs={12} sm={6} lg={2.4}>
                <Card sx={{ background: 'linear-gradient(135deg, #0d001a 0%, #280040 100%)', height: '100%', border: '1px solid #9c27b033' }}>
                  <CardContent sx={{ pb: '8px !important' }}>
                    <Typography variant="subtitle1" sx={{ color: '#ba68c8', fontWeight: 'bold', mb: 0.5 }}>🗺️ Long Range / Survey</Typography>
                    <Typography variant="caption" sx={{ color: '#888', display: 'block', mb: 1, fontSize: '0.65rem' }}>
                      ArduPilot, DJI Agras T30, WingtraOne, senseFly eBee, mapping/agri
                    </Typography>
                    {[
                      { f: '433 MHz', ok: true, l: 'RC / TBS Crossfire' },
                      { f: '869 MHz', ok: true, l: 'SiK radio telemetrija' },
                      { f: '900 MHz', ok: true, l: 'ArduPilot SiK telemetrija' },
                      { f: '915 MHz', ok: true, l: 'ELRS long range' },
                    ].map(r => (
                      <Box key={r.f} sx={{ display: 'flex', alignItems: 'center', mb: 0.4 }}>
                        <Chip label={r.f} size="small" sx={{ fontSize: '0.58rem', minWidth: 60, mr: 0.5, py: 0, height: 18,
                          background: '#1a0030', color: '#ba68c8', border: '1px solid #9c27b044' }} />
                        <Typography sx={{ fontSize: '0.62rem', color: '#888' }}>✓ {r.l}</Typography>
                      </Box>
                    ))}
                    <Box sx={{ mt: 1, display: 'flex', gap: 0.5, flexWrap: 'wrap' }}>
                      <Chip label="Domet 20–100+ km" size="small" sx={{ fontSize: '0.58rem', background: '#140028', color: '#ba68c8', height: 18 }} />
                      {devices.filter(d => d.droneGroup === 'longrange').length > 0 &&
                        <Chip label={`🔴 ${devices.filter(d => d.droneGroup === 'longrange').length} SIGNAL`} size="small" color="error" sx={{ fontSize: '0.58rem', height: 18 }} />}
                    </Box>
                  </CardContent>
                </Card>
              </Grid>

              {/* ── MILITARY ── */}
              <Grid item xs={12} sm={6} lg={2.4}>
                <Card sx={{ background: 'linear-gradient(135deg, #1a0000 0%, #4a0000 100%)', height: '100%', border: `2px solid ${devices.filter(d => d.droneGroup === 'military').length > 0 ? '#f44336' : '#f4433633'}` }}>
                  <CardContent sx={{ pb: '8px !important' }}>
                    <Typography variant="subtitle1" sx={{ color: '#ef5350', fontWeight: 'bold', mb: 0.5 }}>⚔️ Vojni / Taktički</Typography>
                    <Typography variant="caption" sx={{ color: '#888', display: 'block', mb: 0.5, fontSize: '0.65rem' }}>
                      Shahed-136/131, Lancet-3, Orlan-10, Bayraktar TB2, mini taktički UAV
                    </Typography>
                    <Typography variant="caption" sx={{ color: '#f44', display: 'block', mb: 1, fontSize: '0.62rem', fontWeight: 'bold' }}>
                      ⚠️ ŠIFROVANI linkovi — RTL-SDR detektuje RF prisustvo i kretanje, ne sadržaj!
                    </Typography>
                    {[
                      { f: '433 MHz', l: 'Taktički link (enc)' },
                      { f: '868 MHz', l: 'Taktički link (enc)' },
                      { f: '900 MHz', l: 'C2 komandni link' },
                      { f: '1090 MHz', l: 'Mode-S / ADS-B' },
                      { f: '1.2 GHz',  l: 'Video L-band (enc)' },
                      { f: '1575 MHz', l: 'GPS L1 — spoofing alert!' },
                    ].map(r => (
                      <Box key={r.f} sx={{ display: 'flex', alignItems: 'center', mb: 0.3 }}>
                        <Chip label={r.f} size="small" sx={{ fontSize: '0.58rem', minWidth: 60, mr: 0.5, py: 0, height: 18,
                          background: '#2a0000', color: '#ef5350', border: '1px solid #f4433644' }} />
                        <Typography sx={{ fontSize: '0.62rem', color: '#888' }}>✓RF {r.l}</Typography>
                      </Box>
                    ))}
                    <Box sx={{ mt: 1, display: 'flex', gap: 0.5, flexWrap: 'wrap' }}>
                      <Chip label="Domet 50–1000+ km" size="small" sx={{ fontSize: '0.58rem', background: '#1a0000', color: '#ef5350', height: 18 }} />
                      {devices.filter(d => d.droneGroup === 'military').length > 0 &&
                        <Chip icon={<GpsFixed sx={{ fontSize: '12px !important' }} />} label={`🚨 ${devices.filter(d => d.droneGroup === 'military').length} SIGNAL DETEKTOVAN`} size="small" color="error"
                          sx={{ fontSize: '0.58rem', height: 18, fontWeight: 'bold', animation: 'pulse 1s infinite' }} />}
                    </Box>
                  </CardContent>
                </Card>
              </Grid>
            </Grid>

            {/* Detected drone signals by group */}
            {devices.filter(d => d.droneGroup).length > 0 && (
              <Box sx={{ mt: 2 }}>
                <Typography variant="subtitle2" sx={{ color: '#ff9800', mb: 1 }}>📍 Detektovani drone signali (kretanje za sigurnost)</Typography>
                <Box sx={{ overflowX: 'auto' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.8rem' }}>
                    <thead>
                      <tr style={{ color: '#ff9800', borderBottom: '1px solid #3a2000' }}>
                        <th style={{ textAlign: 'left', padding: '5px 8px' }}>Grupa</th>
                        <th style={{ textAlign: 'left', padding: '5px 8px' }}>Frekvencija</th>
                        <th style={{ textAlign: 'center', padding: '5px 8px' }}>Signal (dB)</th>
                        <th style={{ textAlign: 'center', padding: '5px 8px' }}>Udaljenost</th>
                        <th style={{ textAlign: 'center', padding: '5px 8px' }}>Smjer</th>
                        <th style={{ textAlign: 'center', padding: '5px 8px' }}>Mapa</th>
                        <th style={{ textAlign: 'center', padding: '5px 8px' }}>Videno</th>
                      </tr>
                    </thead>
                    <tbody>
                      {devices.filter(d => d.droneGroup)
                        .sort((a, b) => {
                          const order = { military: 0, longrange: 1, pro: 2, fpv: 3, hobby: 4 };
                          return (order[a.droneGroup] ?? 5) - (order[b.droneGroup] ?? 5);
                        })
                        .map(dr => {
                          const groupInfo = {
                            hobby:     { label: '🚁 Hobby',     color: '#4caf50' },
                            pro:       { label: '📡 Pro',       color: '#42a5f5' },
                            fpv:       { label: '🏎️ FPV',      color: '#ff7043' },
                            longrange: { label: '🗺️ Long Range', color: '#ba68c8' },
                            military:  { label: '⚔️ Vojni',    color: '#ef5350' },
                          }[dr.droneGroup] || { label: dr.droneGroup, color: '#aaa' };
                          return (
                            <tr key={dr.id} style={{ borderBottom: '1px solid #1a0800',
                              background: dr.droneGroup === 'military' ? 'rgba(244,67,54,0.08)' : 'transparent' }}>
                              <td style={{ padding: '5px 8px', color: groupInfo.color, fontWeight: 'bold' }}>{groupInfo.label}</td>
                              <td style={{ padding: '5px 8px', color: '#ddd', fontFamily: 'monospace' }}>
                                {(dr.frequency / 1e6).toFixed(3)} MHz
                                <span style={{ color: '#666', fontSize: '0.72em', marginLeft: 6 }}>{dr.protocol}</span>
                              </td>
                              <td style={{ padding: '5px 8px', textAlign: 'center' }}>
                                <span style={{ color: typeof dr.signalStrength === 'number' && dr.signalStrength > -60 ? '#4f4' : '#fa4' }}>
                                  {typeof dr.signalStrength === 'number' ? `${dr.signalStrength.toFixed(1)} dB` : dr.signalStrength || '—'}
                                </span>
                              </td>
                              <td style={{ padding: '5px 8px', textAlign: 'center', color: '#f4a' }}>{dr.distance || '—'}</td>
                              <td style={{ padding: '5px 8px', textAlign: 'center' }}>
                                {dr.bearing != null
                                  ? <span><Navigation sx={{ fontSize: 12, transform: `rotate(${dr.bearing}deg)`, color: '#ff9800', verticalAlign: 'middle' }} /> {getBearingDirection(dr.bearing)}</span>
                                  : '—'}
                              </td>
                              <td style={{ padding: '5px 8px', textAlign: 'center' }}>
                                {dr.estimatedLocation
                                  ? <Button size="small" startIcon={<MapIcon />}
                                      onClick={() => window.open(`https://www.google.com/maps?q=${dr.estimatedLocation.lat},${dr.estimatedLocation.lon}&z=15`, '_blank')}
                                      sx={{ fontSize: '0.65rem', p: '1px 4px', color: '#ff9800', minWidth: 0 }}>Mapa</Button>
                                  : <span style={{ color: '#444' }}>—</span>}
                              </td>
                              <td style={{ padding: '5px 8px', textAlign: 'center', color: '#666', fontSize: '0.72rem' }}>
                                {moment(dr.timestamp).format('HH:mm:ss')}
                              </td>
                            </tr>
                          );
                        })}
                    </tbody>
                  </table>
                </Box>
              </Box>
            )}
          </Paper>

          {/* ── DRONE RF SIGNAL PANEL ───────────────────────────────────────── */}
          {devices.filter(d => d.category === 'drone').length > 0 && (            <Paper sx={{ p: 3, mb: 3, background: 'linear-gradient(135deg, #1a0a2e 0%, #2d1b4e 100%)', border: '1px solid #f093fb55' }}>
              <Typography variant="h5" gutterBottom sx={{ color: '#f093fb', display: 'flex', alignItems: 'center', gap: 1 }}>
                <Radar sx={{ color: '#f093fb' }} /> Drone / RC Signal Detekcija
                <Chip size="small" label={`${devices.filter(d => d.category === 'drone').length} signala`} color="secondary" sx={{ ml: 1 }} />
              </Typography>
              <Box sx={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.82rem' }}>
                  <thead>
                    <tr style={{ color: '#f093fb', borderBottom: '1px solid #3a2050' }}>
                      <th style={{ textAlign: 'left', padding: '6px 8px' }}>Frekvencija / Protokol</th>
                      <th style={{ textAlign: 'center', padding: '6px 8px' }}>Signal (dB)</th>
                      <th style={{ textAlign: 'center', padding: '6px 8px' }}>Udaljenost</th>
                      <th style={{ textAlign: 'center', padding: '6px 8px' }}>Smjer</th>
                      <th style={{ textAlign: 'center', padding: '6px 8px' }}>Modulacija</th>
                      <th style={{ textAlign: 'center', padding: '6px 8px' }}>Mapa</th>
                      <th style={{ textAlign: 'center', padding: '6px 8px' }}>Videno</th>
                    </tr>
                  </thead>
                  <tbody>
                    {devices
                      .filter(d => d.category === 'drone')
                      .sort((a, b) => (b.signalStrength || -999) - (a.signalStrength || -999))
                      .map(dr => (
                        <tr key={dr.id} style={{ borderBottom: '1px solid #2a1540', color: '#e0c8ff' }}>
                          <td style={{ padding: '6px 8px', fontWeight: 'bold' }}>
                            <DevicesOther sx={{ fontSize: 14, mr: 0.5, verticalAlign: 'middle', color: '#f093fb' }} />
                            {(dr.frequency / 1e6).toFixed(3)} MHz
                            <span style={{ color: '#aaa', fontWeight: 'normal', fontSize: '0.8em', marginLeft: 6 }}>{dr.protocol}</span>
                          </td>
                          <td style={{ padding: '6px 8px', textAlign: 'center' }}>
                            <span style={{ color: typeof dr.signalStrength === 'number' && dr.signalStrength > -60 ? '#4f4' : '#fa4' }}>
                              {typeof dr.signalStrength === 'number' ? `${dr.signalStrength.toFixed(1)} dB` : dr.signalStrength}
                            </span>
                          </td>
                          <td style={{ padding: '6px 8px', textAlign: 'center', color: '#f4a' }}>
                            {dr.distance || '—'}
                          </td>
                          <td style={{ padding: '6px 8px', textAlign: 'center' }}>
                            {dr.bearing != null
                              ? <span>
                                  <Navigation sx={{ fontSize: 14, transform: `rotate(${dr.bearing}deg)`, color: '#f093fb', verticalAlign: 'middle' }} />
                                  {' '}{getBearingDirection(dr.bearing)}
                                </span>
                              : '—'}
                          </td>
                          <td style={{ padding: '6px 8px', textAlign: 'center', color: '#aaa', fontFamily: 'monospace', fontSize: '0.78em' }}>
                            {dr.modulation || '—'}
                          </td>
                          <td style={{ padding: '6px 8px', textAlign: 'center' }}>
                            {dr.estimatedLocation
                              ? <Button
                                  size="small"
                                  startIcon={<MapIcon />}
                                  onClick={() => window.open(`https://www.google.com/maps?q=${dr.estimatedLocation.lat},${dr.estimatedLocation.lon}&z=15`, '_blank')}
                                  sx={{ fontSize: '0.7rem', p: '2px 5px', color: '#f093fb', minWidth: 0 }}
                                >
                                  Mapa
                                </Button>
                              : <span style={{ color: '#555' }}>—</span>}
                          </td>
                          <td style={{ padding: '6px 8px', textAlign: 'center', color: '#666', fontSize: '0.75rem' }}>
                            {moment(dr.timestamp).format('HH:mm:ss')}
                          </td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </Box>
            </Paper>
          )}

          {/* NEARBY DEVICES — WiFi mreže, BT, IoT grupisano */}
          {(wifiDevices.length > 0) && (
            <Paper sx={{ p: 3, mb: 3, background: 'linear-gradient(135deg, #0f2027 0%, #203a43 50%, #2c5364 100%)' }}>
              <Typography variant="h5" gutterBottom sx={{ color: '#00d4ff', display: 'flex', alignItems: 'center', gap: 1 }}>
                <Wifi /> Obližnje mreže i uređaji
                <Chip size="small" label={`${wifiDevices.length} WiFi`} color="primary" sx={{ ml: 1 }} />
                {wifiDevices.filter(d => d.suspicious).length > 0 && (
                  <Chip size="small" label={`⚠️ ${wifiDevices.filter(d => d.suspicious).length} SUMNJIVO`} color="error" />
                )}
              </Typography>

              {/* WiFi mreže */}
              <Typography variant="subtitle2" sx={{ color: '#aaa', mb: 1, mt: 1 }}>
                📶 WiFi mreže ({wifiDevices.length})
              </Typography>
              <Box sx={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.82rem' }}>
                  <thead>
                    <tr style={{ color: '#00d4ff', borderBottom: '1px solid #333' }}>
                      <th style={{ textAlign: 'left', padding: '4px 8px' }}>SSID / Naziv</th>
                      <th style={{ textAlign: 'left', padding: '4px 8px' }}>BSSID</th>
                      <th style={{ textAlign: 'center', padding: '4px 8px' }}>Signal</th>
                      <th style={{ textAlign: 'center', padding: '4px 8px' }}>Kanal</th>
                      <th style={{ textAlign: 'center', padding: '4px 8px' }}>Udaljenost</th>
                      <th style={{ textAlign: 'center', padding: '4px 8px' }}>Sigurnost</th>
                      <th style={{ textAlign: 'left', padding: '4px 8px' }}>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...wifiDevices]
                      .sort((a, b) => (b.suspicious ? 1 : 0) - (a.suspicious ? 1 : 0) || b.signal - a.signal)
                      .map(dev => (
                        <tr key={dev.id} style={{
                          borderBottom: '1px solid #1a2a3a',
                          background: dev.suspicious ? 'rgba(255,50,50,0.12)' : 'transparent',
                          color: dev.suspicious ? '#ff8080' : '#ccc'
                        }}>
                          <td style={{ padding: '5px 8px', fontWeight: dev.suspicious ? 'bold' : 'normal' }}>
                            {dev.category === 'wifi_camera' ? <Videocam sx={{ fontSize: 14, mr: 0.5, verticalAlign: 'middle', color: '#f44' }} /> : null}
                            {dev.category === 'hidden_network' ? <SensorsOff sx={{ fontSize: 14, mr: 0.5, verticalAlign: 'middle', color: '#f44' }} /> : null}
                            {dev.category === 'wifi' ? <Wifi sx={{ fontSize: 14, mr: 0.5, verticalAlign: 'middle', color: '#4af' }} /> : null}
                            {dev.category === 'audio_bug' ? <Warning sx={{ fontSize: 14, mr: 0.5, verticalAlign: 'middle', color: '#fa4' }} /> : null}
                            {dev.displayName}
                          </td>
                          <td style={{ padding: '5px 8px', fontFamily: 'monospace', fontSize: '0.75rem', color: '#888' }}>{dev.bssid}</td>
                          <td style={{ padding: '5px 8px', textAlign: 'center' }}>
                            <span style={{ color: dev.signal > 70 ? '#4f4' : dev.signal > 40 ? '#fa4' : '#f44' }}>
                              {dev.signal}% ({dev.dBm}dBm)
                            </span>
                          </td>
                          <td style={{ padding: '5px 8px', textAlign: 'center', color: '#aaa' }}>ch{dev.channel} {dev.freqBand}</td>
                          <td style={{ padding: '5px 8px', textAlign: 'center' }}>
                            <span style={{ color: dev.distanceMeters < 50 ? '#f44' : dev.distanceMeters < 150 ? '#fa4' : '#4af' }}>
                              {dev.distance}
                            </span>
                          </td>
                          <td style={{ padding: '5px 8px', textAlign: 'center' }}>
                            {dev.security === 'Open' || dev.security === '--'
                              ? <LockOpen sx={{ fontSize: 14, color: '#f44' }} />
                              : <Lock sx={{ fontSize: 14, color: '#4f4' }} />}
                            <span style={{ fontSize: '0.72rem', ml: 0.5, color: '#aaa' }}> {dev.security}</span>
                          </td>
                          <td style={{ padding: '5px 8px', fontSize: '0.75rem' }}>
                            {dev.suspicious
                              ? <span style={{ color: '#f66', fontWeight: 'bold' }}>⚠️ {dev.warning}</span>
                              : <span style={{ color: '#4a4' }}>✓ Normalno</span>}
                          </td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </Box>
            </Paper>
          )}

          {/* Devices Grid */}
          <Typography variant="h5" gutterBottom sx={{ mb: 2 }}>
            Detected Devices ({filteredDevices.length})
          </Typography>
          
          {filteredDevices.length === 0 ? (
            <Paper sx={{ p: 6, textAlign: 'center' }}>
              <Radar sx={{ fontSize: 64, color: 'text.secondary', mb: 2 }} />
              <Typography variant="h6" color="text.secondary">
                {scanning ? 'Scanning for devices...' : 'No devices detected. Start a scan to begin.'}
              </Typography>
              {scanning && <LinearProgress sx={{ mt: 2 }} />}
            </Paper>
          ) : (
            <Grid container spacing={2}>
              {filteredDevices.map((device) => (
                <Grid item xs={12} sm={6} md={4} lg={3} key={device.id}>
                  <Card 
                    sx={{ 
                      height: '100%',
                      border: selectedDevice?.id === device.id ? '2px solid #00d4ff' : 'none',
                      transition: 'all 0.3s',
                      '&:hover': {
                        transform: 'translateY(-4px)',
                        boxShadow: '0 8px 24px rgba(0,212,255,0.3)'
                      }
                    }}
                    onClick={() => setSelectedDevice(device)}
                  >
                    <CardContent>
                      <Box sx={{ display: 'flex', alignItems: 'center', mb: 2 }}>
                        {getDeviceIcon(device.type)}
                        <Typography variant="h6" sx={{ ml: 1, flex: 1 }}>
                          {device.protocol}
                        </Typography>
                        <Chip
                          size="small"
                          label={device.type}
                          color="primary"
                          sx={{ fontSize: '0.7rem' }}
                        />
                      </Box>

                      {/* Show Bluetooth device name and address */}
                      {device.type === 'bluetooth' && device.address && (
                        <Box sx={{ mb: 2, p: 1.5, bgcolor: 'rgba(250, 112, 154, 0.1)', borderRadius: 1, border: '1px solid rgba(250, 112, 154, 0.3)' }}>
                          <Typography variant="body2" sx={{ fontWeight: 'bold', color: '#fa709a', mb: 0.5 }}>
                            📱 {device.name || 'Unknown Device'}
                          </Typography>
                          <Typography variant="caption" sx={{ fontFamily: 'monospace', color: 'text.secondary', display: 'block' }}>
                            {device.address}
                          </Typography>
                        </Box>
                      )}

                      <Box sx={{ mb: 2 }}>
                        <Typography variant="body2" color="text.secondary">
                          Frequency
                        </Typography>
                        <Typography variant="body1">
                          {(device.frequency / 1000000).toFixed(3)} MHz
                        </Typography>
                      </Box>

                      {device.distance && (
                        <Box sx={{ mb: 2 }}>
                          <Typography variant="body2" color="text.secondary">
                            Distance
                          </Typography>
                          <Chip
                            icon={<MyLocation />}
                            label={getDistanceText(device.distance)}
                            size="small"
                            color={getSignalColor(device.distance)}
                          />
                        </Box>
                      )}

                      {device.signalStrength && (
                        <Box sx={{ mb: 2 }}>
                          <Typography variant="body2" color="text.secondary" sx={{ mb: 0.5 }}>
                            Signal Strength
                          </Typography>
                          {typeof device.signalStrength === 'number' ? (
                            <>
                              <Box sx={{ display: 'flex', alignItems: 'center', mb: 0.5 }}>
                                <SignalCellularAlt sx={{ mr: 1, fontSize: 18, color: getSignalColor(device.signalStrength) === 'success' ? '#4caf50' : getSignalColor(device.signalStrength) === 'warning' ? '#ff9800' : '#f44336' }} />
                                <Typography variant="body2" sx={{ fontFamily: 'monospace', fontWeight: 'bold' }}>
                                  {device.signalStrength.toFixed(1)} dBm
                                </Typography>
                                <Typography variant="caption" sx={{ ml: 1, color: 'text.secondary' }}>
                                  ({Math.round(rssiToPercent(device.signalStrength))}%)
                                </Typography>
                              </Box>
                              <LinearProgress 
                                variant="determinate" 
                                value={rssiToPercent(device.signalStrength)} 
                                sx={{ 
                                  height: 6, 
                                  borderRadius: 3,
                                  backgroundColor: 'rgba(255,255,255,0.1)',
                                  '& .MuiLinearProgress-bar': {
                                    backgroundColor: getSignalColor(device.signalStrength) === 'success' ? '#4caf50' : getSignalColor(device.signalStrength) === 'warning' ? '#ff9800' : '#f44336'
                                  }
                                }}
                              />
                            </>
                          ) : (
                            <Chip
                              icon={<SignalCellularAlt />}
                              label={device.signalStrength}
                              size="small"
                              color={getSignalColor(device.signalStrength)}
                            />
                          )}
                        </Box>
                      )}

                      {device.bearing != null && (
                        <Box sx={{ mb: 2 }}>
                          <Typography variant="body2" color="text.secondary" sx={{ mb: 0.5 }}>
                            Direction
                          </Typography>
                          <Box sx={{ display: 'flex', alignItems: 'center' }}>
                            <Navigation 
                              sx={{ 
                                mr: 1, 
                                fontSize: 24, 
                                color: '#00d4ff',
                                transform: `rotate(${device.bearing}deg)`,
                                transition: 'transform 0.3s'
                              }} 
                            />
                            <Typography variant="body2" sx={{ fontFamily: 'monospace', fontWeight: 'bold' }}>
                              {getBearingDirection(device.bearing)}
                            </Typography>
                          </Box>
                        </Box>
                      )}

                      {device.deviceTypeInfo && (
                        <Box sx={{ mb: 2, p: 1.5, bgcolor: 'rgba(0, 212, 255, 0.05)', borderRadius: 1, border: '1px solid rgba(0, 212, 255, 0.2)' }}>
                          <Box sx={{ display: 'flex', alignItems: 'center', mb: 1 }}>
                            <Info sx={{ fontSize: 16, mr: 1, color: '#00d4ff' }} />
                            <Typography variant="caption" sx={{ fontWeight: 'bold', color: '#00d4ff' }}>
                              {device.deviceTypeInfo.type}
                            </Typography>
                          </Box>
                          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 0.5 }}>
                            {device.deviceTypeInfo.description}
                          </Typography>
                          <Typography variant="caption" color="text.secondary" sx={{ fontSize: '0.65rem' }}>
                            <strong>Možda:</strong> {device.deviceTypeInfo.possibleDevices.join(', ')}
                          </Typography>
                        </Box>
                      )}

                      {(device.estimatedLocation || (device.lat && device.lon)) && (
                        <Box sx={{ mb: 2 }}>
                          <Button
                            variant="outlined"
                            size="small"
                            startIcon={<MapIcon />}
                            onClick={(e) => { e.stopPropagation(); openOnMap(device); }}
                            sx={{ 
                              width: '100%',
                              borderColor: '#00d4ff',
                              color: '#00d4ff',
                              '&:hover': {
                                borderColor: '#00d4ff',
                                bgcolor: 'rgba(0, 212, 255, 0.1)'
                              }
                            }}
                          >
                            Prikaži na Mapi
                          </Button>
                        </Box>
                      )}

                      {device.icao && (
                        <Box sx={{ mb: 1 }}>
                          <Typography variant="body2" color="text.secondary">ICAO / Callsign</Typography>
                          <Typography variant="body1" sx={{ fontFamily: 'monospace', fontWeight: 'bold' }}>
                            {device.icao}{device.callsign ? ` — ${device.callsign.trim()}` : ''}
                          </Typography>
                        </Box>
                      )}

                      {device.altitude != null && (
                        <Box sx={{ mb: 1 }}>
                          <Typography variant="body2" color="text.secondary">Altitude</Typography>
                          <Typography variant="body1">{device.altitude.toLocaleString()} ft ({Math.round(device.altitude * 0.3048).toLocaleString()} m)</Typography>
                        </Box>
                      )}

                      {device.speed != null && (
                        <Box sx={{ mb: 1 }}>
                          <Typography variant="body2" color="text.secondary">Speed / Track</Typography>
                          <Typography variant="body1">{device.speed} kt{device.track != null ? ` · ${device.track}°` : ''}</Typography>
                        </Box>
                      )}

                      {device.squawk && (
                        <Box sx={{ mb: 1 }}>
                          <Typography variant="body2" color="text.secondary">Squawk</Typography>
                          <Typography variant="body1" sx={{ fontFamily: 'monospace' }}>{device.squawk}</Typography>
                        </Box>
                      )}

                      {device.latitude != null && device.longitude != null && (
                        <Box sx={{ mb: 1 }}>
                          <Typography variant="body2" color="text.secondary">Position</Typography>
                          <Typography variant="body2" sx={{ fontFamily: 'monospace' }}>
                            {device.latitude.toFixed(5)}, {device.longitude.toFixed(5)}
                          </Typography>
                          <Button
                            size="small"
                            startIcon={<MyLocation />}
                            sx={{ mt: 0.5, fontSize: '0.7rem', p: '2px 6px' }}
                            onClick={(e) => {
                              e.stopPropagation();
                              window.open(`https://www.google.com/maps?q=${device.latitude},${device.longitude}`, '_blank');
                            }}
                          >
                            Google Maps
                          </Button>
                        </Box>
                      )}

                      <Typography variant="caption" color="text.secondary">
                        Last seen: {moment(device.timestamp).format('HH:mm:ss')}
                      </Typography>
                    </CardContent>

                    <CardActions>
                      <Tooltip title="Listen Live">
                        <IconButton
                          size="small"
                          color={liveAudio === device.frequency ? 'error' : 'primary'}
                          onClick={(e) => {
                            e.stopPropagation();
                            if (liveAudio === device.frequency) {
                              stopLiveAudio();
                            } else {
                              startLiveAudio(device.frequency, null, device.protocol || `${(device.frequency/1e6).toFixed(3)}MHz`);
                            }
                          }}
                        >
                          {liveAudio === device.frequency ? <Stop /> : <VolumeUp />}
                        </IconButton>
                      </Tooltip>

                      <Tooltip title={activeRecordings.has(device.frequency) ? 'Stop Recording' : 'Start Recording'}>
                        <IconButton
                          size="small"
                          color={activeRecordings.has(device.frequency) ? 'error' : 'secondary'}
                          onClick={(e) => {
                            e.stopPropagation();
                            if (activeRecordings.has(device.frequency)) {
                              stopRecording(device.frequency);
                            } else {
                              startRecording(device.frequency, null, device.protocol || `${(device.frequency/1e6).toFixed(3)}MHz`);
                            }
                          }}
                        >
                          {activeRecordings.has(device.frequency) ? <Stop /> : <FiberManualRecord />}
                        </IconButton>
                      </Tooltip>

                      {device.type === 'bluetooth' && device.address && (
                        <Tooltip title="Auto-Pair & Monitor (Click to pair with YOUR device)">
                          <IconButton
                            size="small"
                            color="info"
                            onClick={(e) => {
                              e.stopPropagation();
                              // Auto-pair and start monitoring
                              if (window.confirm(
                                `Pair with ${device.name || device.address}?\n\n` +
                                `This will:\n` +
                                `1. Pair this device with your PC\n` +
                                `2. Start Bluetooth traffic monitoring\n` +
                                `3. You may need to confirm pairing on your device\n\n` +
                                `This only works with YOUR devices!`
                              )) {
                                pairBtDevice(device.address);
                                // Auto-start btmon after 3 seconds
                                setTimeout(() => {
                                  if (!btmonActive) {
                                    startBtMon();
                                  }
                                }, 3000);
                              }
                            }}
                          >
                            <Bluetooth />
                          </IconButton>
                        </Tooltip>
                      )}

                      <Box sx={{ flex: 1 }} />

                      <Typography variant="caption" color="text.secondary">
                        {device.id.substring(0, 8)}
                      </Typography>
                    </CardActions>
                  </Card>
                </Grid>
              ))}
            </Grid>
          )}
        </Container>

        {/* Recordings Drawer */}
        <Drawer
          anchor="right"
          open={drawerOpen}
          onClose={() => setDrawerOpen(false)}
          sx={{ width: 400 }}
        >
          <Box sx={{ width: 400, p: 2 }}>
            <Typography variant="h5" gutterBottom>
              <Storage sx={{ mr: 1, verticalAlign: 'middle' }} />
              Recordings
            </Typography>
            <Divider sx={{ mb: 2 }} />

            {recordings.length === 0 ? (
              <Typography color="text.secondary" align="center" sx={{ py: 4 }}>
                No recordings yet
              </Typography>
            ) : (
              <List>
                {recordings.map((rec, index) => (
                  <ListItem key={index} divider>
                    <ListItemIcon>
                      <Mic />
                    </ListItemIcon>
                    <ListItemText
                      primary={rec.filename}
                      secondary={`${(rec.size / 1024 / 1024).toFixed(2)} MB - ${moment(rec.created).format('MMM D, HH:mm')}`}
                    />
                    <IconButton
                      edge="end"
                      onClick={() => window.open(`/recordings/${rec.filename}`, '_blank')}
                    >
                      <Download />
                    </IconButton>
                  </ListItem>
                ))}
              </List>
            )}
          </Box>
        </Drawer>
      </Box>
    </ThemeProvider>
  );
}

export default App;
