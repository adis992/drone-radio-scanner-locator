const express = require('express');
const http = require('http');
const net = require('net');
const WebSocket = require('ws');
const cors = require('cors');
const bodyParser = require('body-parser');
const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

// ─────────────────────────────────────────────
//  LOGGER — writes to both terminal and logs/
// ─────────────────────────────────────────────
const logsDir = path.join(__dirname, 'logs');
if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });

function getLogStream() {
    const date = new Date().toISOString().slice(0, 10);
    return fs.createWriteStream(path.join(logsDir, `scanner-${date}.log`), { flags: 'a' });
}
let _logStream = getLogStream();
// Rotate log stream at midnight
setInterval(() => { _logStream = getLogStream(); }, 60 * 60 * 1000);

function log(level, ...args) {
    const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
    const msg = `[${ts}] [${level.padEnd(5)}] ${args.join(' ')}`;
    process.stdout.write(msg + '\n');
    try { _logStream.write(msg + '\n'); } catch (e) {}
    // Broadcast to frontend terminal (filter out DATA spam)
    if (level !== 'DATA') {
        try {
            wss.clients.forEach(client => {
                if (client.readyState === 1) {
                    client.send(JSON.stringify({ type: 'log', level, message: args.join(' '), timestamp: ts }));
                }
            });
        } catch {}
    }
}

// Override console so all third-party logs are also captured
const _origLog   = console.log.bind(console);
const _origWarn  = console.warn.bind(console);
const _origError = console.error.bind(console);
console.log   = (...a) => log('INFO',  ...a);
console.warn  = (...a) => log('WARN',  ...a);
console.error = (...a) => log('ERROR', ...a);

log('INFO', '====== RTL-SDR Scanner Server starting ======');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(cors());
app.use(bodyParser.json());

// Serve built frontend only in production
// In dev mode React dev-server (port 3000) handles the UI
const IS_DEV = process.env.NODE_ENV !== 'production';
if (!IS_DEV) {
    app.use(express.static('client/build'));
    log('INFO', '[HTTP] Serving static client/build (production mode)');
} else {
    log('INFO', '[HTTP] Dev mode — frontend served by React dev-server on port 3000');
}

// Store active scans and recordings
const activeScans = new Map();
const recordings = new Map();
const devices = new Map();

// Base location for distance/direction calculation (set by frontend geolocation)
// Default: WEB TEC d.o.o. Gradačac, Bosnia and Herzegovina
let baseLocation = {
    lat: 44.8520108,
    lon: 18.5064763
};

// Signal detection threshold (dB above average)
// Lower = more sensitive (detects weaker signals, more false positives)
// Higher = less sensitive (only strong signals, fewer false positives)
// Recommended: 3-5 dB for normal use, 8-10 dB for noisy environments
const SIGNAL_DETECTION_THRESHOLD = 4; // dB (reduced for better sensitivity)

// Track active scanners globally for state sync
const activeScanners = {
    adsb: false,
    iot: false,
    general: false,
    bluetooth: false,
    wifi: false,
    drone: false      // dedicated drone-only scanner (hobby/pro/FPV/longrange/military)
};

// Ensure directories exist
const dirs = ['recordings', 'logs', 'captures', 'captures/adsb'];
dirs.forEach(dir => {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
});

// ─────────────────────────────────────────────
//  RTL-SDR DEVICE MUTEX
//  Only one process may use the dongle at a time.
// ─────────────────────────────────────────────
let _rtlOwner = null;
const _rtlQueue = [];

function acquireRTL(owner) {
    return new Promise((resolve) => {
        if (!_rtlOwner) {
            _rtlOwner = owner;
            log('INFO', `[RTL] Device acquired by: ${owner}`);
            resolve();
        } else {
            log('WARN', `[RTL] Device busy (${_rtlOwner}), queuing: ${owner}`);
            _rtlQueue.push({ owner, resolve });
        }
    });
}

function releaseRTL(owner) {
    if (_rtlOwner !== owner) return;
    if (_rtlQueue.length > 0) {
        const next = _rtlQueue.shift();
        _rtlOwner = next.owner;
        log('INFO', `[RTL] Device handed to: ${next.owner}`);
        next.resolve();
    } else {
        _rtlOwner = null;
        log('INFO', `[RTL] Device released by: ${owner}`);
    }
}

// ─────────────────────────────────────────────
//  DEVICE DEDUPLICATION
//  Prevent same frequency appearing multiple times in short period
// ─────────────────────────────────────────────
const DEDUP_WINDOW_MS = 30000; // 30 seconds

function isDuplicateDevice(frequency, type = 'rf_signal') {
    const now = Date.now();
    for (const [id, device] of devices.entries()) {
        if (device.type === type && device.frequency === frequency) {
            const deviceTime = new Date(device.timestamp).getTime();
            if (now - deviceTime < DEDUP_WINDOW_MS) {
                log('DEBUG', `[DEDUP] Skipping duplicate ${type} @ ${(frequency/1e6).toFixed(3)}MHz (already seen ${Math.round((now-deviceTime)/1000)}s ago)`);
                return true;
            }
        }
    }
    return false;
}

// ─────────────────────────────────────────────
//  DUMP1090-MUTABILITY LIFECYCLE
// ─────────────────────────────────────────────
let _dump1090Proc = null;
const DUMP1090_SBS_PORT = 30003;

// Parser za dump1090 stdout — hvata avione koje SBS1/JSON ne uključuje (npr. ICAO 000000)
let _d1090Buf = '';          // line buffer za stdout stream
let _d1090Pending = null;    // aircraft koji se trenutno parsira iz višelinijskog bloka

function _parseDump1090Line(line) {
    // Novi message blok: *hexdata; ili addr:XXXXXX
    const newBlock = /^\*[0-9a-fA-F]+;/.test(line) || /^addr:[0-9a-fA-F]/.test(line);
    if (newBlock) {
        if (_d1090Pending && _d1090Pending.icao) _ingestDump1090Aircraft(_d1090Pending);
        const m = line.match(/^addr:([0-9a-fA-F]{6})/i);
        _d1090Pending = m ? { icao: m[1].toUpperCase() } : {};
        return;
    }
    if (!_d1090Pending) return;
    // ICAO Address (oba formata: "ICAO Address: XXX" i "ICAO Address     : XXX")
    const icao = line.match(/ICAO\s+Address\s*:\s+([0-9a-fA-F]{6})/i);
    if (icao) { _d1090Pending.icao = icao[1].toUpperCase(); return; }
    // Squawk / Identity
    const sq = line.match(/(?:Squawk|Identity)\s*:\s+(\d{4})/i);
    if (sq) { _d1090Pending.squawk = sq[1]; return; }
    // Callsign / Flight
    const cs = line.match(/(?:Callsign|Flight)\s*:\s+(\S+)/i);
    if (cs) { _d1090Pending.callsign = cs[1].trim(); return; }
    // Altitude (ft)
    const alt = line.match(/Altitude\s*:\s+(\d+)\s*ft/i);
    if (alt) { _d1090Pending.altitude = parseInt(alt[1]); return; }
}

function _ingestDump1090Aircraft(info) {
    if (!info.icao) return;
    const existing = [...devices.values()].find(d => d.icao === info.icao);
    const device = existing ? { ...existing } : {
        id: uuidv4(),
        type: 'aircraft/drone',
        protocol: 'ADS-B',
        frequency: 1090000000,
        icao: info.icao,
        callsign: '',
        altitude: null,
        speed: null,
        track: null,
        latitude: null,
        longitude: null,
        squawk: null,
        onGround: false,
        signalStrength: 'medium',
        timestamp: new Date().toISOString()
    };
    if (info.squawk)   device.squawk   = info.squawk;
    if (info.callsign) device.callsign = info.callsign;
    if (info.altitude) device.altitude = info.altitude;
    device.timestamp = new Date().toISOString();
    device.lastSeen = Date.now();
    const isNew = !existing;
    devices.set(device.id, device);
    if (isNew) log('INFO', `[ADS-B] ★ Novi avion (stdout parser): ICAO=${info.icao} squawk=${info.squawk||'?'} callsign=${info.callsign||'?'}`);
    broadcast({ type: 'device_detected', device });
}


function isDump1090Running() {
    try {
        execSync('pgrep -x dump1090-mutability', { stdio: 'ignore' });
        return true;
    } catch { return false; }
}

function startDump1090() {
    if (isDump1090Running() || _dump1090Proc) {
        log('INFO', '[ADS-B] dump1090-mutability already running');
        return;
    }
    log('INFO', '[ADS-B] Starting dump1090-mutability...');
    log('INFO', '[ADS-B] Antena: ground plane (4 radijala 45° + vertikalna 90°) — optimalna konfiguracija ✔️');
    log('WARN', '[ADS-B] USB produžetak 3m: ako nema signala, RTL-SDR možda ne dobija dovoljno struje. Pokušaj powered USB hub ili skrati kabl.');
    _dump1090Proc = spawn('/usr/bin/dump1090-mutability', [
        '--net',
        '--net-sbs-port', String(DUMP1090_SBS_PORT),
        '--net-bind-address', '127.0.0.1',
        '--net-ro-size', '500',
        '--net-ro-rate', '5',
        // FCI 2580 tuner: max gain = 0 dB (hardware limit).
        // --gain -10 (AGC) also selects 0 dB on this chip — remove it.
        // --aggressive not supported in dump1090-mutability package build.
        // Best config for weak-signal reception on FCI 2580:
        '--enable-agc',          // RTL2832U digital AGC (separate from tuner gain)
        '--fix',                 // Single-bit CRC error correction — crucial for weak signals
        '--freq', '1090000000',
        '--write-json', 'captures/adsb',
        '--write-json-every', '1'
    ], { detached: false });

    _dump1090Proc.stdout.on('data', (d) => {
        const text = d.toString();
        log('DATA', `[dump1090] ${text.trimEnd()}`);
        // Parsiraj svaku liniju za aircraft detekciju (hvata ICAO 000000 i sl. koji ne idu u JSON/SBS1)
        _d1090Buf += text;
        const lines = _d1090Buf.split('\n');
        _d1090Buf = lines.pop(); // zadnja nepotpuna linija ostaje u bufferu
        lines.forEach(_parseDump1090Line);
    });;
    _dump1090Proc.stderr.on('data', (d) => log('INFO',  `[dump1090] ${d.toString().trimEnd()}`));
    _dump1090Proc.on('close', (code) => {
        log('WARN', `[ADS-B] dump1090-mutability exited (code ${code})`);
        _dump1090Proc = null;
    });
    _dump1090Proc.on('error', (err) => log('ERROR', `[ADS-B] dump1090 spawn error: ${err.message}`));
}

function stopDump1090() {
    return new Promise((resolve) => {
        const finish = () => {
            // Force-kill any surviving process and wait for USB to be released by kernel
            try { execSync('pkill -9 -x dump1090-mutability 2>/dev/null || true', { stdio: 'ignore' }); } catch {}
            setTimeout(() => {
                // Verify it's really gone
                const stillRunning = isDump1090Running();
                if (stillRunning) {
                    log('WARN', '[ADS-B] dump1090 still running after kill — forcing USB release...');
                    try { execSync('pkill -9 -f dump1090', { stdio: 'ignore' }); } catch {}
                    setTimeout(resolve, 1500);
                } else {
                    resolve();
                }
            }, 800);
        };
        if (_dump1090Proc) {
            _dump1090Proc.once('close', finish);
            _dump1090Proc.kill('SIGTERM');
            _dump1090Proc = null;
        } else if (isDump1090Running()) {
            try { execSync('pkill -TERM -x dump1090-mutability', { stdio: 'ignore' }); } catch {}
            finish();
        } else {
            resolve();
        }
    });
}

// ─────────────────────────────────────────────
//  WEBSOCKET KEEPALIVE — prevents disconnect
//  when browser tab is minimized/backgrounded.
//  Server pings every 25s; drops dead connections.
//  Scanners run independently — NEVER stopped on disconnect.
// ─────────────────────────────────────────────
const WS_PING_INTERVAL = 25000; // ms

const _wsPingTimer = setInterval(() => {
    wss.clients.forEach(ws => {
        if (ws.isAlive === false) {
            log('WARN', '[WS] Client did not pong — dropping dead connection');
            return ws.terminate();
        }
        ws.isAlive = false;
        try { ws.ping(); } catch (_) {}
    });
}, WS_PING_INTERVAL);

wss.on('close', () => clearInterval(_wsPingTimer));

