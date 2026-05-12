import React, { useEffect, useRef, useMemo } from 'react';
import { MapContainer, TileLayer, Marker, Popup, Polyline, Circle, useMap } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { Box, Typography, Chip } from '@mui/material';

// Fix default marker icons
delete L.Icon.Default.prototype._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/images/marker-icon-2x.png',
  iconUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/images/marker-icon.png',
  shadowUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/images/marker-shadow.png',
});

const RANGE_RINGS = [500, 1000, 2000, 3000, 5000, 10000, 15000];

function makeIcon(color, symbol, size) {
  size = size || 28;
  return L.divIcon({
    className: '',
    html: '<div style="width:' + size + 'px;height:' + size + 'px;background:' + color + ';border:2px solid rgba(255,255,255,0.8);border-radius:50%;display:flex;align-items:center;justify-content:center;color:#fff;font-size:' + Math.round(size * 0.5) + 'px;box-shadow:0 0 8px ' + color + ',0 0 16px ' + color + '44;position:relative;">' + symbol + '<div style="position:absolute;bottom:-18px;left:50%;transform:translateX(-50%);width:2px;height:16px;background:' + color + ';"></div></div>',
    iconSize: [size, size + 18],
    iconAnchor: [size / 2, size + 18],
    popupAnchor: [0, -(size + 18)],
  });
}

var ICONS = {
  aircraft:  makeIcon('#5b9cf6', '✈', 30),
  drone:     makeIcon('#ff9800', '⬡', 26),
  bluetooth: makeIcon('#e040fb', '⬡', 22),
  iot:       makeIcon('#26c6da', '⬡', 22),
  rf:        makeIcon('#66bb6a', '◉', 22),
  base: L.divIcon({
    className: '',
    html: '<div style="width:16px;height:16px;background:#00d4ff;border:3px solid #fff;border-radius:50%;box-shadow:0 0 12px #00d4ff,0 0 24px #00d4ff88;"></div>',
    iconSize: [16, 16],
    iconAnchor: [8, 8],
  }),
};

function getDeviceIcon(device) {
  if (device.type === 'aircraft/drone' && device.protocol === 'ADS-B') return ICONS.aircraft;
  if (device.category === 'drone' || device.droneGroup) return ICONS.drone;
  if (device.type === 'bluetooth') return ICONS.bluetooth;
  if (device.type === 'iot_device') return ICONS.iot;
  return ICONS.rf;
}

function getDeviceLat(device) {
  if (device.latitude != null) return device.latitude;
  if (device.estimatedLocation) return device.estimatedLocation.lat;
  return null;
}
function getDeviceLon(device) {
  if (device.longitude != null) return device.longitude;
  if (device.estimatedLocation) return device.estimatedLocation.lon;
  return null;
}

function MapController(props) {
  var map = useMap();
  var prevCenter = useRef(null);
  useEffect(function() {
    var center = props.center;
    if (center && (!prevCenter.current ||
      prevCenter.current[0] !== center[0] || prevCenter.current[1] !== center[1])) {
      map.setView(center, map.getZoom(), { animate: true });
      prevCenter.current = center;
    }
  }, [props.center, map]);
  return null;
}

var MAX_TRAIL = 40;

