import React, { useEffect, useRef, useMemo } from 'react';
import { MapContainer, TileLayer, Marker, Popup, Polyline, Circle, useMap } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { Box, Typography, Chip } from '@mui/material';

delete L.Icon.Default.prototype._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/images/marker-icon-2x.png',
  iconUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/images/marker-icon.png',
  shadowUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/images/marker-shadow.png',
});

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
      ';border:2px solid rgba(255,255,255,0.85);border-radius:50%;display:flex;align-items:center;justify-content:center;' +
      'color:#fff;font-size:' + Math.round(size * 0.52) + 'px;' +
      'box-shadow:0 0 10px ' + color + ',0 0 24px ' + color + '88;position:relative;">' +
      symbol +
      '<div style="position:absolute;bottom:-18px;left:50%;transform:translateX(-50%);width:2px;height:16px;background:' + color + ';opacity:0.7"></div>' +
      '</div>',
    iconSize: [size, size + 18],
    iconAnchor: [size / 2, size + 18],
    popupAnchor: [0, -(size + 18)],
  });
}

var ICONS = {
  aircraft:  makeIcon('#1565c0', '✈', 32),
  drone:     makeIcon('#e65100', '⬡', 26),
  bluetooth: makeIcon('#7b1fa2', '⬡', 22),
  iot:       makeIcon('#00838f', '⬡', 22),
  rf:        makeIcon('#2e7d32', '◉', 22),
  base: L.divIcon({
    className: '',
    html: '<div style="width:20px;height:20px;background:#0288d1;border:3px solid #fff;border-radius:50%;' +
      'box-shadow:0 0 0 3px rgba(2,136,209,0.4),0 0 16px #0288d1;"></div>',
    iconSize: [20, 20],
    iconAnchor: [10, 10],
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

var SWEEP_SPEED_DEG_PER_MS = 360 / 4000;

// ─────────────────────────────────────────────────────────────────────────────
//  RADAR SWEEP — canvas attached DIRECTLY to map container (not to a pane).
//  This is critical: Leaflet panes get CSS transform offsets applied during
//  pan/zoom, which would cause the sweep to drift from the base station marker.
//  By attaching to the container itself, latLngToContainerPoint() is always
//  correct and the sweep stays perfectly anchored on base location.
// ─────────────────────────────────────────────────────────────────────────────
function RadarSweepCanvas(props) {
  var active = props.active;
  var center = props.center; // [lat, lon]
  var map = useMap();
  var canvasRef = useRef(null);
  var rafRef = useRef(null);
  var angleRef = useRef(0);
  var lastTsRef = useRef(null);

  useEffect(function() {
    var container = map.getContainer();
    var canvas = document.createElement('canvas');
    // Must be absolute inside the map container, above tiles (z-index > tile pane)
    canvas.style.cssText = 'position:absolute;top:0;left:0;pointer-events:none;z-index:650;';
    
    function resize() {
      var size = map.getSize();
      canvas.width  = size.x;
      canvas.height = size.y;
    }
    resize();
    container.appendChild(canvas);
    canvasRef.current = canvas;

    map.on('resize', resize);
    return function() {
      map.off('resize', resize);
      if (canvas.parentNode) canvas.parentNode.removeChild(canvas);
      canvasRef.current = null;
    };
  }, [map]);

  useEffect(function() {
    if (!active) {
      var c = canvasRef.current;
      if (c) c.getContext('2d').clearRect(0, 0, c.width, c.height);
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      lastTsRef.current = null;
      return;
    }

    function draw(ts) {
      var canvas = canvasRef.current;
      if (!canvas || !canvas.width || !canvas.height) {
        rafRef.current = requestAnimationFrame(draw);
        return;
      }
      var ctx = canvas.getContext('2d');

      if (lastTsRef.current != null) {
        var dt = ts - lastTsRef.current;
        angleRef.current = (angleRef.current + SWEEP_SPEED_DEG_PER_MS * dt) % 360;
      }
      lastTsRef.current = ts;

      // latLngToContainerPoint is correct because canvas is in map container (not a pane)
      var basePx = map.latLngToContainerPoint(L.latLng(center[0], center[1]));

      // Max radius = farthest corner from base station
      var w = canvas.width, h = canvas.height;
      var maxR = Math.max(
        Math.hypot(basePx.x, basePx.y),
        Math.hypot(w - basePx.x, basePx.y),
        Math.hypot(basePx.x, h - basePx.y),
        Math.hypot(w - basePx.x, h - basePx.y)
      );

      ctx.clearRect(0, 0, w, h);

      var rad = (angleRef.current - 90) * Math.PI / 180; // 0° = North

      // Sweep glow cone
      var sweepArc = 25 * Math.PI / 180;
      var steps = 18;
      for (var i = steps; i >= 0; i--) {
        var frac = i / steps;
        var alpha = 0.20 * frac * frac;
        ctx.beginPath();
        ctx.moveTo(basePx.x, basePx.y);
        ctx.arc(basePx.x, basePx.y, maxR, rad - sweepArc * frac, rad, false);
        ctx.closePath();
        ctx.fillStyle = 'rgba(0,200,80,' + alpha.toFixed(3) + ')';
        ctx.fill();
      }

      // Leading edge bright line
      ctx.beginPath();
      ctx.moveTo(basePx.x, basePx.y);
      ctx.lineTo(basePx.x + Math.cos(rad) * maxR, basePx.y + Math.sin(rad) * maxR);
      ctx.strokeStyle = 'rgba(0,230,80,0.90)';
      ctx.lineWidth = 2;
      ctx.shadowColor = '#00e650';
      ctx.shadowBlur = 10;
      ctx.stroke();
      ctx.shadowBlur = 0;

      // Center dot
      ctx.beginPath();
      ctx.arc(basePx.x, basePx.y, 5, 0, Math.PI * 2);
      ctx.fillStyle = '#0288d1';
      ctx.shadowColor = '#0288d1';
      ctx.shadowBlur = 12;
      ctx.fill();
      ctx.shadowBlur = 0;

      rafRef.current = requestAnimationFrame(draw);
    }

    rafRef.current = requestAnimationFrame(draw);
    return function() { if (rafRef.current) cancelAnimationFrame(rafRef.current); };
  }, [active, center, map]);

  return null;
}

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
      var lat = getDeviceLat(d), lon = getDeviceLon(d);
      if (!trailsRef.current[key]) trailsRef.current[key] = [];
      var trail = trailsRef.current[key];
      var last = trail[trail.length - 1];
      if (!last || last[0] !== lat || last[1] !== lon) {
        trail.push([lat, lon]);
        if (trail.length > MAX_TRAIL) trail.shift();
      }
    });
    var activeKeys = new Set(mappableDevices.map(function(d) { return d.icao || d.id; }));
    Object.keys(trailsRef.current).forEach(function(k) { if (!activeKeys.has(k)) delete trailsRef.current[k]; });
  }, [mappableDevices]);

  var center = baseLocation ? [baseLocation.lat, baseLocation.lon] : [44.852, 18.506];
  var anyActive = Object.values(scannerStatus).some(Boolean);

  return (
    <Box sx={{ position: 'relative', width: '100%', height: '100%', minHeight: 560 }}>
      {/* Status bar */}
      <Box sx={{ position: 'absolute', top: 8, left: 8, zIndex: 1000, display: 'flex', gap: 0.8, flexWrap: 'wrap', alignItems: 'center' }}>
        <Chip label={anyActive ? '● RADAR AKTIVAN' : '○ RADAR OFF'} size="small"
          sx={{ background: anyActive ? 'rgba(27,94,32,0.92)' : 'rgba(60,60,60,0.88)', color: '#fff', fontWeight: 'bold',
            fontSize: '0.7rem', border: anyActive ? '1px solid #4caf50' : '1px solid #555',
            boxShadow: anyActive ? '0 0 8px #4caf5066' : 'none' }} />
        <Chip label={mappableDevices.length + ' na mapi / ' + devices.length + ' ukupno'} size="small"
          sx={{ background: 'rgba(255,255,255,0.85)', color: '#0d47a1', fontSize: '0.68rem', border: '1px solid #90caf9', fontWeight: 'bold' }} />
        {scannerStatus.adsb && (
          <Chip label={'✈ ' + devices.filter(function(d){return d.protocol==='ADS-B';}).length + ' aviona'} size="small"
            sx={{ background: 'rgba(21,101,192,0.9)', color: '#fff', fontSize: '0.68rem' }} />
        )}
        {(scannerStatus.drone||scannerStatus.iot||scannerStatus.general) && (
          <Chip label={'⬡ ' + devices.filter(function(d){return d.droneGroup||d.category==='drone';}).length + ' dronova'} size="small"
            sx={{ background: 'rgba(230,81,0,0.9)', color: '#fff', fontSize: '0.68rem' }} />
        )}
        <Chip label={'📡 Domet: 200km ADS-B / 50km RF'} size="small"
          sx={{ background: 'rgba(255,255,255,0.82)', color: '#555', fontSize: '0.62rem', border: '1px solid #ccc' }} />
      </Box>

      <MapContainer center={center} zoom={9}
        style={{ width: '100%', height: '100%', minHeight: 560 }}
        zoomControl={true} attributionControl={false}>
        <MapController center={center} />
        <RadarSweepCanvas active={anyActive} center={center} />

        {/* Voyager — lighter, good visibility for tracking */}
        <TileLayer
          url="https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png"
          attribution="&copy; CARTO"
          maxZoom={19}
        />

        {/* Base station */}
        {baseLocation && (
          <Marker position={center} icon={ICONS.base}>
            <Popup>
              <div style={{ padding: '8px 10px', minWidth: 190 }}>
                <strong style={{ color: '#0288d1' }}>📡 Base Station</strong><br />
                <span style={{ fontSize: '0.82em', color: '#555' }}>
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
                color: isLong ? '#0288d166' : '#0288d1aa',
                weight: isLong ? 0.8 : 1.2,
                fill: false,
                dashArray: ring.r >= 50000 ? '8 6' : ring.r >= 25000 ? '5 4' : undefined,
              }} />
          );
        })}

        {/* Range ring labels */}
        {baseLocation && RANGE_RINGS.map(function(ring) {
          return (
            <Marker key={'lbl-' + ring.r} position={[center[0] + ring.r / 111320, center[1]]}
              icon={L.divIcon({
                className: '',
                html: '<span style="color:#0277bd;font-size:10px;font-family:monospace;font-weight:bold;white-space:nowrap;text-shadow:0 1px 2px rgba(255,255,255,0.9)">' + ring.label + '</span>',
                iconSize: [44, 14], iconAnchor: [22, 7],
              })} />
          );
        })}

        {/* Device markers + trails */}
        {mappableDevices.map(function(device) {
          var lat = getDeviceLat(device), lon = getDeviceLon(device);
          var key = device.icao || device.id;
          var trail = trailsRef.current[key] || [];
          var isAircraft = device.type === 'aircraft/drone' && device.protocol === 'ADS-B';
          var isDrone = device.category === 'drone' || !!device.droneGroup;

          return (
            <React.Fragment key={key}>
              {trail.length > 1 && (
                <Polyline positions={trail}
                  pathOptions={{
                    color: isAircraft ? '#1565c0' : isDrone ? '#e65100' : '#2e7d32',
                    weight: isAircraft ? 2.5 : 2,
                    opacity: 0.8,
                    dashArray: isDrone ? '4 4' : undefined,
                  }} />
              )}
              <Marker position={[lat, lon]} icon={getDeviceIcon(device)}>
                <Popup maxWidth={280}>
                  <div style={{ padding: '8px 10px', minWidth: 230, fontSize: '0.84em' }}>
                    <div style={{ color: '#0288d1', fontWeight: 'bold', fontSize: '1em', marginBottom: 5 }}>
                      {isAircraft ? '✈ ' : isDrone ? '⬡ ' : '◉ '}
                      {device.icao || (device.callsign && device.callsign.trim()) || device.protocol || device.name || device.id.substring(0, 8)}
                      {device.callsign && device.callsign.trim() && device.icao
                        ? <span style={{ color: '#666', fontWeight: 'normal' }}> — {device.callsign.trim()}</span> : null}
                    </div>
                    {device.bearing    != null && <div><b style={{color:'#555'}}>Smjer:</b> {Math.round(device.bearing)}°</div>}
                    {device.distance           && <div><b style={{color:'#555'}}>Udaljenost:</b> <span style={{color:'#0288d1'}}>{device.distance}</span></div>}
                    {device.altitude   != null && <div><b style={{color:'#555'}}>Visina:</b> {device.altitude.toLocaleString()} ft ({Math.round(device.altitude * 0.3048).toLocaleString()} m)</div>}
                    {device.speed      != null && <div><b style={{color:'#555'}}>Brzina:</b> {device.speed} kt</div>}
                    {device.track      != null && <div><b style={{color:'#555'}}>Track:</b> {device.track}°</div>}
                    {device.frequency          && <div><b style={{color:'#555'}}>Freq:</b> {(device.frequency/1e6).toFixed(3)} MHz</div>}
                    {typeof device.signalStrength==='number' && <div><b style={{color:'#555'}}>Signal:</b> {device.signalStrength.toFixed(1)} dB</div>}
                    {device.squawk && (
                      <div style={{color:['7500','7600','7700'].includes(device.squawk)?'#d32f2f':'#333'}}>
                        <b>Squawk:</b> {device.squawk}
                        {device.squawk==='7700'?' ⚠️ EMERGENCY':device.squawk==='7500'?' ⚠️ HIJACK':''}
                      </div>
                    )}
                    <div style={{marginTop:4,color:'#888',fontSize:'0.82em'}}>GPS: {lat.toFixed(5)}, {lon.toFixed(5)}</div>
                    <div style={{marginTop:6}}>
                      <a href={'https://www.google.com/maps?q='+lat+','+lon+'&z=13'}
                        target="_blank" rel="noopener noreferrer" style={{color:'#0288d1',fontSize:'0.82em'}}>
                        Otvori Google Maps →
                      </a>
                    </div>
                  </div>
                </Popup>
              </Marker>
            </React.Fragment>
          );
        })}
      </MapContainer>

      {/* Legend */}
      <Box sx={{ position: 'absolute', bottom: 8, right: 8, zIndex: 1000,
        background: 'rgba(255,255,255,0.93)', border: '1px solid #cce0f5',
        borderRadius: 2, p: 1, boxShadow: '0 2px 8px rgba(0,0,0,0.15)' }}>
        <Typography sx={{ color: '#0288d1', fontSize: '0.68rem', fontWeight: 'bold', mb: 0.5 }}>LEGENDA</Typography>
        {[
          { color: '#1565c0', label: '✈ Avion (ADS-B) do 200km' },
          { color: '#e65100', label: '⬡ Dron / RC do 50km' },
          { color: '#7b1fa2', label: '⬡ Bluetooth <500m' },
          { color: '#00838f', label: '⬡ IoT uređaj do 20km' },
          { color: '#2e7d32', label: '◉ RF / walkie-talkie' },
          { color: '#0288d1', label: '● Lokacija antene (Base)' },
        ].map(function(item) {
          return (
            <Box key={item.label} sx={{ display: 'flex', alignItems: 'center', gap: 0.5, mb: 0.2 }}>
              <Box sx={{ width: 10, height: 10, borderRadius: '50%', background: item.color, flexShrink: 0 }} />
              <Typography sx={{ color: '#444', fontSize: '0.66rem' }}>{item.label}</Typography>
            </Box>
          );
        })}
        <Typography sx={{ color: '#888', fontSize: '0.62rem', mt: 0.5, borderTop: '1px solid #e0e0e0', pt: 0.5 }}>
          ⬤ Zelena linija = radar sweep (4s/okret)
        </Typography>
      </Box>

      <style>{`
        .leaflet-container { background: #e8edf2 !important; }
        .leaflet-popup-content-wrapper { border-radius: 8px !important; box-shadow: 0 4px 16px rgba(0,0,0,0.15) !important; }
        .leaflet-popup-content { margin: 0 !important; }
      `}</style>
    </Box>
  );
}