// WebSocket connection handler
wss.on('connection', (ws) => {
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; }); // heartbeat response

    log('INFO', '[WS] Client connected');

    // Send current scanner state to newly connected client (NO AUTO-START)
    ws.send(JSON.stringify({
        type: 'scanner_state_sync',
        scanners: activeScanners,
        devices: Array.from(devices.values())
    }));

    log('INFO', `[WS] State synced: IoT=${activeScanners.iot}, BT=${activeScanners.bluetooth}, General=${activeScanners.general}, ADSB=${activeScanners.adsb}`);

    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);
            // Client pong message (some browsers send text pong)
            if (data.type === 'pong') { ws.isAlive = true; return; }
            handleWebSocketMessage(ws, data);
        } catch (error) {
            log('ERROR', '[WS] Message parse error:', error.message);
        }
    });

    ws.on('close', () => {
        log('INFO', '[WS] Client disconnected — scanners continue running');
        // NOTE: Scanners are server-side processes — they keep running.
        // Do NOT call stopAllScans() here.
    });

    ws.on('error', (err) => {
        log('WARN', '[WS] Client error:', err.message);
    });
});

// Broadcast to all connected clients
function broadcast(data) {
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify(data));
        }
    });
}

// Handle WebSocket messages
function handleWebSocketMessage(ws, data) {
    switch (data.type) {
        case 'start_scan':
            startFullScan(data.params);
            break;
        case 'stop_scan':
            stopScan(data.scanId);
            break;
        // Individual scanner controls
        case 'start_scan_adsb':
            startPartialScan(['adsb']);
            break;
        case 'start_scan_iot':
            startPartialScan(['iot']);
            break;
        case 'start_scan_general':
            startPartialScan(['general']);
            break;
        case 'start_scan_bluetooth':
            startPartialScan(['bluetooth']);
            break;
        // Individual scanner stop controls
        case 'stop_scan_adsb':
            stopScannerByType('adsb');
            break;
        case 'stop_scan_iot':
            stopScannerByType('iot');
            break;
        case 'stop_scan_general':
            stopScannerByType('general');
            break;
        case 'stop_scan_bluetooth':
            stopScannerByType('bluetooth');
            break;
        case 'clear_devices':
            devices.clear();
            broadcast({ type: 'devices_cleared' });
            log('INFO', '[WS] Devices cleared by client');
            break;
        case 'scan_frequency':
            // Scan a single specific frequency on demand
            scanSingleFrequency(data.frequency, data.label || `Custom ${(data.frequency/1e6).toFixed(3)}MHz`, data.scanId);
            break;
        case 'start_recording':
            log('INFO', `[WS] start_recording: freq=${data.frequency} mode=${data.mode} label=${data.label || '?'}`);
            stopAllScans(); // Stop all scanners to free RTL device
            setTimeout(() => startRecording(data.frequency, data.mode, data.label), 500); // Wait for cleanup
            break;
        case 'stop_recording':
            log('INFO', `[WS] stop_recording: ${data.recordingId}`);
            stopRecording(data.recordingId);
            break;
        case 'listen_live':
            log('INFO', `[WS] listen_live: freq=${data.frequency} mode=${data.mode}`);
            stopAllScans(); // Stop all scanners to free RTL device
            setTimeout(() => startLiveAudio(data.frequency, data.mode), 500); // Wait for cleanup
            break;
        case 'stop_live':
            log('INFO', '[WS] stop_live');
            stopLiveAudio();
            break;
        case 'start_btmon':
            log('INFO', '[WS] start_btmon - Bluetooth traffic monitoring');
            startBtMon();
            break;
        case 'stop_btmon':
            log('INFO', '[WS] stop_btmon');
            stopBtMon();
            break;
        case 'pair_bt_device':
            log('INFO', `[WS] pair_bt_device: ${data.address}`);
            pairBluetoothDevice(data.address);
            break;
        case 'start_scan_wifi':
            log('INFO', '[WS] start_scan_wifi');
            startWiFiScanner();
            break;
        case 'stop_scan_wifi':
            log('INFO', '[WS] stop_scan_wifi');
            stopWiFiScanner();
            break;
        case 'start_scan_drone':
            log('INFO', '[WS] start_scan_drone — hobby/pro/FPV/long-range/military grupe');
            startPartialScan(['drone']);
            break;
        case 'stop_scan_drone':
            log('INFO', '[WS] stop_scan_drone');
            stopScannerByType('drone');
            break;
    }
}

// ─────────────────────────────────────────────
//  SCAN ORCHESTRATOR
// ─────────────────────────────────────────────

// Start all scanners or a subset via params.scanners = ['adsb','iot','general','bluetooth']
function startFullScan(params = {}) {
    const scanId = uuidv4();
    const enabled = params.scanners || ['adsb', 'iot', 'general', 'bluetooth', 'wifi'];
    
    // Filter out already running scanners
    const toStart = enabled.filter(type => !activeScanners[type]);
    
    if (toStart.length === 0) {
        log('WARN', `[SCAN] All requested scanners already running: ${enabled.join(',')}`);
        return null;
    }
    
    log('INFO', `[SCAN] Starting scanners: ${toStart.join(',')} (scanId: ${scanId})`);

    const handles = {};
    if (toStart.includes('adsb'))      handles.adsb      = startADSBScanner(scanId);
    if (toStart.includes('bluetooth')) handles.bluetooth = startBluetoothScanner(scanId);
    if (toStart.includes('iot'))       handles.iot       = startIoTScanner(scanId);
    if (toStart.includes('general'))   handles.general   = startGeneralScanner(scanId);
    if (toStart.includes('wifi'))      handles.wifi      = startWiFiScanner();
    if (toStart.includes('drone'))     handles.drone     = startDroneScanner(scanId);

    activeScans.set(scanId, handles);
    broadcast({ type: 'scan_started', scanId, scanners: toStart, timestamp: new Date().toISOString() });
    return scanId;
}

// Start a partial scan with only selected scanner types, returns scanId
function startPartialScan(types) {
    return startFullScan({ scanners: types });
}

// Scan one specific frequency immediately (on-demand, not part of the sweep loop)
function scanSingleFrequency(freq, label, scanId) {
    const id = scanId || uuidv4();
    const freqData = { freq, bw: 200000, label, cat: 'custom' };
    acquireRTL(`single:${label}`).then(async () => {
        await scanFrequencyOnce(freqData, id);
        releaseRTL(`single:${label}`);
    });
    return id;
}

// ─────────────────────────────────────────────
//  ADS-B — connect to dump1090-mutability SBS1
//  TCP port 30003, NO RTL mutex needed (dump1090 owns the device)
// ─────────────────────────────────────────────
function startADSBScanner(scanId) {
    let tcpClient = null;
    let reconnectTimer = null;
    let stopped = false;
    let lineBuffer = '';
    let jsonPollInterval = null;

    // JSON file polling — poziva se svake 2s, uvijek ažurira sve avione (ne samo nove)
    // parseAircraftJSON interno provjerava 'existing' i updateuje umjesto dupliciranja
    const pollJSONFiles = () => {
        if (stopped) return;
        try {
            const jsonPath = path.join(__dirname, 'captures/adsb/aircraft.json');
            if (fs.existsSync(jsonPath)) {
                const data = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
                if (data.aircraft && Array.isArray(data.aircraft)) {
                    data.aircraft.forEach(ac => {
                        if (!ac.hex) return;
                        parseAircraftJSON(ac, scanId); // uvijek updateuj poziciju
                    });
                }
            }
        } catch (e) {
            log('DEBUG', `[ADS-B] JSON poll error: ${e.message}`);
        }
    };

    const connect = () => {
        if (stopped) return;

        // Ako drone ili general scanner drži RTL uređaj, ne smijemo startati dump1090
        // (usb_claim_interface error -6). Čekamo dok se ne oslobodi.
        if (activeScanners.drone || activeScanners.general) {
            log('INFO', '[ADS-B] RTL zauzet (drone/general scanner aktivan) — čekam 10s da se oslobodi...');
            reconnectTimer = setTimeout(connect, 10000);
            return;
        }

        log('INFO', `[ADS-B] Connecting to dump1090-mutability SBS1 port ${DUMP1090_SBS_PORT}...`);

        // Start dump1090-mutability (acquires the RTL device on 1090 MHz)
        startDump1090();

        tcpClient = new net.Socket();
        tcpClient.setTimeout(120000); // 2 minutes - dump1090 only sends data when aircraft present

        tcpClient.connect(DUMP1090_SBS_PORT, '127.0.0.1', () => {
            log('INFO', '[ADS-B] SBS1 konekcija uspostavljena — slušam na 1090 MHz');
            log('INFO', '[ADS-B] ✅ Ground plane antena (4x45° + 1x90°), hardware AGC aktivan (FCI 2580)');
            log('INFO', '[ADS-B] Provjeri flightradar24.com — ako su avioni tu, trebaju se pojaviti ovdje');
            activeScanners.adsb = true;
            broadcast({ type: 'adsb_status', status: 'connected', port: DUMP1090_SBS_PORT });
            broadcast({ type: 'scanner_status', scanner: 'adsb', active: true });
            
            // Odmah pollaj JSON (bez čekanja 2s) da uhvati već-tracked avione
            pollJSONFiles();
            // Start JSON polling — svake 2s ažurira pozicije svih aviona
            jsonPollInterval = setInterval(pollJSONFiles, 2000);
            
            // Periodic stats check every 30s
            const statsInterval = setInterval(() => {
                if (stopped) { clearInterval(statsInterval); return; }
                try {
                    const statsPath = path.join(__dirname, 'captures/adsb/stats.json');
                    if (fs.existsSync(statsPath)) {
                        const stats = JSON.parse(fs.readFileSync(statsPath, 'utf8'));
                        const last = stats.last1min || stats.latest;
                        const noise = last.local?.noise;
                        const noiseStr = noise != null ? `${noise.toFixed(1)}dB` : '?';
                        const noiseOK = noise != null && noise < -20;
                        log('INFO', `[ADS-B] Stats: messages=${last.messages || 0} tracks=${last.tracks?.all || 0} noise=${noiseStr} signals=${last.local?.strong_signals || 0} — antena: ${noiseOK ? '✅ radi (šum detektovan)' : '❓ provjeri konekciju'}`);
                        if ((last.messages || 0) === 0 && (last.tracks?.all || 0) === 0) {
                            if (noiseOK) {
                                log('INFO', '[ADS-B] Antena prima signal (noise OK). Nema aviona iznad — to je normalno ako nema letova. Provjeri flightradar24.com → povećaj zoom na 100km. Napomena: DRONOVI nisu na 1090MHz, za njih koristi General scanner!');
                            } else {
                                log('WARN', '[ADS-B] Antena ne prima šum — provjeri USB konekciju, kabel ili spoj antene na RTL-SDR');
                            }
                        } else {
                            log('INFO', `[ADS-B] ✅ Prijem OK — ${last.messages || 0} poruka, ${last.tracks?.all || 0} traka u zadnjoj minuti`);
                        }
                    }
                } catch {}
            }, 30000);
        });

        tcpClient.on('data', (chunk) => {
            lineBuffer += chunk.toString();
            const lines = lineBuffer.split('\n');
            lineBuffer = lines.pop();
            lines.forEach(line => {
                if (line.trim().startsWith('MSG')) {
                    log('INFO', `[ADS-B] SBS1: ${line.trimEnd()}`);
                }
                parseSBS1Line(line.trim(), scanId);
            });
        });

        tcpClient.on('timeout', () => {
            log('WARN', '[ADS-B] TCP timeout — reconnecting...');
            tcpClient.destroy();
        });

        tcpClient.on('error', (err) => {
            log('WARN', `[ADS-B] TCP error: ${err.message}`);
        });

        tcpClient.on('close', () => {
            if (!stopped) {
                log('WARN', '[ADS-B] Connection closed — retrying in 5s...');
                broadcast({ type: 'adsb_status', status: 'reconnecting' });
                reconnectTimer = setTimeout(connect, 5000);
            }
        });
    };

    connect();

    return {
        stop() {
            stopped = true;
            clearTimeout(reconnectTimer);
            clearInterval(jsonPollInterval);
            if (tcpClient) tcpClient.destroy();
            activeScanners.adsb = false;
            broadcast({ type: 'scanner_status', scanner: 'adsb', active: false });
            log('INFO', '[ADS-B] Scanner stopped');
        }
    };
}

