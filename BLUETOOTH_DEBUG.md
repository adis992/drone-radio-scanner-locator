# Bluetooth Debugging Guide

## Problem: Bluetooth ne pronalazi uređaje

### Provera 1: Da li je Bluetooth adapter uključen?
```bash
hciconfig hci0
```

**Ako piše "DOWN":**
```bash
sudo hciconfig hci0 up
```

**Ako piše "UP":** Adapter je spreman.

---

### Provera 2: Ručno testiranje scan-a
```bash
# Metoda 1: hcitool (starija metoda)
sudo hcitool scan

# Metoda 2: bluetoothctl (modernija metoda)
bluetoothctl
> scan on
> devices
> scan off
> exit
```

**Očekivan output (ako ima uređaja):**
```
Scanning ...
	AA:BB:CC:DD:EE:FF	Device Name Here
	11:22:33:44:55:66	Another Device
```

**Ako nema output-a:**
- Nema Bluetooth uređaja u blizini
- Adapter ne radi pravilno
- Potrebna su sudo prava

---

### Provera 3: Da li telefon može da se vidi?
1. Otvori telefon
2. Settings → Bluetooth → Uključi Bluetooth
3. **Napravi telefon vidljivim (Visible/Discoverable)**
   - Ostani na Bluetooth settings ekranu
   - Ili uključi opciju "Make phone visible"
4. Pokreni scan ponovo

⚠️ **Važno:** Mnogi telefoni su nevidljivi (hidden) osim ako nisi na Bluetooth settings ekranu!

---

### Provera 4: Prava pristupa
Dodaj korisnika u `bluetooth` grupu:
```bash
sudo usermod -a -G bluetooth $USER
```

Zatim logout/login ili:
```bash
newgrp bluetooth
```

---

### Rešenje: Koristi sudo
Ako ništa ne radi, pokreni server sa sudo:
```bash
sudo node server.js
```

Ili dodaj u `/etc/sudoers`:
```bash
sudo visudo
# Dodaj liniju:
noname ALL=(ALL) NOPASSWD: /usr/bin/hcitool
```

Zatim promeni server.js da koristi sudo:
```javascript
const proc = spawn('sudo', ['hcitool', 'scan', '--flush']);
```

---

## IoT uređaji se ne prikazuju

### Provera: Da li rtl_433 detektuje signale?
```bash
rtl_433 -f 433920000 -f 868000000
```

**Očekivan output:**
```
time      : 2026-05-08 15:30:00
model     : Acurite-Tower  id        : 12345
Temperature: 22.5 C       Humidity  : 65 %      Battery   : OK
```

**Ako nema output-a:**
- Nema IoT uređaja u blizini (433/868 MHz)
- RTL-SDR dongle nije povezan
- Potreban bolji antenna za 433/868 MHz

---

## Logs interpretacija

### Dobar BT scan (uređaj pronađen):
```
[BT] Starting Bluetooth scan...
[BT] RAW OUTPUT: Scanning ...
[BT] RAW OUTPUT: 	AA:BB:CC:DD:EE:FF	My Phone
[BT] *** DEVICE FOUND: AA:BB:CC:DD:EE:FF - My Phone ***
[BT] hcitool scan finished (code 0)
```

### Prazan BT scan (nema uređaja):
```
[BT] Starting Bluetooth scan...
[BT] RAW OUTPUT: Scanning ...
[BT] No devices matched in output (lines: 2)
[BT] hcitool scan finished (code 0)
```

### Dobar IoT scan (uređaj detektovan):
```
[IoT] {"time":"2026-05-08 15:30:00","model":"Acurite-Tower",...}
[IoT] *** DEVICE DETECTED: Acurite-Tower @ 433.920MHz RSSI=-45 ***
```

---

## Quick Fix Checklist

- [ ] Bluetooth adapter uključen: `sudo hciconfig hci0 up`
- [ ] Telefon je visible/discoverable
- [ ] Korisnik u bluetooth grupi: `groups | grep bluetooth`
- [ ] RTL-SDR dongle povezan: `rtl_test`
- [ ] Server ima potrebna prava
- [ ] IoT uređaji u blizini (433/868 MHz senzori)
