import { createAotPluginHooks, type AotPluginHooks } from './hooks'
import { realPath, resolveEntry, type ElysiaAotOptions } from './core'

interface ViteAotModule {
	id: string | null
	importers: Set<ViteAotModule>
}

interface ViteAotUpdate {
	file: string
	timestamp: number
	modules: ViteAotModule[]
	server: {
		environments: Record<
			string,
			{
				moduleGraph: { invalidateAll(): void }
				hot: {
					send(payload: { type: 'full-reload'; path: string }): void
				}
			}
		>
	}
}

export interface ElysiaAotVitePlugin extends Omit<
	AotPluginHooks,
	'isTransformCandidate'
> {
	name: string
	enforce?: 'pre'
	apply?: 'build'
	configResolved?(config: { command: string }): void
	hotUpdate?(context: ViteAotUpdate): Promise<[] | void>
}

/**
 * Elysia AOT build plugin
 *
 * Run Elysia JIT compilation in build time instead of runtime
 *
 * ```ts
 * import { defineConfig } from 'vite'
 * import { aot } from 'elysia/plugin/aot/vite'
 *
 * export default defineConfig({
 *   plugins: [aot('src/index.ts')]
 * })
 * ```
 */
export const aot = (
	entry: string,
	options?: ElysiaAotOptions
): ElysiaAotVitePlugin => {
	const hooks = createAotPluginHooks(entry, options)
	let serving = false
	let rebuild = Promise.resolve()
	let lastUpdate:
		| { file: string; timestamp: number; done: Promise<void> }
		| undefined
	const entryPath = realPath(resolveEntry(entry))
	const isEntry = (id: string | null) =>
		id !== null && realPath(id.split('?', 1)[0]) === entryPath

	return {
		name: 'elysia-aot',
		enforce: 'pre',
		// Workers cannot use the runtime JIT fallback during development.
		...(options?.target === 'workerd' ? {} : { apply: 'build' as const }),
		configResolved(config) {
			serving = config.command === 'serve'
		},
		async hotUpdate(context) {
			if (!serving || options?.target !== 'workerd') return

			if (
				lastUpdate?.file === context.file &&
				lastUpdate.timestamp === context.timestamp
			) {
				await lastUpdate.done
				return []
			}

			// A changed route or schema also changes the manifest and its stubs.
			// Reload them together instead of replaying a partially updated graph.
			const pending = [...context.modules]
			const visited = new Set<ViteAotModule>()
			let affected = isEntry(context.file)
			while (!affected && pending.length) {
				const module = pending.pop()!
				if (visited.has(module)) continue
				visited.add(module)
				affected = isEntry(module.id)
				pending.push(...module.importers)
			}
			if (!affected) return

			// Vite calls this hook once per environment for the same edit.
			// Serialize edits; a failed capture must not poison the next rebuild.
			rebuild = rebuild
				.catch(() => {})
				.then(async () => {
					await hooks.buildStart()
					const environments = Object.values(
						context.server.environments
					)
					for (const environment of environments)
						environment.moduleGraph.invalidateAll()
					for (const environment of environments)
						environment.hot.send({ type: 'full-reload', path: '*' })
				})
			lastUpdate = {
				file: context.file,
				timestamp: context.timestamp,
				done: rebuild
			}
			await rebuild
			return []
		},
		buildStart: hooks.buildStart,
		buildEnd() {
			// Vite dev can close before any request has loaded the entry.
			if (!serving) hooks.buildEnd()
		},
		resolveId: hooks.resolveId,
		load: hooks.load,
		transform: hooks.transform
	}
}
