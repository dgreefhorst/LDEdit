/* RDF-modelopbouw — gedeeld tussen de app (browser) en de Node-tests.
   Bouwt uit de geparseerde triples een node-register plus afgeleide lijsten
   (klassen, eigenschappen, relaties, instanties) en label/curie-hulpjes. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else {
    root.LDEdit = root.LDEdit || {};
    root.LDEdit.model = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
  const RDFS = 'http://www.w3.org/2000/01/rdf-schema#';
  const OWL = 'http://www.w3.org/2002/07/owl#';
  const SKOS = 'http://www.w3.org/2004/02/skos/core#';
  const SHACL = 'http://www.w3.org/ns/shacl#';
  const XSD = 'http://www.w3.org/2001/XMLSchema#';

  const CORE_NS = [RDF, RDFS, OWL, SHACL, XSD];

  function isCoreURI(uri) {
    return CORE_NS.some(ns => uri.startsWith(ns));
  }

  const LABEL_PREDS = [RDFS + 'label', SKOS + 'prefLabel', 'http://purl.org/dc/terms/title', 'http://xmlns.com/foaf/0.1/name', SKOS + 'notation'];
  const DESC_PREDS = [RDFS + 'comment', SKOS + 'definition', SKOS + 'scopeNote', 'http://purl.org/dc/terms/description'];

  // Veelvoorkomende vocabulaires, standaard beschikbaar in elk model. Een
  // prefix uit het bestand zelf heeft altijd voorrang.
  const COMMON_PREFIXES = [
    ['rdf', RDF],
    ['rdfs', RDFS],
    ['owl', OWL],
    ['xsd', XSD],
    ['sh', SHACL],
    ['skos', SKOS],
    ['skosxl', 'http://www.w3.org/2008/05/skos-xl#'],
    ['dct', 'http://purl.org/dc/terms/'],
    ['dc', 'http://purl.org/dc/elements/1.1/'],
    ['dcat', 'http://www.w3.org/ns/dcat#'],
    ['dcatap', 'http://data.europa.eu/r5r/'],
    ['dqv', 'http://www.w3.org/ns/dqv#'],
    ['prov', 'http://www.w3.org/ns/prov#'],
    ['foaf', 'http://xmlns.com/foaf/0.1/'],
    ['vcard', 'http://www.w3.org/2006/vcard/ns#'],
    ['adms', 'http://www.w3.org/ns/adms#'],
    ['schema', 'https://schema.org/'],
    ['void', 'http://rdfs.org/ns/void#'],
    ['time', 'http://www.w3.org/2006/time#'],
    ['mim', 'http://modellen.mim-standaard.nl/def/mim#'],
    ['mdto', 'http://www.nationaalarchief.nl/mdto#']
  ];

  function buildModel(parsed, options) {
    const { prefixes, triples } = parsed;
    // Bij een bestaand bestand met eigen prefixes gebruiken we uitsluitend die
    // prefixes — zowel voor de weergave als bij het opslaan. Alleen wanneer het
    // bestand zelf geen enkele prefix declareert vullen we aan met de
    // standaardprefixen, zodat er altijd iets te kiezen valt.
    const useFilePrefixes = options && options.useFilePrefixes === true;
    const hasFilePrefixes = Object.keys(prefixes).length > 0;
    if (!(useFilePrefixes && hasFilePrefixes)) {
      COMMON_PREFIXES.forEach(([prefix, ns]) => {
        if (prefixes[prefix] === undefined) prefixes[prefix] = ns;
      });
    }
    const invPrefixes = {};
    Object.keys(prefixes).forEach(p => { invPrefixes[prefixes[p]] = p; });

    // node-register: key = uri of bnode-id
    const nodes = {}; // key -> {uri, isBnode, out:[{p,o}], in:[{p,s}], types:Set}

    function getNode(term) {
      const key = term.value;
      if (!nodes[key]) nodes[key] = { id: key, isBnode: term.type === 'bnode', out: [], in: [], types: new Set() };
      return nodes[key];
    }

    triples.forEach(t => {
      const sNode = getNode(t.s);
      if (t.o.type !== 'literal') {
        const oNode = getNode(t.o);
        sNode.out.push({ p: t.p.value, o: t.o });
        oNode.in.push({ p: t.p.value, s: t.s });
      } else {
        sNode.out.push({ p: t.p.value, o: t.o });
      }
      if (t.p.value === RDF + 'type' && t.o.type === 'uri') {
        sNode.types.add(t.o.value);
      }
    });

    // classificeer gedeclareerde klassen / eigenschappen
    const declaredClasses = new Set();
    const declaredObjProps = new Set();
    const declaredDataProps = new Set();
    const declaredProps = new Set();

    Object.values(nodes).forEach(node => {
      node.types.forEach(t => {
        if (t === RDFS + 'Class' || t === OWL + 'Class') declaredClasses.add(node.id);
        if (t === OWL + 'ObjectProperty') declaredObjProps.add(node.id);
        if (t === OWL + 'DatatypeProperty') declaredDataProps.add(node.id);
        if (t === RDF + 'Property') declaredProps.add(node.id);
      });
    });

    // predicate-gebruiksstatistieken
    const predUsage = {}; // uri -> {literal:bool, resource:bool, count:number}
    triples.forEach(t => {
      if (!predUsage[t.p.value]) predUsage[t.p.value] = { literal: false, resource: false, count: 0 };
      predUsage[t.p.value].count++;
      if (t.o.type === 'literal') predUsage[t.p.value].literal = true;
      else predUsage[t.p.value].resource = true;
    });

    // elk rdf:type-doel van een subject is een "gebruikte klasse"; elk als Class
    // gedeclareerd knooppunt is een "klasse"
    const usedAsClass = new Set();
    Object.values(nodes).forEach(node => {
      node.types.forEach(t => usedAsClass.add(t));
    });

    const allClassURIs = new Set([...declaredClasses, ...usedAsClass].filter(u => !isCoreURI(u)));

    // eigenschappen: gedeclareerd als eigenschapstype, OF ergens als predicate gebruikt
    const allPropURIs = new Set();
    [...declaredObjProps, ...declaredDataProps, ...declaredProps].forEach(u => { if (!isCoreURI(u)) allPropURIs.add(u); });
    Object.keys(predUsage).forEach(u => { if (!isCoreURI(u) && u !== RDF + 'type') allPropURIs.add(u); });

    function classifyProp(uri) {
      if (declaredObjProps.has(uri)) return 'relatie';
      if (declaredDataProps.has(uri)) return 'eigenschap';
      const usage = predUsage[uri];
      if (usage) {
        if (usage.resource && !usage.literal) return 'relatie';
        if (usage.literal && !usage.resource) return 'eigenschap';
        if (usage.resource && usage.literal) return 'relatie';
      }
      return 'eigenschap';
    }

    const propKind = {};
    allPropURIs.forEach(u => { propKind[u] = classifyProp(u); });

    // instanties: knooppunten met een rdf:type die zelf geen klasse/eigenschap is
    const individuals = [];
    Object.values(nodes).forEach(node => {
      if (allClassURIs.has(node.id) || allPropURIs.has(node.id)) return;
      const meaningfulTypes = [...node.types].filter(t => !isCoreURI(t));
      if (meaningfulTypes.length > 0 || node.out.length > 0) {
        individuals.push(node.id);
      }
    });

    function localName(uri) {
      if (invPrefixes[uri] !== undefined) return null;
      const m = uri.match(/([#\/])([^#\/]+)$/);
      return m ? m[2] : uri;
    }

    function curie(uri) {
      let best = null;
      Object.keys(prefixes).forEach(p => {
        const ns = prefixes[p];
        if (uri.startsWith(ns) && (!best || ns.length > prefixes[best].length)) {
          best = p;
        }
      });
      if (best !== null) {
        return (best === '' ? ':' : best + ':') + uri.slice(prefixes[best].length);
      }
      return uri;
    }

    function findLiteralPred(uri, preds) {
      const node = nodes[uri];
      if (!node) return null;
      for (const lp of preds) {
        const hit = node.out.find(o => o.p === lp && o.o.type === 'literal');
        if (hit) return hit.o;
      }
      return null;
    }

    function labelTermOf(uri) { return findLiteralPred(uri, LABEL_PREDS); }
    function descTermOf(uri) { return findLiteralPred(uri, DESC_PREDS); }

    function labelOf(uri) {
      const term = labelTermOf(uri);
      if (term) return term.value;
      const m = uri.match(/([#\/])([^#\/]+)$/);
      return m ? decodeURIComponent(m[2]).replace(/([a-z])([A-Z])/g, '$1 $2') : uri;
    }

    function rawLabelOf(uri) {
      const term = labelTermOf(uri);
      if (term) return term.value;
      const m = uri.match(/([#\/])([^#\/]+)$/);
      return m ? decodeURIComponent(m[2]) : uri;
    }

    function descOf(uri) {
      const term = descTermOf(uri);
      return term ? term.value : null;
    }

    return {
      prefixes, invPrefixes, nodes, predUsage, triples,
      classes: [...allClassURIs].sort((a, b) => labelOf(a).localeCompare(labelOf(b))),
      properties: [...allPropURIs].sort((a, b) => labelOf(a).localeCompare(labelOf(b))),
      propKind,
      individuals: individuals.sort((a, b) => labelOf(a).localeCompare(labelOf(b))),
      curie, labelOf, rawLabelOf, descOf, labelTermOf, descTermOf,
      tripleCount: triples.length
    };
  }

  return {
    RDF, RDFS, OWL, SKOS, SHACL, XSD, CORE_NS, isCoreURI,
    LABEL_PREDS, DESC_PREDS, COMMON_PREFIXES, buildModel
  };
});
