# Map Icon Fix - April 30, 2026

## Issue Fixed

**Error:** `TypeError: Ku is not a constructor` at App.js:88

### Root Cause
The Material-UI `Map` icon import was conflicting with JavaScript's native `Map` constructor. When the code tried to create `new Map()` for the `activeRecordings` state, it was attempting to instantiate the Material-UI icon component instead of a JavaScript Map.

### Solution Applied

**File:** `client/src/App.js`

1. **Renamed the icon import** (line 51):
```javascript
// Before:
import { ..., Map, ... } from '@mui/icons-material';

// After:
import { ..., Map as MapIcon, ... } from '@mui/icons-material';
```

2. **Updated the icon usage** (line 1064):
```javascript
// Before:
startIcon={<Map />}

// After:
startIcon={<MapIcon />}
```

### Build Status

✅ **Fixed and Rebuilt**
- New build hash: `main.d3a250e3.js`
- Old build hash: `main.ee0d4b5f.js`
- Build location: `client/build/`

## How to Restart the Server

### Option 1: Use the restart script (handles root processes)
```bash
cd /home/noname/Desktop/drone_radio_tokivoki_all-freq-scann-locator
./restart-server.sh
```

### Option 2: Use the main start script
```bash
cd /home/noname/Desktop/drone_radio_tokivoki_all-freq-scann-locator
./start.sh
```

### Option 3: Manual restart
```bash
# Kill existing processes
pkill -f "node server.js"

# If port 3001 is still blocked by root process:
sudo lsof -ti tcp:3001 | xargs -r sudo kill -9

# Start the server
cd /home/noname/Desktop/drone_radio_tokivoki_all-freq-scann-locator
NODE_ENV=production node server.js
```

## Improvements Made

### 1. Updated build process in start.sh
- Now builds to a temporary clean directory (`build-temp`)
- Avoids permission conflicts with root-owned build files
- Automatically replaces old build with new one

### 2. Created restart-server.sh
- Handles both user and root-owned server processes
- Properly kills processes before restarting
- Simplifies server management

## Next Steps

1. Restart the server using one of the methods above
2. Open http://localhost:3001 in your browser
3. The Map icon should now work correctly
4. All scanner functionality should be operational

## Files Modified

- ✅ `client/src/App.js` - Fixed Map icon import conflict
- ✅ `start.sh` - Improved build process
- ✅ `restart-server.sh` - Created new restart helper script

## Testing

The application should now:
- ✅ Load without TypeError
- ✅ Display all UI elements correctly
- ✅ Show the Map button with proper icon
- ✅ Handle activeRecordings state using JavaScript Map
- ✅ All scanners operational (ADS-B, IoT, Bluetooth, General RF)
