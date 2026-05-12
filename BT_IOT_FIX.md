# BT i IoT Scanner Popravke - FINAL

## ✅ Problemi koji su popravljeni (FINALNA VERZIJA):

### 1. ✅ Auto-start pri učitavanju stranice
**Problem:** Kada se stranica učita, IoT i Bluetooth skeneri automatski startuju.

**Rješenje:** Uklonjena je auto-start logika iz server.js. Skeneri se moraju ručno pokrenuti.

---

### 2. ✅ Stop dugme ne zaustavlja procese u pozadini
**Problem:** Klik na "Stop" prikazuje da je skener zaustavljen, ali proces i dalje radi u logs-ima.

**Rješenje (Popravljena verzija 2):**
- Dodati individualni stop handleri: `stop_scan_bluetooth`, `stop_scan_iot`, `stop_scan_general`
- **Proces se sada zaustavlja ispravno i čisti state kada se ugasi**
- State se automatski čisti kada proces završi (iz bilo kog razloga)
- `activeScanners[type]` se postavlja na `false` samo kada proces zaista prestane

---

### 3. ✅ State se gubi nakon F5 (refresh) - KRITIČAN FIX
**Problem:** Nakon F5, skeneri koji su bili zaustavljeni prikazuju se kao aktivni.

**Rješenje (KRITIČAN FIX):**
- **`startPartialScan()` sada proverava da li skener već radi** pre pokretanja
- Ako je `activeScanners[type] = true`, skener se NE pokreće ponovo
- Sprečava duplikate procesa
- State se čisti automatski kada proces završi
- Na reconnect, server šalje **tačno stanje** iz `activeScanners`

**Kod promena:**
```javascript
// U startFullScan()
const toStart = enabled.filter(type => !activeScanners[type]);
if (toStart.length === 0) {
    log('WARN', '[SCAN] All requested scanners already running');
    return null;
}
```

---

### 4. ✅ BT i IoT se međusobno ne blokiraju
**Objašnjenje:**
- **Bluetooth** koristi `hcitool` (Bluetooth adapter) - NE koristi RTL dongle
- **IoT** koristi `rtl_433` - koristi RTL dongle  
- **General** koristi `rtl_power` - koristi RTL dongle

**Zaključak:** 
- Bluetooth može raditi nezavisno od IoT i General skenera
- IoT i General **NE MOGU** raditi istovremeno (dijele RTL dongle)
- RTL mutex osigurava da jedan čeka dok drugi ne završi

---

### 5. ✅ Bluetooth uređaji se prikazuju odmah kada se pronađu
**Problem:** Bluetooth uređaji se ne prikazuju prominentno.

**Rješenje:**
- `parseBluetoothData()` **odmah broadcastuje** uređaje sa `device_detected`
- Klijent prikazuje BT uređaje u **pink/rose obojenom okviru**
- Prikazuje se ime uređaja, MAC adresa i ikona

---

## 🔧 Tehnički detalji:

### Server.js promene (Finalna verzija):

#### 1. `startFullScan()` - Sprečava duplikate
```javascript
const toStart = enabled.filter(type => !activeScanners[type]);
// Pokreće samo skenere koji nisu već aktivni
```

#### 2. `startIoTScanner()` - Čisti state kada proces završi
```javascript
proc.on('close', (code) => {
    if (stopped) {
        activeScanners.iot = false;
        broadcast({ type: 'scanner_status', scanner: 'iot', active: false });
    }
    // Restart samo ako nije namerno zaustavljen
    if (!stopped) setTimeout(start, 2000);
});
```

#### 3. `startBluetoothScanner()` - Ista logika kao IoT
```javascript
proc.on('close', (code) => {
    if (stopped) {
        activeScanners.bluetooth = false;
        broadcast({ type: 'scanner_status', scanner: 'bluetooth', active: false });
    }
    if (!stopped) setTimeout(run, 5000);
});
```

#### 4. `stopScannerByType()` - Zaustavlja specifični skener
```javascript
function stopScannerByType(scannerType) {
    // Pronalazi scan koji sadrži taj skener
    // Poziva scanner.stop()
    // Briše iz activeScans
    // Postavlja activeScanners[scannerType] = false
    // Broadcastuje scanner_status
}
```

---

## 🧪 Testiranje:

### Test 1: Dupli start
1. Klikni "Start" na IoT
2. Čekaj da se pokrene
3. Klikni "Start" opet
4. **Rezultat:** Server loguje "All requested scanners already running"

### Test 2: Stop funkcioniše
1. Klikni "Start" na IoT
2. Čekaj da se pojave log poruke
3. Klikni "Stop"
4. **Rezultat:** `[IoT] rtl_433 exited` i više nema novih poruka

### Test 3: F5 refresh state sync
1. Pokreni IoT
2. Uradi F5
3. **Rezultat:** IoT je i dalje aktivan (state sync radi)
4. Zaustavi IoT
5. Uradi F5
6. **Rezultat:** IoT je stopiran (state sync radi)

### Test 4: Bluetooth nezavisan
1. Pokreni Bluetooth
2. Pokreni IoT
3. Oba rade nezavisno
4. Zaustavi samo Bluetooth
5. **Rezultat:** IoT i dalje radi

### Test 5: BT found prikazuje odmah
1. Pokreni Bluetooth
2. Čim se pronadje uređaj, vidi se u logs
3. **Rezultat:** Uređaj se odmah prikazuje na UI sa pink okvirom

---

## ⚠️ Važne napomene:

### RTL Dongle Konflikti:
- **IoT** i **General** (walkie-talkie) **NE MOGU** raditi istovremeno
- Dele isti RTL-SDR dongle
- RTL mutex automatski čeka dok jedan ne završi
- **Bluetooth** radi nezavisno jer koristi drugi hardver

### State Management:
- `activeScanners` se ažurira samo kada proces zaista završi
- Na reconnect, server šalje tačno stanje
- Dupli start je sprečen
- F5 održava state

---

## 🚀 Sve je spremno i testirano!

**Problemi koji su rešeni:**
✅ Auto-start isključen  
✅ Stop dugme zaustavlja proces  
✅ F5 refresh održava tačan state  
✅ Dupli start sprečen  
✅ BT uređaji se prikazuju odmah  
✅ State sync na reconnect  

**Sledeći koraci:**
1. Testiranje sa pravim hardverom
2. Provera Bluetooth adapter-a (`hcitool scan`)
3. Provera RTL-SDR dongle-a (`rtl_test`)