// Parse SBS-1 (BaseStation) format from dump1090
// MSG,3,... contains altitude/lat/lon
function parseSBS1Line(line, scanId) {
    if (!line.startsWith('MSG')) return;
    const p = line.split(',');
    // SBS1 has 22 fields but some dump1090 builds omit trailing fields — accept ≥5
    if (p.length < 5) return;
    const msgType = parseInt(p[1]);
    const icao    = p[4];
    if (!icao) return;

    // MSG types:
    //  1 = callsign/ident
    //  2 = surface position (ground, speed, track, lat, lon)
    //  3 = airborne position (alt, lat, lon)
    //  4 = airborne velocity (speed, track)
    //  5 = surveillance alt
    //  6 = surveillance ID (squawk)
    //  7 = air-to-air
    //  8 = all-call reply
    // We create a device for ANY MSG type so aircraft appears in the counter.
    const existing = [...devices.values()].find(d => d.icao === icao);
    const device = existing ? { ...existing } : {
        id: uuidv4(),
        scanId,
        type: 'aircraft/drone',
        protocol: 'ADS-B',
        frequency: 1090000000,
        icao,
        callsign: '',
        altitude: null,
        speed: null,
        track: null,
        latitude: null,
        longitude: null,
        squawk: null,
        onGround: false,
        signalStrength: 'strong',
        timestamp: new Date().toISOString()
    };

    if (msgType === 1 && p[10]) device.callsign = p[10].trim();
    // MSG,2 = surface position: speed p[12], track p[13], lat p[14], lon p[15]
    if (msgType === 2) {
        device.onGround = true;
        if (p[12] && p[12].trim()) device.speed = parseInt(p[12]);
        if (p[13] && p[13].trim()) device.track = parseInt(p[13]);
        if (p[14] && p[14].trim()) device.latitude  = parseFloat(p[14]);
        if (p[15] && p[15].trim()) device.longitude = parseFloat(p[15]);
    }
    if (msgType === 3) {
        if (p[11] && p[11].trim()) device.altitude  = parseInt(p[11]);
        if (p[14] && p[14].trim()) device.latitude  = parseFloat(p[14]);
        if (p[15] && p[15].trim()) device.longitude = parseFloat(p[15]);
    }
    if (msgType === 4) {
        if (p[12] && p[12].trim()) device.speed = parseInt(p[12]);
        if (p[13] && p[13].trim()) device.track = parseInt(p[13]);
    }
    if (msgType === 5 && p[11] && p[11].trim()) device.altitude = parseInt(p[11]);
    if (msgType === 6 && p[17] && p[17].trim()) device.squawk = p[17].trim();

    device.timestamp = new Date().toISOString();
    device.lastSeen = Date.now();
    
    // Calculate distance and bearing if we have coordinates
    if (device.latitude && device.longitude && baseLocation) {
        const distance = calculateDistance(baseLocation.lat, baseLocation.lon, device.latitude, device.longitude);
        const bearing = calculateBearing(baseLocation.lat, baseLocation.lon, device.latitude, device.longitude);
        device.distance = distance;
        device.bearing = bearing;
    }

    const isNew = !existing;
    devices.set(device.id || icao, device);

    if (isNew) {
        log('INFO', `[ADS-B] New aircraft: ICAO=${icao} callsign=${device.callsign||'?'} alt=${device.altitude||'?'}ft distance=${device.distance||'?'}`);
    }

    broadcast({ type: 'device_detected', device });
}

// Parse aircraft.json format (direct dump1090 JSON output)
function parseAircraftJSON(ac, scanId) {
    const icao = ac.hex.toUpperCase();
    const existing = [...devices.values()].find(d => d.icao === icao);
    
    const device = existing ? { ...existing } : {
        id: uuidv4(),
        scanId,
        type: 'aircraft/drone',
        protocol: 'ADS-B',
        frequency: 1090000000,
        icao,
        callsign: '',
        altitude: null,
        speed: null,
        track: null,
        latitude: null,
        longitude: null,
        squawk: null,
        signalStrength: 'medium',
        timestamp: new Date().toISOString()
    };

    // Update fields from JSON
    if (ac.flight) device.callsign = ac.flight.trim();
    if (ac.alt_baro) device.altitude = ac.alt_baro;
    if (ac.lat) device.latitude = ac.lat;
    if (ac.lon) device.longitude = ac.lon;
    if (ac.gs) device.speed = Math.round(ac.gs);
    if (ac.track) device.track = Math.round(ac.track);
    if (ac.squawk) device.squawk = ac.squawk;
    if (ac.rssi) device.signalStrength = ac.rssi;

    device.timestamp = new Date().toISOString();
    device.lastSeen = Date.now();
    
    // Calculate distance and bearing if we have coordinates
    if (device.latitude && device.longitude && baseLocation) {
        const distance = calculateDistance(baseLocation.lat, baseLocation.lon, device.latitude, device.longitude);
        const bearing = calculateBearing(baseLocation.lat, baseLocation.lon, device.latitude, device.longitude);
        device.distance = distance;
        device.bearing = bearing;
    }
    
    const isNew = !existing;
    devices.set(device.id || icao, device);

    if (isNew) {
        log('INFO', `[ADS-B/JSON] New aircraft: ICAO=${icao} callsign=${device.callsign||'?'} alt=${device.altitude||'?'}ft distance=${device.distance||'?'} (from JSON polling)`);
    }

    broadcast({ type: 'device_detected', device });
}

// ─────────────────────────────────────────────
//  IOT SCANNER (rtl_433) — uses RTL mutex
// ─────────────────────────────────────────────
function startIoTScanner(scanId) {
    let proc = null;
    let stopped = false;
    let lineBuf = '';

    const start = async () => {
        if (stopped) return;
        await acquireRTL('rtl_433');
        if (stopped) { releaseRTL('rtl_433'); return; }

        log('INFO', '[IoT] Starting rtl_433 on 433/868/315/915 MHz...');
        activeScanners.iot = true;
        broadcast({ type: 'scanner_status', scanner: 'iot', active: true });
    proc = spawn('rtl_433', [
            '-F', 'json',
            '-F', 'log',
            '-M', 'utc',
            '-f', '433920000',
            '-f', '868000000',
            '-f', '315000000',
            '-f', '915000000',
            '-T', '60'
        ]);

        proc.stdout.on('data', (data) => {
            lineBuf += data.toString();
            const lines = lineBuf.split('\n');
            lineBuf = lines.pop();
            lines.forEach(line => {
                if (!line.trim()) return;
                log('DATA', `[IoT] ${line.trimEnd()}`);
                try {
                    const json = JSON.parse(line);
                    parseIoTData(json, scanId);
                } catch {}
            });
        });

        proc.stderr.on('data', (d) => log('INFO', `[IoT] ${d.toString().trimEnd()}`));

        proc.on('close', (code) => {
            log('INFO', `[IoT] rtl_433 exited (code ${code})`);
            releaseRTL('rtl_433');
            proc = null;
            // If stopped intentionally, clear state
            if (stopped) {
                activeScanners.iot = false;
                broadcast({ type: 'scanner_status', scanner: 'iot', active: false });
            }
            // Restart after a pause if still scanning
            if (!stopped) setTimeout(start, 2000);
        });

        proc.on('error', (err) => {
            log('ERROR', `[IoT] spawn error: ${err.message}`);
            releaseRTL('rtl_433');
        });
    };

    start();
    return { 
        stop() { 
            stopped = true;
            if (proc) {
                proc.kill('SIGTERM');
            } else {
                // Process not running, clear state immediately
                activeScanners.iot = false;
                broadcast({ type: 'scanner_status', scanner: 'iot', active: false });
            }
        } 
    };
}

function parseIoTData(json, scanId) {
    const distanceResult = estimateDistanceFromSignal(json.rssi);
    const device = {
        id: uuidv4(), scanId,
        type: 'iot_device',
        protocol: json.model || 'Unknown',
        frequency: json.freq || 433920000,
        temperature: json.temperature_C,
        humidity: json.humidity,
        battery: json.battery_ok,
        signalStrength: json.rssi || json.snr || 'medium',
        data: json,
        distance: distanceResult.distance,
        distanceMeters: distanceResult.distanceMeters,
        timestamp: new Date().toISOString()
    };
    
    // Calculate estimated location if we have base location
    if (baseLocation && distanceResult.distanceMeters) {
        const bearing = estimateBearingFromFrequency(device.frequency, device.id);
        device.bearing = bearing;
        device.estimatedLocation = calculateEstimatedLocation(baseLocation, distanceResult.distanceMeters, bearing);
        device.locationNote = '⚠️ Estimated location - requires directional antenna for accuracy';
    }
    
    log('INFO', `[IoT] *** DEVICE DETECTED: ${json.model||'Unknown'} @ ${(device.frequency/1e6).toFixed(3)}MHz RSSI=${json.rssi||'?'} distance=${device.distance||'?'} ***`);
    device.lastSeen = Date.now();
    devices.set(device.id, device);
    broadcast({ type: 'device_detected', device });
}

// ─────────────────────────────────────────────
//  GENERAL SPECTRUM SCANNER — uses RTL mutex, sequential per-freq
//  Includes walkie-talkie / tokivoki / PMR / LPD / TETRA bands
// ─────────────────────────────────────────────
const GENERAL_FREQUENCIES = [
    // ── Drones & RC ─────────────────────────────────────────────────────────
    { freq: 433920000,  bw: 200000,  label: 'RC/Drone 433MHz',            cat: 'drone' },
    { freq: 868000000,  bw: 500000,  label: 'RC/Drone 868MHz',            cat: 'drone' },
    { freq: 915000000,  bw: 500000,  label: 'RC/Drone 915MHz',            cat: 'drone' },
    // DJI control (OcuSync/Lightbridge 2.4GHz channels)
    { freq: 2400000000, bw: 2000000, label: 'DJI/Drone Control 2.4GHz',  cat: 'drone' },
    { freq: 2440000000, bw: 2000000, label: 'DJI OcuSync 2440MHz',       cat: 'drone' },
    { freq: 2462000000, bw: 2000000, label: 'DJI/WiFi 2.4GHz ch11',      cat: 'drone' },
    // DJI video downlink 5.8GHz (FPV racing & Mavic video)
    { freq: 5760000000, bw: 3000000, label: 'FPV Video 5.76GHz',         cat: 'drone' },
    { freq: 5800000000, bw: 3000000, label: 'Drone Video 5.8GHz',        cat: 'drone' },
    { freq: 5840000000, bw: 3000000, label: 'FPV Video 5.84GHz',         cat: 'drone' },
    // DJI Remote ID broadcast (BT/WiFi 2.4GHz but also 5.8GHz)
    { freq: 2484000000, bw: 1000000, label: 'DJI Remote ID 2.4GHz',      cat: 'drone' },
    // Parrot & hobbyist drones (2.4GHz + 5GHz)
    { freq: 5170000000, bw: 2000000, label: 'Parrot/Drone 5.17GHz',      cat: 'drone' },
    // FPV 1.2GHz analog video (long range)
    { freq: 1200000000, bw: 2000000, label: 'FPV Video 1.2GHz',          cat: 'drone' },
    // Walkie-talkie / Tokivoki / PMR
    { freq: 446006250,  bw: 12500,   label: 'PMR446 ch1 (446.006)',  cat: 'tokivoki' },
    { freq: 446018750,  bw: 12500,   label: 'PMR446 ch2 (446.019)',  cat: 'tokivoki' },
    { freq: 446031250,  bw: 12500,   label: 'PMR446 ch3 (446.031)',  cat: 'tokivoki' },
    { freq: 446043750,  bw: 12500,   label: 'PMR446 ch4 (446.044)',  cat: 'tokivoki' },
    { freq: 446056250,  bw: 12500,   label: 'PMR446 ch5 (446.056)',  cat: 'tokivoki' },
    { freq: 446068750,  bw: 12500,   label: 'PMR446 ch6 (446.069)',  cat: 'tokivoki' },
    { freq: 446081250,  bw: 12500,   label: 'PMR446 ch7 (446.081)',  cat: 'tokivoki' },
    { freq: 446093750,  bw: 12500,   label: 'PMR446 ch8 (446.094)',  cat: 'tokivoki' },
    { freq: 446106250,  bw: 12500,   label: 'PMR446 ch9 (446.106)',  cat: 'tokivoki' },
    { freq: 446118750,  bw: 12500,   label: 'PMR446 ch10 (446.119)', cat: 'tokivoki' },
    { freq: 446131250,  bw: 12500,   label: 'PMR446 ch11 (446.131)', cat: 'tokivoki' },
    { freq: 446143750,  bw: 12500,   label: 'PMR446 ch12 (446.144)', cat: 'tokivoki' },
    { freq: 446156250,  bw: 12500,   label: 'PMR446 ch13 (446.156)', cat: 'tokivoki' },
    { freq: 446168750,  bw: 12500,   label: 'PMR446 ch14 (446.169)', cat: 'tokivoki' },
    { freq: 446181250,  bw: 12500,   label: 'PMR446 ch15 (446.181)', cat: 'tokivoki' },
    { freq: 446193750,  bw: 12500,   label: 'PMR446 ch16 (446.194)', cat: 'tokivoki' },
    // LPD433 (walkie-talkie EU)
    { freq: 433075000,  bw: 25000,   label: 'LPD433 ch1',            cat: 'tokivoki' },
    { freq: 433100000,  bw: 25000,   label: 'LPD433 ch2',            cat: 'tokivoki' },
    { freq: 433125000,  bw: 25000,   label: 'LPD433 ch3',            cat: 'tokivoki' },
    { freq: 433150000,  bw: 25000,   label: 'LPD433 ch4',            cat: 'tokivoki' },
    { freq: 433175000,  bw: 25000,   label: 'LPD433 ch5',            cat: 'tokivoki' },
    { freq: 433200000,  bw: 25000,   label: 'LPD433 ch6',            cat: 'tokivoki' },
    { freq: 433225000,  bw: 25000,   label: 'LPD433 ch7',            cat: 'tokivoki' },
    // Marine VHF
    { freq: 156800000,  bw: 25000,   label: 'Marine VHF ch16',       cat: 'marine' },
    { freq: 156300000,  bw: 25000,   label: 'Marine VHF ch6',        cat: 'marine' },
    // Ham / Amateur
    { freq: 144800000,  bw: 25000,   label: 'APRS 144.8MHz',         cat: 'ham' },
    { freq: 432500000,  bw: 25000,   label: 'Ham 70cm',              cat: 'ham' },
    // CB
    { freq: 27185000,   bw: 10000,   label: 'CB ch19 27.185MHz',     cat: 'cb' },
    // TETRA emergency (listen-only)
    { freq: 380000000,  bw: 200000,  label: 'TETRA Blue-light 380MHz', cat: 'tetra' },
    { freq: 390000000,  bw: 200000,  label: 'TETRA 390MHz',          cat: 'tetra' },
    // Air
    { freq: 121500000,  bw: 25000,   label: 'Air Distress 121.5MHz', cat: 'air' },
    { freq: 118000000,  bw: 500000,  label: 'Air VHF 118-136MHz',    cat: 'air' },
    // ISM
    { freq: 868000000,  bw: 500000,  label: 'ISM 868MHz',            cat: 'ism' },
    // 2.4GHz wide scan
    { freq: 2462000000, bw: 2000000, label: 'WiFi 2.4GHz ch11',      cat: 'wifi' },
];

