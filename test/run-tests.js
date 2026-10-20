/* Node-tests voor de Turtle-parser, het model en de SHACL-engine.
   Draai met: npm test  (of: node test/run-tests.js) */
'use strict';

const fs = require('fs');
const path = require('path');

const T = require('../js/turtle.js');
const M = require('../js/model.js');
const S = require('../js/shacl.js');

const ROOT = path.join(__dirname, '..');
const SHAPES_DIR = path.join(ROOT, 'shapes');

let passed = 0;
let failed = 0;
const failures = [];

function check(name, cond, detail) {
  if (cond) { passed++; return; }
  failed++;
  failures.push(name + (detail ? ' — ' + detail : ''));
}

function eq(name, actual, expected) {
  check(name, actual === expected, 'verwacht ' + JSON.stringify(expected) + ', kreeg ' + JSON.stringify(actual));
}

function shapesFrom(files) {
  return S.buildShapes(S.parseShapeFiles(files));
}
function fileList(nameToText) {
  return Object.keys(nameToText).map(name => ({ name, text: nameToText[name] }));
}
function componentsFor(report, nodeValue) {
  return (report.resultsByNode.get(nodeValue) || []).map(r => r.component);
}

/* ---------------- 1. Turtle-parser ---------------- */

(function testParser() {
  const parsed = T.parse('@prefix ex: <http://ex/> .\n ex:a ex:b "x" ; ex:c 1, 2 .\n');
  eq('parser: aantal triples', parsed.triples.length, 3);
  eq('parser: prefix', parsed.prefixes['ex'], 'http://ex/');

  const shapes = fs.readdirSync(SHAPES_DIR).filter(f => f.endsWith('.ttl'));
  check('parser: shape-bestanden gevonden', shapes.length >= 8, 'gevonden: ' + shapes.length);
  shapes.forEach(f => {
    let ok = true, err = '';
    try { T.parse(fs.readFileSync(path.join(SHAPES_DIR, f), 'utf8')); } catch (e) { ok = false; err = e.message; }
    check('parser: ' + f + ' parseert', ok, err);
  });
})();

/* ---------------- 1b. Prefixen: bestand bepaalt de prefixen ---------------- */

(function testFilePrefixes() {
  const withPrefixes = M.buildModel(
    T.parse('@prefix ex: <http://ex/> .\n@prefix foaf: <http://xmlns.com/foaf/0.1/> .\n ex:a foaf:name "x" .\n'),
    { useFilePrefixes: true }
  );
  eq('prefixen: alleen prefixes uit het bestand', Object.keys(withPrefixes.prefixes).sort().join(','), 'ex,foaf');
  eq('prefixen: geen standaardprefix toegevoegd', withPrefixes.prefixes['rdf'], undefined);
  eq('prefixen: curie met eigen prefix', withPrefixes.curie('http://ex/a'), 'ex:a');
  eq('prefixen: onbekende namespace blijft volledige IRI',
    withPrefixes.curie('http://www.w3.org/1999/02/22-rdf-syntax-ns#type'),
    'http://www.w3.org/1999/02/22-rdf-syntax-ns#type');

  const defaults = M.buildModel(T.parse('@prefix ex: <http://ex/> .\nex:a ex:b ex:c .\n'));
  check('prefixen: standaard wordt aangevuld zonder optie',
    defaults.prefixes['rdf'] === 'http://www.w3.org/1999/02/22-rdf-syntax-ns#' && defaults.prefixes['ex'] === 'http://ex/');

  const noPrefixes = M.buildModel(T.parse('<http://ex/a> <http://ex/b> <http://ex/c> .\n'), { useFilePrefixes: true });
  check('prefixen: bestand zonder prefixes krijgt standaardprefixen', noPrefixes.prefixes['rdf'] !== undefined);
})();

/* ---------------- 2. Shapes bouwen uit de meegeleverde bestanden ---------------- */

