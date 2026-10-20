# LDEdit

Native macOS-app (Electron) om linked-data-**resources** te bekijken, te bewerken en te
**valideren tegen SHACL-shapes**. De app verpakt de webversie (`ldedit.html`) in een
native macOS-venster, met een eigen menubalk, bestandsdialogen en ondersteuning voor
slepen-en-neerzetten.

De pagina blijft in de browser werken zoals hij deed; de desktop-API (en daarmee het
openen en opslaan van bestanden en de bundels) is alleen in de Electron-app aanwezig.

De validatie volgt de **SHACL-specificatie**. Meegeleverd in `shapes/` zijn SHACL-shapes
voor MIM, NL-SBB, DCAT-AP-NL, FDS-DQV en MDTO, plus de MIM-ontologie als achtergrondkennis
(voor `rdf:type`/`rdfs:subClassOf`).

## Vereisten

- Node.js 20 of nieuwer
- macOS (Apple Silicon of Intel)

## Draaien tijdens ontwikkeling

```bash
npm install
npm start
```

## Tests

```bash
npm test
```

Draait de Node-tests voor de Turtle-parser, de modelopbouw en de SHACL-engine. De tests
laden onder meer de meegeleverde shape-bestanden. Als de repo met de brondata lokaal aanwezig
is (`~/Documents/GitHub/gegevenskwaliteitsregistratie`), draaien er ook integratietests tegen
de voorbeeld- en negatiefbestanden daarin; anders worden die overgeslagen.

## App bundelen

```bash
npm run dist
```

## Projectbestanden

| Bestand | Functie |
| --- | --- |
| `main.js` | Hoofdproces: venster, menu, openen/opslaan, recente bestanden, SHACL-bundels en -selectie |
| `preload.js` | Brug tussen hoofdproces en pagina |
| `ldedit.html` | De eigenlijke weergave/beheerder (zijbalk met filters, shapes-beheer, validatieweergave) |
| `js/turtle.js` | Turtle/RDF-parser (gedeeld met de tests) |
| `js/model.js` | Modelopbouw uit geparseerde triples (nodes, klassen, instanties, labels) |
| `js/shacl.js` | SHACL-engine: shapes parsen, targets bepalen, constraints en SPARQL-subset evalueren |
| `shapes/` | De meegeleverde bundels met SHACL-shapes en ontologieën (MIM, NL-SBB, DCAT-AP-NL, FDS-DQV, MDTO) plus `bundles.json` |
| `test/run-tests.js` | Node-tests |
| `scripts/adhoc-sign.js` | Ad-hoc ondertekent de bundel na het packen |
| `build/icon.icns` | App-icoon |

## Weergave: filters in de zijbalk

De navigatie is bewust minimaal: de zijbalk bevat alleen de filters en twee knoppen naast
elkaar, zodat er zoveel mogelijk ruimte voor de lijst overblijft. Het **aantal items van de
huidige selectie staat in de titelbalk** van het venster, samen met het aantal triples, het
aantal actieve shapes en het bestand dat open staat.

- **Filter op soort** — toont Instanties, Klassen, Eigenschappen of Relaties.
- **Filter op klasse** — beperkt de lijst tot één klasse. Het filter werkt per soort:
  instanties op hun `rdf:type` (inclusief subklassen), klassen op `rdfs:subClassOf`, en
  eigenschappen en relaties op hun `rdfs:domain`.
- **Zoeken** — filtert op label, verkorte naam of URI.
- De lijst is vlak (geen groepering) en toont alleen items waar het bestand zelf iets over
  zegt: een klasse die je enkel als `rdf:type` gebruikt, of een resource die alleen genoemd
  wordt, staat er niet in.
