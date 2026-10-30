import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { DOMParser, XMLSerializer } from '@xmldom/xmldom'
import { buildPresentation, parseZip } from '@aiden0z/pptx-renderer'
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'

import { diagramPreview } from './diagram.ts'
import { OOXML_NS, readXml, resolvePart } from './xml.ts'

class Parser extends DOMParser {
  override parseFromString(
    source: string,
    mimeType: string
  ): ReturnType<DOMParser['parseFromString']> {
    const document = super.parseFromString(source, mimeType)
    // The public reader queries only parsererror; xmldom supplies the actual XML tree.
    Object.assign(document, {
      querySelector: (selector: string) => {
        assert.equal(selector, 'parsererror')
        return document.getElementsByTagName(selector)[0] ?? null
      },
    })
    for (const element of Array.from(document.getElementsByTagName('*'))) {
      Object.defineProperty(element, 'children', {
        get: () => Array.from(element.childNodes).filter((node) => node.nodeType === 1),
      })
    }
    return document
  }
}
Object.assign(globalThis, { DOMParser: Parser, XMLSerializer })
const OFFICE_RELATIONSHIPS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const DRAWING = 'http://schemas.openxmlformats.org/drawingml/2006/main'
const DIAGRAM_RELATIONSHIP = 'http://schemas.microsoft.com/office/2007/relationships/diagramDrawing'
const corpus = process.env.SCHOLARSEED_OFFICE_CORPUS

function relationships(items: string): string {
  return `<Relationships xmlns="${OOXML_NS.relationships}">${items}</Relationships>`
}

function fixture(target = '../media/photo%20one.jpeg', mode = ''): Uint8Array {
  return zipSync({
    'ppt/slides/_rels/slide1.xml.rels': strToU8(
      relationships(
        `<Relationship Id="rId1" Type="${OFFICE_RELATIONSHIPS}/slideLayout" Target="../slideLayouts/slideLayout1.xml"/><Relationship Id="rIdPreviewDiagram1" Type="${DIAGRAM_RELATIONSHIP}" Target="../diagrams/drawing1.xml"/>`
      )
    ),
    'ppt/slides/_rels/slide2.xml.rels': strToU8(
      relationships(
        `<Relationship Id="rId6" Type="${DIAGRAM_RELATIONSHIP}" Target="/ppt/diagrams/drawing1.xml"/>`
      )
    ),
    'ppt/diagrams/drawing1.xml': strToU8(
      `<d:drawing xmlns:d="urn:diagram" xmlns:a="${DRAWING}" xmlns:r="${OFFICE_RELATIONSHIPS}"><a:blip r:embed="rId1"/></d:drawing>`
    ),
    'ppt/diagrams/_rels/drawing1.xml.rels': strToU8(
      relationships(
        `<Relationship Id="rId1" Type="${OFFICE_RELATIONSHIPS}/image" Target="${target}" ${mode}/>`
      )
    ),
    'ppt/media/photo one.jpeg': new Uint8Array([0xff, 0xd8, 0xff]),
  })
}

test('shared SmartArt drawing preserves original bytes and gains collision-free slide-owned image references', () => {
  for (const target of ['../media/photo%20one.jpeg', '/ppt/media/photo%20one.jpeg']) {
    const source = fixture(target)
    const original = Uint8Array.from(source)
    const projected = unzipSync(diagramPreview(source))
    const drawing = readXml(projected['ppt/diagrams/drawing1.xml'])
    const id = drawing
      .getElementsByTagNameNS(DRAWING, 'blip')[0]
      .getAttributeNS(OFFICE_RELATIONSHIPS, 'embed')
    assert.notEqual(id, 'rId1')
    assert.notEqual(id, 'rIdPreviewDiagram1')
    for (const index of [1, 2]) {
      const rels = readXml(projected[`ppt/slides/_rels/slide${index}.xml.rels`])
      const image = Array.from(
        rels.getElementsByTagNameNS(OOXML_NS.relationships, 'Relationship')
      ).find((rel) => rel.getAttribute('Id') === id)
      assert.ok(image)
      assert.equal(image.getAttribute('Type'), `${OFFICE_RELATIONSHIPS}/image`)
      assert.equal(
        resolvePart(`ppt/slides/slide${index}.xml`, image.getAttribute('Target')!),
        'ppt/media/photo one.jpeg'
      )
    }
    assert.deepEqual(source, original)
    assert.deepEqual(
      projected['ppt/media/photo one.jpeg'],
      unzipSync(source)['ppt/media/photo one.jpeg']
    )
    assert.equal(
      strFromU8(projected['ppt/diagrams/_rels/drawing1.xml.rels']),
      strFromU8(unzipSync(source)['ppt/diagrams/_rels/drawing1.xml.rels'])
    )
  }
})

test('external SmartArt image relations are not fetched or projected', () => {
  const source = fixture('https://example.com/photo.jpeg', 'TargetMode="External"')
  assert.equal(diagramPreview(source), source)
})

test('packages without diagram drawings retain exact bytes', () => {
  const source = zipSync({ 'ppt/media/photo.jpeg': new Uint8Array([0xff, 0xd8, 0xff]) })
  assert.equal(diagramPreview(source), source)
})

test(
  'original SmartArt sample resolves its ellipse image from the public renderer model',
  { skip: !corpus },
  async () => {
    const source = new Uint8Array(readFileSync(join(corpus!, 'pptx', 'poi-smartart-simple.pptx')))
    const original = Uint8Array.from(source)
    const projected = diagramPreview(source)
    const sourceModel = buildPresentation(await parseZip(Uint8Array.from(source).buffer))
    assert.equal(
      sourceModel.slides[0].rels.get('rId1')!.type,
      `${OFFICE_RELATIONSHIPS}/slideLayout`
    )
    const presentation = buildPresentation(await parseZip(Uint8Array.from(projected).buffer))
    const slide = presentation.slides[0]
    const group = slide.nodes.find((node) => node.nodeType === 'group')
    assert.ok(group && group.nodeType === 'group')
    const child = group.children.find((node) => node.child('spPr').child('blipFill').exists())
    assert.ok(child)
    const blip = child.child('spPr').child('blipFill').child('blip')
    const id = blip.attr('embed') ?? blip.attr('r:embed')
    const relation = slide.rels.get(id!)
    assert.ok(relation)
    assert.equal(relation.type, `${OFFICE_RELATIONSHIPS}/image`)
    const imagePath = resolvePart(slide.slidePath, relation.target)
    assert.equal(imagePath, 'ppt/media/image1.jpeg')
    assert.deepEqual(presentation.media.get(imagePath), unzipSync(source)[imagePath])
    assert.deepEqual(source, original)
    assert.equal(slide.rels.get('rId1')!.type, `${OFFICE_RELATIONSHIPS}/slideLayout`)
  }
)
