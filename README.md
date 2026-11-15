# EasyAuto

[Otevřít EasyAuto](https://skalekmarek.github.io/EasyAuto/)

EasyAuto je česká webová aplikace pro přípravu na teoretickou zkoušku v autoškole. Obsahuje všech 1 136 zkušebních otázek a pět ukázek z [Věstníku Ministerstva dopravy](https://etesty.md.gov.cz/ro/Bulletin). Sada byla ověřena 15. listopadu 2026. Pro cvičnou zkoušku se používá oficiální sada 1 080 otázek pro skupinu B.

- Přehled pokroku, odhad skóre po tématech a mapa každé otázky s filtry pro nezodpovězené otázky, aktivní chyby i dřívější chyby.
- Procvičování po tématech a samostatná kola pro nové otázky, chyby a otázky označené „Nerozumím“.
- Cvičná zkouška s 25 otázkami, limitem 30 minut, hodnocením z 50 bodů a hranicí úspěchu 43 bodů.
- Historie testů, vyhledávání v katalogu, galerie obrázků a import dokončených testů přes záložku prohlížeče nebo soubor.

Pokrok a profil se ukládají do úložiště aktuálního prohlížeče. Aplikace běží na GitHub Pages a načítá většinu obrázků a videí z eTestů Ministerstva dopravy. Při spuštění na localhostu použije dostupná média z `czech-driving-licence/media/`.

## Místní spuštění

V kořeni repozitáře spusť `python -m http.server 8000` a otevři [localhost:8000](http://localhost:8000/). Frontend je v `index.html`, `styles.css` a `src/`.