- Een rode badge in de lijst toont hoeveel SHACL-overtredingen een item heeft.
- **Labels en omschrijvingen uit de vocabulaire** — is er een ontologie of vocabulaire
  geladen (het gekozen modeltype), dan gebruikt de interface het **label** daaruit
  (`rdfs:label`, `skos:prefLabel`, …) en de **omschrijving/definitie** (`rdfs:comment`,
  `skos:definition`, `skos:scopeNote`, `dct:description`, `sh:description`). Dat geldt ook
  voor labels en definities die op een shape staan via `sh:path` of `sh:targetClass`. De
  omschrijving verschijnt onder de titel in het detail. Wat in de data zelf staat heeft
  voorrang, en Nederlands wint van Engels; anders wordt de lokale naam gebruikt.
- **+ Nieuwe resource** (naast **SHACL-shapes…**) opent een pop-up waarin je eerst het
  **soort** kiest: instantie, klasse, eigenschap of relatie. Een **label is genoeg** (met
  optioneel een **taal**, bijvoorbeeld @nl): de verkorte naam wordt daaruit voorgesteld (en
  blijft aanpasbaar) en een **voorbeeld** toont direct de triples die worden aangemaakt.
  Enter maakt aan, Escape sluit.
  - **Instantie** — optioneel een klasse, of een eigen klasse-URI, of een blanco node. Een
    blanco node mag **leeg** blijven (ook zonder label): hij komt in de lijst te staan zodat je
    er daarna eigenschappen aan kunt toevoegen.
  - **Klasse** — optioneel een **superklasse** (`rdfs:subClassOf`).
  - **Eigenschap / relatie** — optioneel een **super-eigenschap/-relatie**
    (`rdfs:subPropertyOf`), een **domein** (`rdfs:domain`, een klasse) en een **bereik**
    (`rdfs:range`: een datatype bij een eigenschap, een klasse bij een relatie).
  - De keuzelijsten bevatten naast de klassen en eigenschappen uit het model ook die uit de
    **geselecteerde SHACL-bestanden** (`sh:targetClass`, `sh:class`, `sh:path` en
    gedeclareerde klassen/eigenschappen).

Items blijven volledig bewerkbaar: klik op een waarde om die aan te passen, wijzig de taal
van een tekst, of gebruik ✎/× om een verwijzing te wijzigen of te verwijderen. Onderaan een
item voeg je eigenschappen en relaties toe; met de rode knop verwijder je het item.

Bij **+ Eigenschap of relatie toevoegen** kun je kiezen uit de eigenschappen en relaties die
volgens de geselecteerde SHACL-shapes bij de **klasse van het item** horen (inclusief
overerving), aangevuld met wat al in het model voorkomt. Zonder zoekterm staan de
shape-eigenschappen direct in de lijst.

Bij een tekstwaarde kies je ook het **datatype**:
gewone tekst, tekst met taal (`rdf:langString`), geheel getal, decimaal, kommagetal, boolean,
datum, datum en tijd, tijd, jaar, duur, URI of taalcode — of een **eigen datatype**. Bij
tekstwaarden staat direct een **taalveld** ernaast (optioneel; bij `rdf:langString`
verplicht), zodat je meteen een taal-getagde tekst kunt invoeren. De
lexicale vorm wordt licht gecontroleerd (bijvoorbeeld een geheel getal bij `xsd:integer`),
zodat er geen ongeldige literal ontstaat. Daarnaast kun je een verwijzing naar een andere
resource leggen, of een **nieuwe blanco node als waarde** maken (bijv. `ex:adres [ … ]`) —
die komt in de lijst te staan en je gaat er direct naartoe om er eigenschappen aan toe te
voegen. Met **✎** wijzig je een bestaande verwijzing (ook een blanco node) naar een andere
resource, met **×** verwijder je hem.

Een blanco node die in het bestand alleen genoemd wordt (`ex:Ding ex:adres _:x1`) staat pas in
de lijst zodra je er zelf iets over zegt; vanaf dat moment is het een instantie, net als bij
het laden.

