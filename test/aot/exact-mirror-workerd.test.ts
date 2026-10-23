import { describe, expect, it } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'

const mirrorModule = resolve(
	import.meta.dir,
	'../../src/type/validator/exact-mirror.ts'
)

const observe = (setup: string) => {
	const child = spawnSync(
		process.execPath,
		[
			'-e',
			`
		${setup}
		const { getExactMirror, setExactMirror } = await import(${JSON.stringify(mirrorModule)})
		const automatic = typeof getExactMirror()
		const explicit = () => 'registered'
		setExactMirror(explicit)
		console.log(JSON.stringify({ automatic, registered: getExactMirror() === explicit }))
	`
		],
		{ encoding: 'utf8' }
	)

	expect(child.status).toBe(0)
	expect(child.stderr).toBe('')
	return JSON.parse(child.stdout.trim())
}

describe('exact-mirror under workerd', () => {
	it('skips CommonJS discovery when WebSocketPair identifies Workers', () => {
		expect(observe(`globalThis.WebSocketPair = class {}`)).toEqual({
			automatic: 'undefined',
			registered: true
		})
	})

	it('recognizes the Workers user agent without caches or WebSocketPair', () => {
		expect(
			observe(`Object.defineProperty(globalThis, 'navigator', {
			value: { userAgent: 'Cloudflare-Workers' }, configurable: true
		})`)
		).toEqual({ automatic: 'undefined', registered: true })
	})

	it('still discovers the real package outside Workers', () => {
		expect(observe('')).toEqual({ automatic: 'function', registered: true })
	})
})
