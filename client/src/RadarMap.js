import React, { useEffect, useRef, useMemo } from 'react';
import { MapContainer, TileLayer, Marker, Popup, Polyline, Circle, useMap } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { Box, Typography, Chip } from '@mui/material';

// Fix leaflet default icons
delete L.Icon.Default.prototype._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/images/marker-icon-2x.png',
  iconUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/images/marker-icon.png',
  shadowUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/images/marker-shadow.png',
});

// RTL-SDR realistic range rings:
// ADS-B (1090 MHz): 100-250km with ground-plane antenna
// IoT/drone (433/868 MHz): 10-50km
// Bluetooth/WiFi: <1km
const RANGE_RINGS = [
  { r: 5000,   label: '5km'   },
  { r: 10000,  label: '10km'  },
  { r: 25000,  label: '25km'  },
  { r: 50000,  label: '50km'  },
  { r: 100000, label: '100km' },
  { r: 150000, label: '150km' },
  { r: 200000, label: '200km' },
];

function makeIcon(color, symbol, size) {
  size = size || 28;
  return L.divIcon({
    className: '',
    html: '<div style="width:' + size + 'px;height:' + size + 'px;background:' + color +
      ';border:2px solid rgba(255,255,255,0.8);border-radius:50%;display:flex;align-items:center;justify-content:center;' +
      'color:#fff;font-size:' + Math.round(size * 0.52) + 'px;' +
      'box-shadow:0 0 8px ' + color + ',0 0 20px ' + color + '55;position:relative;">' +
      symbol +
      '<div style="position:absolute;bottom:-18px;left:50%;transform:translateX(-50%);width:2px;height:16px;background:' + color + ';"></div>' +
      '</div>',
    iconSize: [size, size + 18],
    iconAnchor: [size / 2, size + 18],
    popupAnchor: [0, -(size + 18)],
  });
}

var ICONS = {
  aircraft:  makeIcon('#5b9cf6', '✈', 32),
  drone:     makeIcon('#ff9800', '⬡', 26),
  bluetooth: makeIcon('#e040fb', '⬡', 22),
  iot:       makeIcon('#26c6da', '⬡', 22),
  rf:        makeIcon('#66bb6a', '◉', 22),
  base: L.divIcon({
    className: '',
    html: '<div style="width:18px;height:18px;background:#00d4ff;border:3px solid #fff;border-radius:50%;' +
      'box-shadow:0 0 14px #00d4ff,0 0 28px #00d4ffaa;"></div>',
    iconSize: [18, 18],
    iconAnchor: [9, 9],
  }),
};

function getDeviceIcon(device) {
  if (device.type === 'aircraft/drone' && device.protocol === 'ADS-B') return ICONS.aircraft;
  if (device.category === 'drone' || device.droneGroup) return ICONS.drone;
  if (device.type === 'bluetooth') return ICONS.bluetooth;
  if (device.type === 'iot_device') return ICONS.iot;
  return ICONS.rf;
}
function getDeviceLat(d) { return d.latitude != null ? d.latitude : (d.estimatedLocation ? d.estimatedLocation.lat : null); }
function getDeviceLon(d) { return d.longitude != null ? d.longitude : (d.estimatedLocation ? d.estimatedLocation.lon : null); }

// ─────────────────────────────────────────────────────────────────────────────
//  SVG RADAR SWEEP — a Leaflet custom pane overlay
//  Draws a rotating sweep line + glow on a canvas element
//  that is positioned and sized to always match the map viewport.
// ─────────────────────────────────────────────────────────────────────────────
var SWEEP_SPEED_DEG_PER_MS = 360 / 4000; // full rotation in 4 seconds