function startGeneralScanner(scanId) {
    let stopped = false;
    let scanIndex = 0;

    const scanNext = async () => {
        if (stopped) return;

        const freqData = GENERAL_FREQUENCIES[scanIndex % GENERAL_FREQUENCIES.length];
        scanIndex++;

        await acquireRTL(`rtl_power:${freqData.label}`);
        if (stopped) { releaseRTL(`rtl_power:${freqData.label}`); return; }

        await scanFrequencyOnce(freqData, scanId);
        releaseRTL(`rtl_power:${freqData.label}`);

        if (!stopped) setTimeout(scanNext, 500);
    };

    const doStartGeneral = async () => {
        // Postavi flag ODMAH — isti race condition fix kao za drone scanner
        activeScanners.general = true;
        broadcast({ type: 'scanner_status', scanner: 'general', active: true });

        // dump1090 drži RTL USB uređaj — zaustavi ga prije general scan
        if (isDump1090Running() || _dump1090Proc) {
            log('WARN', '[GEN] dump1090 drži RTL uređaj — privremeno zaustavljam ADS-B...');
            await stopDump1090();
            log('INFO', '[GEN] RTL uređaj oslobođen — počinjem general scan...');
        }
        if (isDump1090Running()) {
            log('WARN', '[GEN] dump1090 i dalje živ! Force kill + 1.5s...');
            try { execSync('pkill -9 -f dump1090', { stdio: 'ignore' }); } catch {}
            await new Promise(r => setTimeout(r, 1500));
        }
        scanNext();
    };

    doStartGeneral();
    return { 
        stop() { 
            stopped = true; 
            activeScanners.general = false;
            broadcast({ type: 'scanner_status', scanner: 'general', active: false });
            if (activeScanners.adsb) {
                log('INFO', '[GEN] Restartujem dump1090 (ADS-B bio aktivan)...');
                setTimeout(startDump1090, 500);
            }
        } 
    };
}

function scanFrequencyOnce(freqData, scanId) {
    return new Promise((resolve) => {
        const lo = freqData.freq - freqData.bw;
        const hi = freqData.freq + freqData.bw;
        const step = Math.max(Math.round(freqData.bw / 50), 1000);

        // Guard: if dump1090 is alive it holds USB exclusively — kill it before rtl_power
        if (isDump1090Running() || _dump1090Proc) {
            log('WARN', `[GEN] dump1090 alive before rtl_power scan — killing it now...`);
            try { execSync('pkill -9 -f dump1090', { stdio: 'ignore' }); } catch {}
            _dump1090Proc = null;
            // Short delay for USB release
            setTimeout(() => scanFrequencyOnce(freqData, scanId).then(resolve), 1200);
            return;
        }

        log('INFO', `[GEN] Scanning ${freqData.label} (${(freqData.freq/1e6).toFixed(3)} MHz)...`);

        const proc = spawn('rtl_power', [
            '-f', `${lo}:${hi}:${step}`,
            '-i', '1',
            '-1',   // single shot
            '-'
        ]);

        let output = '';
        proc.stdout.on('data', (d) => { output += d.toString(); });
        proc.stderr.on('data', (d) => log('INFO', `[rtl_power] ${d.toString().trimEnd()}`));
        proc.on('error', (err) => { log('ERROR', `[GEN] rtl_power error: ${err.message}`); resolve(); });
        proc.on('close', (code) => {
            log('INFO', `[GEN] rtl_power finished ${freqData.label} (code ${code})`);
            if (output.trim()) analyzeSpectrumData(output, freqData, scanId);
            resolve();
        });

        // Safety timeout
        setTimeout(() => { try { proc.kill(); } catch {} }, 8000);
    });
}

function analyzeSpectrumData(data, freqData, scanId) {
    const lines = data.split('\n').filter(l => l.trim());
    if (lines.length === 0) return;

    let bestMax = -Infinity;
    let bestAvg = 0;

    lines.forEach(line => {
        const parts = line.split(',');
        if (parts.length < 7) return;
        const values = parts.slice(6).map(v => parseFloat(v)).filter(v => !isNaN(v));
        if (values.length === 0) return;
        const maxPow = Math.max(...values);
        const avgPow = values.reduce((a, b) => a + b, 0) / values.length;
        if (maxPow > bestMax) { bestMax = maxPow; bestAvg = avgPow; }
    });

    if (bestMax === -Infinity) return;

    const delta = bestMax - bestAvg;
    log('INFO', `[GEN] ${freqData.label} — max=${bestMax.toFixed(1)}dB avg=${bestAvg.toFixed(1)}dB delta=${delta.toFixed(1)}dB ${delta >= SIGNAL_DETECTION_THRESHOLD ? '✓ DETECTED' : '✗ below threshold'}`);

    if (delta >= SIGNAL_DETECTION_THRESHOLD) {
        // Pronađi postojeći uređaj na ovoj frekvenciji — updateuj ga umjesto da pravimo duplikat
        let existingDevice = null;
        for (const d of devices.values()) {
            if (d.type === 'rf_signal' && d.frequency === freqData.freq) {
                existingDevice = d;
                break;
            }
        }

        const deviceId = existingDevice ? existingDevice.id : uuidv4();
        const distanceResult = estimateDistanceFromSignal(bestMax, freqData.freq);
        // Zadrži stari bearing ako postoji (ne skaće svaki scan)
        const bearing = existingDevice ? existingDevice.bearing : estimateBearingFromFrequency(freqData.freq, deviceId);
        const deviceTypeInfo = getDeviceTypeDescription(freqData.label, freqData.freq);
        const estimatedLocation = baseLocation && distanceResult.distanceMeters ? calculateEstimatedLocation(baseLocation, distanceResult.distanceMeters, bearing) : null;
        
        const device = {
            ...(existingDevice || {}),
            id: deviceId, scanId,
            type: 'rf_signal',
            protocol: freqData.label,
            category: freqData.cat,
            droneGroup: freqData.droneGroup || null,   // hobby / pro / fpv / longrange / military
            frequency: freqData.freq,
            signalStrength: bestMax,
            bandwidth: freqData.bw,
            modulation: detectModulation([bestMax, bestAvg]),
            distance: distanceResult.distance,
            distanceMeters: distanceResult.distanceMeters,
            bearing: bearing,
            estimatedLocation: estimatedLocation,
            locationNote: '⚠️ Approximate location - bearing unknown without DF antenna',
            deviceTypeInfo: deviceTypeInfo,
            timestamp: new Date().toISOString()
        };
        log('INFO', `[GEN] *** SIGNAL ${existingDevice ? 'UPDATE' : 'DETECTED'}: ${freqData.label} @ ${(freqData.freq/1e6).toFixed(3)}MHz signal=${bestMax.toFixed(1)}dB dist=${device.distance} bearing=${bearing}° ***`);
        device.lastSeen = Date.now();
        devices.set(device.id, device);
        broadcast({ type: 'device_detected', device });
    }
}

// ─────────────────────────────────────────────
//  DRONE FREQUENCY DATABASE — grouped by drone type
//  RTL-SDR pokriva do ~1.75 GHz.
//  2.4 GHz i 5.8 GHz zahtijevaju HackRF/USRP — označeno rtlOk: false (info only).
//  Vojni dronovi koriste ŠIFROVANE linkove — RTL-SDR detektuje RF prisustvo.
// ─────────────────────────────────────────────
const DRONE_FREQUENCIES = [
    // ── MALI / HOBISTIČKI DRONOVI ────────────────────────────────────────
    // DJI Mini 1/2/3/4 Pro, Spark, Autel EVO Nano, Holy Stone, SJRC, Hubsan, igračke
    { freq:  433920000, bw:  250000, label: 'Hobby RC 433MHz',             cat: 'drone', droneGroup: 'hobby',     rtlOk: true  },
    { freq: 1200000000, bw: 5000000, label: 'Hobby FPV 1.2GHz',            cat: 'drone', droneGroup: 'hobby',     rtlOk: true  },
    // 2.4GHz i 5.8GHz — RTL-SDR NE MOŽE (zahtijeva HackRF), samo info referenca:
    // { freq: 2400000000, label: 'DJI OcuSync 2.4GHz',    rtlOk: false },
    // { freq: 5800000000, label: 'DJI video 5.8GHz',       rtlOk: false },

    // ── PROFESIONALNI DRONOVI ─────────────────────────────────────────────
    // DJI Mavic 3 Enterprise, Matrice 300/350 RTK, Autel EVO II Pro, Skydio 2+
    { freq:  868000000, bw:  500000, label: 'Pro Telemetry 868MHz',         cat: 'drone', droneGroup: 'pro',       rtlOk: true  },
    { freq:  915000000, bw:  500000, label: 'Pro Telemetry 915MHz',         cat: 'drone', droneGroup: 'pro',       rtlOk: true  },
    { freq: 1200000000, bw: 5000000, label: 'Pro Video 1.2GHz',             cat: 'drone', droneGroup: 'pro',       rtlOk: true  },
    // { freq: 2440000000, label: 'OcuSync 3 2.44GHz',      rtlOk: false },

    // ── FPV RACING DRONOVI ────────────────────────────────────────────────
    // Racing quads, freestyle, TinyWhoop — ELRS, FrSky, TBS Crossfire, Betaflight
    { freq:  433920000, bw:  300000, label: 'FPV ELRS/Crossfire 433MHz',    cat: 'drone', droneGroup: 'fpv',       rtlOk: true  },
    { freq:  868000000, bw:  500000, label: 'FPV ELRS 868MHz',              cat: 'drone', droneGroup: 'fpv',       rtlOk: true  },
    { freq:  915000000, bw:  500000, label: 'FPV ELRS 915MHz',              cat: 'drone', droneGroup: 'fpv',       rtlOk: true  },
    { freq: 1200000000, bw: 8000000, label: 'FPV Analog Video 1.2GHz',      cat: 'drone', droneGroup: 'fpv',       rtlOk: true  },
    // { freq: 5800000000, label: 'FPV video 5.8GHz',        rtlOk: false },

    // ── LONG RANGE / SURVEY DRONOVI ──────────────────────────────────────
    // ArduPilot quad, DJI Agras T30, WingtraOne, senseFly eBee, mapping/agri
    { freq:  433075000, bw:   25000, label: 'LR Drone RC 433MHz',           cat: 'drone', droneGroup: 'longrange', rtlOk: true  },
    { freq:  869525000, bw:   25000, label: 'LR SiK Telemetry 869.5MHz',    cat: 'drone', droneGroup: 'longrange', rtlOk: true  },
    { freq:  900000000, bw:  500000, label: 'LR SiK Telemetry 900MHz',      cat: 'drone', droneGroup: 'longrange', rtlOk: true  },
    { freq:  915000000, bw:  500000, label: 'LR ELRS 915MHz',               cat: 'drone', droneGroup: 'longrange', rtlOk: true  },

    // ── VOJNI / TAKTIČKI DRONOVI ─────────────────────────────────────────
    // NAPOMENA: Šifrovani linkovi! RTL-SDR = detektuje RF prisustvo, NE sadržaj.
    // Shahed-136/131 (Iran), Lancet-3 (Rusija), Orlan-10, Bayraktar TB2 (Turska)
    { freq:  433920000, bw:  500000, label: 'Tactical UAV 433MHz',          cat: 'drone', droneGroup: 'military',  rtlOk: true  },
    { freq:  868000000, bw:  500000, label: 'Tactical UAV 868MHz',          cat: 'drone', droneGroup: 'military',  rtlOk: true  },
    { freq:  900000000, bw: 1000000, label: 'Tactical UAV 900MHz',          cat: 'drone', droneGroup: 'military',  rtlOk: true  },
    { freq: 1090000000, bw:  500000, label: 'UAV Mode-S 1090MHz',           cat: 'drone', droneGroup: 'military',  rtlOk: true  },
    { freq: 1200000000, bw: 5000000, label: 'UAV L-band 1.2GHz',            cat: 'drone', droneGroup: 'military',  rtlOk: true  },
    { freq: 1575420000, bw: 2000000, label: 'GPS L1 1575.42MHz (spoofing!)', cat: 'drone', droneGroup: 'military',  rtlOk: true  },
];

