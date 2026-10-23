import { describe, expect, it } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { aot } from '../../src/plugin/aot/vite'

describe('vite plugin dev mode', () => {
	it('runs during dev when targeting workerd', () => {
		const plugin = aot('src/index.ts', { target: 'workerd' })
		expect(plugin.apply).toBeUndefined()
	})

	it('keeps the default runtime JIT path during dev', () => {
		const plugin = aot('src/index.ts')
		expect(plugin.apply).toBe('build')
	})

	it('keeps the Bun runtime JIT path during dev', () => {
		const plugin = aot('src/index.ts', { target: 'bun' })
		expect(plugin.apply).toBe('build')
	})

	it('does not throw buildEnd on an unmatched entry while serving', async () => {
		const directory = await mkdtemp(join(tmpdir(), 'elysia-aot-vite-dev-'))
		const entry = join(directory, 'app.ts')
		const sourceEntry = resolve(import.meta.dir, '../../src/index.ts')

		await writeFile(
			entry,
			`import { Elysia } from ${JSON.stringify(sourceEntry)}\n` +
				`export const app = new Elysia().get('/', () => 'ok')\n`
		)

		try {
			const plugin = aot(entry, { target: 'workerd', strip: false })
			plugin.configResolved!({ command: 'serve' })
			await plugin.buildStart()

			// No request transformed the entry before shutdown.
			expect(() => plugin.buildEnd()).not.toThrow()
		} finally {
			await rm(directory, { recursive: true, force: true })
		}
	})

	it('still throws buildEnd on an unmatched entry for command: build', async () => {
		const directory = await mkdtemp(
			join(tmpdir(), 'elysia-aot-vite-build-')
		)
		const entry = join(directory, 'app.ts')
		const sourceEntry = resolve(import.meta.dir, '../../src/index.ts')

		await writeFile(
			entry,
			`import { Elysia } from ${JSON.stringify(sourceEntry)}\n` +
				`export const app = new Elysia().get('/', () => 'ok')\n`
		)

		try {
			const plugin = aot(entry, { target: 'workerd', strip: false })
			plugin.configResolved!({ command: 'build' })
			await plugin.buildStart()

			expect(() => plugin.buildEnd()).toThrow(
				/never appeared in the bundler module graph/
			)
		} finally {
			await rm(directory, { recursive: true, force: true })
		}
	})
})