(function testBundledShapes() {
  const files = fs.readdirSync(SHAPES_DIR).filter(f => f.endsWith('.ttl'));
  const shapes = shapesFrom(fileList(Object.fromEntries(files.map(f => [f, fs.readFileSync(path.join(SHAPES_DIR, f), 'utf8')]))));
  check('shapes: node shapes gevonden', shapes.nodeShapeCount > 100, 'node=' + shapes.nodeShapeCount);
  check('shapes: property shapes gevonden', shapes.propertyShapeCount > 100, 'prop=' + shapes.propertyShapeCount);
})();

/* ---------------- 3. Kern-constraints op een klein voorbeeld ---------------- */

const SHAPE_A = `@prefix sh: <http://www.w3.org/ns/shacl#> .
@prefix ex: <http://example.org/> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .

ex:PersonShape a sh:NodeShape ;
  sh:targetClass ex:Person ;
  sh:property [ sh:path ex:name ; sh:minCount 1 ; sh:maxCount 1 ; sh:datatype xsd:string ; sh:message "Naam is verplicht" ] ;
  sh:property [ sh:path ex:age ; sh:datatype xsd:integer ; sh:minInclusive 0 ] ;
  sh:property [ sh:path ex:knows ; sh:nodeKind sh:IRI ; sh:class ex:Person ] ;
  sh:property [ sh:path ex:code ; sh:pattern "^[A-Z]{3}$" ; sh:flags "i" ] ;
  sh:property [ sh:path ex:status ; sh:in ( "actief" "inactief" ) ] ;
  sh:property [ sh:path ex:email ; sh:or ( [ sh:datatype xsd:string ] [ sh:nodeKind sh:IRI ] ) ] .
`;

const SHAPE_B = `@prefix sh: <http://www.w3.org/ns/shacl#> .
@prefix ex: <http://example.org/> .

ex:MemberShape a sh:NodeShape ;
  sh:targetSubjectsOf ex:memberOf ;
  sh:sparql [ sh:message "Lid maar geen persoon" ; sh:select """SELECT $this
    WHERE { FILTER NOT EXISTS { $this a ex:Person } }""" ] .
`;

const DATA = `@prefix ex: <http://example.org/> .

ex:alice a ex:Person ;
  ex:age 5 ;
  ex:knows ex:carol ;
  ex:code "abc" ;
  ex:status "onbekend" ;
  ex:email "alice@example.org" .

ex:bob a ex:Person ; ex:name "Bob" .

ex:carol a ex:Organization ; ex:memberOf ex:club .

ex:club a ex:Organization .
`;

(function testConstraints() {
  const shapes = shapesFrom(fileList({ 'a.ttl': SHAPE_A, 'b.ttl': SHAPE_B }));
  const model = M.buildModel(T.parse(DATA));
  const report = S.validate(model, shapes);

  const alice = componentsFor(report, 'http://example.org/alice');
  check('minCount: ontbrekende naam gemeld', alice.indexOf('MinCount') !== -1, alice.join(','));
  check('in: ongeldige status gemeld', alice.indexOf('In') !== -1, alice.join(','));
  check('class: carol is geen Person', alice.indexOf('Class') !== -1, alice.join(','));

  const aliceName = (report.resultsByNode.get('http://example.org/alice') || []).find(r => r.component === 'MinCount');
  eq('minCount: bericht uit sh:message', aliceName && aliceName.message, 'Naam is verplicht');
  eq('minCount: pad bekend', aliceName && aliceName.path, 'http://example.org/name');

  const bob = componentsFor(report, 'http://example.org/bob');
  check('bob: geen in/class-fouten', bob.indexOf('In') === -1 && bob.indexOf('Class') === -1, bob.join(','));

  const club = componentsFor(report, 'http://example.org/carol');
  check('sparql: FILTER NOT EXISTS gedetecteerd', club.indexOf('Sparql') !== -1, club.join(','));
  const clubRes = (report.resultsByNode.get('http://example.org/carol') || []).find(r => r.component === 'Sparql');
  eq('sparql: bericht', clubRes && clubRes.message, 'Lid maar geen persoon');

  // pattern moet met flag "i" hoofdletterongevoelig zijn: "abc" is ok
  const alicePatterns = (report.resultsByNode.get('http://example.org/alice') || []).filter(r => r.component === 'Pattern');
  eq('pattern: "abc" voldoet met /i', alicePatterns.length, 0);

  // age 5 voldoet aan minInclusive 0
  const aliceRange = (report.resultsByNode.get('http://example.org/alice') || []).filter(r => r.component === 'Range');
  eq('minInclusive: 5 >= 0 ok', aliceRange.length, 0);
})();