// Deduplicirani spisak za skeniranje (jedan prolaz po frekvenciji)
const DRONE_SCAN_FREQUENCIES = (() => {
    const seen = new Set();
    return DRONE_FREQUENCIES.filter(f => {
        if (!f.rtlOk) return false; // preskoči frekvencije van RTL-SDR opsega
        if (seen.has(f.freq)) return false;
        seen.add(f.freq);
        return true;
    });
})();

// ─────────────────────────────────────────────
//  DRONE SCANNER — dedicated sweep po drone frekvencijama
//  Grupe: hobby / pro / fpv / longrange / military
// ─────────────────────────────────────────────
function startDroneScanner(scanId) {
    let stopped = false;
    let scanIndex = 0;
    const adsbWasActive = activeScanners.adsb;

    const scanNext = async () => {
        if (stopped) return;
        const freqData = DRONE_SCAN_FREQUENCIES[scanIndex % DRONE_SCAN_FREQUENCIES.length];
        scanIndex++;
        await acquireRTL(`drone:${freqData.label}`);
        if (stopped) { releaseRTL(`drone:${freqData.label}`); return; }
        await scanFrequencyOnce(freqData, scanId);
        releaseRTL(`drone:${freqData.label}`);
        if (!stopped) setTimeout(scanNext, 500);
    };

    const doStart = async () => {
        // Postavi flag ODMAH — sprječava ADS-B connect loop da restartuje dump1090
        // dok mi asinkrono čekamo da se process ubije (race condition fix)
        activeScanners.drone = true;
        broadcast({ type: 'scanner_status', scanner: 'drone', active: true });

        // dump1090 drži RTL USB uređaj ekskluzivno — mora se zaustaviti
        // prije nego rtl_power može dobiti pristup.
        if (isDump1090Running() || _dump1090Proc) {
            log('WARN', '[DRONE] dump1090 drži RTL uređaj — zaustavljam i čekam oslobođenje USB...');
            await stopDump1090();
            log('INFO', '[DRONE] RTL uređaj oslobođen — počinjem drone scan...');
        }
        // Extra provjera — ako OS još drži USB
        if (isDump1090Running()) {
            log('WARN', '[DRONE] dump1090 i dalje živ! Force kill + 2s...');
            try { execSync('pkill -9 -f dump1090', { stdio: 'ignore' }); } catch {}
            await new Promise(r => setTimeout(r, 2000));
        }
        log('INFO', '[DRONE] Dedicated drone scanner AKTIVAN — grupe: hobby/pro/FPV/long-range/military');
        log('INFO', `[DRONE] Skeniram ${DRONE_SCAN_FREQUENCIES.length} frekvencija: ${DRONE_SCAN_FREQUENCIES.map(f => (f.freq/1e6).toFixed(0)+'MHz').join(', ')}`);
        scanNext();
    };

    doStart();

    return {
        stop() {
            stopped = true;
            activeScanners.drone = false;
            broadcast({ type: 'scanner_status', scanner: 'drone', active: false });
            log('INFO', '[DRONE] Dedicated drone scanner ZAUSTAVLJEN');
            // ADS-B connect() loop će automatski detektovati da je drone stopped
            // i restartovati dump1090 sam (via 10s check loop). Ne trebamo zvati startDump1090 ovdje.
            if (adsbWasActive || activeScanners.adsb) {
                log('INFO', '[DRONE] ADS-B bio aktivan — dump1090 će se restartovati automatski (connect loop)');
            }
        }
    };
}

// ─────────────────────────────────────────────
//  BLUETOOTH SCANNER
// ─────────────────────────────────────────────
function startBluetoothScanner(scanId) {
    let stopped = false;

    const run = () => {
        if (stopped) return;
        log('INFO', '[BT] Starting Bluetooth scan...');
        
        // Check if Bluetooth is available first
        const checkBT = spawn('hciconfig', ['hci0']);
        let btStatus = '';
        checkBT.stdout.on('data', (d) => { btStatus += d.toString(); });
        checkBT.on('close', () => {
            if (btStatus.toLowerCase().includes('down')) {
                log('WARN', '[BT] Bluetooth adapter is DOWN. Run: sudo hciconfig hci0 up');
            } else if (btStatus.toLowerCase().includes('up')) {
                log('INFO', '[BT] Bluetooth adapter is UP and ready');
            }
        });
        
        const proc = spawn('timeout', ['15', 'hcitool', 'scan']);

        proc.stdout.on('data', (data) => {
            const output = data.toString();
            log('DATA', `[BT] RAW OUTPUT: ${output.trimEnd()}`);
            parseBluetoothData(output, scanId);
        });
        proc.stderr.on('data', (d) => log('INFO', `[BT] ${d.toString().trimEnd()}`));
        proc.on('close', (code) => {
            log('INFO', `[BT] hcitool scan finished (code ${code})`);
            // If stopped intentionally, clear state
            if (stopped) {
                activeScanners.bluetooth = false;
                broadcast({ type: 'scanner_status', scanner: 'bluetooth', active: false });
            }
            if (!stopped) setTimeout(run, 5000);
        });
        proc.on('error', (err) => log('ERROR', `[BT] error: ${err.message}`));
    };

    activeScanners.bluetooth = true;
    broadcast({ type: 'scanner_status', scanner: 'bluetooth', active: true });
    run();
    return { 
        stop() { 
            stopped = true;
            // State will be cleared in process close handler
        } 
    };
}

// ─────────────────────────────────────────────
//  PARSE BLUETOOTH
// ─────────────────────────────────────────────
function parseBluetoothData(data, scanId) {
    const lines = data.split('\n');
    let foundDevice = false;
    lines.forEach(line => {
        const trimmed = line.trim();
        if (!trimmed || trimmed.includes('Scanning') || trimmed.includes('Device')) {
            // Skip header lines
            return;
        }
        
        // Match MAC address followed by device name
        const match = trimmed.match(/([0-9A-F:]{17})\s+(.+)/);
        if (match) {
            foundDevice = true;
            const device = {
                id: uuidv4(),
                scanId: scanId,
                type: 'bluetooth',
                protocol: 'Bluetooth',
                address: match[1],
                name: match[2].trim(),
                frequency: 2400000000,
                distance: 'short_range',
                timestamp: new Date().toISOString()
            };

            log('INFO', `[BT] *** DEVICE FOUND: ${device.address} - ${device.name} ***`);
            device.lastSeen = Date.now();
            devices.set(device.id, device);
            broadcast({ type: 'device_detected', device });
        }
    });
    
    if (!foundDevice && data.trim()) {
        log('DEBUG', `[BT] No devices matched in output (lines: ${lines.length})`);
    }
}

// ─────────────────────────────────────────────
//  RECORDING — rtl_fm → sox WAV
//  Uses RTL mutex; recording releases when stopped
// ─────────────────────────────────────────────
async function startRecording(frequency, mode = 'wbfm', deviceLabel = null) {
    const recordingId = uuidv4();
    const freqMHz = (frequency / 1e6).toFixed(3);
    const labelSafe = deviceLabel ? deviceLabel.replace(/[^a-zA-Z0-9_-]/g, '_') : `${freqMHz}MHz`;
    const filename = `recordings/${labelSafe}_${Date.now()}.wav`;
    
    await acquireRTL(`recording:${recordingId}`);
    log('INFO', `[REC] Recording started: ${freqMHz} MHz (${deviceLabel || 'unknown'}) mode=${mode} → ${filename}`);
    
    const rtl = spawn('rtl_fm', [
        '-f', frequency.toString(),
        '-M', mode,
        '-s', '200000',
        '-r', '48000',
        '-l', '0',         // squelch level (0 = auto, reduces noise)
        '-'
    ]);

    const sox = spawn('sox', [
        '-t', 'raw',
        '-r', '48000',
        '-e', 'signed-integer',
        '-b', '16',
        '-c', '1',
        '-',
        filename
    ]);

    rtl.stdout.pipe(sox.stdin);
    rtl.stderr.on('data', (d) => log('INFO', `[rtl_fm/rec] ${d.toString().trimEnd()}`));
    
    rtl.on('error', (err) => {
        log('ERROR', `[REC] rtl_fm error: ${err.message}`);
    });
    
    rtl.on('close', (code) => {
        log('WARN', `[REC] rtl_fm exited (code ${code})`);
        if (code !== 0 && code !== null) {
            releaseRTL(`recording:${recordingId}`);
            recordings.delete(recordingId);
            broadcast({ type: 'recording_error', recordingId, error: `rtl_fm failed with code ${code}` });
        }
    });
    
    sox.on('error', (err) => log('ERROR', `[REC] sox error: ${err.message}`));
    
    sox.on('close', (code) => {
        log('INFO', `[REC] sox exited (code ${code})`);
        if (recordings.has(recordingId)) {
            releaseRTL(`recording:${recordingId}`);
            recordings.delete(recordingId);
        }
    });

    recordings.set(recordingId, {
        id: recordingId,
        frequency,
        mode,
        deviceLabel,
        filename,
        processes: [rtl, sox],
        startTime: new Date().toISOString()
    });

    broadcast({ type: 'recording_started', recordingId, frequency, deviceLabel });
    return recordingId;
}

// Stop recording
function stopRecording(recordingId) {
    const recording = recordings.get(recordingId);
    if (recording) {
        recording.processes.forEach(proc => { try { proc.kill(); } catch {} });
        recordings.delete(recordingId);
        releaseRTL(`recording:${recordingId}`);
        log('INFO', `[REC] Recording stopped: ${recording.filename}`);
        broadcast({ type: 'recording_stopped', recordingId, filename: recording.filename });
    }
}

// ─────────────────────────────────────────────
//  LIVE AUDIO — rtl_fm piped to play (sox)
//  Uses RTL mutex
// ─────────────────────────────────────────────
let liveAudioProcess = null;
async function startLiveAudio(frequency, mode = 'wbfm') {
    if (liveAudioProcess) stopLiveAudio();

    await acquireRTL('live_audio');
    log('INFO', `[LIVE] Live audio: ${(frequency/1e6).toFixed(3)} MHz mode=${mode}`);

    const rtl = spawn('rtl_fm', [
        '-f', frequency.toString(),
        '-M', mode,
        '-s', '200000',
        '-r', '48000',
        '-l', '0',         // squelch level (0 = auto, reduces noise when no signal)
        '-'
    ]);
    
    // Use aplay with explicit device for headphones/speakers (card 2 = ALC897 Analog)
    // plughw:2,0 = motherboard audio (where headphones/speakers usually are)
    // Falls back to default if card 2 doesn't exist
    const aplay = spawn('aplay', [
        '-D', 'plughw:2,0',  // Card 2, Device 0 (ALC897 Analog - motherboard audio)
        '-f', 'S16_LE',      // signed 16-bit little-endian
        '-r', '48000',       // 48kHz sample rate
        '-c', '1',           // mono
        '-t', 'raw'          // raw PCM
    ]);
    
    log('INFO', '[LIVE] Using ALSA aplay on card 2 (motherboard audio/headphones)');

    rtl.stdout.pipe(aplay.stdin);
    
    rtl.stderr.on('data', (d) => log('INFO', `[rtl_fm] ${d.toString().trimEnd()}`));
    
    rtl.on('error', (err) => {
        log('ERROR', `[LIVE] rtl_fm error: ${err.message}`);
        stopLiveAudio();
    });
    
    rtl.on('close', (code) => {
        log('WARN', `[LIVE] rtl_fm exited (code ${code})`);
        if (code !== 0 && code !== null) {
            stopLiveAudio();
            broadcast({ type: 'live_audio_error', error: `rtl_fm failed with code ${code}` });
        }
    });
    
    aplay.stderr.on('data', (d) => {
        const msg = d.toString().trimEnd();
        // Log errors but ignore benign ALSA messages
        if (msg.includes('FAIL') || msg.includes('error') || msg.includes('cannot')) {
            log('ERROR', `[aplay] ${msg}`);
            // If audio device fails, suggest alternatives
            if (msg.includes('No such') || msg.includes('device')) {
                log('ERROR', '[LIVE] Audio device hw:2,0 not available. Check: aplay -l');
                log('ERROR', '[LIVE] You may need to change audio card in server.js line ~1065');
            }
        }
    });
    
    aplay.on('error', (err) => {
        log('ERROR', `[LIVE] play command error: ${err.message}`);
        log('ERROR', '[LIVE] Make sure sox is installed: sudo apt install sox');
        stopLiveAudio();
    });
    
    aplay.on('close', (code) => {
        log('INFO', `[LIVE] audio player exited (code ${code})`);
        if (code !== 0 && code !== null && liveAudioProcess) {
            stopLiveAudio();
            broadcast({ type: 'live_audio_error', error: 'Audio playback stopped' });
        }
    });

    liveAudioProcess = { rtl, play: aplay, frequency, mode };
    broadcast({ type: 'live_audio_started', frequency, mode });
}

