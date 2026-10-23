import { isCloudflareWorker } from '../../universal/constants'
import { syncRequire } from '../sync-require'
import { requireExactMirror } from './exact-mirror-require'

export type CreateMirror = (schema: any, options?: any) => any

// Resolved on first use, an app without schemas never loads the package
let exactMirror: CreateMirror | undefined
let resolved = false

export const getExactMirror = () => {
	if (resolved) return exactMirror
	resolved = true

	// workerd's module fallback can log host errors before require throws.
	// AOT wiring or setupTypebox registers a mirror without probing CommonJS.
	if (isCloudflareWorker) return undefined

	try {
		const module =
			requireExactMirror() ??
			syncRequire(import.meta, import.meta.url)?.('exact-mirror')
		const mirror = module?.default ?? module

		if (typeof mirror === 'function') exactMirror = mirror
	} catch {}

	return exactMirror
}

// Internal registration hook for non-Node runtimes and tests.
export const setExactMirror = (mirror: CreateMirror | undefined) => {
	resolved = true

	return (exactMirror = mirror)
}

export const exactMirrorRequired = () =>
	new Error(
		"exact-mirror is required when using normalize: 'exactMirror' or sanitize. Install it and, if the runtime cannot load CommonJS modules, register it with setupTypebox({ exactMirror }); otherwise use normalize: 'typebox'."
	)
