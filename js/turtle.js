/* Turtle/TriG/RDF parser — gedeeld tussen de app (browser) en de Node-tests.
   Hand-geschreven tokenizer + recursive-descent parser voor een praktische
   subset van Turtle én TriG: @prefix/@base, PN-prefixed names, volledige IRIs,
   blank nodes (gelabeld en [...] anoniem), RDF-collecties (...), getypeerde en
   taal-getagde literals incl. triple-quoted multi-line strings, 'a', ';' en
   ',' lijst-continuaties, commentaar. TriG voegt named graphs toe:
   `GRAPH <g> { … }`, `<g> { … }`, `_:g { … }` of een blok `{ … }` voor de
   standaardgraph. Elke triple in een named graph krijgt een `g`-term. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else {
    root.LDEdit = root.LDEdit || {};
    root.LDEdit.turtle = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function parseTurtle(text) {
    const prefixes = {};
    let base = null;
    const triples = []; // {s,p,o,g?} elk als {type:'uri'|'bnode'|'literal', value, datatype, lang}
    let i = 0;
    const n = text.length;
    let bnodeCounter = 0;
    // Huidige named graph (TriG); null betekent de standaardgraph.
    let graph = null;

    // Voegt een triple toe en onthoudt in welke graph hij staat (TriG).
    function emit(s, p, o) {
      const triple = { s, p, o };
      if (graph) triple.g = graph;
      triples.push(triple);
    }

    function error(msg) {
      const upto = text.slice(0, i);
      const line = upto.split('\n').length;
      throw new Error('Parsefout op regel ' + line + ': ' + msg);
    }

    function peek() { return text[i]; }
    function isWS(c) { return c === ' ' || c === '\t' || c === '\r' || c === '\n'; }

    function skipWS() {
      for (;;) {
        while (i < n && isWS(text[i])) i++;
        if (text[i] === '#') {
          while (i < n && text[i] !== '\n') i++;
        } else {
          break;
        }
      }
    }

    function startsWith(s) { return text.startsWith(s, i); }

    function readIRIREF() {
      // gaat ervan uit dat het huidige teken '<' is
      i++; // sla < over
      let start = i;
      let buf = '';
      while (i < n && text[i] !== '>') {
        if (text[i] === '\\') {
          buf += text.slice(start, i);
          i++;
          buf += unescapeChar();
          start = i;
        } else {
          i++;
        }
      }
      buf += text.slice(start, i);
      if (text[i] !== '>') error('onafgesloten IRI');
      i++; // sla > over
      return resolveIRI(buf);
    }

    function unescapeChar() {
      const c = text[i];
      if (c === 'u') {
        const hex = text.slice(i + 1, i + 5); i += 5;
        return String.fromCodePoint(parseInt(hex, 16));
      } else if (c === 'U') {
        const hex = text.slice(i + 1, i + 9); i += 9;
        return String.fromCodePoint(parseInt(hex, 16));
      } else {
        i++;
        const map = { n: '\n', t: '\t', r: '\r', '"': '"', "'": "'", '\\': '\\', b: '\b', f: '\f' };
        return map[c] !== undefined ? map[c] : c;
      }
    }

    function resolveIRI(iri) {
      if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(iri)) return iri; // absoluut
      if (base) {
        try { return new URL(iri, base).toString(); } catch (e) { return iri; }
      }
      return iri;
    }

    const PN_CHARS_BASE = /[A-Za-z\u00C0-\uFFFF]/;
    function isPNCharsStart(c) { return c && PN_CHARS_BASE.test(c); }
    function isPNChars(c) { return c && (PN_CHARS_BASE.test(c) || /[0-9_\-\u00B7]/.test(c)); }

    function readPN_PREFIX() {
      let start = i;
      if (!isPNCharsStart(text[i])) return null;
      i++;
      while (i < n && (isPNChars(text[i]) || text[i] === '.')) i++;
      // verwijder punten aan het einde
      let end = i;
      while (end > start && text[end - 1] === '.') end--;
      i = end;
      return text.slice(start, end);
    }

    function readPN_LOCAL() {
      let start = i;
      while (i < n) {
        const c = text[i];
        if (c === '\\') { i += 2; continue; }
        if (c === '%') { i += 3; continue; }
        if (isPNChars(c) || c === ':' || c === '.') { i++; continue; }
        break;
      }
      let end = i;
      while (end > start && text[end - 1] === '.') end--;
      i = end;
      let raw = text.slice(start, end);
      raw = raw.replace(/\\([_~.\-!$&'()*+,;=/?#@%])/g, '$1');
      return raw;
    }

    function readPrefixedName() {
      // leest Prefix:local, prefix mag leeg zijn
      let start = i;
      let prefix = '';
      const save = i;
      if (text[i] === ':') {
        prefix = '';
      } else {
        const p = readPN_PREFIX();
        if (p === null) { i = save; return null; }
        prefix = p;
      }
      if (text[i] !== ':') { i = save; return null; }
      i++; // sla dubbele punt over
      const local = readPN_LOCAL();
      const ns = prefixes[prefix];
      if (ns === undefined) error('onbekend prefix "' + prefix + '"');
      return ns + local;
    }

    function readBlankNodeLabel() {
      // gaat ervan uit dat _:
      i += 2;
      let start = i;
      if (!isPNCharsStart(text[i]) && !/[0-9]/.test(text[i])) error('ongeldig blank node label');
      i++;
      while (i < n && (isPNChars(text[i]) || text[i] === '.')) i++;
      let end = i;
      while (end > start && text[end - 1] === '.') end--;
      i = end;
      return '_:' + text.slice(start, end);
    }

    function readStringLiteral() {
      const quoteChar = text[i];
      let triple = false;
      if (text.startsWith(quoteChar.repeat(3), i)) { triple = true; i += 3; }
      else { i += 1; }
      const endSeq = triple ? quoteChar.repeat(3) : quoteChar;
      let start = i;
      let buf = '';
      while (i < n) {
        if (text[i] === '\\') {
          buf += text.slice(start, i);
          i++;
          buf += unescapeChar();
          start = i;
          continue;
        }
        if (text.startsWith(endSeq, i)) {
          buf += text.slice(start, i);
          i += endSeq.length;
          return buf;
        }
        i++;
      }
      error('onafgesloten string');
    }

    function readNumberOrOther() {
      let start = i;
      if (text[i] === '+' || text[i] === '-') i++;
      while (i < n && /[0-9]/.test(text[i])) i++;
      if (text[i] === '.') { i++; while (i < n && /[0-9]/.test(text[i])) i++; }
      if (text[i] === 'e' || text[i] === 'E') {
        i++;
        if (text[i] === '+' || text[i] === '-') i++;
        while (i < n && /[0-9]/.test(text[i])) i++;
      }
      return text.slice(start, i);
    }

    function parseCollection() {
      // gaat ervan uit dat het huidige teken '(' is
      i++; skipWS();
      const items = [];
      while (true) {
        skipWS();
        if (text[i] === ')') { i++; break; }
        const node = parseObjectTerm();
        items.push(node);
        skipWS();
      }
      // bouw RDF-liststructuur met bnodes
      if (items.length === 0) {
        return { type: 'uri', value: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#nil' };
      }
      let headBnode = null;
      let prevBnode = null;
      for (let k = 0; k < items.length; k++) {
        const b = { type: 'bnode', value: '_:coll' + (++bnodeCounter) };
        if (k === 0) headBnode = b;
        if (prevBnode) {
          emit(prevBnode, { type: 'uri', value: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#rest' }, b);
        }
        emit(b, { type: 'uri', value: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#first' }, items[k]);
        prevBnode = b;
      }
      emit(prevBnode, { type: 'uri', value: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#rest' }, { type: 'uri', value: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#nil' });
      return headBnode;
    }

    function parseBlankNodePropertyList() {
      // gaat ervan uit dat het huidige teken '[' is
      i++; skipWS();
      const subj = { type: 'bnode', value: '_:anon' + (++bnodeCounter) };
      if (text[i] === ']') { i++; return subj; }
      parsePredicateObjectList(subj);
      skipWS();
      if (text[i] !== ']') error('verwacht "]"');
      i++;
      return subj;
    }

    function parseObjectTerm() {
      skipWS();
      const c = text[i];
      if (c === '<') return { type: 'uri', value: readIRIREF() };
      if (c === '_' && text[i + 1] === ':') return { type: 'bnode', value: readBlankNodeLabel() };
      if (c === '[') return parseBlankNodePropertyList();
      if (c === '(') return parseCollection();
      if (c === '"' || c === "'") {
        const val = readStringLiteral();
        if (text[i] === '@') {
          i++;
          let start = i;
          while (i < n && /[A-Za-z0-9\-]/.test(text[i])) i++;
          return { type: 'literal', value: val, lang: text.slice(start, i) };
        } else if (text[i] === '^' && text[i + 1] === '^') {
          i += 2;
          let dt;
          if (text[i] === '<') dt = readIRIREF();
          else dt = readPrefixedName();
          return { type: 'literal', value: val, datatype: dt };
        }
        return { type: 'literal', value: val, datatype: 'http://www.w3.org/2001/XMLSchema#string' };
      }
      if (c === 't' && text.startsWith('true', i) && !isPNChars(text[i + 4])) {
        i += 4; return { type: 'literal', value: 'true', datatype: 'http://www.w3.org/2001/XMLSchema#boolean' };
      }
      if (c === 'f' && text.startsWith('false', i) && !isPNChars(text[i + 5])) {
        i += 5; return { type: 'literal', value: 'false', datatype: 'http://www.w3.org/2001/XMLSchema#boolean' };
      }
      if (/[0-9+\-.]/.test(c)) {
        const numStr = readNumberOrOther();
        if (numStr === '' || numStr === '+' || numStr === '-') {
          // geen getal, valt door naar prefixed name
        } else {
          let dt = 'http://www.w3.org/2001/XMLSchema#integer';
          if (numStr.indexOf('.') >= 0 || numStr.indexOf('e') >= 0 || numStr.indexOf('E') >= 0) dt = 'http://www.w3.org/2001/XMLSchema#decimal';
          return { type: 'literal', value: numStr, datatype: dt };
        }
      }
      const pn = readPrefixedName();
      if (pn !== null) return { type: 'uri', value: pn };
      error('onverwacht teken "' + c + '" bij object');
    }

    function parseVerb() {
      skipWS();
      if (text[i] === 'a' && isWS(text[i + 1])) {
        i++;
        return { type: 'uri', value: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type' };
      }
      if (text[i] === '<') return { type: 'uri', value: readIRIREF() };
      const pn = readPrefixedName();
      if (pn !== null) return { type: 'uri', value: pn };
      error('verwacht predicate');
    }

    function parsePredicateObjectList(subj) {
      while (true) {
        skipWS();
        if (text[i] === ';') { i++; skipWS(); continue; }
        if (text[i] === '.' || text[i] === '}' || text[i] === ']' || i >= n) return;
        const pred = parseVerb();
        skipWS();
        // objectlijst
        while (true) {
          const obj = parseObjectTerm();
          emit(subj, pred, obj);
          skipWS();
          if (text[i] === ',') { i++; skipWS(); continue; }
          break;
        }
        skipWS();
        if (text[i] === ';') {
          i++; skipWS();
          // kan einde statement zijn na trailing ';'
          if (text[i] === '.') { i++; return; }
          continue;
        }
        return;
      }
    }

    // "GRAPH" als los keyword (niet als prefixnaam zoals graph:foo).
    function isGraphKeyword() {
      if (!/^GRAPH$/i.test(text.slice(i, i + 5))) return false;
      const next = text[i + 5];
      return next === undefined || /\s/.test(next) || next === '<' || (next === '_' && text[i + 6] === ':');
    }

    // Leest het onderwerp van een triple of de naam van een graph. `graphLabel`
    // geeft aan of het resultaat ook als graphnaam mag dienen (IRI of bnode).
    function parseSubject() {
      if (text[i] === '<') return { term: { type: 'uri', value: readIRIREF() }, graphLabel: true };
      if (text[i] === '_' && text[i + 1] === ':') return { term: { type: 'bnode', value: readBlankNodeLabel() }, graphLabel: true };
      if (text[i] === '[') return { term: parseBlankNodePropertyList(), graphLabel: false };
      if (text[i] === '(') return { term: parseCollection(), graphLabel: false };
      const pn = readPrefixedName();
      if (pn === null) error('onverwacht teken "' + text[i] + '" bij subject');
      return { term: { type: 'uri', value: pn }, graphLabel: true };
    }

    // Eén triple-regel binnen een graph-block (of de standaardgraph).
    function parseTriplesStatement() {
      const { term } = parseSubject();
      skipWS();
      if (text[i] === '.') { i++; return; }
      parsePredicateObjectList(term);
      skipWS();
      if (text[i] === '.') i++;
    }

    // De inhoud van `{ … }`: alle triples erin horen bij graph `g` (of de
    // standaardgraph als `g` null is).
    function parseGraphBody(g) {
      if (text[i] !== '{') error('verwacht "{"');
      i++;
      const previous = graph;
      graph = g;
      for (;;) {
        skipWS();
        if (i >= n) error('onafgesloten graph');
        if (text[i] === '}') { i++; break; }
        parseTriplesStatement();
      }
      graph = previous;
    }

    function parseStatement() {
      skipWS();
      if (i >= n) return false;
      if (startsWith('@prefix') || startsWith('PREFIX') || startsWith('prefix')) {
        if (startsWith('@prefix')) { i += 7; }
        else { i += 6; }
        skipWS();
        let pname = readPN_PREFIX() || '';
        if (text[i] !== ':') error('verwacht ":" in prefix-declaratie');
        i++;
        skipWS();
        const iri = readIRIREF();
        prefixes[pname] = iri;
        skipWS();
        if (text[i] === '.') i++;
        return true;
      }
      if (startsWith('@base') || startsWith('BASE') || startsWith('base')) {
        if (startsWith('@base')) { i += 5; } else { i += 4; }
        skipWS();
        base = readIRIREF();
        skipWS();
        if (text[i] === '.') i++;
        return true;
      }
      // TriG: GRAPH <naam> { … }
      if (isGraphKeyword()) {
        i += 5;
        skipWS();
        const label = parseSubject();
        skipWS();
        parseGraphBody(label.term);
        return true;
      }
      // TriG: een blok zonder naam is de standaardgraph.
      if (text[i] === '{') {
        parseGraphBody(null);
        return true;
      }
      // subject (of graphnaam gevolgd door een blok)
      const { term: subj, graphLabel } = parseSubject();
      skipWS();
      if (graphLabel && text[i] === '{') {
        parseGraphBody(subj);
        return true;
      }
      if (text[i] === '.') { i++; return true; } // bare blank node statement (zeldzaam)
      parsePredicateObjectList(subj);
      skipWS();
      if (text[i] === '.') i++;
      return true;
    }

    while (true) {
      skipWS();
      if (i >= n) break;
      parseStatement();
    }

    return { prefixes, triples };
  }

  return { parse: parseTurtle };
});
