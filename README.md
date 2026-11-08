# SH3D Home

Sweet Home 3D wird lebendig: Ein Home-Assistant-Add-on, das `.sh3d`-Dateien
importiert, das Haus in 3D zeigt und Lichter, Türen, Fenster, Heizungen,
Lautsprecher und Bildschirme mit Home-Assistant-Entitäten verbindet.

## Installation

1. In Home Assistant: **Einstellungen → Add-ons → Add-on-Store**.
2. Drei Punkte → **Repositories** → `https://github.com/TechnoLau/ha-sh3d-home`.
3. **SH3D Home** installieren, starten und in der Seitenleiste öffnen.

## Erste Schritte

- Oben links **Neu** wählen und eine `.sh3d`-Datei hochladen.
- Etage wählen, Objekt in der Liste oder im Modell antippen.
- Unter **Gerät** eine Home-Assistant-Entität zuweisen.
- **Live** aktivieren: Tippen auf das Objekt schaltet.
- **Dashboard-Karte** öffnet den Generator für ganze Karte, Etage oder Zimmer.

## Dashboard

Die Ressource `/local/sh3d-home/sh3d-home-card.js` wird beim Start automatisch
registriert. Karte manuell hinzufügen:

```yaml
type: custom:sh3d-home-card
model: DEIN_MODELL_ID
mode: home          # home | floor | room
level: level-id     # optional
room: room-id       # nur bei mode: room
focus: dim          # none | dim | isolate
view: iso           # iso | front | top
height: 460
```

## Funktionen

- .sh3d-Import inkl. Wänden, Räumen, Möbeln und Original-3D-Modellen
- Live-Sync über die Home-Assistant-WebSocket-API
- Lichtfarben, Helligkeit, Weißton, Effekte
- Thermostate mit Ist-/Solltemperatur
- Tür-/Fensterzustände, Rollläden
- Mehrere Regeln pro Objekt, UND/ODER, beliebig viele Bedingungen
- z. B. PC-Turm + Monitor: Monitor leuchtet, wenn der PC an ist
- Etagen, Zimmer-Fokus, freie Kamera, Front, Draufsicht und Gehmodus
- Dashboard-Modi für ganzes Haus, Etage oder Zimmer
- Lokale Speicherung unter `/data`; keine Cloud
