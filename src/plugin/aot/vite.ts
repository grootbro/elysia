import { createAotPluginHooks, type AotPluginHooks } from './hooks'
import type { ElysiaAotOptions } from './core'

export interface ElysiaAotVitePlugin
	extends Omit<AotPluginHooks, 'isTransformCandidate'> {
	name: string
	enforce?: 'pre'
	apply?: 'build'
	configResolved?(config: { command: string }): void
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

	return {
		name: 'elysia-aot',
		enforce: 'pre',
		// Workers cannot use the runtime JIT fallback during development.
		...(options?.target === 'workerd' ? {} : { apply: 'build' as const }),
		configResolved(config) {
			serving = config.command === 'serve'
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
