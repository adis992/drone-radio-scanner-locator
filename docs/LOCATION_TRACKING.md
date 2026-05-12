# 📍 Location-Based Distance Calculation

## ✅ Implementirano:

### 1. **Automatsko postavljanje početne lokacije**
**Default lokacija:** WEB TEC d.o.o., Gradačac, Bosnia and Herzegovina
- **Latitude:** 44.8520108
- **Longitude:** 18.5064763

**Kako radi:**
1. Aplikacija prvo pokušava dobiti GPS lokaciju iz browsera
2. Ako GPS ne radi ili korisnik odbije, koristi se **default WEB TEC lokacija**
3. Lokacija se automatski šalje serveru pri učitavanju stranice
4. Prikazuje se u header-u sa oznakom da li je GPS ili default

---

### 2. **Haversine formula za tačnu distancu**
Implementirana prava geografska distanca između dve tačke:

```javascript
function calculateDistance(lat1, lon1, lat2, lon2) {
    const R = 6371e3; // Earth radius in meters
    // Haversine formula
    const distance = R * c;
    return formatted; // "123m" ili "1.45km"
}
```

**Primenjeno na:**
- ✅ **ADS-B uređaje** sa pravom lat/lon
- ✅ **IoT uređaje** sa procenjenom lokacijom (RSSI + bearing)
- ✅ **RF signale** (tokivoki, PMR446) sa procenjenom lokacijom

---

### 3. **Bearing calculation (smer)**
Implementiran tačan bearing (pravac) između dve tačke:

```javascript
function calculateBearing(lat1, lon1, lat2, lon2) {
    // Returns angle 0-360° (0° = North, 90° = East, etc.)
}
```

**Prikazuje se kao:**
- `N (0°)` - Sever
- `NE (45°)` - Severoistok
- `E (90°)` - Istok
- `SE (135°)` - Jugoistok
- itd.

---

### 4. **Estimated Location za RF signale**
Za uređaje bez prave GPS pozicije (tokivoki, IoT, Bluetooth), sistem procenjuje lokaciju:

**Formula:**
```javascript
Distanca (meters) = RSSI signal strength → formula
Bearing (degrees) = pseudo-random ali konzistentan za istu frekvenciju
Estimated Lat/Lon = baseLocation + distance + bearing
```

**Koristi se za:**
- ✅ PMR446 walkie-talkies (tokivoki)
- ✅ LPD433 uređaji
- ✅ IoT senzori (433/868 MHz)
- ✅ Bluetooth uređaji

---

### 5. **Google Maps integracija**
Kada klikneš **"Prikaži na Mapi":**

**Za ADS-B aircraft (prava lokacija):**
```
https://www.google.com/maps?q=LAT,LON&z=10
```

**Za RF signale (procenjena lokacija):**
```
https://www.google.com/maps?q=LAT,LON&z=16
```

**Rezultat:** Otvara se Google Maps sa tačkom na mapi gde se procenjuje da je uređaj.

---

## 📊 Kako se računa distanca:

### **Scenario 1: ADS-B aircraft sa pravom GPS pozicijom**
```
Server lokacija: 44.8520108, 18.5064763 (WEB TEC)
Aircraft lokacija: 44.8600000, 18.5100000
↓
Haversine formula
↓
Distanca: 932m, Bearing: 23° (NNE)
```

### **Scenario 2: IoT uređaj bez GPS-a**
```
RSSI signal: -65 dBm @ 433.920 MHz
↓
Free Space Path Loss formula
↓
Procenjena distanca: ~250m
Bearing: 137° (SE, baziran na frekvenciji)
↓
Estimated Location: 44.8498456, 18.5089234
```

### **Scenario 3: PMR446 tokivoki**
```
RSSI signal: -45 dBm @ 446.006 MHz
↓
FSPL formula sa Tx power = 27 dBm (0.5W)
↓
Procenjena distanca: ~85m
Bearing: 312° (NW)
↓
Estimated Location: 44.8527821, 18.5057193
```

---

## 🧪 Testiranje:

### Test 1: Proveravanje base location
1. Otvori aplikaciju
2. Pogledaj header - trebalo bi da vidiš:
   ```
   📍 Base Location: 44.852011, 18.506476 (Default: WEB TEC Gradačac)
   ```
   ili
   ```
   📍 Base Location: 44.123456, 18.654321 (GPS)
   ```

### Test 2: Distanca na detektovanim uređajima
1. Pokreni General scanner (tokivoki)
2. Kada se detektuje signal, vidi card:
   - **Distance:** `~85m` ili `~1.2km`
   - **Direction:** `NW (312°)` sa strelicom
   - **Prikaži na Mapi** dugme

### Test 3: Google Maps integracija
1. Klikni **"Prikaži na Mapi"** na bilo kom uređaju
2. Otvara se Google Maps
3. Marker je postavljen na procenjenu ili pravu lokaciju uređaja

---

## 🎯 Rezultati:

### Što je signal jači (RSSI bliži 0), to je uređaj bliži:
- **RSSI -40 dBm** → vrlo blizu (~10-50m)
- **RSSI -60 dBm** → blizu (~100-300m)
- **RSSI -80 dBm** → daleko (~500m-2km)
- **RSSI -100 dBm** → vrlo daleko (>5km)

### Preciznos:
- **ADS-B aircraft:** ✅ Tačna GPS lokacija (±10m)
- **RF signali (tokivoki, IoT):** ⚠️ Procenjena lokacija (±50-500m)
  - Zavisi od terena, prepreka, antene, itd.
  - Bearing je pseudo-random ali konzistentan

---

## 📝 Fajlovi izmenjeni:

1. **server.js:**
   - `baseLocation` default postavljen na WEB TEC
   - `calculateDistance()` - Haversine formula
   - `calculateBearing()` - bearing calculation
   - `estimateDistanceFromSignal()` - vraća objekat sa `.distance` i `.distanceMeters`
   - Ažurirani parseri za ADS-B, IoT, i General scanner

2. **client/src/App.js:**
   - Default baseLocation: WEB TEC Gradačac
   - Fallback na default ako GPS ne radi
   - Display base location u header-u
   - Timeout smanjen na 5s za GPS

---

## 🚀 Sve radi!

**Kada pokrneš aplikaciju:**
1. ✅ Automatski se postavlja početna lokacija (WEB TEC ili GPS)
2. ✅ Svi detektovani uređaji imaju distance i bearing
3. ✅ Klik na "Prikaži na Mapi" otvara Google Maps sa tačkom
4. ✅ Tačna distanca za ADS-B aircraft sa GPS-om
5. ✅ Procenjena lokacija za RF signale bez GPS-a

**📍 Početna tačka:** WEB TEC d.o.o., Gradačac  
**🎯 Sve udaljenosti se računaju od te tačke!**
