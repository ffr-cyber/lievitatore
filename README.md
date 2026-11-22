# Lievitatore

Pagina di controllo del lievitatore per lievito madre solido (ESP32 + laser VL53L0X + Firebase).

- Pagina: https://ffr-cyber.github.io/lievitatore/ (senza database configurato parte in **modalità demo** con dati simulati; si forza con `?demo=1`).
- `firebase-config.js`: configurazione web di Firebase (non segreta; i dati sono protetti dalle regole in `database.rules.json` e dal login).
- Il firmware della scheda e la guida di installazione non sono in questo repository (contengono le chiavi locali).
