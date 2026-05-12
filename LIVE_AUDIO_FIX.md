# Live Audio Fix - Slušalice / Headphones

## Problem
Live audio je išao na HDMI/grafička kartica umjesto na slušalice/speakers.

## Riješenje
Server sada koristi **plughw:2,0** (ALC897 Analog - motherboard audio) gdje su obično priključene slušalice.

## Izmjene

### server.js
1. **Audio output**: Promijenjen sa `play` (sox) na `aplay -D plughw:2,0`
2. **Auto-stop**: Ako korisnik klikne na drugi live audio, automatski zaustavlja prethodni
3. **Bolji error handling**: Jasniji logovi i poruke o greškama
4. **Force kill**: Koristi SIGTERM pa SIGKILL za siguran stop procesa

### client/src/App.js
1. **Auto-switch**: Automatski zaustavlja prethodni live audio prije pokretanja novog (nema više alert-a)
2. **Visual indicator**: Dodao Chip na vrhu koji pokazuje trenutno aktivni live audio
3. **Stop dugme**: Chip ima X dugme za brzo zaustavljanje

## Kako testirati

1. **Provjeri audio device-e:**
```bash
aplay -l
```
Traži "ALC897 Analog" ili "Generic" - to je obično card 2.

2. **Testiraj audio na slušalicama:**
```bash
speaker-test -D hw:2,0 -c 2 -t sine -f 440
```
Trebao bi čuti beep u slušalicama. Ctrl+C za stop.

3. **Ako slušalice nisu na card 2:**
- Otvori `server.js` linija ~1065
- Promijeni `-D plughw:2,0` u odgovarajući card (npr. `-D plughw:1,0`)
- Restart server

4. **Provjeri volume:**
```bash
alsamixer
```
F6 da izabereš card 2 (Generic), arrow keys za volume, M za unmute.

## Kako radi

```
RTL-SDR → rtl_fm (demodulacija) → aplay (playback na slušalice)
```

- **rtl_fm**: FM demodulator za radio signal
- **aplay -D plughw:2,0**: Pušta audio direktno na motherboard audio (slušalice)
- **Mode**: Auto-detect (FM/AM/WFM) ili manual override

## UI Indikatori

- **🔊 LIVE chip (vrh)**: Prikazuje trenutnu frekvenciju koja se sluša
- **Crveno dugme (device card)**: Stop ikona kad je aktivan
- **Žuto dugme**: Mikrofon ikona za live audio

## Troubleshooting

**Nema zvuka:**
1. Provjeri da li su slušalice priključene
2. Provjeri volume (alsamixer)
3. Provjeri card number: `aplay -l`
4. Provjeri server logs za errore

**Drugi device ne startuje:**
- Auto-stop bi trebao da zaustavlja prethodni
- Ako ne radi, osvježi stranicu (F5)
- Provjeri logs za "Already listening" poruke

**Audio kasni:**
- Normalno je ~1s delay (buffer)
- Slabiji signal = više šuma

**Greška "No such device":**
- Card 2 ne postoji na sistemu
- Promijeni u server.js (linija ~1065)
- Koristi `aplay -L` da vidiš sve dostupne device-e
