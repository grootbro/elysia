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

describe('workerd dev updates', () => {
	const entry = resolve(import.meta.dir, 'fixtures/vite-app.ts')
	interface Module {
		id: string
		importers: Set<Module>
	}
	const module = (id: string): Module => ({
		id,
		importers: new Set<Module>()
	})

	const setup = (
		target: 'workerd' | 'bun' = 'workerd',
		command = 'serve',
		appEntry = entry
	) => {
		const plugin = aot(appEntry, { target, strip: false })
		plugin.configResolved!({ command })
		const calls: string[] = []
		const environment = (name: string) => ({
			moduleGraph: {
				invalidateAll() {
					calls.push(name + ':invalidate')
				}
			},
			hot: {
				send() {
					calls.push(name + ':reload')
				}
			}
		})
		const server = {
			environments: {
				client: environment('client'),
				worker: environment('worker')
			}
		}
		return { plugin, server, calls }
	}

	it('reloads on an entry edit even before the entry has loaded', async () => {
		const context = setup()
		expect(
			await context.plugin.hotUpdate!({
				file: entry,
				timestamp: 1,
				modules: [],
				server: context.server
			})
		).toEqual([])
		expect(context.calls).toEqual([
			'client:invalidate',
			'worker:invalidate',
			'client:reload',
			'worker:reload'
		])
	})

	it('reloads when an edited dependency reaches the entry through importers', async () => {
		const context = setup()
		const dependency = module('/app/schema.ts')
		const route = module('/app/route.ts')
		dependency.importers.add(route)
		route.importers.add(dependency) // Cycles must terminate.
		route.importers.add(module(entry + '?worker'))
		expect(
			await context.plugin.hotUpdate!({
				file: dependency.id,
				timestamp: 1,
				modules: [dependency],
				server: context.server
			})
		).toEqual([])
		expect(context.calls).toEqual([
			'client:invalidate',
			'worker:invalidate',
			'client:reload',
			'worker:reload'
		])
	})

	it('leaves unrelated frontend and CSS edits to Vite', async () => {
		const context = setup()
		const dependency = module('/frontend/style.css')
		const page = module('/frontend/page.ts')
		dependency.importers.add(page)
		page.importers.add(dependency)
		expect(
			await context.plugin.hotUpdate!({
				file: dependency.id,
				timestamp: 1,
				modules: [dependency],
				server: context.server
			})
		).toBeUndefined()
		expect(context.calls).toEqual([])
	})

	for (const [target, command] of [
		['bun', 'serve'],
		['workerd', 'build']
	] as const)
		it(`leaves ${target} ${command} updates unchanged`, async () => {
			const context = setup(target, command)
			expect(
				await context.plugin.hotUpdate!({
					file: entry,
					timestamp: 1,
					modules: [],
					server: context.server
				})
			).toBeUndefined()
			expect(context.calls).toEqual([])
		})
	it('coalesces one edit across environments and queues distinct edits', async () => {
		const context = setup()
		const update = {
			file: entry,
			timestamp: 2,
			modules: [],
			server: context.server
		}
		await Promise.all([
			context.plugin.hotUpdate!(update),
			context.plugin.hotUpdate!(update),
			context.plugin.hotUpdate!({ ...update, timestamp: 3 })
		])
		expect(context.calls).toEqual([
			'client:invalidate',
			'worker:invalidate',
			'client:reload',
			'worker:reload',
			'client:invalidate',
			'worker:invalidate',
			'client:reload',
			'worker:reload'
		])
	})

	it('keeps the old graph on capture failure and recovers on the next edit', async () => {
		const directory = await mkdtemp(
			join(tmpdir(), 'elysia-aot-vite-recover-')
		)
		const appEntry = join(directory, 'app.ts')
		try {
			await writeFile(appEntry, 'export const broken = ;')
			const context = setup('workerd', 'serve', appEntry)
			const update = {
				file: appEntry,
				timestamp: 4,
				modules: [],
				server: context.server
			}
			await expect(context.plugin.hotUpdate!(update)).rejects.toThrow()
			expect(context.calls).toEqual([])
			await writeFile(
				appEntry,
				`import { Elysia } from ${JSON.stringify(resolve(import.meta.dir, '../../src/index.ts'))}
` +
					`export const app = new Elysia().get('/', () => 'fixed')
`
			)
			await context.plugin.hotUpdate!({ ...update, timestamp: 5 })
			expect(context.calls).toEqual([
				'client:invalidate',
				'worker:invalidate',
				'client:reload',
				'worker:reload'
			])
		} finally {
			await rm(directory, { recursive: true, force: true })
		}
	})
	it('refreshes the compiled manifest after an imported route changes', async () => {
		const directory = await mkdtemp(
			join(tmpdir(), 'elysia-aot-vite-dependency-')
		)
		const appEntry = join(directory, 'app.ts')
		const routeEntry = join(directory, 'routes.ts')
		try {
			await writeFile(routeEntry, "export const path = '/before'\n")
			await writeFile(
				appEntry,
				`import { Elysia } from ${JSON.stringify(resolve(import.meta.dir, '../../src/index.ts'))}\n` +
					`import { path } from './routes.ts'\n` +
					`export const app = new Elysia().get(path, () => 'ok')\n`
			)
			const context = setup('workerd', 'serve', appEntry)
			await context.plugin.buildStart()
			const virtual = context.plugin.resolveId('elysia/compiled')!
			expect(context.plugin.load(virtual)).toContain('/before')
			await writeFile(routeEntry, "export const path = '/after'\n")
			const dependency = module(routeEntry)
			dependency.importers.add(module(appEntry))
			await context.plugin.hotUpdate!({
				file: routeEntry,
				timestamp: 6,
				modules: [dependency],
				server: context.server
			})
			expect(context.plugin.load(virtual)).toContain('/after')
			expect(context.plugin.load(virtual)).not.toContain('/before')
		} finally {
			await rm(directory, { recursive: true, force: true })
		}
	})
})