Welke eigenschappen de shapes bij een klasse voorschrijven bepaalt ook het **datatype** in het
formulier: zodra je een eigenschap kiest, wordt het datatype uit de shape voorgeselecteerd
(bijvoorbeeld `sh:datatype xsd:date` → "Datum (xsd:date)"). Staat het datatype als alternatief
in `sh:or` (`[ sh:datatype xsd:date ] [ sh:datatype xsd:gYearMonth ]`), dan zijn al die
datatypes kiesbaar en staat de eerste voor. Een datatype dat niet in de standaardlijst staat
krijgt daarvoor een eigen optie. Kan er geen taal-tag, dan blijft het taalveld leeg en
uitgeschakeld; staat `rdf:langString` er wél bij (bijvoorbeeld `xsd:string` of
`rdf:langString`), dan is het taalveld beschikbaar — met een taal wordt de waarde een
`rdf:langString`, zonder taal een `xsd:string`. In het detailscherm verschijnt bij zo'n waarde
geen taalkeuze als de shape die niet toestaat.

Heeft de shape een **`sh:defaultValue`** (bijvoorbeeld `sh:defaultValue false` bij
`mim:indicatieAbstractObject`), dan staat die waarde al in het veld — inclusief het bijbehorende
datatype — zodat je alleen nog hoeft te bevestigen. Je kunt hem gewoon aanpassen.

## Modeltype en bundels

In de zijbalk kies je onder **Modeltype** een bundel. Via het menu **Shapes → Bundels…**
(⇧⌘H) open je een overzicht van alle bundels met hun volledige inhoud: bestanden,
shape-tellingen en omschrijving. Daar kun je ook het modeltype kiezen.

- Een **bundel** bevat de SHACL-shapes plus de bijbehorende ontologie(ën)/vocabularia en
  wordt als geheel toegepast. De shapes komen uit de map `shapes/` die met de app wordt
  meegeleverd (bundels MIM, NL-SBB, DCAT-AP-NL, FDS-DQV, MDTO, Ontologie en SHACL); die map
  is niet instelbaar. De bundels bevatten ook de externe vocabularia die de shapes
  gebruiken: **SKOS, DCAT, DQV, PROV-O, DCMI Terms, ADMS, vCard en FOAF** (opgehaald bij
  W3C/DCMI/FOAF; SKOS en FOAF naar Turtle geconverteerd).
- Je kiest één modeltype tegelijk, of "geen". Een bestand dat niet in `bundles.json`
  voorkomt wordt als eigen bundel getoond.
- Een ontologie in een bundel geldt als achtergrondkennis: ze levert `rdf:type`- en
  `rdfs:subClassOf`-informatie voor `sh:class`- en `sh:targetClass`-controles en vult
  ontbrekende eigenschappen aan (zonder bestaande waarden te verdubbelen). De dataview van de
  app blijft daarbij ongewijzigd.

## Prefixen en standaardprefix

Via **Bestand → Prefixen…** (⌘,) beheer je de prefixes. Naast de prefixes uit het bestand
staan er standaard een groot aantal veelvoorkomende vocabularia in (RDF, RDFS, OWL, XSD,
SHACL, SKOS, DCAT, DQV, PROV, FOAF, vCard, ADMS, DCMI, schema.org, VoID, Time, MIM, MDTO).

- Met de radio kies je de **standaardprefix** die wordt voorgesteld bij het aanmaken van een
  nieuwe resource (bijvoorbeeld `ex:Test`). Die keuze wordt onthouden.
- **Standaardprefixen toevoegen** vult de lijst aan met ontbrekende standaardprefixen en
  meldt hoeveel er zijn toegevoegd — of dat ze er al allemaal in staan.
- **Opslaan** schrijft de prefixes naar het model; bij het opslaan van het bestand worden ze
  als `@prefix`-regels weggeschreven.

## Validatie tegen SHACL

Bij het openen van een resource toont de detailweergave het resultaat:

- **Eigenschappen die niet voldoen worden gemarkeerd**, met de reden erbij. Bijvoorbeeld
  "Verplichte eigenschap ontbreekt (minimaal 1)", "Waarde moet een literal van het type
  xsd:date zijn" of het `sh:message` uit de shape. Waarden waarop de overtreding
  betrekking heeft worden apart gemarkeerd.
