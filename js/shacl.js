/* SHACL-engine — parseert één of meer SHACL-shape-bestanden (Turtle), bouwt
   een shapes-register en valideert een datamodel tegen die shapes.

   Ondersteunde constraint-componenten:
     - sh:minCount / sh:maxCount
     - sh:datatype / sh:class / sh:nodeKind
     - sh:pattern (+ sh:flags) / sh:minLength / sh:maxLength
     - sh:in / sh:hasValue
     - sh:minInclusive / sh:maxInclusive / sh:minExclusive / sh:maxExclusive
     - sh:languageIn / sh:uniqueLang
     - sh:node / sh:or / sh:and / sh:not / sh:xone / sh:property
     - sh:closed (+ sh:ignoredProperties)
     - sh:qualifiedValueShape (+ sh:qualifiedMinCount / sh:qualifiedMaxCount)
     - sh:equals / sh:disjoint
     - sh:sparql / sh:select (beperkte SPARQL-subset)

   Niet-ondersteunde constructies worden als 'info'-resultaat gemeld, zodat er
   niets stil wordt overgeslagen. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else {
    root.LDEdit = root.LDEdit || {};
    root.LDEdit.shacl = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
  const RDFS = 'http://www.w3.org/2000/01/rdf-schema#';
  const SH = 'http://www.w3.org/ns/shacl#';
  const XSD = 'http://www.w3.org/2001/XMLSchema#';

  function getParser() {
    if (typeof module === 'object' && module.exports) return require('./turtle.js');
    return (typeof window !== 'undefined' && window.LDEdit && window.LDEdit.turtle) || null;
  }
  function parseTurtle(text) {
    const p = getParser();
    if (!p) throw new Error('Turtle-parser niet beschikbaar');
    return (p.parse || p)(text);
  }

  /* ================= shapes-graaf ================= */

  // Voegt geparseerde bestanden samen; bnodes krijgen een bestands-prefix zodat
  // labels uit verschillende bestanden niet botsen.
  function mergeGraphs(parsedList) {
    const triples = [];
    const prefixes = {};
    const files = [];
    parsedList.forEach((parsed, fileIdx) => {
      const map = {};
      const rekey = (term) => {
        if (!term || term.type !== 'bnode') return term;
        if (!map[term.value]) map[term.value] = '_:f' + fileIdx + '_' + term.value.slice(2);
        return { type: 'bnode', value: map[term.value] };
      };
      parsed.triples.forEach(t => { triples.push({ s: rekey(t.s), p: t.p, o: rekey(t.o) }); });
      Object.assign(prefixes, parsed.prefixes || {});
      files.push({
        index: fileIdx,
        name: parsed.name || ('bestand-' + fileIdx),
        tripleCount: parsed.triples.length
      });
    });
    return { triples, prefixes, files };
  }

  function parseShapeFiles(fileList) {
    const parsedList = fileList.map(f => {
      const parsed = parseTurtle(f.text) || { prefixes: {}, triples: [] };
      parsed.name = f.name;
      return parsed;
    });
    return mergeGraphs(parsedList);
  }

  function makeGraph(triples) {
    const byS = new Map();
    triples.forEach(t => {
      const s = t.s.value;
      let m = byS.get(s);
      if (!m) { m = new Map(); byS.set(s, m); }
      if (!m.has(t.p.value)) m.set(t.p.value, []);
      m.get(t.p.value).push(t.o);
    });
    return {
      byS,
      out(subjValue, pred) { const m = byS.get(subjValue); return (m && m.get(pred)) || []; },
      first(subjValue, pred) { const a = this.out(subjValue, pred); return a.length ? a[0] : null; },
      subjects() { return [...byS.keys()]; }
    };
  }

  function isListNode(g, term) { return term && g.first(term.value, RDF + 'first') !== null; }

  function readList(g, term) {
    const items = [];
    let cur = term;
    const seen = new Set();
    while (cur && cur.value !== RDF + 'nil') {
      if (seen.has(cur.value)) break;
      seen.add(cur.value);
      const first = g.first(cur.value, RDF + 'first');
      if (first) items.push(first);
      cur = g.first(cur.value, RDF + 'rest');
      if (!cur) break;
    }
    return items;
  }

  const CONSTRAINT_PREDS = [
    'minCount', 'maxCount', 'datatype', 'class', 'nodeKind', 'pattern', 'minLength',
    'maxLength', 'in', 'hasValue', 'minInclusive', 'maxInclusive', 'minExclusive',
    'maxExclusive', 'languageIn', 'uniqueLang', 'node', 'or', 'and', 'not', 'xone',
    'closed', 'property', 'path', 'sparql', 'qualifiedValueShape', 'qualifiedMinCount',
    'qualifiedMaxCount', 'equals', 'disjoint', 'lessThan', 'lessThanOrEquals'
  ].map(p => SH + p);

  function buildShapes(graphInput) {
    const g = (graphInput && typeof graphInput.out === 'function') ? graphInput : makeGraph((graphInput && graphInput.triples) || []);
    const prefixes = (graphInput && graphInput.prefixes) || {};
    const shapeIds = new Set();
    g.subjects().forEach(s => {
      if (CONSTRAINT_PREDS.some(p => g.out(s, p).length)) shapeIds.add(s);
    });

    const targetIndex = { class: new Map(), node: new Map(), subjOf: new Map(), objOf: new Map() };
    const addTo = (map, key, id) => {
      if (!map.has(key)) map.set(key, []);
      const arr = map.get(key);
      if (arr.indexOf(id) === -1) arr.push(id);
    };
    shapeIds.forEach(id => {
      g.out(id, SH + 'targetClass').forEach(t => addTo(targetIndex.class, t.value, id));
      g.out(id, SH + 'targetNode').forEach(t => addTo(targetIndex.node, t.value, id));
      g.out(id, SH + 'targetSubjectsOf').forEach(t => addTo(targetIndex.subjOf, t.value, id));
      g.out(id, SH + 'targetObjectsOf').forEach(t => addTo(targetIndex.objOf, t.value, id));
    });

    const nodeShapeCount = [...shapeIds].filter(id => !g.first(id, SH + 'path')).length;
    const propertyShapeCount = [...shapeIds].filter(id => g.first(id, SH + 'path')).length;

    // Achtergrondkennis uit de gemarkeerde bestanden: rdf:type-asserties en
    // rdfs:subClassOf. Zo werkt een meegeleverde ontologie (bv. mim_ontologie.ttl)
    // mee bij sh:class- en sh:targetClass-controles zonder de dataview te vervuilen.
    const bgTypes = new Map();
    g.byS.forEach((m, s) => {
      const types = m.get(RDF + 'type');
      if (types) types.forEach(t => { if (t.type === 'uri') addTo(bgTypes, s, t.value); });
    });

    return {
      graph: g,
      shapeIds,
      prefixes,
      targetIndex,
      bgTypes,
      nodeShapeCount,
      propertyShapeCount,
      labelOf(id) {
        const name = g.first(id, SH + 'name');
        if (name && name.type === 'literal') return name.value;
        const lbl = g.first(id, RDFS + 'label');
        if (lbl && lbl.type === 'literal') return lbl.value;
        const m = id.match(/([#\/])([^#\/]+)$/);
        return m ? m[2] : id;
      },
      isPropertyShape(id) { return g.first(id, SH + 'path') !== null; },
      propertyShapes(id) { return g.out(id, SH + 'property').map(t => t.value); },
      sparqlConstraints(id) { return g.out(id, SH + 'sparql'); }
    };
  }

  // Parseert shape-bestanden en bouwt direct het shapes-register.
  function loadShapes(fileList) {
    const merged = parseShapeFiles(fileList);
    return { merged, shapes: buildShapes(merged) };
  }

  /* ================= pad-expressies ================= */

  function pathOf(g, term) {
    if (!term) return null;
    if (term.type === 'uri') return { kind: 'pred', iri: term.value };
    const inv = g.first(term.value, SH + 'inversePath');
    if (inv) return { kind: 'inverse', sub: pathOf(g, inv) };
    const alt = g.first(term.value, SH + 'alternativePath');
    if (alt) return { kind: 'alt', subs: readList(g, alt).map(t => pathOf(g, t)) };
    const zom = g.first(term.value, SH + 'zeroOrMorePath');
    if (zom) return { kind: 'zeroOrMore', sub: pathOf(g, zom) };
    const oom = g.first(term.value, SH + 'oneOrMorePath');
    if (oom) return { kind: 'oneOrMore', sub: pathOf(g, oom) };
    if (isListNode(g, term)) return { kind: 'sequence', subs: readList(g, term).map(t => pathOf(g, t)) };
    return { kind: 'unsupported' };
  }

  function pathPrimaryIri(path) {
    if (!path) return null;
    if (path.kind === 'pred') return path.iri;
    if (path.kind === 'inverse' && path.sub) return pathPrimaryIri(path.sub);
    return null;
  }

  function pathLabel(path) {
    if (!path) return '';
    if (path.kind === 'pred') return path.iri;
    if (path.kind === 'inverse') return '^' + pathLabel(path.sub);
    if (path.kind === 'sequence') return '(' + path.subs.map(pathLabel).join(' / ') + ')';
    if (path.kind === 'alt') return '(' + path.subs.map(pathLabel).join(' | ') + ')';
    return '(pad)';
  }

  function valuesForPath(model, focusValue, path) {
    const node = model.nodes[focusValue];
    if (!node || !path) return [];
    if (path.kind === 'pred') return node.out.filter(o => o.p === path.iri).map(o => o.o);
    if (path.kind === 'inverse') {
      if (path.sub && path.sub.kind === 'pred') return node.in.filter(e => e.p === path.sub.iri).map(e => e.s);
      return [];
    }
    if (path.kind === 'sequence') {
      let cur = [{ type: node.isBnode ? 'bnode' : 'uri', value: focusValue }];
      path.subs.forEach(sub => {
        const next = [];
        cur.forEach(t => valuesForPath(model, t.value, sub).forEach(v => next.push(v)));
        cur = next;
      });
      return cur;
    }
    if (path.kind === 'alt') {
      const out = [];
      path.subs.forEach(sub => valuesForPath(model, focusValue, sub).forEach(v => out.push(v)));
      return out;
    }
    if (path.kind === 'oneOrMore' || path.kind === 'zeroOrMore') {
      const out = [];
      const seen = new Set();
      let frontier = path.kind === 'zeroOrMore'
        ? [{ type: node.isBnode ? 'bnode' : 'uri', value: focusValue }]
        : valuesForPath(model, focusValue, path.sub);
      frontier.forEach(t => { if (!seen.has(t.value)) { seen.add(t.value); out.push(t); } });
      let guard = 0;
      while (frontier.length && guard++ < 10000) {
        const next = [];
        frontier.forEach(t => valuesForPath(model, t.value, path.sub).forEach(v => {
          if (!seen.has(v.value)) { seen.add(v.value); out.push(v); next.push(v); }
        }));
        frontier = next;
      }
      return out;
    }
    return [];
  }

  /* ================= term-hulpjes ================= */

  function sameTerm(a, b) {
    if (!a || !b) return false;
    return a.type === b.type && a.value === b.value &&
      (a.datatype || '') === (b.datatype || '') && (a.lang || '') === (b.lang || '');
  }

  function termLabel(term, model) {
    if (!term) return '';
    if (term.type === 'literal') {
      let s = '"' + term.value + '"';
      if (term.lang) s += '@' + term.lang;
      else if (term.datatype && term.datatype !== XSD + 'string') s += '^^' + (model ? model.curie(term.datatype) : term.datatype);
      return s;
    }
    return model ? model.labelOf(term.value) : term.value;
  }

  function localName(uri, model) {
    if (model) { const c = model.curie(uri); if (c !== uri) return c; }
    const m = uri.match(/([#\/])([^#\/]+)$/);
    return m ? m[2] : uri;
  }

  /* ================= subklasse-redenering ================= */

  function buildSubclassIndex(model, shapes) {
    const parents = new Map();
    const add = (child, parent) => {
      if (!parents.has(child)) parents.set(child, new Set());
      parents.get(child).add(parent);
    };
    model.triples.forEach(t => {
      if (t.p.value === RDFS + 'subClassOf' && t.s.type !== 'literal' && t.o.type === 'uri') add(t.s.value, t.o.value);
    });
    if (shapes && shapes.graph) {
      shapes.graph.byS.forEach((m, s) => {
        const sp = m.get(RDFS + 'subClassOf');
        if (sp) sp.forEach(t => { if (t.type === 'uri') add(s, t.value); });
      });
    }
    return parents;
  }

  function superclassesOf(parents, cls) {
    const out = new Set([cls]);
    const stack = [cls];
    while (stack.length) {
      const c = stack.pop();
      const ps = parents.get(c);
      if (!ps) continue;
      ps.forEach(p => { if (!out.has(p)) { out.add(p); stack.push(p); } });
    }
    return out;
  }

  /* ================= validatie ================= */

  const NODE_KINDS = {
    [SH + 'IRI']: ['uri'],
    [SH + 'BlankNode']: ['bnode'],
    [SH + 'Literal']: ['literal'],
    [SH + 'BlankNodeOrIRI']: ['uri', 'bnode'],
    [SH + 'IRIOrLiteral']: ['uri', 'literal'],
    [SH + 'BlankNodeOrLiteral']: ['bnode', 'literal']
  };
  const NODE_KIND_LABELS = {
    [SH + 'IRI']: 'een IRI', [SH + 'BlankNode']: 'een blanco node', [SH + 'Literal']: 'een literal',
    [SH + 'BlankNodeOrIRI']: 'een IRI of blanco node', [SH + 'IRIOrLiteral']: 'een IRI of literal',
    [SH + 'BlankNodeOrLiteral']: 'een blanco node of literal'
  };
  const NUMERIC_DT = /integer|decimal|double|float|int|long|short|byte|unsigned|positiveInteger|negativeInteger|nonNegativeInteger|nonPositiveInteger/;

  function numericValue(term) {
    if (term.type !== 'literal' || !NUMERIC_DT.test(term.datatype || '')) return null;
    const n = Number(term.value);
    return Number.isNaN(n) ? null : n;
  }

  /* --- sh:datatype volgens de SHACL-specificatie ---------------------------
     De waarde moet een literal zijn met precies het opgegeven datatype.
     Een taal-getagde literal heeft rdf:langString; een gewone literal xsd:string. */
  // Korte, herkenbare naam voor een datatype (xsd:string, rdf:langString).
  function datatypeName(iri, model) {
    const known = [['http://www.w3.org/2001/XMLSchema#', 'xsd:'], ['http://www.w3.org/1999/02/22-rdf-syntax-ns#', 'rdf:']];
    for (let i = 0; i < known.length; i++) {
      if (iri.indexOf(known[i][0]) === 0) return known[i][1] + iri.slice(known[i][0].length);
    }
    return localName(iri, model);
  }

  function shaclDatatypeCheck(term, dt, model) {
    const expected = datatypeName(dt, model);
    if (term.type !== 'literal') return { ok: false, label: 'een literal van het type ' + expected };
    const actual = term.datatype || (term.lang ? RDF + 'langString' : XSD + 'string');
    return { ok: actual === dt, label: 'een literal van het type ' + expected, actual: datatypeName(actual, model) };
  }

  function createValidator(model, shapes) {
    const g = shapes.graph;
    const parents = buildSubclassIndex(model, shapes);
    const seen = new Set();

    // Typen van een knooppunt, inclusief overerving én achtergrondkennis uit de
    // gemarkeerde shape/ontologie-bestanden.
    function typesOf(value) {
      const set = new Set();
      const node = model.nodes[value];
      if (node) node.types.forEach(t => superclassesOf(parents, t).forEach(x => set.add(x)));
      const bg = shapes.bgTypes && shapes.bgTypes.get(value);
      if (bg) bg.forEach(t => superclassesOf(parents, t).forEach(x => set.add(x)));
      return set;
    }

    function messageOf(shapeId, fallback) {
      const msgs = g.out(shapeId, SH + 'message');
      if (msgs.length) {
        const nl = msgs.find(m => m.lang === 'nl');
        return (nl || msgs[0]).value;
      }
      return fallback;
    }

    // Een shape heeft vaak één sh:message voor meerdere constraints. De
    // concrete reden gaat daarom apart mee als 'detail', zodat de melding het
    // werkelijke probleem niet verbergt.
    function msg(shapeId, fallback) {
      const message = messageOf(shapeId, fallback);
      return message === fallback ? { message } : { message, detail: fallback };
    }

    function severityOf(shapeId) {
      const s = g.first(shapeId, SH + 'severity');
      if (s) {
        if (s.value === SH + 'Warning') return 'warning';
        if (s.value === SH + 'Info') return 'info';
      }
      return 'violation';
    }

    function base(focus, extra) {
      return Object.assign({
        focusNode: focus, path: null, pathLabel: null, value: null,
        component: null, severity: 'violation', message: '', detail: null, shapeId: null
      }, extra);
    }

    function checkValueConstraints(focus, value, shapeId, pathIri, resultsArr, depth) {
      const sev = severityOf(shapeId);
      const push = (component, fallback, extra) => resultsArr.push(base(focus, Object.assign({
        path: pathIri, value, component, severity: sev,
        ...msg(shapeId, fallback), shapeId
      }, extra || {})));

      g.out(shapeId, SH + 'datatype').forEach(dt => {
        const res = shaclDatatypeCheck(value, dt.value, model);
        if (!res.ok) push('Datatype', 'Waarde moet ' + res.label + ' zijn' + (res.actual ? ' (nu: ' + res.actual + ')' : ''));
      });

      g.out(shapeId, SH + 'class').forEach(cls => {
        if (value.type === 'literal') { push('Class', 'Waarde moet een ' + localName(cls.value, model) + ' zijn, maar is een literal'); return; }
        if (!typesOf(value.value).has(cls.value)) push('Class', 'Waarde moet een ' + localName(cls.value, model) + ' zijn');
      });

      g.out(shapeId, SH + 'nodeKind').forEach(nk => {
        const allowed = NODE_KINDS[nk.value];
        if (allowed && allowed.indexOf(value.type) === -1) push('NodeKind', 'Waarde moet ' + (NODE_KIND_LABELS[nk.value] || localName(nk.value, model)) + ' zijn');
      });

      const pat = g.first(shapeId, SH + 'pattern');
      if (pat) {
        const flagsTerm = g.first(shapeId, SH + 'flags');
        const flags = flagsTerm ? flagsTerm.value.replace(/[^imsu]/g, '') : '';
        let re = null;
        try { re = new RegExp(pat.value, flags); } catch (e) { re = null; }
        if (re && !re.test(value.value)) push('Pattern', 'Waarde "' + value.value + '" voldoet niet aan patroon /' + pat.value + '/');
      }

      const minLen = g.first(shapeId, SH + 'minLength');
      if (minLen && String(value.value).length < Number(minLen.value)) push('MinLength', 'Waarde moet minimaal ' + minLen.value + ' tekens bevatten');
      const maxLen = g.first(shapeId, SH + 'maxLength');
      if (maxLen && String(value.value).length > Number(maxLen.value)) push('MaxLength', 'Waarde mag maximaal ' + maxLen.value + ' tekens bevatten');

      const inList = g.first(shapeId, SH + 'in');
      if (inList && !readList(g, inList).some(a => sameTerm(a, value))) push('In', 'Waarde moet één van de toegestane waarden zijn');

      const langIn = g.first(shapeId, SH + 'languageIn');
      if (langIn) {
        const langs = readList(g, langIn).map(t => t.value.toLowerCase());
        if (!value.lang || langs.indexOf(value.lang.toLowerCase()) === -1) push('LanguageIn', 'Taal van de waarde moet één van ' + langs.join(', ') + ' zijn');
      }

      [['minInclusive', '>='], ['maxInclusive', '<='], ['minExclusive', '>'], ['maxExclusive', '<']].forEach(([pred, op]) => {
        const lim = g.first(shapeId, SH + pred);
        if (!lim) return;
        const n = numericValue(value);
        const l = numericValue(lim);
        if (n === null || l === null) { push('Comparable', 'Kan waarde niet vergelijken met ' + lim.value); return; }
        const ok = op === '>=' ? n >= l : op === '<=' ? n <= l : op === '>' ? n > l : n < l;
        if (!ok) push('Range', 'Waarde moet ' + op + ' ' + lim.value + ' zijn');
      });

      g.out(shapeId, SH + 'hasValue').forEach(hv => {
        if (!sameTerm(hv, value)) push('HasValue', 'Waarde moet ' + termLabel(hv, model) + ' zijn');
      });

      g.out(shapeId, SH + 'node').forEach(n => {
        if (!conforms(value, n.value, depth + 1)) push('Node', 'Waarde voldoet niet aan shape ' + shapes.labelOf(n.value));
      });

      const orList = g.first(shapeId, SH + 'or');
      if (orList) {
        const alts = readList(g, orList);
        if (!alts.length) push('Or', 'sh:or zonder alternatieven');
        else if (!alts.some(a => conforms(value, a.value, depth + 1))) push('Or', 'Waarde voldoet aan geen van de toegestane vormen');
      }
      const andList = g.first(shapeId, SH + 'and');
      if (andList) {
        readList(g, andList).forEach(a => { if (!conforms(value, a.value, depth + 1)) push('And', 'Waarde voldoet niet aan alle vereiste vormen'); });
      }
      const notShape = g.first(shapeId, SH + 'not');
      if (notShape && conforms(value, notShape.value, depth + 1)) push('Not', 'Waarde mag niet aan shape ' + shapes.labelOf(notShape.value) + ' voldoen');
      const xone = g.first(shapeId, SH + 'xone');
      if (xone) {
        const count = readList(g, xone).filter(a => conforms(value, a.value, depth + 1)).length;
        if (count !== 1) push('Xone', 'Waarde moet aan precies één vorm voldoen (nu: ' + count + ')');
      }
    }

    function conforms(value, shapeId, depth) {
      if (depth > 25) return true;
      const key = shapeId + '|' + value.value + '|' + (value.type || '');
      if (seen.has(key)) return true;
      seen.add(key);
      const out = [];
      const path = shapes.isPropertyShape(shapeId) ? pathOf(g, g.first(shapeId, SH + 'path')) : null;
      if (path) validatePropertyShape(value, shapeId, path, out, depth);
      else validateNodeConstraints(value, shapeId, out, depth);
      seen.delete(key);
      return out.length === 0;
    }

    function validateNodeConstraints(focus, shapeId, resultsArr, depth) {
      checkValueConstraints(focus, focus, shapeId, null, resultsArr, depth);

      const closed = g.first(shapeId, SH + 'closed');
      if (closed && closed.value === 'true') {
        const allowed = new Set();
        const igList = g.first(shapeId, SH + 'ignoredProperties');
        if (igList) readList(g, igList).forEach(t => allowed.add(t.value));
        shapes.propertyShapes(shapeId).forEach(ps => {
          const iri = pathPrimaryIri(pathOf(g, g.first(ps, SH + 'path')));
          if (iri) allowed.add(iri);
        });
        const node = model.nodes[focus.value];
        if (node) {
          const bad = new Set();
          node.out.forEach(o => { if (!allowed.has(o.p)) bad.add(o.p); });
          bad.forEach(p => resultsArr.push(base(focus, {
            component: 'Closed', severity: severityOf(shapeId),
            ...msg(shapeId, 'Eigenschap ' + localName(p, model) + ' is niet toegestaan'), shapeId
          })));
        }
      }

      shapes.propertyShapes(shapeId).forEach(psId => {
        const path = pathOf(g, g.first(psId, SH + 'path'));
        if (!path) return;
        validatePropertyShape(focus, psId, path, resultsArr, depth);
      });

      validateSparql(focus, shapeId, resultsArr);
    }

    function validatePropertyShape(focus, shapeId, path, resultsArr, depth) {
      const values = valuesForPath(model, focus.value, path);
      const pathIri = pathPrimaryIri(path);
      const sev = severityOf(shapeId);

      const minCount = g.first(shapeId, SH + 'minCount');
      if (minCount && values.length < Number(minCount.value)) {
        resultsArr.push(base(focus, {
          path: pathIri, pathLabel: pathLabel(path), value: null, component: 'MinCount', severity: sev,
          ...msg(shapeId, 'Verplichte eigenschap ontbreekt (minimaal ' + minCount.value + ')'),
          shapeId, minCount: Number(minCount.value), actualCount: values.length
        }));
      }
      const maxCount = g.first(shapeId, SH + 'maxCount');
      if (maxCount && values.length > Number(maxCount.value)) {
        resultsArr.push(base(focus, {
          path: pathIri, pathLabel: pathLabel(path), value: null, component: 'MaxCount', severity: sev,
          ...msg(shapeId, 'Te veel waarden (maximaal ' + maxCount.value + ', nu ' + values.length + ')'),
          shapeId, maxCount: Number(maxCount.value), actualCount: values.length
        }));
      }

      const uniqueLang = g.first(shapeId, SH + 'uniqueLang');
      if (uniqueLang && uniqueLang.value === 'true') {
        const seenLang = new Set();
        values.forEach(v => {
          if (!v.lang) return;
          if (seenLang.has(v.lang)) resultsArr.push(base(focus, { path: pathIri, value: v, component: 'UniqueLang', severity: sev, ...msg(shapeId, 'Dubbele taal-tag @' + v.lang), shapeId }));
          seenLang.add(v.lang);
        });
      }

      const qvs = g.first(shapeId, SH + 'qualifiedValueShape');
      if (qvs) {
        const conforming = values.filter(v => conforms(v, qvs.value, depth + 1)).length;
        const qmin = g.first(shapeId, SH + 'qualifiedMinCount');
        const qmax = g.first(shapeId, SH + 'qualifiedMaxCount');
        if (qmin && conforming < Number(qmin.value)) resultsArr.push(base(focus, { path: pathIri, component: 'QualifiedMinCount', severity: sev, ...msg(shapeId, 'Minimaal ' + qmin.value + ' waarde(n) moeten aan de shape voldoen (nu ' + conforming + ')'), shapeId }));
        if (qmax && conforming > Number(qmax.value)) resultsArr.push(base(focus, { path: pathIri, component: 'QualifiedMaxCount', severity: sev, ...msg(shapeId, 'Maximaal ' + qmax.value + ' waarde(n) mogen aan de shape voldoen (nu ' + conforming + ')'), shapeId }));
      }

      const eq = g.first(shapeId, SH + 'equals');
      if (eq) {
        const other = valuesForPath(model, focus.value, pathOf(g, eq));
        if (values.map(v => v.value).sort().join('|') !== other.map(v => v.value).sort().join('|')) {
          resultsArr.push(base(focus, { path: pathIri, component: 'Equals', severity: sev, ...msg(shapeId, 'Waarden moeten gelijk zijn aan ' + pathLabel(pathOf(g, eq))), shapeId }));
        }
      }
      const dj = g.first(shapeId, SH + 'disjoint');
      if (dj) {
        const other = valuesForPath(model, focus.value, pathOf(g, dj)).map(v => v.value);
        if (values.some(v => other.indexOf(v.value) !== -1)) {
          resultsArr.push(base(focus, { path: pathIri, component: 'Disjoint', severity: sev, ...msg(shapeId, 'Waarden mogen niet ook via ' + pathLabel(pathOf(g, dj)) + ' voorkomen'), shapeId }));
        }
      }

      values.forEach(v => checkValueConstraints(focus, v, shapeId, pathIri, resultsArr, depth));

      validateSparql(focus, shapeId, resultsArr);
    }

    function validateSparql(focus, shapeId, resultsArr) {
      shapes.sparqlConstraints(shapeId).forEach(c => {
        const select = g.first(c.value, SH + 'select');
        if (!select) return;
        const sev = severityOf(c.value);
        let solutions;
        try {
          solutions = evalSparql(select.value, focus, resolveQueryPrefixes(c.value, shapeId), model);
        } catch (e) {
          resultsArr.push(base(focus, {
            component: 'SparqlUnsupported', severity: 'info',
            message: 'SPARQL-constraint niet geëvalueerd (' + e.message + '): ' + (messageOf(c.value, '(select-query)')),
            shapeId
          }));
          return;
        }
        if (solutions.length > 0) {
          resultsArr.push(base(focus, { component: 'Sparql', severity: sev, ...msg(c.value, 'Voldoet niet aan SPARQL-constraint'), shapeId }));
        }
      });
    }

    function resolveQueryPrefixes(constraintId, shapeId) {
      const map = Object.assign({}, shapes.prefixes);
      const collect = (holder) => {
        g.out(holder, SH + 'declare').forEach(d => {
          const p = g.first(d.value, SH + 'prefix');
          const ns = g.first(d.value, SH + 'namespace');
          if (p && ns) map[p.value] = ns.value;
        });
      };
      [constraintId, shapeId].forEach(id => {
        if (!id) return;
        g.out(id, SH + 'prefixes').forEach(t => collect(t.value));
      });
      return map;
    }

    function applicableShapes(focusValue) {
      const ids = new Set();
      const node = model.nodes[focusValue];
      if (!node) return ids;
      (shapes.targetIndex.node.get(focusValue) || []).forEach(id => ids.add(id));
      node.out.forEach(o => (shapes.targetIndex.subjOf.get(o.p) || []).forEach(id => ids.add(id)));
      node.in.forEach(e => (shapes.targetIndex.objOf.get(e.p) || []).forEach(id => ids.add(id)));
      typesOf(focusValue).forEach(t => (shapes.targetIndex.class.get(t) || []).forEach(id => ids.add(id)));
      return ids;
    }

    function validateNode(focusValue) {
      const node = model.nodes[focusValue];
      const focus = { type: node && node.isBnode ? 'bnode' : 'uri', value: focusValue };
      const out = [];
      applicableShapes(focusValue).forEach(id => {
        if (shapes.isPropertyShape(id)) validatePropertyShape(focus, id, pathOf(g, g.first(id, SH + 'path')), out, 0);
        else validateNodeConstraints(focus, id, out, 0);
      });
      return out;
    }

    // Datatypes die binnen sh:or als alternatief staan, bijvoorbeeld
    // [ sh:datatype xsd:date ] [ sh:datatype xsd:gYearMonth ].
    function datatypesInOr(psId) {
      const out = [];
      g.out(psId, SH + 'or').forEach(listTerm => {
        readList(g, listTerm).forEach(item => {
          g.out(item.value, SH + 'datatype').forEach(t => {
            if (out.indexOf(t.value) === -1) out.push(t.value);
          });
        });
      });
      return out;
    }

    function expectedTypeOf(psId) {
      const dts = g.out(psId, SH + 'datatype').map(t => t.value);
      const alts = dts.length ? dts : datatypesInOr(psId);
      if (alts.length) return { kind: 'literal', datatype: alts[0], datatypes: alts };
      const nk = g.first(psId, SH + 'nodeKind');
      if (nk && NODE_KINDS[nk.value]) return { kind: 'nodeKind', nodeKind: nk.value, types: NODE_KINDS[nk.value] };
      const cls = g.first(psId, SH + 'class');
      if (cls) return { kind: 'class', class: cls.value };
      return null;
    }

    function collectPropertyShapes(focusValue, onlyRequired) {
      const list = [];
      applicableShapes(focusValue).forEach(id => {
        const propIds = shapes.isPropertyShape(id) ? [id] : shapes.propertyShapes(id);
        propIds.forEach(psId => {
          const path = pathOf(g, g.first(psId, SH + 'path'));
          const pathIri = pathPrimaryIri(path);
          if (!pathIri) return;
          const minCount = Number(((g.first(psId, SH + 'minCount') || {}).value) || 0);
          if (onlyRequired && minCount < 1) return;
          list.push({
            shapeId: psId, path: pathIri, minCount,
            maxCount: g.first(psId, SH + 'maxCount') ? Number(g.first(psId, SH + 'maxCount').value) : null,
            expected: expectedTypeOf(psId),
            defaultValue: g.first(psId, SH + 'defaultValue'),
            label: shapes.labelOf(psId),
            name: (g.first(psId, SH + 'name') || {}).value || null,
            message: (g.first(psId, SH + 'message') || {}).value || null
          });
        });
      });
      const byPath = new Map();
      list.forEach(r => { if (!byPath.has(r.path)) byPath.set(r.path, r); });
      return [...byPath.values()];
    }

    return {
      parents,
      applicableShapeIds: applicableShapes,
      validateNode,
      requiredPropertyShapes: (v) => collectPropertyShapes(v, true),
      propertyShapesFor: (v) => collectPropertyShapes(v, false)
    };
  }

  /* ================= SPARQL-subset ================= */

  function tokenizeSparql(s) {
    const toks = [];
    let i = 0;
    const n = s.length;
    const isNameChar = c => /[A-Za-z0-9_\u00C0-\uFFFF]/.test(c);
    while (i < n) {
      const c = s[i];
      if (/\s/.test(c)) { i++; continue; }
      if (c === '#') { while (i < n && s[i] !== '\n') i++; continue; }
      if (c === '<' && /^<[^<>\s]*>/.test(s.slice(i))) {
        const j = s.indexOf('>', i);
        toks.push({ t: 'iri', v: s.slice(i + 1, j) });
        i = j + 1;
        continue;
      }
      const two = s.slice(i, i + 2);
      if (two === '!=' || two === '<=' || two === '>=') { toks.push({ t: 'op', v: two }); i += 2; continue; }
      if ('{}().;|^,='.indexOf(c) !== -1) { toks.push({ t: 'punc', v: c }); i++; continue; }
      if (c === '!' || c === '<' || c === '>') { toks.push({ t: 'op', v: c }); i++; continue; }
      if (c === '"' || c === "'") {
        const q = c; i++; let buf = '';
        while (i < n && s[i] !== q) { if (s[i] === '\\') { buf += s[i + 1]; i += 2; } else { buf += s[i]; i++; } }
        i++;
        const term = { t: 'lit', v: buf, lang: null, datatype: null };
        if (s[i] === '@') { i++; const st = i; while (i < n && /[A-Za-z0-9-]/.test(s[i])) i++; term.lang = s.slice(st, i); }
        else if (s[i] === '^' && s[i + 1] === '^') {
          i += 2;
          if (s[i] === '<') { const j = s.indexOf('>', i); term.datatype = s.slice(i + 1, j); i = j + 1; }
          else { const st = i; while (i < n && /[\w:.\-]/.test(s[i])) i++; term.datatype = s.slice(st, i); }
        }
        toks.push(term); continue;
      }
      if (c === '$' || c === '?') { const st = i; i++; while (i < n && isNameChar(s[i])) i++; toks.push({ t: 'var', v: s.slice(st + 1, i) }); continue; }
      if (/[0-9]/.test(c) || ((c === '+' || c === '-') && /[0-9]/.test(s[i + 1]))) { const st = i; i++; while (i < n && /[0-9.eE+\-]/.test(s[i])) i++; toks.push({ t: 'lit', v: s.slice(st, i), datatype: null }); continue; }
      if (c === ':') { i++; const st = i; while (i < n && isNameChar(s[i])) i++; toks.push({ t: 'name', v: ':' + s.slice(st, i) }); continue; }
      if (/[A-Za-z_]/.test(c)) {
        const st = i; while (i < n && isNameChar(s[i])) i++;
        const word = s.slice(st, i);
        if (s[i] === ':') { i++; const ls = i; while (i < n && isNameChar(s[i])) i++; toks.push({ t: 'name', v: word + ':' + s.slice(ls, i) }); continue; }
        toks.push({ t: 'kw', v: word.toUpperCase() }); continue;
      }
      throw new Error('onverwacht teken in query: ' + c);
    }
    return toks;
  }

  function parseSparql(query) {
    const toks = tokenizeSparql(query);
    let p = 0;
    const peek = () => toks[p];
    const next = () => toks[p++];
    if (!peek() || peek().t !== 'kw' || peek().v !== 'SELECT') throw new Error('geen SELECT');
    next();
    while (peek() && !(peek().t === 'punc' && peek().v === '{')) next();
    if (!peek()) throw new Error('geen WHERE-groep');

    function parseTerm() {
      const t = next();
      if (!t) throw new Error('onverwacht einde van query');
      if (t.t === 'var') return { kind: 'var', name: t.v };
      if (t.t === 'name') return { kind: 'curie', value: t.v };
      if (t.t === 'iri') return { kind: 'iri', value: t.v };
      if (t.t === 'lit') return { kind: 'literal', term: { type: 'literal', value: t.v, lang: t.lang || undefined, datatype: t.datatype || undefined } };
      if (t.t === 'kw' && t.v === 'A') return { kind: 'iri', value: RDF + 'type' };
      throw new Error('onverwachte term in query');
    }

    function parsePathAlt() {
      const subs = [];
      for (;;) {
        let inv = false;
        if (peek() && peek().t === 'punc' && peek().v === '^') { next(); inv = true; }
        const term = parseTerm();
        if (term.kind !== 'iri' && term.kind !== 'curie') throw new Error('pad moet een IRI of verkorte naam zijn');
        subs.push({ inv, term });
        if (peek() && peek().t === 'punc' && peek().v === '|') { next(); continue; }
        break;
      }
      return subs;
    }

    function parseTriples() {
      const out = [];
      const s = parseTerm();
      for (;;) {
        const preds = parsePathAlt();
        for (;;) {
          const o = parseTerm();
          preds.forEach(pr => out.push({ s, pred: pr, o }));
          if (peek() && peek().t === 'punc' && peek().v === ',') { next(); continue; }
          break;
        }
        if (peek() && peek().t === 'punc' && peek().v === ';') {
          next();
          if (peek() && peek().t === 'punc' && peek().v === '.') break;
          continue;
        }
        break;
      }
      if (peek() && peek().t === 'punc' && peek().v === '.') next();
      return out;
    }

    function parseGroup() {
      if (!(peek() && peek().t === 'punc' && peek().v === '{')) throw new Error('verwacht {');
      next();
      const items = [];
      while (peek() && !(peek().t === 'punc' && peek().v === '}')) {
        if (peek().t === 'kw' && peek().v === 'FILTER') { items.push(parseFilter()); continue; }
        if (peek().t === 'kw' && (peek().v === 'OPTIONAL' || peek().v === 'UNION' || peek().v === 'BIND' ||
          peek().v === 'VALUES' || peek().v === 'MINUS' || peek().v === 'GRAPH' || peek().v === 'SERVICE' ||
          peek().v === 'GROUP' || peek().v === 'ORDER' || peek().v === 'LIMIT')) {
          throw new Error('niet-ondersteunde SPARQL-constructie: ' + peek().v);
        }
        items.push(...parseTriples());
      }
      if (!peek()) throw new Error('onafgesloten WHERE-groep');
      next();
      return { kind: 'group', items };
    }

    function parseFilter() {
      next(); // FILTER
      let negate = false;
      if (peek() && peek().t === 'kw' && peek().v === 'NOT') { negate = true; next(); }
      if (peek() && peek().t === 'kw' && peek().v === 'EXISTS') { next(); return { kind: 'exists', negate, group: parseGroup() }; }
      if (peek() && peek().t === 'punc' && peek().v === '(') {
        next();
        const a = parseTerm();
        const opTok = next();
        const b = parseTerm();
        if (!opTok || (opTok.t !== 'op' && opTok.t !== 'punc') || (opTok.v !== '=' && opTok.v !== '!=')) throw new Error('alleen = en != in FILTER');
        if (peek() && peek().t === 'punc' && peek().v === ')') next();
        return { kind: 'filter', a, op: opTok.v, b };
      }
      throw new Error('onbekende FILTER-vorm');
    }

    return parseGroup();
  }

  function evalSparql(query, focusTerm, prefixMap, model) {
    if (!focusTerm) return [];
    const group = parseSparql(query);
    const focus = { type: focusTerm.type || 'uri', value: focusTerm.value };

    function resolveCurie(v) {
      if (v[0] === ':') return (prefixMap[''] || '') + v.slice(1);
      const idx = v.indexOf(':');
      const pfx = v.slice(0, idx);
      if (prefixMap[pfx] === undefined) throw new Error('onbekend prefix ' + pfx);
      return prefixMap[pfx] + v.slice(idx + 1);
    }

    function termFrom(node, b) {
      if (node.kind === 'var') return b[node.name] || null;
      if (node.kind === 'iri') return { type: 'uri', value: node.value };
      if (node.kind === 'curie') return { type: 'uri', value: resolveCurie(node.value) };
      if (node.kind === 'literal') return node.term;
      return null;
    }

    function evalFilter(expr, b) {
      const left = termFrom(expr.a, b);
      const right = termFrom(expr.b, b);
      if (!left || !right) return false;
      return expr.op === '=' ? sameTerm(left, right) : !sameTerm(left, right);
    }

    function evalGroup(groupObj, bindingsList) {
      let current = bindingsList;
      for (const item of groupObj.items) {
        if (current.length === 0) break;
        if (item.kind === 'exists') {
          current = current.filter(b => {
            const inner = evalGroup(item.group, [Object.assign({}, b)]);
            return item.negate ? inner.length === 0 : inner.length > 0;
          });
        } else if (item.kind === 'filter') {
          current = current.filter(b => evalFilter(item, b));
        } else {
          const next = [];
          current.forEach(b => {
            const cands = [];
            if (item.s.kind === 'var' && !b[item.s.name]) {
              Object.keys(model.nodes).forEach(sv => cands.push({ type: model.nodes[sv].isBnode ? 'bnode' : 'uri', value: sv }));
            } else {
              const st = termFrom(item.s, b);
              if (st) cands.push(st);
            }
            const wantPred = item.pred.term.kind === 'iri' ? item.pred.term.value : resolveCurie(item.pred.term.value);
            cands.forEach(subj => {
              const node = model.nodes[subj.value];
              if (!node) return;
              const pairs = item.pred.inv
                ? node.in.filter(e => e.p === wantPred).map(e => e.s)
                : node.out.filter(o => o.p === wantPred).map(o => o.o);
              pairs.forEach(objTerm => {
                const nb = Object.assign({}, b);
                if (item.s.kind === 'var') {
                  if (nb[item.s.name] && !sameTerm(nb[item.s.name], subj)) return;
                  nb[item.s.name] = subj;
                }
                if (item.o.kind === 'var') {
                  if (nb[item.o.name] && !sameTerm(nb[item.o.name], objTerm)) return;
                  nb[item.o.name] = objTerm;
                } else if (!sameTerm(termFrom(item.o, b), objTerm)) return;
                next.push(nb);
              });
            });
          });
          current = next;
        }
      }
      return current;
    }

    return evalGroup(group, [{ this: focus }]);
  }

  /* ================= publieke API ================= */

  // Valideerbeeld: het datamodel, aangevuld met achtergrondtriples uit de
  // gemarkeerde shape-/ontologie-bestanden. Zo werkt een meegeleverde ontologie
  // (bv. mim_ontologie.ttl) mee bij rdf:type- en rdfs:subClassOf-redenering voor
  // sh:class- en sh:targetClass-controles, zonder de dataview van de app te wijzigen.
  function augmentModelWithBackground(model, shapes) {
    const g = shapes.graph;
    const bgOut = new Map();
    const bgIn = new Map();
    const nodeType = v => (v.indexOf('_:') === 0 ? 'bnode' : 'uri');
    g.byS.forEach((m, s) => {
      const outs = [];
      m.forEach((objs, p) => objs.forEach(o => outs.push({ p, o })));
      if (outs.length) bgOut.set(s, outs);
      m.forEach((objs, p) => objs.forEach(o => {
        if (o.type === 'literal') return;
        if (!bgIn.has(o.value)) bgIn.set(o.value, []);
        bgIn.get(o.value).push({ p, s: { type: nodeType(s), value: s } });
      }));
    });
    const key = (p, term) => p + '|' + (term.type || '') + '|' + term.value + '|' + (term.datatype || '') + '|' + (term.lang || '');
    const nodes = {};
    Object.keys(model.nodes).forEach(v => {
      const n = model.nodes[v];
      const extraOut = bgOut.get(v) || [];
      const extraIn = bgIn.get(v) || [];
      const types = new Set(n.types);
      const out = n.out.slice();
      const inEdges = n.in.slice();
      const haveOut = new Set(out.map(e => key(e.p, e.o)));
      // Predicaten die de data zelf al invult: achtergrondkennis vult alleen
      // ontbrekende eigenschappen aan en verdubbelt bestaande waarden niet.
      const dataPreds = new Set(out.map(e => e.p));
      const mergeAlways = p => p === RDF + 'type' || p === RDFS + 'subClassOf';
      extraOut.forEach(e => {
        if (e.p === RDF + 'type' && e.o.type === 'uri') types.add(e.o.value);
        if (haveOut.has(key(e.p, e.o))) return;
        if (!mergeAlways(e.p) && dataPreds.has(e.p)) return;
        out.push(e);
      });
      const haveIn = new Set(inEdges.map(e => key(e.p, e.s)));
      extraIn.forEach(e => { if (!haveIn.has(key(e.p, e.s))) inEdges.push(e); });
      nodes[v] = { id: n.id, isBnode: n.isBnode, out, in: inEdges, types };
    });
    return Object.assign({}, model, { nodes });
  }

  function validate(model, shapes) {
    const vmodel = augmentModelWithBackground(model, shapes);
    const validator = createValidator(vmodel, shapes);
    const resultsByNode = new Map();
    const all = [];
    Object.keys(vmodel.nodes).forEach(value => {
      const node = vmodel.nodes[value];
      if (node.isBnode && node.out.length === 0) return;
      let res = [];
      try { res = validator.validateNode(value); } catch (e) { res = []; }
      if (res.length) {
        resultsByNode.set(value, res);
        res.forEach(r => all.push(r));
      }
    });
    return { resultsByNode, results: all, validator, model: vmodel };
  }

  return {
    SH, RDF, RDFS, XSD,
    parseShapeFiles, mergeGraphs, makeGraph, buildShapes, loadShapes,
    pathOf, pathLabel, pathPrimaryIri, valuesForPath, sameTerm,
    augmentModelWithBackground,
    validate, createValidator, parseSparql, evalSparql
  };
});
