import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { runInNewContext } from 'node:vm'

const context: Record<string, any> = {}
runInNewContext(readFileSync(new URL('./search.js', import.meta.url), 'utf8'), context)
const createSearch = context.ScholarSeedOfficeSearch.create

function plain<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

interface SearchFixture {
  active: () => string
  controller: any
  selected: string[]
  setActive: (name: string) => void
}

function searchFixture(): SearchFixture {
  let activeName = '数据'
  const selected: string[] = []
  const values: Record<string, string[]> = {
    数据: ['Alpha', 'beta alpha', 'ALPHA', 'other'],
    参数: ['alpha', 'gamma']
  }
  const sheets = Object.fromEntries(Object.entries(values).map(([name, cells]) => [name, {
    getName: () => name,
    createSearchDescriptor: () => {
      const descriptor = { query: '', properties: {} as Record<string, unknown> }
      return {
        descriptor,
        setSearchString: (query: string) => { descriptor.query = query },
        setPropertyValue: (property: string, value: unknown) => { descriptor.properties[property] = value }
      }
    },
    findAll: (descriptor: { descriptor: { query: string; properties: Record<string, unknown> } }) => {
      assert.equal(descriptor.descriptor.properties.SearchCaseSensitive, false)
      assert.equal(descriptor.descriptor.properties.SearchRegularExpression, false)
      assert.equal(descriptor.descriptor.properties.SearchWords, false)
      const query = descriptor.descriptor.query.toLocaleLowerCase()
      const matches = cells
        .map((value, index) => ({
          id: `${name}:${index + 1}`,
          value,
          getCellAddress: () => ({ Sheet: 0, Row: index, Column: 0 })
        }))
        .filter(cell => cell.value.toLocaleLowerCase().includes(query))
      if (!matches.length) return null
      return {
        getCount: () => 1,
        getByIndex: () => ({ id: `${name}:merged-range` }),
        getCells: () => ({
          createEnumeration: () => {
            let index = 0
            return {
              hasMoreElements: () => index < matches.length,
              nextElement: () => matches[index++]
            }
          }
        })
      }
    }
  }]))
  const controller = {
    getActiveSheet: () => sheets[activeName],
    select: (match: { id: string }) => { selected.push(match.id); return true }
  }
  return {
    active: () => activeName,
    controller,
    selected,
    setActive: (name: string) => { activeName = name }
  }
}

test('spreadsheet search counts display-value matches and selects the first result', () => {
  const fixture = searchFixture()
  const search = createSearch('calc', fixture.controller, null)
  assert.deepEqual(plain(search.run('alpha', 'first')), {
    query: 'alpha', location: '数据', current: 1, total: 3
  })
  assert.deepEqual(fixture.selected, ['数据:1'])
})

test('spreadsheet search expands a merged result range into individual cells', () => {
  const fixture = searchFixture()
  const search = createSearch('calc', fixture.controller, null)
  assert.equal(search.run('alpha', 'first').total, 3)
  assert.equal(search.run('alpha', 'next').current, 2)
  assert.deepEqual(fixture.selected, ['数据:1', '数据:2'])
})

test('spreadsheet search wraps previous and next navigation', () => {
  const fixture = searchFixture()
  const search = createSearch('calc', fixture.controller, null)
  search.run('alpha', 'first')
  assert.equal(search.run('alpha', 'previous').current, 3)
  assert.equal(search.run('alpha', 'next').current, 1)
  assert.deepEqual(fixture.selected, ['数据:1', '数据:3', '数据:1'])
})

test('spreadsheet search keeps the query and reports no match without selecting', () => {
  const fixture = searchFixture()
  const search = createSearch('calc', fixture.controller, null)
  assert.deepEqual(plain(search.run('missing', 'first')), {
    query: 'missing', location: '数据', current: 0, total: 0
  })
  assert.deepEqual(fixture.selected, [])
})

test('spreadsheet search refreshes the retained query after changing worksheets', () => {
  const fixture = searchFixture()
  const search = createSearch('calc', fixture.controller, null)
  search.run('alpha', 'first')
  fixture.setActive('参数')
  assert.deepEqual(plain(search.refresh()), {
    query: 'alpha', location: '参数', current: 1, total: 1
  })
  assert.equal(search.refresh(), undefined)
  assert.deepEqual(fixture.selected, ['数据:1', '参数:1'])
})