/* ---------------- 4. Paden, or/xone/node en datatype-semantiek (SHACL) ---------------- */

(function testAdvanced() {
  const shapes = shapesFrom(fileList({
    'adv.ttl': `@prefix sh: <http://www.w3.org/ns/shacl#> .
@prefix ex: <http://example.org/> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
ex:WidgetShape a sh:NodeShape ; sh:targetClass ex:Widget ;
  sh:property [ sh:path ex:size ; sh:xone ( [ sh:datatype xsd:integer ] [ sh:datatype xsd:string ] ) ] ;
  sh:property [ sh:path ex:flag ; sh:datatype xsd:boolean ] ;
  sh:property [ sh:path ex:home ; sh:datatype xsd:anyURI ] .
` }));
  const model = M.buildModel(T.parse(`@prefix ex: <http://example.org/> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
ex:w1 a ex:Widget ; ex:size "groot" .                                  # xone: exact één vorm -> ok
ex:w2 a ex:Widget ; ex:flag true ; ex:home "https://x.nl"^^xsd:anyURI . # juiste datatypes -> ok
ex:w3 a ex:Widget ; ex:size true .                                     # xone: geen vorm -> fout
ex:w4 a ex:Widget ; ex:flag "Nee" .                                    # xsd:string != xsd:boolean
ex:w5 a ex:Widget ; ex:home "https://x.nl" .                           # xsd:string != xsd:anyURI
ex:w6 a ex:Widget ; ex:home <https://x.nl> .                           # IRI is geen literal
`));
  const report = S.validate(model, shapes);
  const dataErrors = v => (report.resultsByNode.get(v) || []).filter(r => r.component === 'Datatype').length;
  eq('xone: één vorm ok', componentsFor(report, 'http://example.org/w1').filter(c => c === 'Xone').length, 0);
  eq('datatype: correcte boolean + anyURI ok', dataErrors('http://example.org/w2'), 0);
  check('xone: geen enkele vorm fout', componentsFor(report, 'http://example.org/w3').indexOf('Xone') !== -1, componentsFor(report, 'http://example.org/w3').join(','));
  check('datatype: "Nee" is geen xsd:boolean', dataErrors('http://example.org/w4') === 1, 'n=' + dataErrors('http://example.org/w4'));
  check('datatype: tekst is geen xsd:anyURI', dataErrors('http://example.org/w5') === 1, 'n=' + dataErrors('http://example.org/w5'));
  check('datatype: een IRI is geen literal', dataErrors('http://example.org/w6') === 1, 'n=' + dataErrors('http://example.org/w6'));
})();

/* ---------------- 5. Bnodes botsen niet tussen bestanden ---------------- */

(function testBnodeSafety() {
  const a = `@prefix ex: <http://example.org/> . @prefix sh: <http://www.w3.org/ns/shacl#> .
ex:S a sh:NodeShape ; sh:targetClass ex:A ; sh:property [ sh:path ex:p ; sh:minCount 1 ] .`;
  const b = `@prefix ex: <http://example.org/> . @prefix sh: <http://www.w3.org/ns/shacl#> .
ex:S2 a sh:NodeShape ; sh:targetClass ex:B ; sh:property [ sh:path ex:q ; sh:minCount 1 ] .`;
  const shapes = shapesFrom(fileList({ 'a.ttl': a, 'b.ttl': b }));
  eq('bnode-collisie: 2 node shapes', shapes.nodeShapeCount, 2);
  eq('bnode-collisie: 2 property shapes', shapes.propertyShapeCount, 2);
  const model = M.buildModel(T.parse('@prefix ex: <http://example.org/> . ex:x a ex:A .'));
  const report = S.validate(model, shapes);
  const comps = componentsFor(report, 'http://example.org/x');
  check('bnode-collisie: alleen ex:A-shape geraakt', comps.length === 1 && comps[0] === 'MinCount', comps.join(','));
})();