export default function RadarMap(props) {
  var devices = props.devices;
  var baseLocation = props.baseLocation;
  var scannerStatus = props.scannerStatus;

  var trailsRef = useRef({});

  var mappableDevices = useMemo(function() {
    return devices.filter(function(d) {
      return getDeviceLat(d) != null && getDeviceLon(d) != null;
    });
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
    <Box sx={{ position: 'relative', width: '100%', height: '100%', minHeight: 520 }}>
      <Box sx={{
        position: 'absolute', top: 8, left: 8, zIndex: 1000,
        display: 'flex', gap: 1, flexWrap: 'wrap', alignItems: 'center'
      }}>
        <Chip
          label={anyActive ? '● RADAR AKTIVAN' : '○ RADAR OFF'}
          size="small"
          sx={{
            background: anyActive ? 'rgba(0,180,0,0.85)' : 'rgba(60,60,60,0.85)',
            color: '#fff', fontWeight: 'bold', fontSize: '0.7rem',
            border: anyActive ? '1px solid #0f0' : '1px solid #555',
            boxShadow: anyActive ? '0 0 8px #0f0' : 'none',
          }}
        />
        <Chip
          label={activeCount + ' na mapi / ' + totalCount + ' ukupno'}
          size="small"
          sx={{ background: 'rgba(0,0,0,0.75)', color: '#00d4ff', fontSize: '0.7rem', border: '1px solid #00d4ff44' }}
        />
        {scannerStatus.adsb && (
          <Chip
            label={'✈ ' + devices.filter(function(d){ return d.protocol === 'ADS-B'; }).length + ' aviona'}
            size="small" sx={{ background: 'rgba(91,156,246,0.85)', color: '#fff', fontSize: '0.68rem' }} />
        )}
        {(scannerStatus.drone || scannerStatus.iot || scannerStatus.general) && (
          <Chip
            label={'⬡ ' + devices.filter(function(d){ return d.droneGroup || d.category === 'drone'; }).length + ' dronova'}
            size="small" sx={{ background: 'rgba(255,152,0,0.85)', color: '#fff', fontSize: '0.68rem' }} />
        )}
      </Box>

      {anyActive && (
        <Box sx={{
          position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
          zIndex: 500, pointerEvents: 'none', overflow: 'hidden',
        }}>
          <Box sx={{
            position: 'absolute', top: '50%', left: '50%',
            width: '200%', height: '200%',
            marginLeft: '-100%', marginTop: '-100%',
            background: 'conic-gradient(from 0deg, transparent 340deg, rgba(0,255,0,0.05) 355deg, rgba(0,255,0,0.15) 360deg)',
            animation: 'radarSweep 4s linear infinite',
          }} />
        </Box>
      )}

      <MapContainer
        center={center}
        zoom={12}
        style={{ width: '100%', height: '100%', minHeight: 520, background: '#0a1628' }}
        zoomControl={true}
        attributionControl={false}
      >
        <MapController center={center} />

        <TileLayer
          url="https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png"
          attribution="&copy; CARTO"
          maxZoom={19}
        />

        {baseLocation && (
          <Marker position={center} icon={ICONS.base}>
            <Popup>
              <div style={{ background: '#0a1628', color: '#00d4ff', padding: 8, borderRadius: 6, minWidth: 180 }}>
                <strong>📡 Base Station</strong><br />
                <span style={{ fontSize: '0.8em', color: '#aaa' }}>
                  {baseLocation.lat.toFixed(6)}, {baseLocation.lon.toFixed(6)}
                </span>
              </div>
            </Popup>
          </Marker>
        )}

        {baseLocation && RANGE_RINGS.map(function(r) {
          return (
            <Circle
              key={r}
              center={center}
              radius={r}
              pathOptions={{
                color: r >= 10000 ? '#00d4ff22' : '#00d4ff44',
                weight: 1,
                fill: false,
                dashArray: r >= 5000 ? '6 4' : undefined,
              }}
            />
          );
        })}

        {baseLocation && RANGE_RINGS.map(function(r) {
          var labelLat = center[0] + (r / 111320);
          return (
            <Marker
              key={'lbl-' + r}
              position={[labelLat, center[1]]}
              icon={L.divIcon({
                className: '',
                html: '<span style="color:#00d4ff88;font-size:10px;font-family:monospace;white-space:nowrap;text-shadow:0 0 4px #000">' + (r >= 1000 ? (r/1000) + 'km' : r + 'm') + '</span>',
                iconSize: [40, 14],
                iconAnchor: [20, 7],
              })}
            />
          );
        })}

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
                <Polyline
                  positions={trail}
                  pathOptions={{
                    color: isAircraft ? '#5b9cf6' : isDrone ? '#ff9800' : '#66bb6a',
                    weight: isAircraft ? 2 : 1.5,
                    opacity: 0.7,
                    dashArray: isDrone ? '4 4' : undefined,
                  }}
                />
              )}
              <Marker position={[lat, lon]} icon={getDeviceIcon(device)}>
                <Popup maxWidth={260}>
                  <div style={{
                    background: '#0d1b2a', color: '#ddd', padding: '10px 12px',
                    borderRadius: 8, minWidth: 220, fontSize: '0.82em',
                    border: '1px solid #00d4ff44'
                  }}>
                    <div style={{ color: '#00d4ff', fontWeight: 'bold', fontSize: '1em', marginBottom: 6 }}>
                      {isAircraft ? '✈ ' : isDrone ? '⬡ ' : '◉ '}
                      {device.icao || (device.callsign && device.callsign.trim()) || device.protocol || device.name || device.id.substring(0, 8)}
                    </div>
                    {device.callsign && device.callsign.trim() && (
                      <div><span style={{ color: '#888' }}>Callsign: </span><b>{device.callsign.trim()}</b></div>
                    )}
                    {device.bearing != null && (
                      <div><span style={{ color: '#888' }}>Smjer: </span>{Math.round(device.bearing)}°</div>
                    )}
                    {device.distance && (
                      <div><span style={{ color: '#888' }}>Udaljenost: </span><b style={{ color: '#4af' }}>{device.distance}</b></div>
                    )}
                    {device.altitude != null && (
                      <div><span style={{ color: '#888' }}>Visina: </span>{device.altitude.toLocaleString()} ft ({Math.round(device.altitude * 0.3048).toLocaleString()} m)</div>
                    )}
                    {device.speed != null && (
                      <div><span style={{ color: '#888' }}>Brzina: </span>{device.speed} kt</div>
                    )}
                    {device.track != null && (
                      <div><span style={{ color: '#888' }}>Track: </span>{device.track}°</div>
                    )}
                    {device.frequency && (
                      <div><span style={{ color: '#888' }}>Freq: </span>{(device.frequency / 1e6).toFixed(3)} MHz</div>
                    )}
                    {typeof device.signalStrength === 'number' && (
                      <div><span style={{ color: '#888' }}>Signal: </span>{device.signalStrength.toFixed(1)} dB</div>
                    )}
                    <div style={{ marginTop: 4, color: '#888', fontSize: '0.85em' }}>
                      GPS: {lat.toFixed(5)}, {lon.toFixed(5)}
                    </div>
                    {device.squawk && (
                      <div style={{ color: ['7500','7600','7700'].includes(device.squawk) ? '#f44' : '#aaa' }}>
                        Squawk: {device.squawk}
                        {device.squawk === '7700' ? ' ⚠️ EMERGENCY' : ''}
                        {device.squawk === '7500' ? ' ⚠️ HIJACK' : ''}
                      </div>
                    )}
                    <div style={{ marginTop: 6 }}>
                      <a href={'https://www.google.com/maps?q=' + lat + ',' + lon + '&z=14'}
                        target="_blank" rel="noopener noreferrer"
                        style={{ color: '#00d4ff', fontSize: '0.82em' }}>
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

      <Box sx={{
        position: 'absolute', bottom: 8, right: 8, zIndex: 1000,
        background: 'rgba(10,22,40,0.92)',
        border: '1px solid #00d4ff33',
        borderRadius: 2, p: 1,
        backdropFilter: 'blur(4px)',
      }}>
        <Typography sx={{ color: '#00d4ff', fontSize: '0.68rem', fontWeight: 'bold', mb: 0.5 }}>LEGENDA</Typography>
        {[
          { color: '#5b9cf6', label: '✈ Avion (ADS-B)' },
          { color: '#ff9800', label: '⬡ Dron / RC' },
          { color: '#e040fb', label: '⬡ Bluetooth' },
          { color: '#26c6da', label: '⬡ IoT uređaj' },
          { color: '#66bb6a', label: '◉ RF signal' },
          { color: '#00d4ff', label: '● Base station' },
        ].map(function(item) {
          return (
            <Box key={item.label} sx={{ display: 'flex', alignItems: 'center', gap: 0.5, mb: 0.2 }}>
              <Box sx={{ width: 10, height: 10, borderRadius: '50%', background: item.color, boxShadow: '0 0 4px ' + item.color, flexShrink: 0 }} />
              <Typography sx={{ color: '#ccc', fontSize: '0.68rem' }}>{item.label}</Typography>
            </Box>
          );
        })}
      </Box>

      <style>{`
        @keyframes radarSweep {
          from { transform: rotate(0deg); }
          to   { transform: rotate(360deg); }
        }
        .leaflet-container { background: #0a1628 !important; }
        .leaflet-popup-content-wrapper { background: #0d1b2a; border: 1px solid #00d4ff44; }
        .leaflet-popup-tip { background: #0d1b2a; }
      `}</style>
    </Box>
  );
}
