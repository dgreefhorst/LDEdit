/* Turtle-serialisatie — gedeeld tussen de app (browser) en de Node-tests.
   Schrijft een model (prefixes + triples) als Turtle, met behoud van structuur:

   - een blanco node die maar één keer als waarde gebruikt wordt, komt inline in
     de bovenliggende resource als `[ … ]` (bijv. `sh:property [ sh:path … ]`);
   - een goed gevormde RDF-collectie waarvan de knooppunten elk één keer gebruikt
     worden, wordt weer `( … )`;
   - blanco nodes die vaker gebruikt worden, in een cyclus zitten of een
     afwijkende lijst vormen, krijgen een eigen `_:id`-blok;
   - getallen/booleans met de standaard xsd-lexicale vorm worden zonder datatype
     geschreven (`1` in plaats van `"1"^^xsd:integer`).

   `serializeSubject` levert het blok van één subject plus de id's van de blanco
   nodes die daarin inline zijn geschreven, zodat de app die bij het bewerken
   weet te vervangen. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else {
    root.LDEdit = root.LDEdit || {};
    root.LDEdit.serialize = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
  const XSD = 'http://www.w3.org/2001/XMLSchema#';
  const RDF_TYPE = RDF + 'type';
  const RDF_FIRST = RDF + 'first';
  const RDF_REST = RDF + 'rest';
  const RDF_NIL = RDF + 'nil';

  const XSD_INTEGER = XSD + 'integer';
  const XSD_DECIMAL = XSD + 'decimal';
  const XSD_DOUBLE = XSD + 'double';
  const XSD_BOOLEAN = XSD + 'boolean';

  const SAFE_PN_LOCAL = /^[A-Za-z0-9_][A-Za-z0-9_.\-]*[A-Za-z0-9_\-]$|^[A-Za-z0-9_]$/;

  function escapeLiteralBody(v){ return v.replace(/\\/g,'\\\\').replace(/"/g,'\\"'); }

  // Bare (datatype-loze) vorm voor de standaard xsd-typen, of null. Alleen
  // wanneer de lexicale vorm exact zo ook als dat type terugkomt.
  function bareValue(term){
    const v = term.value;
    if(term.datatype === XSD_BOOLEAN && (v === 'true' || v === 'false')) return v;
    if(term.datatype === XSD_INTEGER && /^[+-]?\d+$/.test(v)) return v;
    if(term.datatype === XSD_DECIMAL && /^[+-]?(\d+\.\d*|\.\d+)$/.test(v)) return v;
    if(term.datatype === XSD_DOUBLE && /^[+-]?(\d+(\.\d*)?|\.\d+)[eE][+-]?\d+$/.test(v)) return v;
    return null;
  }

  function uriToTurtle(model, uri){
    const c = model.curie(uri);
    if(c === uri) return '<' + uri + '>';
    const local = c.slice(c.indexOf(':') + 1);
    if(local.length > 0 && SAFE_PN_LOCAL.test(local)) return c;
    return '<' + uri + '>';
  }

  function literalToTurtle(model, term){
    if(!term.lang && term.datatype){
      const bare = bareValue(term);
      if(bare !== null) return bare;
    }
    const v = term.value;
    let body;
    if(v.indexOf('\n') >= 0 || v.indexOf('"') >= 0){
      body = '"""' + v.replace(/\\/g,'\\\\').replace(/"""/g,'\\"\\"\\"') + '"""';
    } else {
      body = '"' + escapeLiteralBody(v) + '"';
    }
    if(term.lang) return body + '@' + term.lang;
    if(term.datatype && term.datatype !== XSD+'string') return body + '^^' + uriToTurtle(model, term.datatype);
    return body;
  }

  function termToTurtle(model, term, isPredicate){
    if(term.type === 'uri'){
      if(isPredicate && term.value === RDF_TYPE) return 'a';
      return uriToTurtle(model, term.value);
    }
    if(term.type === 'bnode') return term.value;
    return literalToTurtle(model, term);
  }

  function buildIndex(triples){
    const order = [];
    const byKey = new Map();
    triples.forEach(t => {
      const key = t.s.type + ':' + t.s.value;
      let e = byKey.get(key);
      if(!e){ e = { key, term: t.s, preds: new Map(), predOrder: [] }; byKey.set(key, e); order.push(key); }
      if(!e.preds.has(t.p.value)){ e.preds.set(t.p.value, []); e.predOrder.push(t.p.value); }
      e.preds.get(t.p.value).push(t.o);
    });
    return { order, byKey };
  }

  function referenceInfo(triples){
    const count = new Map();
    const parent = new Map();
    triples.forEach(t => {
      if(t.o.type === 'bnode'){
        count.set(t.o.value, (count.get(t.o.value) || 0) + 1);
        parent.set(t.o.value, t.s.type + ':' + t.s.value);
      }
    });
    return { count, parent };
  }

  // Bouwt alle afgeleide informatie en de renderfuncties voor een model.
  function prepare(model){
    const index = buildIndex(model.triples);
    const { count, parent } = referenceInfo(model.triples);

    const isListNode = id => {
      const e = index.byKey.get('bnode:' + id);
      return Boolean(e && e.preds.has(RDF_FIRST));
    };
    const isCandidate = id => count.get(id) === 1 && index.byKey.has('bnode:' + id) && !isListNode(id);

    function reachable(id){
      let cur = id;
      const seen = new Set();
      for(;;){
        if(seen.has(cur)) return false;
        seen.add(cur);
        const p = parent.get(cur);
        if(!p) return false;
        if(!p.startsWith('bnode:')) return true;
        const pid = p.slice('bnode:'.length);
        if(count.get(pid) !== 1 || isListNode(pid)) return true;
        cur = pid;
      }
    }

    const inlined = new Set();
    index.order.forEach(key => {
      if(!key.startsWith('bnode:')) return;
      const id = key.slice('bnode:'.length);
      if(isCandidate(id) && reachable(id)) inlined.add(id);
    });

    function tryList(headId){
      const items = [];
      const chain = [];
      let cur = headId;
      const seen = new Set();
      for(;;){
        if(seen.has(cur)) return null;
        seen.add(cur);
        const e = index.byKey.get('bnode:' + cur);
        if(!e || e.preds.size !== 2) return null;
        const first = e.preds.get(RDF_FIRST);
        const rest = e.preds.get(RDF_REST);
        if(!first || first.length !== 1 || !rest || rest.length !== 1) return null;
        if(count.get(cur) !== 1) return null;
        items.push(first[0]);
        chain.push(cur);
        const rr = rest[0];
        if(rr.type === 'uri' && rr.value === RDF_NIL) return { items, chain };
        if(rr.type !== 'bnode') return null;
        cur = rr.value;
      }
    }

    const lists = new Map();
    index.order.forEach(key => {
      if(!key.startsWith('bnode:')) return;
      const id = key.slice('bnode:'.length);
      if(!isListNode(id) || count.get(id) !== 1) return;
      const res = tryList(id);
      if(res && reachable(id)) lists.set(id, res);
    });

    const consumed = new Set(inlined);
    lists.forEach(info => info.chain.forEach(id => consumed.add(id)));

    const stack = new Set();

    function objectStr(o){
      if(o.type === 'bnode' && !stack.has(o.value)){
        if(lists.has(o.value)) return listStr(o.value);
        if(inlined.has(o.value)) return inlineBnode(o.value);
      }
      return termToTurtle(model, o, false);
    }

    function inlineBnode(id){
      const e = index.byKey.get('bnode:' + id);
      if(!e) return termToTurtle(model, { type:'bnode', value:id }, false);
      stack.add(id);
      const parts = e.predOrder.map(pUri => {
        const predStr = termToTurtle(model, { type:'uri', value:pUri }, true);
        const objs = e.preds.get(pUri).map(objectStr).join(', ');
        return predStr + ' ' + objs;
      });
      stack.delete(id);
      return parts.length ? '[ ' + parts.join(' ; ') + ' ]' : '[]';
    }

    function listStr(id){
      stack.add(id);
      const inner = lists.get(id).items.map(objectStr).join(' ');
      stack.delete(id);
      return inner ? '( ' + inner + ' )' : '( )';
    }

    // Het blok (subject + predicaten) van één subject, zonder prefixregels.
    function blockText(key){
      const e = index.byKey.get(key);
      if(!e) return '';
      const subjStr = termToTurtle(model, e.term, false);
      const lines = e.predOrder.map(pUri => {
        const predStr = termToTurtle(model, { type:'uri', value:pUri }, true);
        const objStr = e.preds.get(pUri).map(objectStr).join(', ');
        return '    ' + predStr + ' ' + objStr;
      });
      return subjStr + '\n' + lines.join(' ;\n') + ' .\n\n';
    }

    function prefixBlock(){
      let out = '';
      Object.keys(model.prefixes).sort().forEach(p => { out += '@prefix ' + p + ': <' + model.prefixes[p] + '> .\n'; });
      return out + '\n';
    }

    return { index, consumed, lists, inlined, blockText, prefixBlock };
  }

  function serialize(model){
    const b = prepare(model);
    let out = b.prefixBlock();
    b.index.order.forEach(key => {
      if(key.startsWith('bnode:') && b.consumed.has(key.slice('bnode:'.length))) return;
      out += b.blockText(key);
    });
    return out;
  }

  // Het Turtle-blok van één subject, plus de id's van de blanco nodes die daarin
  // inline zijn geschreven (die horen dus bij dit blok).
  function serializeSubject(model, subjectKey){
    const b = prepare(model);
    const consumed = new Set();
    const visit = key => {
      const e = b.index.byKey.get(key);
      if(!e) return;
      e.predOrder.forEach(p => e.preds.get(p).forEach(o => {
        if(o.type === 'bnode' && b.consumed.has(o.value) && !consumed.has(o.value)){
          consumed.add(o.value);
          visit('bnode:' + o.value);
        }
      }));
    };
    visit(subjectKey);
    return { text: b.blockText(subjectKey), consumed: [...consumed] };
  }

  return { serialize, serializeSubject, uriToTurtle, termToTurtle, literalToTurtle };
});