/* ---------------- 6. Achtergrondkennis vult aan, verdubbelt niet ---------------- */

(function testBackgroundKnowledge() {
  const shapesText = `@prefix sh: <http://www.w3.org/ns/shacl#> .
@prefix ex: <http://example.org/> .
ex:CShape a sh:NodeShape ; sh:targetClass ex:C ;
  sh:property [ sh:path ex:p ; sh:minCount 1 ; sh:maxCount 1 ] ;
  sh:property [ sh:path ex:q ; sh:minCount 1 ] .
ex:x a ex:C ; ex:p "uit-de-achtergrond" ; ex:q "alleen-in-de-achtergrond" .
`;
  const shapes = shapesFrom(fileList({ 'bg.ttl': shapesText }));
  const model = M.buildModel(T.parse('@prefix ex: <http://example.org/> .\nex:x ex:p "uit-de-data" .\n'));
  const report = S.validate(model, shapes);
  const comps = componentsFor(report, 'http://example.org/x');
  eq('achtergrond: geen maxCount door dubbele waarde', comps.filter(c => c === 'MaxCount').length, 0);
  eq('achtergrond: ontbrekende eigenschap aangevuld', comps.filter(c => c === 'MinCount').length, 0);
  const vals = (report.resultsByNode.get('http://example.org/x') || []);
  eq('achtergrond: geen resultaten', vals.length, 0);
})();

/* ---------------- 7. Integratie tegen de voorbeeldbestanden van de
   gegevenskwaliteitsregistratie-repo. Draait alleen als die repo lokaal aanwezig is. */

(function testSampleIntegration() {
  const SRC = '/Users/dgreefhorst/Documents/GitHub/gegevenskwaliteitsregistratie';
  if (!fs.existsSync(SRC)) {
    console.log('  (integratietests overgeslagen: voorbeelddata-repo niet gevonden)');
    return;
  }
  const read = p => fs.readFileSync(path.join(SRC, p), 'utf8');
  const shapeText = name => fs.readFileSync(path.join(SHAPES_DIR, name), 'utf8');
  const run = (shapeNames, dataText) => {
    const shapes = shapesFrom(shapeNames.map(n => ({ name: n, text: shapeText(n) })));
    return S.validate(M.buildModel(T.parse(dataText)), shapes);
  };

  const mdto = run(['mdto-rdf-1.0-shacl.ttl'], read('dev/krt/extern/mdto-rdf-1.0-voorbeeldset-informatieobjecten-bestanden.ttl'));
  eq('integratie: MDTO voorbeeldset is conform', mdto.results.length, 0);

  const dcatOk = run(['dcat-ap-nl-SHACL.ttl'], read('dev/krt/extern/dcat-ap-nl-30-voorbeelddataset.ttl'));
  eq('integratie: DCAT voorbeelddataset is conform', dcatOk.results.length, 0);

  const dcatBad = run(['dcat-ap-nl-SHACL.ttl'], read('dev/krt/extern/dcat-ap-nl-30-negatief.ttl'));
  check('integratie: DCAT negatief levert overtredingen', dcatBad.results.length > 0, 'aantal=' + dcatBad.results.length);

  const sbbBad = run(['skos-ap-nl.ttl'], read('dev/krt/extern/nl-sbb-negatief.ttl'));
  const sbbComps = sbbBad.results.map(r => r.component);
  check('integratie: NL-SBB negatief mist verplichte velden', sbbComps.indexOf('MinCount') !== -1, sbbComps.join(','));
  check('integratie: NL-SBB negatief raakt SPARQL-regels', sbbComps.indexOf('Sparql') !== -1, sbbComps.join(','));

  const dqvBad = run(['dqv_shacl.ttl'], read('dev/krt/extern/fds-dqv-negatief.ttl'));
  const dqvComps = dqvBad.results.map(r => r.component);
  check('integratie: FDS-DQV negatief mist verplichte velden', dqvComps.indexOf('MinCount') !== -1, dqvComps.join(','));
  check('integratie: FDS-DQV negatief patroonfout', dqvComps.indexOf('Pattern') !== -1, dqvComps.join(','));

  // Het MIM-voorbeeld is conform: de ontologie vult ontbrekende eigenschappen
  // aan (naam, definitie, …), maar verdubbelt geen waarden die de data zelf al
  // heeft (zoals mim:identificatie). Zo blijven maxCount-regels kloppen.
  const mim = run(['mim-shapes.ttl', 'mim_ontologie.ttl'], read('public/mim.ttl'));
  eq('integratie: MIM-voorbeeld is conform', mim.results.length, 0);
})();

