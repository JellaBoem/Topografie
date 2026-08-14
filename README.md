# Topografie

Oefen-app voor de blinde wereldkaart. Je krijgt een land als vraag
("Waar ligt Ecuador?") en tikt op de kaart waar het ligt. Foute landen komen
later opnieuw terug — over sessies heen, niet op de klok.

**Live:** https://jellaboem.github.io/Topografie/

## Wat het doet

- Blinde wereldkaart, Robinson-projectie, Nederlandse namen: 168 landen, 10 zeeën,
  9 gebergtes, 168 hoofdsteden en 31 wereldhavens
- Twee oefenstanden: aanwijzen op de kaart, of de kaart licht iets op en jij kiest de
  naam. Elke stand houdt zijn eigen voortgang bij
- Herhaling volgens Leitner: fout → volgende sessie, daarna na 3, 10, 30, 90 sessies.
  Geteld in sessies, niet in kalenderdagen — een dag overslaan kost je niets
- Kies je oefenstof: alles, één werelddeel, of één brok
- Meerdere profielen op één toestel, elk met eigen voortgang en eigen instellingen
- Per land te lezen wat de naam betekent, welke taal er gesproken wordt, hoe het land
  ontstond en welke gewoonte er opvalt — pas ná je antwoord
- Voortgang blijft op het toestel staan, ook na herstarten
- Export/import van voortgang als bestand, per profiel
- Werkt offline; installeerbaar op het beginscherm (iPhone: Safari → Deel → "Zet op beginscherm")

## Privacy

Geen account, geen server, geen tracking, geen externe verzoeken tijdens gebruik.
Je voortgang en de namen van de profielen staan uitsluitend in de browseropslag van je
eigen toestel en worden nooit verstuurd. Profielen dienen om voortgang uit elkaar te
houden; ze zijn geen beveiliging — er is geen wachtwoord.

## Techniek

Losse HTML + JavaScript, geen framework, geen build-stap, geen runtime-afhankelijkheden.

| Bestand | Wat het is |
|---|---|
| `index.html` | alle schermen en alle CSS |
| `app.js` | vragen, tikdetectie, herhaling, profielen, opslaan |
| `map-data.json` | kant-en-klare kaart (alle landen als SVG-pad) |
| `extra-data.json` | zeeën, gebergtes, hoofdsteden en havens |
| `land-info.json` | tekst per land (naam, taal, geschiedenis, cultuur, feit) |
| `manifest.json` | maakt de app installeerbaar |
| `sw.js` | zorgt dat de app offline werkt |

De kaart is eenmalig gegenereerd uit **Natural Earth** via het `world-atlas`-pakket
(publiek domein). De app zelf gebruikt geen internet.
