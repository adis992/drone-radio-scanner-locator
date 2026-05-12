# Auto-Pairing & Bluetooth Monitoring - Kompletni Vodič

## 🎯 ŠTA OVO RADI

**Automatski upariš SVOJ Bluetooth uređaj (telefon, slušalice) sa računarom i monitoruješ traffic.**

### Proces:
1. **Klikneš Bluetooth ikonu** na BT uređaju u listi
2. **Potvrdiš** da želiš da upariš
3. **Sistem automatski:**
   - Uključi Bluetooth adapter
   - Pokrene scanning
   - Pošalje pairing request
   - Čeka tvoju potvrdu na uređaju
   - Konektuje se
   - **Automatski pokrene btmon monitoring**

## 📱 KORACI - Kako koristiti

### Korak 1: Pripremi svoj uređaj
**Na telefonu/uređaju:**
- Idi u **Settings → Bluetooth**
- Ostani na tom ekranu (mora biti "visible")
- Ili uključi "Pairing mode" na slušalicama

### Korak 2: Startuj scanner
- Otvori web aplikaciju
- Klikni **"Start Bluetooth Scanner"**
- Čekaj 5-10 sekundi

### Korak 3: Upari automatski
- Vidi svoj uređaj u listi (npr. "noname", "Galaxy S21", itd.)
- Klikni **Bluetooth ikonu** (📶) na tom uređaju
- Potvrdi u popup-u: **"Yes, pair with this device"**

### Korak 4: Potvrdi na uređaju
**VAŽNO:**
- Na telefonu/uređaju će se pojaviti **"Pairing request"**
- **PRIHVATI/ACCEPT** pairing
- Nekad traži PIN: obično **0000** ili **1234**

### Korak 5: Wait for confirmation
- Posle ~10 sekundi dobiš **"✅ SUCCESS!"** poruku
- **btmon automatski startuje**
- Vidi BT traffic u real-time!

## 🔊 Monitoring BT Audio

### Šta monitoring pokazuje:
- **ACL Data** - Audio/data transfer paketi
- **SCO Data** - Voice call paketi
- **Connection events** - Kada se device konektuje/diskonektuje
- **Device info** - Namen, MAC adresa, usluge

### Primeri:
```
[BTMON] ACL Data RX: Handle 42 flags 0x02 dlen 48
[BTMON] > HCI Event: Connect Complete (0x03) plen 11
[BTMON]     Status: Success (0x00)
[BTMON]     Handle: 42
[BTMON]     Address: D0:56:FB:EB:CA:DC (Public)
```

### Šta možeš pratiti:
✅ Audio streaming (pustio muziku sa telefona)  
✅ Voice calls (telefonski razgovori)  
✅ Data transfer (file sharing)  
✅ Connection quality (signal strength)  

**Ali:** Audio je **enkriptovan**, vidiš samo da se prenosi, ne sam sadržaj.

## ⚙️ Tehnički detalji

### Auto-pairing sekvenca:
```bash
1. bluetoothctl power on
2. bluetoothctl agent on
3. bluetoothctl default-agent
4. bluetoothctl pairable on
5. bluetoothctl scan on
6. bluetoothctl pair <MAC>
7. bluetoothctl trust <MAC>
8. bluetoothctl connect <MAC>
9. sudo btmon --tty  # auto-start
```

### Komande koje se izvršavaju:
- **power on** - Uključi BT adapter
- **agent on** - Omogući auto-accept
- **pairable on** - Dozvoli pairing
- **scan on** - Skenuj nearby devices
- **pair** - Pošalji pairing request
- **trust** - Dodaj u trusted devices
- **connect** - Konektuj se
- **btmon** - Pokreni monitoring

## 🐛 Troubleshooting

### Problem: "Pairing timeout"
**Uzrok:** Uređaj nije u pairing mode-u ili van dometa  
**Rešenje:**
- Proveri da li je uređaj "visible" (Settings → Bluetooth)
- Približi uređaj računaru (<5m)
- Resetuj BT na uređaju (OFF→ON)
- Probaj ponovo

### Problem: "Device already paired"
**Uzrok:** Uređaj je već uparen  
**Rešenje:**
- Prvo **unpair** sa uređaja (Settings → Forget this device)
- Ili terminalom:
```bash
bluetoothctl remove <MAC_ADDRESS>
```

