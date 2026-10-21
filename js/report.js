/* Rapportage — gedeeld tussen de app (browser) en de Node-tests.
   Bouwt uit een model een tabel (rijen = resources, kolommen = predicaten) en
   zet die om naar CSV. De standaardkolommen zijn skos:prefLabel en
   skos:definition als die in het model voorkomen, anders rdfs:label en
   rdfs:comment. Welke rijen meedoen bepaalt de app (soort- en klassefilter). */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else {
    root.LDEdit = root.LDEdit || {};
    root.LDEdit.report = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
  const RDFS = 'http://www.w3.org/2000/01/rdf-schema#';
  const SKOS = 'http://www.w3.org/2004/02/skos/core#';

  const PREF_LABELS = [SKOS + 'prefLabel', RDFS + 'label'];
  const DEFINITIONS = [SKOS + 'definition', RDFS + 'comment'];

  // De predicaten die in het model gebruikt worden (rdf:type uitgezonderd),
  // elk één keer.
  function predicatesInModel(model){
    const set = new Set();
    model.triples.forEach(t => { if(t.p.value !== RDF + 'type') set.add(t.p.value); });
    return [...set];
  }

  function pickColumn(present, candidates){
    return candidates.find(p => present.has(p)) || candidates[candidates.length - 1];
  }

  // Standaardkolommen: per kolom het skos-alternatief als het voorkomt, anders
  // het rdfs-alternatief.
  function defaultColumns(model){
    const present = new Set(predicatesInModel(model));
    return [pickColumn(present, PREF_LABELS), pickColumn(present, DEFINITIONS)];
  }

  function termText(model, term){
    if(term.type === 'literal') return term.value;
    if(term.type === 'bnode') return term.value;
    return model.curie(term.value);
  }

  // Alle waarden van één predicaat voor één subject.
  function cellValues(model, subjectUri, predicateUri){
    const node = model.nodes[subjectUri];
    if(!node) return [];
    return node.out.filter(e => e.p === predicateUri).map(e => termText(model, e.o));
  }

  // { header: [...], rows: [[...]] }. Eerste kolom is altijd de resource zelf.
  function buildTable(model, items, columns){
    const header = ['resource'].concat(columns.map(p => model.curie(p)));
    const rows = items.map(uri => [uri].concat(columns.map(p => cellValues(model, uri, p).join('; '))));
    return { header, rows };
  }

  function csvEscape(value){
    const s = value == null ? '' : String(value);
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  // CSV met UTF-8 BOM (voor Excel) en CRLF-regeleinden.
  function toCsv(table){
    const lines = [table.header.map(csvEscape).join(',')];
    table.rows.forEach(row => lines.push(row.map(csvEscape).join(',')));
    return '\uFEFF' + lines.join('\r\n') + '\r\n';
  }

  return { predicatesInModel, defaultColumns, cellValues, buildTable, toCsv, csvEscape };
});
