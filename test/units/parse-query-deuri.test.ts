import { describe, expect, it } from 'bun:test'
import { Elysia, t } from '../../src'
import { parseQuery, parseQueryFromURL } from '../../src/parse-query'

const fromURL = (query: string) =>
	parseQueryFromURL('http://localhost/?' + query)

describe('query percent decoding contract', () => {
	it('decodes keys and replaces invalid UTF-8 with replacement characters', () => {
		for (const parse of [parseQuery, fromURL])
			expect(parse('%71=%FF')).toEqual({ q: '\uFFFD' })
	})

	it('preserves decoded NUL keys and values', () => {
		for (const parse of [parseQuery, fromURL])
			expect(parse('%00=%00')).toEqual({ '\0': '\0' })
	})

	it('preserves malformed hex and incomplete percent escapes', () => {
		for (const parse of [parseQuery, fromURL])
			expect(parse('%GG=%2')).toEqual({ '%GG': '%2' })
	})

	it('turns raw plus into spaces while preserving encoded plus', () => {
		for (const parse of [parseQuery, fromURL])
			expect(parse('a+b=q%2B+x')).toEqual({ 'a b': 'q+ x' })
	})

	it('preserves the two parsers distinct duplicate policies after decoding', () => {
		const query = 'q=%FF&q=%C0%AF'
		expect(parseQuery(query)).toEqual({ q: ['\uFFFD', '\uFFFD\uFFFD'] })
		expect(fromURL(query)).toEqual({ q: '\uFFFD\uFFFD' })
	})

	it('keeps an encoded comma inside raw array elements', () => {
		for (const query of ['q=a%2Cb,%FF', 'q=[a%2Cb,%FF]'])
			expect(
				parseQueryFromURL('http://localhost/?' + query, undefined, {
					q: 1
				})
			).toEqual({ q: ['a,b', '\uFFFD'] })
	})

	it('preserves empty array members around decoded values', () => {
		expect(
			parseQueryFromURL('http://localhost/?q=,%00,,%GG,', undefined, {
				q: 1
			})
		).toEqual({ q: ['', '\0', '', '%GG', ''] })
	})

	it('decodes unvalidated and typed array queries through handle', async () => {
		const app = new Elysia()
			.get('/plain', ({ query }) => query)
			.get(
				'/array',
				{ query: t.Object({ q: t.Array(t.String()) }) },
				({ query }) => query.q
			)
		const plain = await app.handle(
			new Request('http://localhost/plain?%71=%FF&plus=a+b%2B')
		)
		expect(plain.status).toBe(200)
		expect(await plain.json()).toEqual({ q: '\uFFFD', plus: 'a b+' })
		const array = await app.handle(
			new Request('http://localhost/array?q=a%2Cb,%FF')
		)
		expect(array.status).toBe(200)
		expect(await array.json()).toEqual(['a,b', '\uFFFD'])
	})
})