### Problem: "No confirmation on device"
**Uzrok:** Uređaj ne pokazuje pairing request  
**Rešenje:**
- Proveri da li BT adapter radi: `hciconfig hci0`
- Restartuj BT servis: `sudo systemctl restart bluetooth`
- Probaj ručno: `bluetoothctl` pa `pair <MAC>`

### Problem: "btmon shows nothing"
**Uzrok:** Nema traffica ili nije konektovan  
**Rešenje:**
- Pusti muziku sa telefona
- Otvori neku BT aplikaciju
- Proveri da li je device zaista konektovan: `bluetoothctl info <MAC>`

### Problem: "Permission denied - btmon requires sudo"
**Uzrok:** btmon treba root permisije  
**Rešenje:**
```bash
# Opcija 1: Dodaj user u bluetooth grupu
sudo usermod -a -G bluetooth $USER
# Logout/login

# Opcija 2: Pokreni server sa sudo
sudo ./start.sh
```

## 📊 Šta možeš analizirati

### Use Case 1: Audio Quality Testing
```
1. Paruj BT slušalice
2. Start btmon
3. Pusti muziku
4. Gledaj ACL Data rate
5. Ako ima mnogo "Packet lost" → loš signal
```

### Use Case 2: Connection Stability
```
1. Paruj telefon
2. Start btmon
3. Udaljuj se od računara
4. Vidi kada connection dropuje
5. Izmeri max. domet
```

### Use Case 3: Battery Drain Analysis
```
1. Paruj smartwatch/fitness tracker
2. Monitor ACL pakete
3. Ako konstantno šalje pakete → troši bateriju
4. Identifikuj apps koji stalno koriste BT
```

## 🔐 Sigurnost & Privatnost

### Šta može:
✅ Monitoruješ **SVOJ** traffic (telefon ↔ PC)  
✅ Debug **SVOJIH** BT uređaja  
✅ Analiziraš **SVOJE** konekcije  

### Šta NE može:
❌ Dekodovati enkriptovani audio sadržaj  
❌ Hvatati traffic drugih ljudi bez pairing-a  
❌ "Over the air" sniffing random BT devices  

**Bluetooth audio je AES-128 enkriptovan.**  
Vidiš da se **prenosi** audio, ali ne čuješ **šta**.

## 🎓 Edukativna vrednost

### Nauči kako Bluetooth radi:
- **Pairing process** - Kako se uređaji međusobno autentifikuju
- **Encryption** - AES-128 cipher za audio/data
- **Frequency hopping** - 1600 promeni frekvencije u sekundi
- **Packet structure** - ACL, SCO, LE paketi
- **Connection management** - Power states, sniff mode, hold mode

### Za penetration testing (legalno):
- **Security audit SVOJIH uređaja**
- **Vulnerability testing** sa dozvolom
- **Protocol analysis** za edukaciju
- **IoT security research** na sopstvenim devices

## 📚 Dodatni resursi

### YouTube tutorijali:
- "Bluetooth Hacking with Ubertooth" (za advanced sniffing)
- "BLE Security Basics" (za Bluetooth Low Energy)
- "Wireshark BT Analysis" (za packet inspection)

### GitHub projekti:
- **libbtbb** - https://github.com/greatscottgadgets/libbtbb
- **Ubertooth** - https://github.com/greatscottgadgets/ubertooth
- **Bettercap** - https://github.com/bettercap/bettercap

### Linux tools:
```bash
bluetoothctl    # Interactive BT management
hcitool         # Low-level HCI commands
btmon           # Bluetooth monitor (built-in)
sdptool         # Service Discovery Protocol
l2ping          # BT connectivity test
```

## ✅ Zaključak

**Auto-pairing feature** omogućava da brzo upariš SVOJ uređaj i monitoruješ BT traffic.

**Korisno za:**
- 🔧 Debug BT problema
- 📊 Analiza connection quality
- 🔋 Battery consumption monitoring
- 🎓 Learning Bluetooth protocols
- 🔐 Security testing SVOJIH devices

**NIJE za:**
- ❌ Prisluškivanje tuđih razgovora (ilegalno)
- ❌ Hakovanje BT uređaja (ilegalno)
- ❌ Krađu podataka (ilegalno)

Koristi odgovorno! 🙌
