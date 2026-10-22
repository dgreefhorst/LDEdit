/* Diagrammen — gedeeld tussen de app (browser) en de Node-tests.
   Bouwt uit een model een UML-klassediagram en schrijft dat als PlantUML,
   Mermaid, GraphML (yEd) of Draw.IO.

   Twee varianten:
   - MIM: MIM-conform (Objecttype → klasse «Objecttype», Attribuutsoort →
     attribuut, Relatiesoort → associatie, Generalisatie → overerving).
   - generiek: klassen met datatype-eigenschappen (via rdfs:domain/rdfs:range),
     objecteigenschappen als associaties en rdfs:subClassOf als overerving.
     Optioneel met rdfs:labels in plaats van CURIEs. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else {
    root.LDEdit = root.LDEdit || {};
    root.LDEdit.diagram = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
  const RDFS = 'http://www.w3.org/2000/01/rdf-schema#';
  const MIM = 'http://modellen.mim-standaard.nl/def/mim#';

  // MIM-metaklassen die als klasse in het diagram verschijnen (meest specifiek eerst).
  const MIM_CLASS_KINDS = [
    'Relatieklasse', 'Enumeratie', 'Referentielijst', 'Codelijst',
    'GestructureerdDatatype', 'PrimitiefDatatype', 'Keuze',
    'Gegevensgroeptype', 'Objecttype', 'Domein', 'View', 'Datatype'
  ];
  const MIM_RELATION_KINDS = ['Relatieklasse', 'ExterneKoppeling', 'Relatiesoort'];

  function localName(uri){
    const s = String(uri);
    const hash = s.lastIndexOf('#');
    const slash = s.lastIndexOf('/');
    return s.slice(Math.max(hash, slash) + 1) || s;
  }

  function sanitizeId(text){
    const s = String(text).replace(/[^A-Za-z0-9_]/g, '_').replace(/^_+|_+$/g, '');
    return s || 'x';
  }

  function outValues(model, uri, predicate){
    const node = model.nodes[uri];
    if(!node) return [];
    return node.out.filter(e => e.p === predicate).map(e => e.o);
  }

  function firstUriValue(model, uri, predicate){
    const hit = outValues(model, uri, predicate).find(o => o.type === 'uri' || o.type === 'bnode');
    return hit ? hit.value : null;
  }

  function firstLiteral(model, uri, predicate){
    const hit = outValues(model, uri, predicate).find(o => o.type === 'literal');
    return hit ? hit.value : null;
  }

  function typesOf(model, uri){
    const node = model.nodes[uri];
    return node ? [...node.types] : [];
  }

  function mimTypeName(model, uri){
    if(!uri) return '';
    if(model.nodes[uri]){
      return firstLiteral(model, uri, MIM + 'naam') ||
        firstLiteral(model, uri, RDFS + 'label') ||
        localName(uri);
    }
    return localName(uri);
  }

  /* ---------------- bouwers ---------------- */

  function buildMim(model, options){
    const classes = [];
    const classUris = new Set();
    const associations = [];
    const generalizations = [];

    Object.keys(model.nodes).forEach(uri => {
      const types = typesOf(model, uri);
      const kind = MIM_CLASS_KINDS.find(k => types.indexOf(MIM + k) !== -1);
      if(!kind) return;
      // "Alleen kern": alleen objecttypen en gegevensgroeptypen (plus hun
      // relaties); datatypen, enumeraties en referentielijsten vallen weg.
      if(options.coreOnly && kind !== 'Objecttype' && kind !== 'Gegevensgroeptype') return;
      classUris.add(uri);
      classes.push(buildMimClass(model, uri, kind, options));
    });

    // Associaties uit relatiesoorten.
    Object.keys(model.nodes).forEach(uri => {
      const types = typesOf(model, uri);
      if(!MIM_RELATION_KINDS.some(k => types.indexOf(MIM + k) !== -1)) return;
      const from = firstUriValue(model, uri, MIM + 'bron');
      const to = firstUriValue(model, uri, MIM + 'doel');
      if(!from || !to || !classUris.has(from) || !classUris.has(to)) return;
      associations.push({
        from, to,
        label: firstLiteral(model, uri, MIM + 'naam') || model.labelOf(uri),
        multiplicity: firstLiteral(model, uri, MIM + 'kardinaliteit') || ''
      });
    });

    // Gegevensgroep: Objecttype → Gegevensgroep → Gegevensgroeptype.
    Object.keys(model.nodes).forEach(uri => {
      outValues(model, uri, MIM + 'gegevensgroep').forEach(entry => {
        if(entry.type !== 'uri') return;
        const target = firstUriValue(model, entry.value, MIM + 'gegevensgroeptype');
        if(!target || !classUris.has(uri) || !classUris.has(target)) return;
        associations.push({
          from: uri, to: target,
          label: firstLiteral(model, entry.value, MIM + 'naam') || model.labelOf(entry.value),
          multiplicity: firstLiteral(model, entry.value, MIM + 'kardinaliteit') || ''
        });
      });
    });

    // Generalisaties: expliciete mim:Generalisatie en directe mim:supertype-links.
    Object.keys(model.nodes).forEach(uri => {
      const types = typesOf(model, uri);
      if(types.indexOf(MIM + 'Generalisatie') !== -1){
        const sub = firstUriValue(model, uri, MIM + 'subtype');
        const sup = firstUriValue(model, uri, MIM + 'supertype');
        if(sub && sup) generalizations.push({ sub, sup });
      }
      if(classUris.has(uri)){
        const sup = firstUriValue(model, uri, MIM + 'supertype');
        if(sup) generalizations.push({ sub: uri, sup });
      }
    });

    return finalize(model, { classes, associations, generalizations });
  }

  function buildMimClass(model, uri, kind, options){
    const name = firstLiteral(model, uri, MIM + 'naam') || firstLiteral(model, uri, RDFS + 'label') || model.labelOf(uri);
    const attributes = [];

    function addAttribute(nodeUri){
      const attrName = firstLiteral(model, nodeUri, MIM + 'naam') || model.labelOf(nodeUri);
      const typeUri = firstUriValue(model, nodeUri, MIM + 'type');
      const mult = firstLiteral(model, nodeUri, MIM + 'kardinaliteit') || '';
      const identifying = firstLiteral(model, nodeUri, MIM + 'identificerend') === 'true';
      attributes.push({
        name: identifying ? attrName + ' {id}' : attrName,
        type: options.showDatatypes ? mimTypeName(model, typeUri) : '',
        multiplicity: mult
      });
    }

    if(kind === 'Enumeratie'){
      outValues(model, uri, MIM + 'waarde').forEach(v => {
        if(v.type !== 'uri') return;
        attributes.push({
          name: firstLiteral(model, v.value, MIM + 'naam') || firstLiteral(model, v.value, MIM + 'code') || model.labelOf(v.value),
          type: '', multiplicity: ''
        });
      });
    } else if(kind === 'GestructureerdDatatype'){
      outValues(model, uri, MIM + 'dataElement').forEach(v => { if(v.type === 'uri') addAttribute(v.value); });
    } else if(kind === 'Referentielijst'){
      outValues(model, uri, MIM + 'referentieElement').forEach(v => { if(v.type === 'uri') addAttribute(v.value); });
    } else {
      outValues(model, uri, MIM + 'attribuut').forEach(v => { if(v.type === 'uri') addAttribute(v.value); });
    }

    return {
      uri,
      name,
      stereotype: options.stereotypes ? kind : '',
      abstract: firstLiteral(model, uri, MIM + 'indicatieAbstractObject') === 'true',
      attributes
    };
  }

  function buildGeneric(model, options){
    // Geen `items` = geen filter (alle klassen). Een lege lijst betekent: het
    // filter leverde niets op, dus ook geen klassen.
    const filtered = Array.isArray(options.items);
    const classSet = new Set(
      filtered ? options.items.filter(u => model.nodes[u]) : model.classes
    );
    const nameOf = uri => (options.useLabels ? model.labelOf(uri) : model.curie(uri));
    const typeOf = uri => (options.useLabels ? model.labelOf(uri) : model.curie(uri));

    const classes = [];
    const associations = [];
    const generalizations = [];

    [...classSet].sort((a, b) => nameOf(a).localeCompare(nameOf(b))).forEach(uri => {
      const attributes = [];
      model.properties.forEach(p => {
        if(model.propKind[p] !== 'eigenschap') return;
        const domains = outValues(model, p, RDFS + 'domain').filter(o => o.type === 'uri').map(o => o.value);
        if(domains.indexOf(uri) === -1) return;
        const range = firstUriValue(model, p, RDFS + 'range');
        attributes.push({
          name: nameOf(p),
          type: options.showDatatypes ? (range ? typeOf(range) : 'Literal') : '',
          multiplicity: ''
        });
      });
      attributes.sort((a, b) => a.name.localeCompare(b.name));
      classes.push({ uri, name: nameOf(uri), stereotype: '', abstract: false, attributes });

      // Generalisaties
      outValues(model, uri, RDFS + 'subClassOf').forEach(o => {
        if(o.type === 'uri' && classSet.has(o.value) && o.value !== uri) generalizations.push({ sub: uri, sup: o.value });
      });
    });

    // Associaties: objecteigenschappen met domein en bereik binnen de set.
    model.properties.forEach(p => {
      if(model.propKind[p] !== 'relatie') return;
      const domains = outValues(model, p, RDFS + 'domain').filter(o => o.type === 'uri').map(o => o.value).filter(u => classSet.has(u));
      const ranges = outValues(model, p, RDFS + 'range').filter(o => o.type === 'uri').map(o => o.value).filter(u => classSet.has(u));
      domains.forEach(from => ranges.forEach(to => {
        associations.push({ from, to, label: nameOf(p), multiplicity: '' });
      }));
    });

    return finalize(model, { classes, associations, generalizations });
  }

  // Zet URIs om naar unieke, veilige id's en houd alleen geldige relaties over.
  function finalize(model, diagram){
    const used = new Set();
    const idByUri = new Map();
    diagram.classes.forEach(c => {
      const base = sanitizeId(model.curie(c.uri));
      let id = base;
      let n = 2;
      while(used.has(id)) id = base + '_' + (n++);
      used.add(id);
      c.id = id;
      idByUri.set(c.uri, id);
    });

    const seen = new Set();
    const associations = [];
    diagram.associations.forEach(a => {
      if(!idByUri.has(a.from) || !idByUri.has(a.to)) return;
      const key = idByUri.get(a.from) + '|' + idByUri.get(a.to) + '|' + a.label + '|' + a.multiplicity;
      if(seen.has(key)) return;
      seen.add(key);
      associations.push({ from: idByUri.get(a.from), to: idByUri.get(a.to), label: a.label, multiplicity: a.multiplicity });
    });

    const seenGen = new Set();
    const generalizations = [];
    diagram.generalizations.forEach(g => {
      if(!idByUri.has(g.sub) || !idByUri.has(g.sup) || g.sub === g.sup) return;
      const key = idByUri.get(g.sub) + '|' + idByUri.get(g.sup);
      if(seenGen.has(key)) return;
      seenGen.add(key);
      generalizations.push({ sub: idByUri.get(g.sub), sup: idByUri.get(g.sup) });
    });

    diagram.classes.sort((a, b) => a.name.localeCompare(b.name));
    return { classes: diagram.classes, associations, generalizations };
  }

  function build(model, options){
    const opts = options || {};
    let diagram = null;
    if(opts.flavor === 'mim') diagram = buildMim(model, opts);
    if(!diagram || !diagram.classes.length) diagram = buildGeneric(model, opts);
    return diagram;
  }

  /* ---------------- serializers ---------------- */

  function attributeLine(a){
    let s = a.name;
    if(a.type) s += ' : ' + a.type;
    if(a.multiplicity) s += ' [' + a.multiplicity + ']';
    return s;
  }

  function toPlantUml(diagram){
    const lines = ['@startuml', 'skinparam classAttributeIconSize 0', ''];
    diagram.classes.forEach(c => {
      const st = c.stereotype ? ' <<' + c.stereotype + '>>' : '';
      lines.push((c.abstract ? 'abstract class "' : 'class "') + c.name + '"' + st + ' as ' + c.id + ' {');
      c.attributes.forEach(a => lines.push('  ' + attributeLine(a)));
      lines.push('}');
      lines.push('');
    });
    diagram.generalizations.forEach(g => lines.push(g.sup + ' <|-- ' + g.sub));
    diagram.associations.forEach(a => {
      const mult = a.multiplicity ? ' "' + a.multiplicity + '"' : '';
      lines.push(a.from + ' --> ' + mult + a.to + (a.label ? ' : ' + a.label : ''));
    });
    lines.push('@enduml');
    return lines.join('\n') + '\n';
  }

  function toMermaid(diagram){
    const lines = ['classDiagram'];
    diagram.classes.forEach(c => {
      const label = String(c.name).replace(/"/g, "'");
      lines.push('class ' + c.id + '["' + label + '"] {');
      if(c.abstract) lines.push('  <<abstract>>');
      if(c.stereotype) lines.push('  <<' + c.stereotype + '>>');
      c.attributes.forEach(a => {
        const member = (a.type ? a.type + ' ' : '') + a.name;
        lines.push('  +' + member);
      });
      lines.push('}');
    });
    diagram.generalizations.forEach(g => lines.push(g.sup + ' <|-- ' + g.sub));
    diagram.associations.forEach(a => {
      const mult = a.multiplicity ? ' "' + a.multiplicity + '"' : '';
      lines.push(a.from + ' -->' + mult + ' ' + a.to + (a.label ? ' : ' + a.label : ''));
    });
    return lines.join('\n') + '\n';
  }

  function escapeXmlText(value){
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  function escapeXmlAttr(value){
    return escapeXmlText(value).replace(/"/g, '&quot;');
  }

  function toDrawio(diagram){
    const cells = [];
    const cellId = id => 'c_' + id;
    const colCount = 3;
    const width = 220;
    diagram.classes.forEach((c, i) => {
      const col = i % colCount;
      const row = Math.floor(i / colCount);
      let html = '<b>' + escapeXmlText(c.name) + '</b>';
      if(c.stereotype) html += '<br><i>«' + escapeXmlText(c.stereotype) + '»</i>';
      if(c.attributes.length) html += '<hr>' + c.attributes.map(a => escapeXmlText(attributeLine(a))).join('<br>');
      cells.push(
        `<mxCell id="${escapeXmlAttr(cellId(c.id))}" value="${escapeXmlAttr(html)}" style="rounded=0;whiteSpace=wrap;html=1;align=left;verticalAlign=top;spacingLeft=6;" vertex="1" parent="1">` +
        `<mxGeometry x="${40 + col * (width + 60)}" y="${40 + row * 180}" width="${width}" height="${Math.max(80, 40 + c.attributes.length * 16)}" as="geometry"/></mxCell>`
      );
    });
    diagram.generalizations.forEach((g, i) => {
      cells.push(
        `<mxCell id="g${i}" value="" style="endArrow=block;endFill=0;html=1;edgeStyle=orthogonalEdgeStyle;" edge="1" parent="1" source="${escapeXmlAttr(cellId(g.sup))}" target="${escapeXmlAttr(cellId(g.sub))}">` +
        `<mxGeometry relative="1" as="geometry"/></mxCell>`
      );
    });
    diagram.associations.forEach((a, i) => {
      cells.push(
        `<mxCell id="a${i}" value="${escapeXmlAttr(a.label || '')}" style="endArrow=open;html=1;edgeStyle=orthogonalEdgeStyle;" edge="1" parent="1" source="${escapeXmlAttr(cellId(a.from))}" target="${escapeXmlAttr(cellId(a.to))}">` +
        `<mxGeometry relative="1" as="geometry"/></mxCell>`
      );
    });
    return '<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<mxfile host="LDEdit" version="24.0.0">\n' +
      '  <diagram id="diagram" name="Page-1">\n' +
      '    <mxGraphModel dx="1200" dy="800" grid="1" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="1" page="1" pageScale="1" pageWidth="1600" pageHeight="1200" math="0" shadow="0">\n' +
      '      <root>\n' +
      '        <mxCell id="0"/>\n' +
      '        <mxCell id="1" parent="0"/>\n' +
      cells.map(c => '        ' + c).join('\n') + '\n' +
      '      </root>\n' +
      '    </mxGraphModel>\n' +
      '  </diagram>\n' +
      '</mxfile>\n';
  }

  function toGraphml(diagram){
    const lines = [];
    const colCount = 3;
    const width = 200;
    diagram.classes.forEach((c, i) => {
      const col = i % colCount;
      const row = Math.floor(i / colCount);
      const lines2 = [c.name];
      if(c.stereotype) lines2.push('«' + c.stereotype + '»');
      if(c.attributes.length){ lines2.push('---'); c.attributes.forEach(a => lines2.push(attributeLine(a))); }
      lines.push(
        `    <node id="${escapeXmlAttr(c.id)}">\n` +
        '      <data key="d0">\n' +
        '        <y:ShapeNode>\n' +
        `          <y:Geometry height="${Math.max(60, 24 + lines2.length * 18)}" width="${width}" x="${40 + col * (width + 60)}" y="${40 + row * 160}"/>\n` +
        '          <y:Fill color="#FFFFFF" transparent="false"/>\n' +
        '          <y:BorderStyle color="#000000" type="line" width="1.0"/>\n' +
        '          <y:NodeLabel alignment="left" autoSizePolicy="content" fontFamily="Dialog" fontSize="12" fontStyle="plain" hasBackgroundColor="false" hasLineColor="false" modelName="internal" modelPosition="t" textColor="#000000" visible="true">' +
        escapeXmlText(lines2.join('\n')) + '</y:NodeLabel>\n' +
        '          <y:Shape type="rectangle"/>\n' +
        '        </y:ShapeNode>\n' +
        '      </data>\n' +
        '    </node>'
      );
    });
    diagram.generalizations.forEach((g, i) => {
      lines.push(
        `    <edge id="g${i}" source="${escapeXmlAttr(g.sup)}" target="${escapeXmlAttr(g.sub)}">\n` +
        '      <data key="d1">\n' +
        '        <y:PolyLineEdge>\n' +
        '          <y:LineStyle color="#000000" type="line" width="1.0"/>\n' +
        '          <y:Arrows source="none" target="white_delta"/>\n' +
        '          <y:BendStyle smoothed="false"/>\n' +
        '        </y:PolyLineEdge>\n' +
        '      </data>\n' +
        '    </edge>'
      );
    });
    diagram.associations.forEach((a, i) => {
      lines.push(
        `    <edge id="a${i}" source="${escapeXmlAttr(a.from)}" target="${escapeXmlAttr(a.to)}">\n` +
        '      <data key="d1">\n' +
        '        <y:PolyLineEdge>\n' +
        '          <y:LineStyle color="#000000" type="line" width="1.0"/>\n' +
        '          <y:Arrows source="none" target="std"/>\n' +
        (a.label
          ? '          <y:EdgeLabel alignment="center" fontFamily="Dialog" fontSize="11" fontStyle="plain" hasBackgroundColor="false" hasLineColor="false" modelName="centered" modelPosition="center" textColor="#000000" visible="true">' +
            escapeXmlText(a.label) + '</y:EdgeLabel>\n'
          : '') +
        '          <y:BendStyle smoothed="false"/>\n' +
        '        </y:PolyLineEdge>\n' +
        '      </data>\n' +
        '    </edge>'
      );
    });
    return '<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<graphml xmlns="http://graphml.graphdrawing.org/xmlns" xmlns:y="http://www.yworks.com/xml/graphml">\n' +
      '  <key for="node" id="d0" yfiles.type="nodegraph"/>\n' +
      '  <key for="edge" id="d1" yfiles.type="edgegraph"/>\n' +
      '  <graph id="G" edgedefault="directed">\n' +
      lines.join('\n') + '\n' +
      '  </graph>\n' +
      '</graphml>\n';
  }

  return { build, toPlantUml, toMermaid, toDrawio, toGraphml, sanitizeId };
});
