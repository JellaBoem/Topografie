# Topografie

Oefen-app voor de blinde wereldkaart. Je krijgt een land als vraag
("Waar ligt Ecuador?") en tikt op de kaart waar het ligt. Foute landen komen
later opnieuw terug — over sessies heen, niet op de klok.

**Live:** https://jellaboem.github.io/Topografie/

## Wat het doet

- Blinde wereldkaart, Robinson-projectie, Nederlandse landnamen (168 landen)
- Herhaling volgens Leitner: fout → volgende sessie, daarna na 3, 10, 30, 90 sessies
- Kies je oefenstof: alles, één werelddeel, of één brok
- Voortgang blijft op het toestel staan, ook na herstarten
- Export/import van voortgang als bestand
- Werkt offline; installeerbaar op het beginscherm (iPhone: Safari → Deel → "Zet op beginscherm")

## Privacy

Geen account, geen server, geen tracking, geen externe verzoeken tijdens gebruik.
Je voortgang staat uitsluitend in de browseropslag van je eigen toestel en wordt
nooit verstuurd.

## Techniek

Losse HTML + JavaScript, geen framework, geen build-stap, geen runtime-afhankelijkheden.

| Bestand | Wat het is |
|---|---|
| `index.html` | het scherm |
| `app.js` | vragen, tikdetectie, herhaling, opslaan |
| `map-data.json` | kant-en-klare kaart (alle landen als SVG-pad) |
| `manifest.json` | maakt de app installeerbaar |
| `sw.js` | zorgt dat de app offline werkt |

De kaart is eenmalig gegenereerd uit **Natural Earth** via het `world-atlas`-pakket
(publiek domein). De app zelf gebruikt geen internet.