function stopLiveAudio() {
    if (liveAudioProcess) {
        log('INFO', '[LIVE] Stopping live audio...');
        try { 
            liveAudioProcess.rtl.kill('SIGTERM'); 
            setTimeout(() => { 
                try { liveAudioProcess.rtl.kill('SIGKILL'); } catch {} 
            }, 1000);
        } catch (err) {
            log('WARN', `[LIVE] Error killing rtl_fm: ${err.message}`);
        }
        try { 
            liveAudioProcess.play.kill('SIGTERM');
            setTimeout(() => { 
                try { liveAudioProcess.play.kill('SIGKILL'); } catch {} 
            }, 1000);
        } catch (err) {
            log('WARN', `[LIVE] Error killing aplay: ${err.message}`);
        }
        releaseRTL('live_audio');
        liveAudioProcess = null;
        log('INFO', '[LIVE] Live audio stopped');
        broadcast({ type: 'live_audio_stopped' });
    } else {
        log('INFO', '[LIVE] No live audio to stop');
    }
}

// ─────────────────────────────────────────────
//  BLUETOOTH MONITORING (btmon) — Monitor YOUR paired BT device traffic
// ─────────────────────────────────────────────
let btmonProcess = null;

function startBtMon() {
    if (btmonProcess) {
        log('WARN', '[BTMON] Already running');
        return;
    }

    log('INFO', '[BTMON] Starting Bluetooth traffic monitor...');
    log('INFO', '[BTMON] This monitors YOUR paired devices only');
    
    // btmon requires root/sudo to capture HCI traffic
    const proc = spawn('sudo', ['btmon', '--tty']);
    
    let dataBuffer = '';
    
    proc.stdout.on('data', (data) => {
        dataBuffer += data.toString();
        const lines = dataBuffer.split('\n');
        dataBuffer = lines.pop(); // Keep incomplete line in buffer
        
        lines.forEach(line => {
            const trimmed = line.trim();
            if (!trimmed) return;
            
            // Parse interesting BT events
            if (trimmed.includes('ACL Data') || 
                trimmed.includes('SCO Data') || 
                trimmed.includes('Device Connected') ||
                trimmed.includes('Device Disconnected') ||
                trimmed.includes('Name:')) {
                
                log('INFO', `[BTMON] ${trimmed}`);
                
                // Broadcast interesting events to UI
                broadcast({
                    type: 'btmon_event',
                    message: trimmed,
                    timestamp: new Date().toISOString()
                });
            }
        });
    });
    
    proc.stderr.on('data', (d) => {
        const msg = d.toString().trimEnd();
        if (msg.includes('Permission denied')) {
            log('ERROR', '[BTMON] Permission denied - btmon requires sudo');
            log('ERROR', '[BTMON] Run server with sudo or add user to bluetooth group');
            stopBtMon();
        } else {
            log('WARN', `[BTMON] ${msg}`);
        }
    });
    
    proc.on('error', (err) => {
        log('ERROR', `[BTMON] Error: ${err.message}`);
        btmonProcess = null;
        broadcast({ type: 'btmon_stopped', error: err.message });
    });
    
    proc.on('close', (code) => {
        log('INFO', `[BTMON] Stopped (code ${code})`);
        btmonProcess = null;
        broadcast({ type: 'btmon_stopped' });
    });
    
    btmonProcess = proc;
    broadcast({ type: 'btmon_started' });
}

function stopBtMon() {
    if (btmonProcess) {
        log('INFO', '[BTMON] Stopping Bluetooth monitor...');
        try {
            btmonProcess.kill('SIGTERM');
            setTimeout(() => {
                try { btmonProcess.kill('SIGKILL'); } catch {}
            }, 1000);
        } catch (err) {
            log('WARN', `[BTMON] Error killing btmon: ${err.message}`);
        }
        btmonProcess = null;
    }
}

// ─────────────────────────────────────────────
//  BLUETOOTH PAIRING — Pair with YOUR device
// ─────────────────────────────────────────────
function pairBluetoothDevice(address) {
    if (!address || !/[0-9A-F:]{17}/.test(address)) {
        log('ERROR', `[BT-PAIR] Invalid MAC address: ${address}`);
        broadcast({ type: 'bt_pair_error', message: 'Invalid MAC address' });
        return;
    }

    log('INFO', `[BT-PAIR] ========================================`);
    log('INFO', `[BT-PAIR] AUTO-PAIRING with ${address}...`);
    log('INFO', `[BT-PAIR] IMPORTANT: Confirm pairing on your device!`);
    log('INFO', `[BT-PAIR] ========================================`);
    broadcast({ type: 'bt_pair_started', address });

    // First, make sure Bluetooth adapter is powered on
    const powerOn = spawn('bluetoothctl', ['power', 'on']);
    powerOn.on('close', () => {
        // Enable pairable mode
        const pairable = spawn('bluetoothctl', ['pairable', 'on']);
        pairable.on('close', () => {
            // Now start the pairing process
            startPairingProcess(address);
        });
    });
}

function startPairingProcess(address) {
    // Use bluetoothctl in batch mode with proper sequencing
    const commands = [
        `power on`,
        `agent on`,
        `default-agent`,
        `scan on`,
        `discoverable on`,
        `pairable on`
    ];
    
    // Wait 2 seconds for scanning, then pair
    setTimeout(() => {
        const proc = spawn('bluetoothctl');
        
        // Send initial setup commands
        commands.forEach((cmd, idx) => {
            setTimeout(() => proc.stdin.write(`${cmd}\n`), idx * 200);
        });
        
        // Attempt pairing
        setTimeout(() => {
            log('INFO', `[BT-PAIR] Removing any old pairing...`);
            proc.stdin.write(`remove ${address}\n`);
        }, 1500);
        
        setTimeout(() => {
            log('INFO', `[BT-PAIR] Sending pair command...`);
            proc.stdin.write(`pair ${address}\n`);
        }, 2500);
        
        setTimeout(() => {
            log('INFO', `[BT-PAIR] Trusting device...`);
            proc.stdin.write(`trust ${address}\n`);
        }, 5000);
        
        setTimeout(() => {
            log('INFO', `[BT-PAIR] Connecting...`);
            proc.stdin.write(`connect ${address}\n`);
        }, 7000);
        
        // Quit after 10 seconds
        setTimeout(() => {
            proc.stdin.write('quit\n');
        }, 10000);
        
        let output = '';
        let pairingSuccessful = false;
        
        proc.stdout.on('data', (data) => {
            const text = data.toString();
            output += text;
            
            // Log interesting lines
            const lines = text.split('\n');
            lines.forEach(line => {
                const trimmed = line.trim();
                if (!trimmed || trimmed.startsWith('[bluetooth]')) return;
                
                if (trimmed.includes('Pairing successful') || trimmed.includes('Paired: yes')) {
                    log('INFO', `[BT-PAIR] ✓✓✓ PAIRING SUCCESSFUL ✓✓✓`);
                    pairingSuccessful = true;
                    broadcast({ 
                        type: 'bt_pair_success', 
                        address, 
                        message: 'Device paired successfully! You can now monitor traffic.' 
                    });
                } else if (trimmed.includes('Connected: yes') || trimmed.includes('Connection successful')) {
                    log('INFO', `[BT-PAIR] ✓ CONNECTED to ${address}`);
                    broadcast({ 
                        type: 'bt_pair_success', 
                        address, 
                        message: 'Device connected! BT Monitor starting...' 
                    });
                } else if (trimmed.includes('Failed') || trimmed.includes('not available') || trimmed.includes('Device does not exist')) {
                    log('ERROR', `[BT-PAIR] ✗ ${trimmed}`);
                    broadcast({ 
                        type: 'bt_pair_error', 
                        address, 
                        message: trimmed 
                    });
                } else if (trimmed.includes('Confirm passkey') || trimmed.includes('Authorize service') || trimmed.includes('[yes/no]')) {
                    log('WARN', `[BT-PAIR] >>> USER ACTION REQUIRED: ${trimmed}`);
                    log('WARN', `[BT-PAIR] >>> Check your device screen and confirm pairing!`);
                    proc.stdin.write('yes\n'); // Auto-accept
                    broadcast({
                        type: 'bt_pair_info',
                        message: '⚠️ CONFIRM PAIRING ON YOUR DEVICE!'
                    });
                } else if (trimmed.length > 5) {
                    log('INFO', `[BT-PAIR] ${trimmed}`);
                }
            });
        });
        
        proc.stderr.on('data', (d) => log('WARN', `[BT-PAIR] ${d.toString().trimEnd()}`));
        
        proc.on('close', (code) => {
            log('INFO', `[BT-PAIR] Pairing process finished (code ${code})`);
            if (pairingSuccessful) {
                log('INFO', `[BT-PAIR] ========================================`);
                log('INFO', `[BT-PAIR] ✓ Device ${address} paired successfully!`);
                log('INFO', `[BT-PAIR] ✓ Starting Bluetooth monitoring...`);
                log('INFO', `[BT-PAIR] ========================================`);
                
                // Auto-start btmon if not already running
                setTimeout(() => {
                    if (!btmonProcess) {
                        log('INFO', '[BT-PAIR] Auto-starting btmon...');
                        startBtMon();
                    }
                }, 1000);
            } else {
                log('WARN', `[BT-PAIR] Pairing may have failed. Check if device is in pairing mode.`);
                broadcast({
                    type: 'bt_pair_error',
                    message: 'Pairing timeout. Make sure device is in pairing mode and try again.'
                });
            }
        });
    }, 2000);
}

// Stop all scans
function stopScan(scanId) {
    const scanners = activeScans.get(scanId);
    if (scanners) {
        Object.values(scanners).forEach(scanner => {
            if (!scanner) return;
            if (typeof scanner.stop === 'function') scanner.stop();
            else if (scanner.kill)      scanner.kill();
            else if (scanner.interval) clearInterval(scanner.interval);
        });
        activeScans.delete(scanId);
        log('INFO', `[SCAN] Scan stopped: ${scanId}`);
        broadcast({ type: 'scan_stopped', scanId });
    }
}

// Stop ALL active scanners (for listen/recording to acquire RTL device)
function stopAllScans() {
    const scanIds = Array.from(activeScans.keys());
    if (scanIds.length === 0) return;
    
    log('INFO', `[SCAN] Stopping all scanners (${scanIds.length}) to free RTL device...`);
    scanIds.forEach(scanId => stopScan(scanId));
    
    // Reset global scanner states
    activeScanners.adsb = false;
    activeScanners.iot = false;
    activeScanners.general = false;
    activeScanners.bluetooth = false;
    activeScanners.drone = false;
    
    broadcast({ type: 'scanner_status', scanner: 'adsb', active: false });
    broadcast({ type: 'scanner_status', scanner: 'iot', active: false });
    broadcast({ type: 'scanner_status', scanner: 'general', active: false });
    broadcast({ type: 'scanner_status', scanner: 'bluetooth', active: false });
    broadcast({ type: 'scanner_status', scanner: 'drone', active: false });
}