test('blank spreadsheet search clears matches and does not select a cell', () => {
  const fixture = searchFixture()
  const search = createSearch('calc', fixture.controller, null)
  search.run('alpha', 'first')
  assert.deepEqual(plain(search.run('   ', 'first')), {
    query: '   ', location: '数据', current: 0, total: 0
  })
  assert.deepEqual(fixture.selected, ['数据:1'])
})

function descriptorFixture(matches: Array<{ id: string }>): any {
  return {
    createSearchDescriptor: () => {
      const descriptor = { query: '', properties: {} as Record<string, unknown> }
      return {
        descriptor,
        setSearchString: (query: string) => { descriptor.query = query },
        setPropertyValue: (property: string, value: unknown) => { descriptor.properties[property] = value }
      }
    },
    findAll: (descriptor: { descriptor: { query: string } }) => descriptor.descriptor.query === 'alpha' ? {
      getCount: () => matches.length,
      getByIndex: (index: number) => matches[index]
    } : null
  }
}

test('Writer search counts document ranges and wraps native selection', () => {
  const selected: string[] = []
  const model = descriptorFixture([{ id: 'paragraph-1' }, { id: 'table-cell-2' }])
  const search = createSearch('writer', { select: (match: { id: string }) => selected.push(match.id) }, model)

  assert.deepEqual(plain(search.run('alpha', 'first')), {
    query: 'alpha', location: '', current: 1, total: 2
  })
  assert.equal(search.run('alpha', 'previous').current, 2)
  assert.deepEqual(selected, ['paragraph-1', 'table-cell-2'])
})

function textShape(id: string, text: string, visible = true): any {
  return {
    id,
    getString: () => text,
    getPropertyValue: (name: string) => name === 'Visible' ? visible : undefined,
    createTextCursor: () => {
      const cursor = { id: `${id}:cursor`, moves: [] as Array<[number, boolean]> }
      return Object.assign(cursor, {
        gotoStart: () => true,
        goRight: (count: number, select: boolean) => { cursor.moves.push([count, select]); return true }
      })
    }
  }
}

function indexed(values: any[]): any {
  return {
    getCount: () => values.length,
    getByIndex: (index: number) => values[index]
  }
}

test('Impress search walks visible slide text in order and selects the matching range', () => {
  const pages = [
    Object.assign(indexed([textShape('title-1', 'Alpha beta alpha'), textShape('hidden', 'alpha', false)]), { id: 'slide-1' }),
    Object.assign(indexed([textShape('body-2', 'gamma ALPHA')]), { id: 'slide-2' })
  ]
  const selected: string[] = []
  const currentPages: string[] = []
  const controller = {
    setCurrentPage: (page: { id: string }) => currentPages.push(page.id),
    select: (range: { id: string }) => selected.push(range.id)
  }
  const search = createSearch('impress', controller, { getDrawPages: () => indexed(pages) })

  assert.deepEqual(plain(search.run('alpha', 'first')), {
    query: 'alpha', location: '第 1 页', current: 1, total: 3
  })
  assert.equal(search.run('alpha', 'next').current, 2)
  assert.equal(search.run('alpha', 'next').location, '第 2 页')
  assert.deepEqual(currentPages, ['slide-1', 'slide-1', 'slide-2'])
  assert.deepEqual(selected, ['title-1:cursor', 'title-1:cursor', 'body-2:cursor'])
})

test('Impress search includes table cells and skips unsupported shapes', () => {
  const cells = [[textShape('cell-a', 'alpha')], [textShape('cell-b', 'other')]]
  const table = {
    getRows: () => ({ getCount: () => cells.length }),
    getColumns: () => ({ getCount: () => cells[0].length }),
    getCellByPosition: (column: number, row: number) => cells[row][column]
  }
  const tableShape = {
    getShapeType: () => 'com.sun.star.drawing.TableShape',
    getPropertyValue: (name: string) => name === 'Visible' ? true : name === 'Model' ? table : undefined,
    supportsService: (name: string) => name === 'com.sun.star.drawing.TableShape'
  }
  const page = Object.assign(indexed([{}, tableShape]), { id: 'slide-1' })
  const selected: string[] = []
  const search = createSearch('impress', {
    setCurrentPage: () => {},
    select: (range: { id: string }) => selected.push(range.id)
  }, { getDrawPages: () => indexed([page]) })

  assert.equal(search.run('alpha', 'first').total, 1)
  assert.deepEqual(selected, ['cell-a:cursor'])
})
