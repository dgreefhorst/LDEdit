/* Rapportage — gedeeld tussen de app (browser) en de Node-tests.
   Bouwt uit een model een tabel (rijen = resources, kolommen = predicaten) en
   zet die om naar CSV, een MediaWiki-tabel, HTML of Markdown.

   De standaardkolommen zijn skos:prefLabel en skos:definition als die in het
   model voorkomen, anders rdfs:label en rdfs:comment — maar alleen als die
   predicaten ook echt in het model gebruikt worden. Welke rijen meedoen bepaalt
   de app (soort- en klassefilter). De URI-kolom is optioneel. */
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

  // De predicaten die in het model gebruikt worden (rdf:type uitgezonderd).
  function predicatesInModel(model){
    const set = new Set();
    model.triples.forEach(t => { if(t.p.value !== RDF + 'type') set.add(t.p.value); });
    return [...set];
  }

  // Standaardkolommen: per kolom het skos-alternatief als het voorkomt, anders
  // het rdfs-alternatief — en alleen als dat predicaat daadwerkelijk in het model
  // voorkomt.
  function defaultColumns(model){
    const present = new Set(predicatesInModel(model));
    return [
      PREF_LABELS.find(p => present.has(p)),
      DEFINITIONS.find(p => present.has(p))
    ].filter(Boolean);
  }

  function termText(model, term){
    if(term.type === 'literal') return term.value;
    if(term.type === 'bnode') return term.value;
    return model.curie(term.value);
  }

  function cellValues(model, subjectUri, predicateUri){
    const node = model.nodes[subjectUri];
    if(!node) return [];
    return node.out.filter(e => e.p === predicateUri).map(e => termText(model, e.o));
  }

  // { header, rows }. De URI-kolom staat vooraan, tenzij includeResource false is.
  function buildTable(model, items, columns, options){
    const includeResource = !(options && options.includeResource === false);
    const header = (includeResource ? ['URI'] : []).concat(columns.map(p => model.curie(p)));
    const rows = items.map(uri => {
      const rest = columns.map(p => cellValues(model, uri, p).join('; '));
      return includeResource ? [uri].concat(rest) : rest;
    });
    return { header, rows };
  }

  /* ---------------- CSV ---------------- */

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

  /* ---------------- MediaWiki ---------------- */

  function wikiEscape(value){
    const s = value == null ? '' : String(value);
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/\|/g, '&#124;').replace(/\r?\n/g, '<br>');
  }

  function toMediaWiki(table){
    const lines = ['{| class="wikitable"', '|-'];
    lines.push('! ' + table.header.map(wikiEscape).join(' !! '));
    table.rows.forEach(row => {
      lines.push('|-');
      lines.push('| ' + row.map(wikiEscape).join(' || '));
    });
    lines.push('|}');
    return lines.join('\n') + '\n';
  }

  /* ---------------- HTML ---------------- */

  function htmlEscape(value){
    const s = value == null ? '' : String(value);
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/\r?\n/g, '<br>');
  }

  function toHtml(table){
    const head = table.header.map(h => '<th>' + htmlEscape(h) + '</th>').join('');
    const body = table.rows.map(row =>
      '<tr>' + row.map(c => '<td>' + htmlEscape(c) + '</td>').join('') + '</tr>'
    ).join('\n');
    return '<!DOCTYPE html>\n<html lang="nl">\n<head>\n<meta charset="utf-8">\n' +
      '<title>Rapportage</title>\n<style>\n' +
      'table{border-collapse:collapse}\nth,td{border:1px solid #999;padding:4px 8px;text-align:left;vertical-align:top}\n' +
      '</style>\n</head>\n<body>\n<table>\n<thead><tr>' + head + '</tr></thead>\n<tbody>\n' +
      body + '\n</tbody>\n</table>\n</body>\n</html>\n';
  }

  /* ---------------- Markdown ---------------- */

  function markdownEscape(value){
    const s = value == null ? '' : String(value);
    return s.replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>');
  }

  function toMarkdown(table){
    const line = row => '| ' + row.map(markdownEscape).join(' | ') + ' |';
    const sep = '| ' + table.header.map(() => '---').join(' | ') + ' |';
    return [line(table.header), sep].concat(table.rows.map(line)).join('\n') + '\n';
  }

  return {
    predicatesInModel, defaultColumns, cellValues, buildTable,
    toCsv, toMediaWiki, toHtml, toMarkdown, csvEscape
  };
});