/* ---------------- 8. Voorgesteld datatype en defaultwaarde uit de shapes ----
   De app vult het datatype én de sh:defaultValue in het toevoegformulier voor
   met wat de shapes voorschrijven — ook als het datatype binnen sh:or als
   alternatief staat. */

(function testExpectedDatatypes() {
  const XSD = 'http://www.w3.org/2001/XMLSchema#';
  const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
  const MDTO = 'http://www.nationaalarchief.nl/mdto#';
  const MIM = 'http://modellen.mim-standaard.nl/def/mim#';

  const shapeText = name => fs.readFileSync(path.join(SHAPES_DIR, name), 'utf8');
  const shapes = shapesFrom([
    { name: 'mdto-rdf-1.0-shacl.ttl', text: shapeText('mdto-rdf-1.0-shacl.ttl') },
    { name: 'mdto-rdf-1.0.ttl', text: shapeText('mdto-rdf-1.0.ttl') },
    { name: 'mim-shapes.ttl', text: shapeText('mim-shapes.ttl') },
    { name: 'mim_ontologie.ttl', text: shapeText('mim_ontologie.ttl') }
  ]);
  const data = `@prefix mdto: <${MDTO}> .
@prefix mim: <${MIM}> .
mdto:dkg a mdto:DekkingInTijdGegevens .
mdto:obj a mdto:Object .
mim:gg a mim:Gegevensgroep .
mim:ot a mim:Objecttype .
`;
  const v = S.validate(M.buildModel(T.parse(data)), shapes).validator;
  const propShape = (focus, propPath) => v.propertyShapesFor(focus).find(p => p.path === propPath);
  const datatypesOf = (focus, propPath) => {
    const ps = propShape(focus, propPath);
    return ps && ps.expected ? (ps.expected.datatypes || [ps.expected.datatype]) : [];
  };

  eq('datatype: enkel sh:datatype xsd:string', datatypesOf(MDTO + 'obj', MDTO + 'naam').join(' '), XSD + 'string');

  const begin = datatypesOf(MDTO + 'dkg', MDTO + 'dekkingInTijdBeginDatum');
  eq('datatype: sh:or met drie alternatieven', begin.length, 3);
  eq('datatype: eerste alternatief is xsd:date', begin[0], XSD + 'date');
  check('datatype: xsd:gYearMonth zit erbij', begin.indexOf(XSD + 'gYearMonth') !== -1, begin.join(','));

  const mimNaam = datatypesOf(MIM + 'gg', MIM + 'naam');
  eq('datatype: MIM naam is tekst of taal-getagd', mimNaam.join(' '), XSD + 'string ' + RDF + 'langString');
  check('datatype: taal-tag toegestaan als een alternatief rdf:langString is',
    mimNaam.indexOf(RDF + 'langString') !== -1, mimNaam.join(','));
  check('datatype: geen taal-tag bij alleen xsd:date',
    begin.indexOf(RDF + 'langString') === -1, begin.join(','));

  const dv = propShape(MIM + 'ot', MIM + 'indicatieAbstractObject').defaultValue;
  eq('default: sh:defaultValue komt mee', dv && dv.value, 'false');
  eq('default: datatype van de defaultwaarde', dv && dv.datatype, XSD + 'boolean');
  check('default: geen defaultwaarde zonder sh:defaultValue',
    propShape(MIM + 'ot', MIM + 'naam').defaultValue === null, 'kreeg wel een default');
})();

/* ---------------- rapport ---------------- */

console.log('\n' + passed + ' geslaagd, ' + failed + ' gefaald');
if (failed) {
  console.log('\nMislukt:');
  failures.forEach(f => console.log('  - ' + f));
  process.exit(1);
}