// Stop a specific scanner by type (adsb, iot, general, bluetooth)
function stopScannerByType(scannerType) {
    if (!['adsb', 'iot', 'general', 'bluetooth', 'wifi', 'drone'].includes(scannerType)) {
        log('WARN', `[SCAN] Invalid scanner type: ${scannerType}`);
        return;
    }

    if (scannerType === 'wifi') {
        stopWiFiScanner();
        return;
    }
    
    if (!activeScanners[scannerType]) {
        log('WARN', `[SCAN] Scanner ${scannerType} is not running`);
        return;
    }
    
    log('INFO', `[SCAN] Stopping ${scannerType} scanner...`);
    
    // Find all scans that contain this scanner and stop only that scanner
    for (const [scanId, scanners] of activeScans.entries()) {
        if (scanners[scannerType] && typeof scanners[scannerType].stop === 'function') {
            scanners[scannerType].stop();
            delete scanners[scannerType];
            
            // If this was the last scanner in the scan, remove the scan entirely
            if (Object.keys(scanners).length === 0) {
                activeScans.delete(scanId);
                log('INFO', `[SCAN] Scan ${scanId} fully stopped`);
            }
        }
    }
    
    activeScanners[scannerType] = false;
    broadcast({ type: 'scanner_status', scanner: scannerType, active: false });
    log('INFO', `[SCAN] ${scannerType} scanner stopped`);
}

// ─────────────────────────────────────────────
//  WIFI SCANNER — nmcli (ne treba RTL-SDR)
//  Skenira sve WiFi mreže, detektuje skrivene kamere i sumnjive uređaje
// ─────────────────────────────────────────────
const CAMERA_SSID_PATTERNS = [
    /cam/i, /camera/i, /ipcam/i, /ipc\d/i, /dvr/i, /nvr/i,
    /hikvision/i, /dahua/i, /foscam/i, /reolink/i, /amcrest/i,
    /annke/i, /axis/i, /vivotek/i, /wisenet/i, /hanwha/i,
    /yi.?cam/i, /xiaomi.?cam/i, /kami/i, /eufy/i,
    /blink/i, /ring.?cam/i, /arlo/i, /nest.?cam/i, /wyze/i,
    /tapo/i, /wificam/i, /netcam/i, /securecam/i, /babycam/i,
    /nannycam/i, /spycam/i, /hiddencam/i, /guardcam/i,
    /tp.?link.*cam/i, /d.?link.*cam/i, /imou/i, /ezviz/i
];
const AUDIO_SSID_PATTERNS = [
    /spy/i, /hidden/i, /covert/i, /bug\d/i, /gsm.?bug/i,
    /listen/i, /surv/i, /audio.?bug/i, /prislusk/i
];

function parseNmcliTerseLine(line) {
    // nmcli -t -e yes uses \ to escape : in values
    const parts = [];
    let current = '';
    let i = 0;
    while (i < line.length) {
        if (line[i] === '\\' && i + 1 < line.length) {
            current += line[i + 1];
            i += 2;
        } else if (line[i] === ':') {
            parts.push(current);
            current = '';
            i++;
        } else {
            current += line[i];
            i++;
        }
    }
    parts.push(current);
    return parts;
}

function wifiRssiToDistance(signalPct) {
    // nmcli SIGNAL 0-100 → approximate dBm → approximate distance
    const dBm = Math.round((signalPct * 70 / 100) - 110);
    // FSPL at 2.44 GHz: d = 10^((|dBm| - 40.2) / 20)
    const d = Math.round(Math.pow(10, (Math.abs(dBm) - 40.2) / 20));
    return { dBm, distanceMeters: Math.min(d, 500) };
}

let wifiScanTimer = null;
let wifiScanActive = false;

function startWiFiScanner() {
    if (wifiScanActive) {
        log('WARN', '[WIFI] Already running');
        return { stop() {} };
    }
    wifiScanActive = true;
    activeScanners.wifi = true;
    broadcast({ type: 'scanner_status', scanner: 'wifi', active: true });
    log('INFO', '[WIFI] WiFi network scanner started (nmcli)');

    const doScan = () => {
        if (!wifiScanActive) return;
        log('INFO', '[WIFI] Scanning nearby WiFi networks...');

        const proc = spawn('nmcli', ['-t', '-e', 'yes', '-f', 'SSID,BSSID,SIGNAL,CHAN,SECURITY', 'dev', 'wifi', 'list', '--rescan', 'yes']);
        let output = '';
        proc.stdout.on('data', d => { output += d.toString(); });
        proc.stderr.on('data', d => log('DEBUG', `[WIFI] nmcli: ${d.toString().trim()}`));
        proc.on('error', err => {
            log('ERROR', `[WIFI] nmcli not available: ${err.message}`);
            wifiScanActive = false;
            activeScanners.wifi = false;
            broadcast({ type: 'scanner_status', scanner: 'wifi', active: false });
        });
        proc.on('close', code => {
            if (!wifiScanActive) return;
            const wifiList = [];
            const seen = new Set();

            if (code === 0 && output.trim()) {
                output.split('\n').filter(l => l.trim()).forEach(line => {
                    const parts = parseNmcliTerseLine(line);
                    if (parts.length < 5) return;
                    const ssid     = parts[0].trim();
                    const bssid    = parts[1].trim();
                    const signal   = parseInt(parts[2]) || 0;
                    const chan     = parseInt(parts[3]) || 6;
                    const security = parts[4].trim() || 'Open';

                    if (!bssid || seen.has(bssid)) return;
                    seen.add(bssid);

                    const { dBm, distanceMeters } = wifiRssiToDistance(signal);
                    const freqBand = chan > 14 ? '5GHz' : '2.4GHz';

                    let category = 'wifi';
                    let suspicious = false;
                    let warning = null;
                    let displayName = ssid || '(Skrivena mreža)';
                    let deviceLabel = ssid || 'HIDDEN';

                    if (!ssid || ssid.trim() === '') {
                        category = 'hidden_network';
                        suspicious = true;
                        displayName = '⚠️ Skrivena SSID mreža';
                        warning = 'Hidden network - moguć nadzorni uređaj ili skrivena kamera';
                        deviceLabel = `HIDDEN_${bssid}`;
                    } else if (CAMERA_SSID_PATTERNS.some(p => p.test(ssid))) {
                        category = 'wifi_camera';
                        suspicious = true;
                        displayName = `📷 ${ssid}`;
                        warning = 'Moguća IP/WiFi kamera';
                    } else if (AUDIO_SSID_PATTERNS.some(p => p.test(ssid))) {
                        category = 'audio_bug';
                        suspicious = true;
                        displayName = `🎙️ ${ssid}`;
                        warning = 'Moguć audio nadzorni uređaj (prisluškivač)';
                    }

                    const device = {
                        id: uuidv4(),
                        type: 'wifi',
                        category,
                        ssid,
                        bssid,
                        displayName,
                        deviceLabel,
                        signal,
                        dBm,
                        channel: chan,
                        freqBand,
                        security,
                        distanceMeters,
                        distance: distanceMeters < 100 ? `~${distanceMeters}m` : `~${(distanceMeters / 1000).toFixed(2)}km`,
                        suspicious,
                        warning,
                        timestamp: new Date().toISOString()
                    };

                    wifiList.push(device);
                    if (suspicious) {
                        log('WARN', `[WIFI] ⚠️ SUSPICIOUS: ${displayName} | ${bssid} | ${signal}% | ch${chan} ${freqBand} | ~${distanceMeters}m | ${warning}`);
                    } else {
                        log('INFO', `[WIFI] ${ssid || 'HIDDEN'} | ${bssid} | ${signal}% (${dBm}dBm) | ch${chan} ${freqBand} | ~${distanceMeters}m | ${security}`);
                    }
                });
            }

            log('INFO', `[WIFI] Scan done: ${wifiList.length} mreže, ${wifiList.filter(d => d.suspicious).length} sumnjive`);
            broadcast({ type: 'wifi_devices', devices: wifiList, timestamp: new Date().toISOString() });

            if (wifiScanActive) {
                wifiScanTimer = setTimeout(doScan, 30000); // Re-scan svakih 30s
            }
        });
    };

    doScan();
    return {
        stop() { stopWiFiScanner(); }
    };
}

function stopWiFiScanner() {
    wifiScanActive = false;
    activeScanners.wifi = false;
    if (wifiScanTimer) { clearTimeout(wifiScanTimer); wifiScanTimer = null; }
    broadcast({ type: 'scanner_status', scanner: 'wifi', active: false });
    log('INFO', '[WIFI] WiFi scanner stopped');
}

// Calculate distance between two lat/lon points using Haversine formula
function calculateDistance(lat1, lon1, lat2, lon2) {
    if (!lat1 || !lon1 || !lat2 || !lon2) return null;
    
    const R = 6371e3; // Earth radius in meters
    const φ1 = lat1 * Math.PI / 180;
    const φ2 = lat2 * Math.PI / 180;
    const Δφ = (lat2 - lat1) * Math.PI / 180;
    const Δλ = (lon2 - lon1) * Math.PI / 180;

    const a = Math.sin(Δφ/2) * Math.sin(Δφ/2) +
              Math.cos(φ1) * Math.cos(φ2) *
              Math.sin(Δλ/2) * Math.sin(Δλ/2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));

    const distanceMeters = R * c;
    
    // Return formatted string
    if (distanceMeters < 1000) {
        return `${Math.round(distanceMeters)}m`;
    } else {
        return `${(distanceMeters / 1000).toFixed(2)}km`;
    }
}

// Calculate bearing between two points
function calculateBearing(lat1, lon1, lat2, lon2) {
    if (!lat1 || !lon1 || !lat2 || !lon2) return null;
    
    const φ1 = lat1 * Math.PI / 180;
    const φ2 = lat2 * Math.PI / 180;
    const Δλ = (lon2 - lon1) * Math.PI / 180;
    
    const y = Math.sin(Δλ) * Math.cos(φ2);
    const x = Math.cos(φ1) * Math.sin(φ2) -
              Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
    const θ = Math.atan2(y, x);
    const bearing = (θ * 180 / Math.PI + 360) % 360;
    
    return bearing;
}

function estimateDistanceFromSignal(signalStrength, frequencyHz = 446e6) {
    if (signalStrength === null || signalStrength === undefined || signalStrength === 0) {
        return { distance: null, distanceMeters: null };
    }

    // rtl_power vraca negativne dBm vrijednosti (apsolutni nivo primit signala)
    // Jaci signal (manje negativan) = blizi uredaj
    // Primjeri iz prakse:
    //  -5 do -15 dBm  → jako blizu (<200m)
    //  -15 do -25 dBm → blizu (200m-800m)
    //  -25 do -35 dBm → srednje (800m-3km)
    //  -35 do -45 dBm → daleko (3-10km)
    //  -45 do -55 dBm → jako daleko (10-30km)
    //  < -55 dBm      → van dometa (30km+)

    let distanceMeters;
    const s = signalStrength;

    if (s >= -15) {
        distanceMeters = 150;    // <200m
    } else if (s >= -25) {
        distanceMeters = 500;    // 200-800m
    } else if (s >= -35) {
        distanceMeters = 1800;   // 800m-3km
    } else if (s >= -45) {
        distanceMeters = 6000;   // 3-10km
    } else if (s >= -55) {
        distanceMeters = 18000;  // 10-30km
    } else {
        distanceMeters = 40000;  // 30km+
    }

    const distanceKm = distanceMeters / 1000;
    let distanceStr;
    if (distanceMeters < 1000) {
        distanceStr = `~${Math.round(distanceMeters)}m`;
    } else {
        distanceStr = `~${(distanceKm).toFixed(1)}km`;
    }

    return {
        distance: distanceStr,
        distanceMeters: distanceMeters,
        note: 'Procjena udaljenosti na osnovu jačine signala (±50% greška)'
    };
}

function detectModulation(spectrum) {
    // Simple modulation detection based on spectrum shape
    const variance = calculateVariance(spectrum);
    if (variance < 2) return 'AM';
    if (variance < 10) return 'FM';
    return 'Digital';
}

function calculateVariance(arr) {
    const mean = arr.reduce((a, b) => a + b) / arr.length;
    return arr.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / arr.length;
}

function estimateBearingFromFrequency(frequencyHz, deviceId) {
    // Without directional antenna, bearing is unknown!
    // Add random variation per device so they don't all stack on same spot
    // Use deviceId for consistent randomness per device
    const freqBase = Math.abs(frequencyHz % 360);
    const idHash = deviceId ? deviceId.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0) : 0;
    const variation = (idHash % 90) - 45; // ±45 degrees variation
    return (freqBase + variation + 360) % 360;
}