function RadarSweepCanvas(props) {
  var active = props.active;
  var center = props.center; // [lat, lon]
  var map = useMap();
  var canvasRef = useRef(null);
  var rafRef = useRef(null);
  var angleRef = useRef(0);
  var lastTsRef = useRef(null);

  // Create / attach canvas to a Leaflet pane
  useEffect(function() {
    var pane = map.getPane('radarSweepPane');
    if (!pane) {
      map.createPane('radarSweepPane');
      pane = map.getPane('radarSweepPane');
      pane.style.zIndex = 450;
      pane.style.pointerEvents = 'none';
    }
    var canvas = document.createElement('canvas');
    canvas.style.position = 'absolute';
    canvas.style.top = '0';
    canvas.style.left = '0';
    canvas.style.pointerEvents = 'none';
    pane.appendChild(canvas);
    canvasRef.current = canvas;

    function resize() {
      var size = map.getSize();
      canvas.width  = size.x;
      canvas.height = size.y;
    }
    resize();
    map.on('resize move zoom', resize);

    return function() {
      map.off('resize move zoom', resize);
      if (canvas.parentNode) canvas.parentNode.removeChild(canvas);
      canvasRef.current = null;
    };
  }, [map]);

  // Animation loop
  useEffect(function() {
    if (!active) {
      // Clear canvas when not active
      var canvas = canvasRef.current;
      if (canvas) {
        var ctx = canvas.getContext('2d');
        ctx.clearRect(0, 0, canvas.width, canvas.height);
      }
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      lastTsRef.current = null;
      return;
    }

    function draw(ts) {
      if (!canvasRef.current) return;
      var canvas = canvasRef.current;
      var ctx = canvas.getContext('2d');
      if (canvas.width === 0 || canvas.height === 0) {
        rafRef.current = requestAnimationFrame(draw);
        return;
      }

      // Advance angle
      if (lastTsRef.current != null) {
        var dt = ts - lastTsRef.current;
        angleRef.current = (angleRef.current + SWEEP_SPEED_DEG_PER_MS * dt) % 360;
      }
      lastTsRef.current = ts;

      // Convert base station lat/lon to pixel coords
      var baseLatLng = L.latLng(center[0], center[1]);
      var basePx = map.latLngToContainerPoint(baseLatLng);

      // Radius = distance from center to corner (so sweep covers whole viewport)
      var maxR = Math.sqrt(basePx.x * basePx.x + basePx.y * basePx.y);
      maxR = Math.max(maxR, Math.sqrt((canvas.width - basePx.x) ** 2 + (canvas.height - basePx.y) ** 2));
      maxR = Math.max(maxR, Math.sqrt((canvas.width - basePx.x) ** 2 + basePx.y ** 2));
      maxR = Math.max(maxR, Math.sqrt(basePx.x ** 2 + (canvas.height - basePx.y) ** 2));

      ctx.clearRect(0, 0, canvas.width, canvas.height);

      var rad = (angleRef.current - 90) * Math.PI / 180; // 0° = North

      // ── Sweep glow cone (conic gradient via multiple arcs)
      var sweepArc = 25 * Math.PI / 180; // 25° wide glow
      var steps = 18;
      for (var i = steps; i >= 0; i--) {
        var frac = i / steps;
        var alpha = 0.18 * frac * frac;
        var arcStart = rad - sweepArc * frac;
        var arcEnd   = rad;
        ctx.beginPath();
        ctx.moveTo(basePx.x, basePx.y);
        ctx.arc(basePx.x, basePx.y, maxR, arcStart, arcEnd, false);
        ctx.closePath();
        ctx.fillStyle = 'rgba(0,255,80,' + alpha.toFixed(3) + ')';
        ctx.fill();
      }

      // ── Leading edge bright line
      ctx.beginPath();
      ctx.moveTo(basePx.x, basePx.y);
      ctx.lineTo(
        basePx.x + Math.cos(rad) * maxR,
        basePx.y + Math.sin(rad) * maxR
      );
      ctx.strokeStyle = 'rgba(0,255,80,0.85)';
      ctx.lineWidth = 2;
      ctx.shadowColor = '#00ff50';
      ctx.shadowBlur = 10;
      ctx.stroke();
      ctx.shadowBlur = 0;

      // ── Center pulse dot
      ctx.beginPath();
      ctx.arc(basePx.x, basePx.y, 5, 0, Math.PI * 2);
      ctx.fillStyle = '#00d4ff';
      ctx.shadowColor = '#00d4ff';
      ctx.shadowBlur = 12;
      ctx.fill();
      ctx.shadowBlur = 0;

      rafRef.current = requestAnimationFrame(draw);
    }

    rafRef.current = requestAnimationFrame(draw);
    return function() {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [active, center, map]);

  return null;
}

// Auto-center map on base location change
function MapController(props) {
  var map = useMap();
  var prev = useRef(null);
  useEffect(function() {
    var c = props.center;
    if (c && (!prev.current || prev.current[0] !== c[0] || prev.current[1] !== c[1])) {
      map.setView(c, map.getZoom(), { animate: true });
      prev.current = c;
    }
  }, [props.center, map]);
  return null;
}

var MAX_TRAIL = 50;

export default function RadarMap(props) {
  var devices = props.devices;
  var baseLocation = props.baseLocation;
  var scannerStatus = props.scannerStatus;

  var trailsRef = useRef({});

  var mappableDevices = useMemo(function() {
    return devices.filter(function(d) { return getDeviceLat(d) != null && getDeviceLon(d) != null; });
  }, [devices]);

  useEffect(function() {
    mappableDevices.forEach(function(d) {
      var key = d.icao || d.id;
      var lat = getDeviceLat(d);
      var lon = getDeviceLon(d);
      if (!trailsRef.current[key]) trailsRef.current[key] = [];
      var trail = trailsRef.current[key];
      var last = trail[trail.length - 1];
      if (!last || last[0] !== lat || last[1] !== lon) {
        trail.push([lat, lon]);
        if (trail.length > MAX_TRAIL) trail.shift();
      }
    });
    var activeKeys = new Set(mappableDevices.map(function(d) { return d.icao || d.id; }));
    Object.keys(trailsRef.current).forEach(function(k) {
      if (!activeKeys.has(k)) delete trailsRef.current[k];
    });
  }, [mappableDevices]);

  var center = baseLocation ? [baseLocation.lat, baseLocation.lon] : [44.852, 18.506];
  var anyActive = Object.values(scannerStatus).some(Boolean);
  var activeCount = mappableDevices.length;
  var totalCount = devices.length;

  return (
    <Box sx={{ position: 'relative', width: '100%', height: '100%', minHeight: 560 }}>
      {/* Status bar */}
      <Box sx={{
        position: 'absolute', top: 8, left: 8, zIndex: 1000,
        display: 'flex', gap: 0.8, flexWrap: 'wrap', alignItems: 'center'
      }}>
        <Chip
          label={anyActive ? '● RADAR AKTIVAN' : '○ RADAR OFF'}
          size="small"
          sx={{
            background: anyActive ? 'rgba(0,180,0,0.88)' : 'rgba(60,60,60,0.88)',
            color: '#fff', fontWeight: 'bold', fontSize: '0.7rem',
            border: anyActive ? '1px solid #0f0' : '1px solid #555',
            boxShadow: anyActive ? '0 0 8px #0f066' : 'none',
          }}
        />
        <Chip label={activeCount + ' na mapi / ' + totalCount + ' ukupno'}
          size="small" sx={{ background: 'rgba(0,0,0,0.8)', color: '#00d4ff', fontSize: '0.68rem', border: '1px solid #00d4ff33' }} />
        {scannerStatus.adsb && (
          <Chip label={'✈ ' + devices.filter(function(d) { return d.protocol === 'ADS-B'; }).length + ' aviona'}
            size="small" sx={{ background: 'rgba(91,156,246,0.85)', color: '#fff', fontSize: '0.68rem' }} />
        )}
        {(scannerStatus.drone || scannerStatus.iot || scannerStatus.general) && (
          <Chip label={'⬡ ' + devices.filter(function(d) { return d.droneGroup || d.category === 'drone'; }).length + ' dronova'}
            size="small" sx={{ background: 'rgba(255,152,0,0.85)', color: '#fff', fontSize: '0.68rem' }} />
        )}
        <Chip label={'📡 Domet: 200km (ADS-B) / 50km (RF)'}
          size="small" sx={{ background: 'rgba(0,0,0,0.75)', color: '#aaa', fontSize: '0.62rem', border: '1px solid #333' }} />
      </Box>

      <MapContainer
        center={center}
        zoom={9}
        style={{ width: '100%', height: '100%', minHeight: 560, background: '#0a1628' }}
        zoomControl={true}
        attributionControl={false}
      >
        <MapController center={center} />
        <RadarSweepCanvas active={anyActive} center={center} />

        <TileLayer
          url="https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png"
          attribution="&copy; CARTO"
          maxZoom={19}
        />

        {/* Base station */}
        {baseLocation && (
          <Marker position={center} icon={ICONS.base}>
            <Popup>
              <div style={{ background: '#0a1628', color: '#00d4ff', padding: 8, borderRadius: 6, minWidth: 180 }}>
                <strong>📡 Base Station</strong><br />
                <span style={{ fontSize: '0.8em', color: '#aaa' }}>
                  {baseLocation.lat.toFixed(6)}, {baseLocation.lon.toFixed(6)}<br />
                  RTL-SDR domet: ~200km ADS-B / ~50km RF
                </span>
              </div>
            </Popup>
          </Marker>
        )}

        {/* Range rings */}
        {baseLocation && RANGE_RINGS.map(function(ring) {
          var isLong = ring.r >= 100000;
          return (
            <Circle key={ring.r} center={center} radius={ring.r}
              pathOptions={{
                color: isLong ? '#00d4ff1a' : '#00d4ff33',
                weight: isLong ? 0.8 : 1,
                fill: false,
                dashArray: ring.r >= 50000 ? '8 6' : ring.r >= 25000 ? '5 4' : undefined,
              }}
            />
          );
        })}

        {/* Range ring labels */}
        {baseLocation && RANGE_RINGS.map(function(ring) {
          var labelLat = center[0] + (ring.r / 111320);
          return (
            <Marker key={'lbl-' + ring.r} position={[labelLat, center[1]]}
              icon={L.divIcon({
                className: '',
                html: '<span style="color:#00d4ff77;font-size:10px;font-family:monospace;white-space:nowrap;text-shadow:0 0 4px #000">' + ring.label + '</span>',
                iconSize: [44, 14], iconAnchor: [22, 7],
              })}
            />
          );
        })}

        {/* Device markers + trails */}
        {mappableDevices.map(function(device) {
          var lat = getDeviceLat(device);
          var lon = getDeviceLon(device);
          var key = device.icao || device.id;
          var trail = trailsRef.current[key] || [];
          var isAircraft = device.type === 'aircraft/drone' && device.protocol === 'ADS-B';
          var isDrone = device.category === 'drone' || !!device.droneGroup;

          return (
            <React.Fragment key={key}>
              {trail.length > 1 && (
                <Polyline positions={trail}
                  pathOptions={{
                    color: isAircraft ? '#5b9cf6' : isDrone ? '#ff9800' : '#66bb6a',
                    weight: isAircraft ? 2 : 1.5,
                    opacity: 0.75,
                    dashArray: isDrone ? '4 4' : undefined,
                  }}
                />
              )}
              <Marker position={[lat, lon]} icon={getDeviceIcon(device)}>
                <Popup maxWidth={270}>
                  <div style={{
                    background: '#0d1b2a', color: '#ddd', padding: '10px 12px',
                    borderRadius: 8, minWidth: 230, fontSize: '0.82em',
                    border: '1px solid #00d4ff33'
                  }}>
                    <div style={{ color: '#00d4ff', fontWeight: 'bold', fontSize: '1em', marginBottom: 6 }}>
                      {isAircraft ? '✈ ' : isDrone ? '⬡ ' : '◉ '}
                      {device.icao || (device.callsign && device.callsign.trim()) || device.protocol || device.name || device.id.substring(0, 8)}
                      {device.callsign && device.callsign.trim() && device.icao
                        ? <span style={{ color: '#aaa', fontWeight: 'normal' }}> — {device.callsign.trim()}</span>
                        : null}
                    </div>
                    {device.bearing != null && <div><span style={{ color: '#888' }}>Smjer: </span>{Math.round(device.bearing)}°</div>}
                    {device.distance    && <div><span style={{ color: '#888' }}>Udaljenost: </span><b style={{ color: '#4af' }}>{device.distance}</b></div>}
                    {device.altitude != null && <div><span style={{ color: '#888' }}>Visina: </span>{device.altitude.toLocaleString()} ft ({Math.round(device.altitude * 0.3048).toLocaleString()} m)</div>}
                    {device.speed    != null && <div><span style={{ color: '#888' }}>Brzina: </span>{device.speed} kt</div>}
                    {device.track    != null && <div><span style={{ color: '#888' }}>Track: </span>{device.track}°</div>}
                    {device.frequency   && <div><span style={{ color: '#888' }}>Freq: </span>{(device.frequency / 1e6).toFixed(3)} MHz</div>}
                    {typeof device.signalStrength === 'number' && <div><span style={{ color: '#888' }}>Signal: </span>{device.signalStrength.toFixed(1)} dB</div>}
                    {device.squawk && (
                      <div style={{ color: ['7500','7600','7700'].includes(device.squawk) ? '#f44' : '#aaa' }}>
                        Squawk: {device.squawk}
                        {device.squawk === '7700' ? ' ⚠️ EMERGENCY' : device.squawk === '7500' ? ' ⚠️ HIJACK' : ''}
                      </div>
                    )}
                    <div style={{ marginTop: 4, color: '#888', fontSize: '0.82em' }}>GPS: {lat.toFixed(5)}, {lon.toFixed(5)}</div>
                    <div style={{ marginTop: 6 }}>
                      <a href={'https://www.google.com/maps?q=' + lat + ',' + lon + '&z=13'}
                        target="_blank" rel="noopener noreferrer"
                        style={{ color: '#00d4ff', fontSize: '0.82em' }}>Otvori Google Maps →</a>
                    </div>
                  </div>
                </Popup>
              </Marker>
            </React.Fragment>
          );
        })}
      </MapContainer>

      {/* Legend */}
      <Box sx={{
        position: 'absolute', bottom: 8, right: 8, zIndex: 1000,
        background: 'rgba(10,22,40,0.93)',
        border: '1px solid #00d4ff22',
        borderRadius: 2, p: 1,
      }}>
        <Typography sx={{ color: '#00d4ff', fontSize: '0.68rem', fontWeight: 'bold', mb: 0.5 }}>LEGENDA</Typography>
        {[
          { color: '#5b9cf6', label: '✈ Avion (ADS-B) do 200km' },
          { color: '#ff9800', label: '⬡ Dron / RC do 50km' },
          { color: '#e040fb', label: '⬡ Bluetooth <500m' },
          { color: '#26c6da', label: '⬡ IoT uređaj do 20km' },
          { color: '#66bb6a', label: '◉ RF / walkie-talkie' },
          { color: '#00d4ff', label: '● Lokacija antene' },
        ].map(function(item) {
          return (
            <Box key={item.label} sx={{ display: 'flex', alignItems: 'center', gap: 0.5, mb: 0.2 }}>
              <Box sx={{ width: 10, height: 10, borderRadius: '50%', background: item.color, boxShadow: '0 0 4px ' + item.color, flexShrink: 0 }} />
              <Typography sx={{ color: '#ccc', fontSize: '0.66rem' }}>{item.label}</Typography>
            </Box>
          );
        })}
        <Typography sx={{ color: '#555', fontSize: '0.62rem', mt: 0.5, borderTop: '1px solid #1a2a3a', pt: 0.5 }}>
          ⬤ Zelena linija = radar sweep (4s/okret)
        </Typography>
      </Box>

      <style>{`
        .leaflet-container { background: #0a1628 !important; }
        .leaflet-popup-content-wrapper { background: #0d1b2a !important; border: 1px solid #00d4ff33 !important; color: #ddd !important; }
        .leaflet-popup-tip { background: #0d1b2a !important; }
        .leaflet-popup-content { margin: 0 !important; }
      `}</style>
    </Box>
  );
}