- Heeft een shape één `sh:message` voor meerdere constraints, dan staat de **concrete reden**
  eronder (bijvoorbeeld `Datatype · Waarde moet een literal van het type xsd:string zijn
  (nu: rdf:langString) — bij "Meting 2024"@nl`). Zo verbergt zo'n algemene melding het
  werkelijke probleem niet.
- **Ontbrekende verplichte eigenschappen** staan in een eigen blok, met een knop om ze
  direct toe te voegen.
- Bovenaan staat een samenvatting: voldoet wel/niet, met aantallen fouten en waarschuwingen.
- **Bij het toevoegen van een eigenschap worden eerst de verplichte eigenschappen
  gesuggereerd** die nog ontbreken; klik erop om de eigenschap (en het verwachte waardetype)
  voor te vullen. In de keuzelijst staan verplichte eigenschappen bovenaan.

Ondersteunde constraint-componenten: `sh:minCount`/`sh:maxCount`, `sh:datatype`,
`sh:class`, `sh:nodeKind`, `sh:pattern`/`sh:flags`, `sh:minLength`/`sh:maxLength`,
`sh:in`, `sh:hasValue`, numerieke bereiken, `sh:languageIn`/`sh:uniqueLang`,
`sh:node`, `sh:or`/`sh:and`/`sh:not`/`sh:xone`, `sh:property`, `sh:closed`,
`sh:qualifiedValueShape` (+ counts), `sh:equals`/`sh:disjoint` en `sh:sparql`
(een beperkte SELECT-subset: triple-patronen, `a`, predicate-alternatieven, inverse en
`FILTER [NOT] EXISTS` / `?a != ?b`). Een SPARQL-constraint die buiten die subset valt
wordt als "niet geëvalueerd" gemeld — er wordt niets stil overgeslagen.

### Datatype-semantiek

`sh:datatype` volgt de SHACL-specificatie: de waarde moet een **literal met precies dat
datatype** zijn.

- een taal-getagde tekst (`"…"@nl`) heeft `rdf:langString`;
- een gewone tekst zonder datatype heeft `xsd:string`;
- een IRI is géén literal en voldoet dus niet aan `sh:datatype`.

Let op: sommige meegeleverde shapes schrijven `sh:datatype xsd:anyURI` of `sh:datatype
xsd:boolean` voor, terwijl de bijbehorende voorbeelddata daar IRIs of teksten als `"Nee"`
gebruikt. Volgens de SHACL-specificatie is dat een overtreding, en de app meldt dat ook.
Wil je zulke waarden toestaan, gebruik dan `sh:nodeKind`/`sh:class` (of `sh:or`) in de shape
in plaats van `sh:datatype`.

## Niet-opgeslagen wijzigingen

De app bewaakt werk dat nog niet is weggeschreven. Er verschijnt een native melding wanneer
je het venster sluit of een ander bestand opent met niet-opgeslagen wijzigingen, met de
keuze **Opslaan**, **Annuleren** of **Niet opslaan**.

In de browser blijft "Download gewijzigd bestand" een gewone download; de desktop-API is
alleen in de Electron-app aanwezig.

## Copyright

Copyright © 2026 Danny Greefhorst (danny.greefhorst@gmail.com). Dit staat in
`package.json` en in het Info.plist van de gebundelde app, en verschijnt onder
**LDEdit → Over LDEdit**.

## Let op: de app is niet ondertekend met een Developer ID

De app is alleen **ad-hoc** ondertekend. Dat is genoeg om hem op deze Mac te draaien, maar
macOS vertrouwt hem niet automatisch. Op een andere Mac verschijnt bij het eerste starten de
melding *"Apple kan niet controleren of deze app schadelijk is"*. Zo omzeil je dat:

1. **Rechtsklik op de app → Open → nogmaals Open.** Daarna start hij normaal.
2. Of verwijder het quarantaine-attribuut:

   ```bash
   xattr -dr com.apple.quarantine "/Applications/LDEdit.app"
   ```

Wil je de waarschuwing helemaal weg hebben, dan is daar een **Developer ID Application**-
certificaat voor nodig (betaald Apple Developer Program-lidmaatschap), plus notarisatie.