function calculateEstimatedLocation(baseLatLon, distanceMeters, bearingDegrees) {
    // If no base location provided, return null
    if (!baseLatLon || !baseLatLon.lat || !baseLatLon.lon) return null;
    
    const R = 6371e3; // Earth radius in meters
    const lat1 = baseLatLon.lat * Math.PI / 180;
    const lon1 = baseLatLon.lon * Math.PI / 180;
    const bearing = bearingDegrees * Math.PI / 180;
    
    const lat2 = Math.asin(
        Math.sin(lat1) * Math.cos(distanceMeters / R) +
        Math.cos(lat1) * Math.sin(distanceMeters / R) * Math.cos(bearing)
    );
    
    const lon2 = lon1 + Math.atan2(
        Math.sin(bearing) * Math.sin(distanceMeters / R) * Math.cos(lat1),
        Math.cos(distanceMeters / R) - Math.sin(lat1) * Math.sin(lat2)
    );
    
    return {
        lat: lat2 * 180 / Math.PI,
        lon: lon2 * 180 / Math.PI,
        bearing: bearingDegrees
    };
}

function getDeviceTypeDescription(protocol, frequency) {
    // Detailed device type descriptions based on protocol/frequency
    const freq = frequency / 1e6; // Convert to MHz
    
    if (protocol.includes('PMR446')) {
        return {
            type: 'Walkie-Talkie / Portable Radio',
            description: 'Personal Mobile Radio (PMR446) - Common in handheld radios, security communications, event coordination, hiking radios',
            possibleDevices: ['Walkie-Talkie', 'Security Radio', 'Business Radio', 'Two-Way Radio', 'PMR Handset'],
            band: 'UHF 446 MHz',
            range: 'Up to 3-5 km (open terrain)'
        };
    }
    
    if (protocol.includes('LPD433')) {
        return {
            type: 'Low Power Device (LPD)',
            description: 'Short-range radio devices on 433 MHz band',
            possibleDevices: ['Baby Monitor', 'Wireless Doorbell', 'Toy Radio', 'Short-range Walkie-Talkie'],
            band: 'UHF 433 MHz',
            range: 'Up to 100-300m'
        };
    }
    
    if (freq >= 433 && freq <= 434) {
        return {
            type: 'ISM 433 MHz Device',
            description: 'Industrial, Scientific, Medical band - Common for IoT and remote controls',
            possibleDevices: ['Garage Door Opener', 'Car Key Fob', 'Weather Station', 'IoT Sensor', 'Wireless Thermometer', 'Remote Control'],
            band: 'ISM 433 MHz',
            range: 'Up to 50-500m'
        };
    }
    
    if (freq >= 868 && freq <= 870) {
        return {
            type: 'ISM 868 MHz Device',
            description: 'European ISM band for smart home and IoT',
            possibleDevices: ['Smart Home Sensor', 'LoRa Device', 'Zigbee Sensor', 'Alarm System', 'Utility Meter'],
            band: 'ISM 868 MHz',
            range: 'Up to 1-10 km (LoRa)'
        };
    }
    
    if (freq >= 2400 && freq <= 2500) {
        if (protocol.includes('DJI') || protocol.includes('OcuSync') || protocol.includes('Remote ID')) {
            return {
                type: '🚁 DJI Drone / Remote ID',
                description: 'DJI OcuSync/Lightbridge kontrolni link ili Remote ID broadcast — dron u letu',
                possibleDevices: ['DJI Mini 2/3/4', 'DJI Mavic 3', 'DJI Air 3', 'DJI Phantom', 'DJI FPV'],
                band: 'ISM 2.4 GHz',
                range: 'Do 10 km (OcuSync 3)'
            };
        }
        return {
            type: '🚁 Drone / RC / 2.4GHz ISM',
            description: 'Dron kontrolni link, WiFi, Bluetooth ili 2.4GHz ISM uređaj',
            possibleDevices: ['DJI dron', 'Parrot dron', 'Spektrum/FrSky RC', 'WiFi router', 'Bežična kamera', 'RC igračka'],
            band: 'ISM 2.4 GHz',
            range: 'Do 100m (WiFi), do 10km (RC dron)'
        };
    }
    
    if (freq >= 5700 && freq <= 5900) {
        return {
            type: '🎥 FPV Video Downlink 5.8GHz',
            description: 'Dron video transmisija 5.8GHz — FPV drone šalje live video sliku',
            possibleDevices: ['DJI FPV', 'DJI O3 video link', 'Eachine FPV', 'TBS Unify', 'ImmersionRC Tramp', 'FPV racing drone'],
            band: '5.8 GHz',
            range: 'Do 500m (FPV), do 10km (DJI O3)'
        };
    }
    
    if (freq >= 5150 && freq <= 5250) {
        return {
            type: '🚁 Parrot / Autel Drone 5GHz',
            description: '5GHz drone kontrolni link — Parrot ili Autel EVO serija',
            possibleDevices: ['Parrot Anafi', 'Parrot Bebop 2', 'Autel EVO II', 'DJI 5GHz backup channel'],
            band: '5 GHz',
            range: 'Do 2 km'
        };
    }
    
    if (freq >= 1180 && freq <= 1220) {
        return {
            type: '🎥 FPV Analogni Video 1.2GHz',
            description: 'Analogni FPV video link dugog dometa — wojni/profesionalni droni',
            possibleDevices: ['Long-range FPV drone', 'Vojni UAV', 'Profesionalni FPV', 'Analog 1.2GHz VTX'],
            band: '1.2 GHz',
            range: 'Do 5-20 km'
        };
    }
    
    // Default
    return {
        type: 'Unknown RF Device',
        description: `Signal detected on ${freq.toFixed(3)} MHz`,
        possibleDevices: ['Unknown'],
        band: `${freq.toFixed(3)} MHz`,
        range: 'Unknown'
    };
}

// REST API endpoints

// Individual scanner REST endpoints
app.post('/api/scan/start/adsb', (req, res) => {
    const scanId = startPartialScan(['adsb']);
    res.json({ scanId, type: 'adsb' });
});
app.post('/api/scan/start/iot', (req, res) => {
    const scanId = startPartialScan(['iot']);
    res.json({ scanId, type: 'iot' });
});
app.post('/api/scan/start/general', (req, res) => {
    const scanId = startPartialScan(['general']);
    res.json({ scanId, type: 'general' });
});
app.post('/api/scan/start/bluetooth', (req, res) => {
    const scanId = startPartialScan(['bluetooth']);
    res.json({ scanId, type: 'bluetooth' });
});

// Set base location (from browser geolocation)
app.post('/api/location/base', (req, res) => {
    const { lat, lon } = req.body;
    if (typeof lat === 'number' && typeof lon === 'number') {
        baseLocation = { lat, lon };
        log('INFO', `[GEO] Base location set: ${lat.toFixed(6)}, ${lon.toFixed(6)}`);
        
        // Recalculate estimated locations for all existing devices
        for (const [id, device] of devices.entries()) {
            if (device.distanceMeters && device.bearing != null) {
                const estimatedLocation = calculateEstimatedLocation(baseLocation, device.distanceMeters, device.bearing);
                device.estimatedLocation = estimatedLocation;
                devices.set(id, device);
            }
        }
        
        // Broadcast updated devices to all clients
        broadcast({ type: 'location_updated', baseLocation, devices: Array.from(devices.values()) });
        
        res.json({ success: true, baseLocation });
    } else {
        res.status(400).json({ error: 'Invalid lat/lon' });
    }
});

// Scan a single frequency: POST /api/scan/frequency {freq: 446006250, label: 'PMR446 ch1'}
app.post('/api/scan/frequency', (req, res) => {
    const { freq, label } = req.body;
    if (!freq) return res.status(400).json({ error: 'freq required' });
    const scanId = scanSingleFrequency(freq, label || `${(freq/1e6).toFixed(3)} MHz`);
    res.json({ scanId, freq, label });
});

// List available frequencies to scan
app.get('/api/frequencies', (req, res) => {
    res.json(GENERAL_FREQUENCIES);
});

// List active scans
app.get('/api/scans', (req, res) => {
    const list = [];
    activeScans.forEach((scanners, scanId) => {
        list.push({ scanId, scanners: Object.keys(scanners) });
    });
    res.json(list);
});

app.get('/api/devices', (req, res) => {
    res.json(Array.from(devices.values()));
});

app.get('/api/recordings', (req, res) => {
    const files = fs.readdirSync('recordings').map(file => ({
        filename: file,
        path: `/recordings/${file}`,
        size: fs.statSync(path.join('recordings', file)).size,
        created: fs.statSync(path.join('recordings', file)).birthtime
    }));
    res.json(files);
});

app.get('/recordings/:filename', (req, res) => {
    const filepath = path.join('recordings', req.params.filename);
    if (fs.existsSync(filepath)) {
        res.sendFile(path.resolve(filepath));
    } else {
        res.status(404).send('File not found');
    }
});

app.post('/api/scan/start', (req, res) => {
    const scanId = startFullScan(req.body);
    res.json({ scanId: scanId });
});

app.post('/api/scan/stop/:scanId', (req, res) => {
    stopScan(req.params.scanId);
    res.json({ success: true });
});

app.get('/api/device/:id', (req, res) => {
    const device = devices.get(req.params.id);
    if (device) {
        res.json(device);
    } else {
        res.status(404).json({ error: 'Device not found' });
    }
});

// Check RTL-SDR device
app.get('/api/rtl-test', (req, res) => {
    // If ADS-B scanner is active dump1090 already holds the device — return connected=true
    // without spawning rtl_test (which would cause usb_claim_interface error -6)
    if (activeScanners.adsb || activeScanners.drone || activeScanners.general) {
        return res.json({ output: 'Device in use by active scanner', connected: true });
    }
    const rtlTest = spawn('rtl_test', ['-t']);
    let output = '';

    rtlTest.stdout.on('data', (data) => { output += data.toString(); });
    rtlTest.stderr.on('data', (data) => { output += data.toString(); });

    rtlTest.on('close', () => {
        const connected = output.includes('Found');
        log('INFO', `[RTL-TEST] ${connected ? 'device found' : 'no device'}: ${output.split('\n')[0]}`);
        res.json({ output, connected });
    });

    setTimeout(() => { try { rtlTest.kill(); } catch {} }, 3000);
});

// Serve React app only in production
if (!IS_DEV) {
    app.get('*', (req, res) => {
        res.sendFile(path.join(__dirname, 'client/build', 'index.html'));
    });
}

const PORT = process.env.PORT || 3001;

// Bind na 0.0.0.0 — dostupno svim uređajima u LAN-u
// ─────────────────────────────────────────────────────────────────────────────
// Stale device cleanup — auto-removes devices that haven't sent a signal
// within a type-appropriate timeout.  Broadcasts 'device_removed' to all
// clients so the map can instantly remove the marker.
// ─────────────────────────────────────────────────────────────────────────────
const STALE_TIMEOUTS = {
    'aircraft/drone':  60000,  // ADS-B aircraft: 60s (dump1090 may gap between frames)
    'drone':           30000,  // RF drone signals
    'iot_device':      60000,  // IoT 433/868 MHz sensors
    'bluetooth':       30000,  // Bluetooth devices
    'wifi':            60000,  // WiFi access points
    'default':         60000,  // Everything else
};
setInterval(() => {
    const now = Date.now();
    for (const [id, device] of devices) {
        const lastSeen = device.lastSeen || new Date(device.timestamp).getTime();
        const timeout = STALE_TIMEOUTS[device.type] || STALE_TIMEOUTS.default;
        if (now - lastSeen > timeout) {
            devices.delete(id);
            log('INFO', `[Cleanup] Device stale — removed: ${device.icao || device.name || id} (type=${device.type}, lastSeen=${Math.round((now-lastSeen)/1000)}s ago)`);
            broadcast({ type: 'device_removed', deviceId: id, icao: device.icao });
        }
    }
}, 15000); // check every 15 seconds

server.listen(PORT, '0.0.0.0', () => {
    // Pronađi LAN IP adresu za prikaz
    const os = require('os');
    const nets = os.networkInterfaces();
    let lanIP = 'localhost';
    for (const name of Object.keys(nets)) {
        for (const net of nets[name]) {
            if (net.family === 'IPv4' && !net.internal) {
                lanIP = net.address;
                break;
            }
        }
        if (lanIP !== 'localhost') break;
    }

    log('INFO', `RTL-SDR Scanner API+WS running na svim interfejsima (0.0.0.0:${PORT})`);
    log('INFO', `═══════════════════════════════════════════════════`);
    log('INFO', `  📡 LAN pristup (svi uređaji u mreži):`);
    log('INFO', `     http://${lanIP}:${PORT}`);
    log('INFO', `  💻 Lokalni pristup:`);
    log('INFO', `     http://localhost:${PORT}`);
    log('INFO', `═══════════════════════════════════════════════════`);
    log('INFO', `  Otvori na telefonu/tabletu: http://${lanIP}:${PORT}`);
    log('INFO', `═══════════════════════════════════════════════════`);
    // NOTE: dump1090 NOT auto-started (requires proper 1090 MHz antenna)
});
