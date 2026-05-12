# Bluetooth Monitoring - Za TVOJE uređaje

## ⚠️ VAŽNO - Šta ovo MOŽE i NE MOŽE

### ✅ MOŽE (Legalno i tehnički moguće):
- **Detekcija BT uređaja** u blizini (hcitool scan) - već radi!
- **Pairing sa tvojim uređajima** (telefon, slušalice, itd.)
- **Monitoring BT traffic-a sa UPARENIH uređaja** (btmon)
- Videti pakete koji se razmenjuju između tvog PC-ja i uparenih uređaja

### ❌ NE MOŽE:
- **Dekodiranje audio-a sa random BT uređaja** bez pairing-a
- **"Over the air" prisluškivanje** tuđih BT razgovora (potreban Ubertooth hardware)
- **Dekriptovanje enkriptovanih BT stream-ova**

## Kako radi

### 1. **Bluetooth Device Discovery** (automatski)
```
✓ Scanner detektuje sve BT uređaje u blizini
✓ Prikazuje MAC adresu i ime
✓ Procenjuje distancu
```

### 2. **Pairing sa tvojim uređajem**
1. Klikni na **Bluetooth ikonu** pored BT uređaja u listi
2. Server će pokrenuti `bluetoothctl` da upari uređaj
3. Možda će trebati da potvrdiš pairing na telefonu/uređaju

**Komande koje se izvršavaju:**
```bash
bluetoothctl pair AA:BB:CC:DD:EE:FF
bluetoothctl trust AA:BB:CC:DD:EE:FF
bluetoothctl connect AA:BB:CC:DD:EE:FF
```

### 3. **Bluetooth Traffic Monitoring**
Klikni **"Start BT Monitor"** dugme u headeru.

**Šta vidiš:**
- ACL Data pakete (audio/data transfer)
- SCO Data pakete (voice calls)
- Connection events
- Disconnection events
- Device names i adrese

**Napomena:** btmon može videti samo pakete između **tvog PC-ja** i **uparenih** uređaja. Ne može hvatati random BT traffic "iz vazduha".

## Praktični use case-ovi

### Use Case 1: Monitoring svog telefona
```
1. Paruj telefon sa PC-jem (Bluetooth ikona u device listi)
2. Start BT Monitor
3. Pusti muziku sa telefona ili pozovi nekog
4. Vidi BT pakete u realu
```

### Use Case 2: Debug BT audio problema
```
1. Paruj BT slušalice
2. Start BT Monitor
3. Vidi kada se konektuju/diskonektuju
4. Traži error poruke u event logu
```

### Use Case 3: Detektovanje nearby devices
```
1. Start Bluetooth scanner (automatski)
2. Vidi sve BT uređaje u radijusu
3. Procena distanceBT


 na osnovu RSSI signala
```

## Tehnički detalji

### btmon (Bluetooth Monitor)
- **Zahteva:** Linux kernel 2.6.38+ (HCI snooping)
- **Permisije:** root/sudo ili bluetooth grupa
- **Output:** HCI paketi u čitljivom formatu

### Komande koje se koriste:
```bash
# Device discovery
hcitool scan

# Pairing
bluetoothctl pair MAC_ADDRESS
bluetoothctl trust MAC_ADDRESS
bluetoothctl connect MAC_ADDRESS

# Traffic monitoring
sudo btmon --tty
```

## Troubleshooting

### Problem: "btmon requires sudo"
**Rešenje:**
```bash
# Opcija 1: Dodaj korisnika u bluetooth grupu
sudo usermod -a -G bluetooth $USER
# Logout/login da primeni

# Opcija 2: Pokreni server sa sudo
sudo ./start.sh
```

### Problem: "Pairing failed"
**Rešenje:**
1. Proveri da li je uređaj u pairing mode-u
2. Proveri da li je BT adapter UP: `hciconfig hci0 up`
3. Probaj ručno: `bluetoothctl` pa `pair MAC`

### Problem: "Ne vidim BT traffic"
**Razlog:** btmon može videti samo traffic između tvog PC-ja i **uparenih** uređaja.
- Prvo moraš da upariš uređaj
- Random BT signali se NE mogu dekodirati bez special hardware-a

## Šta dalje?

### Za ozbiljan BT sniffing:
- **Ubertooth One** ($120) - hvata "over the air" BT pakete
- **Nordic nRF52840** ($10) - BLE sniffing
- **Wireshark + btmon** - analiza traffic-a (već podržano)

### Za BT audio streaming:
- Upari telefon kao audio source
- Koristi PulseAudio/BlueALSA
- Recording preko `parecord` ili `arecord`

## Zaključak

**Ovo je alat za monitoring TVOJIH BT uređaja**, ne za prisluškivanje tuđih.

Korisno za:
- ✅ Debug BT konekcija
- ✅ Monitoring svog traffica
- ✅ Detektovanje nearby devices
- ✅ Analiza BT paketa

Nije za:
- ❌ Prisluškivanje tuđih razgovora
- ❌ Dekodovanje tuđih audio stream-ova
- ❌ Hakovanje BT uređaja
