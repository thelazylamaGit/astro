import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Plugin } from 'vite';
import hmrReload from '../../../dist/vite-plugin-hmr-reload/index.js';

type MockModule = { id: string | null; file?: string };
type MockModuleGraphEntry = { id: string };

type HotUpdateContext = {
	modules: MockModule[];
	server: MockServer;
	timestamp: number;
	file: string;
};

type HotUpdateHandler = (this: { environment: MockEnvironment }, context: HotUpdateContext) => unknown;

type MockEnvironment = {
	name: string;
	moduleGraph: {
		idToModuleMap: Map<string, MockModuleGraphEntry>;
		getModuleById: (id: string) => MockModuleGraphEntry | null;
		invalidateModule: (
			mod: MockModuleGraphEntry,
			seen?: Set<unknown>,
			timestamp?: number,
			isHmr?: boolean,
		) => void;
	};
	runner?: {
		evaluatedModules: {
			getModuleById: (id: string) => MockModuleGraphEntry | null;
			invalidateModule: (mod: MockModuleGraphEntry) => void;
		};
	};
};

type MockServer = {
	environments: {
		client: {
			moduleGraph: {
				getModuleById: (id: string) => object | null;
			};
		};
	};
	ws: {
		send: () => void;
	};
};

/**
 * Tests for CSS HMR invalidation of SSR dev-css virtual modules.
 *
 * When a CSS file changes during dev, the astro:hmr-reload plugin must
 * invalidate the per-route virtual:astro:dev-css:* modules in the SSR
 * environment so the next SSR render picks up fresh CSS content.
 * Without this, the server-rendered inline <style> tags serve stale CSS.
 */
describe('astro:hmr-reload CSS invalidation', () => {
	function getHotUpdateHandler(plugin: Plugin): HotUpdateHandler {
		const hotUpdate = plugin.hotUpdate;

		assert.ok(hotUpdate && typeof hotUpdate === 'object' && 'handler' in hotUpdate);

		return hotUpdate.handler as HotUpdateHandler;
	}

	function createMockContext(options: {
		moduleGraphEntries?: Array<[string, MockModuleGraphEntry]>;
		runnable?: boolean;
	}) {
		const invalidatedModuleGraphIds: string[] = [];
		const invalidatedRunnerIds: string[] = [];

		const moduleGraphEntries = new Map<string, MockModuleGraphEntry>(
			options.moduleGraphEntries ?? [],
		);

		const runnerEntries = new Map<string, MockModuleGraphEntry>(
			options.moduleGraphEntries ?? [],
		);

		const environment: MockEnvironment = {
			name: 'ssr',
			moduleGraph: {
				idToModuleMap: moduleGraphEntries,
				getModuleById: (id) => moduleGraphEntries.get(id) ?? null,
				invalidateModule: (mod) => {
					invalidatedModuleGraphIds.push(mod.id);
				},
			},
			...(options.runnable
				? {
						runner: {
							evaluatedModules: {
								getModuleById: (id: string) => runnerEntries.get(id) ?? null,
								invalidateModule: (mod: MockModuleGraphEntry) => {
									invalidatedRunnerIds.push(mod.id);
								},
							},
						},
					}
				: {}),
		};

		const server: MockServer = {
			environments: {
				client: {
					moduleGraph: {
						getModuleById: () => null,
					},
				},
			},
			ws: { send: () => {} },
		};

		return {
			environment,
			server,
			invalidatedModuleGraphIds,
			invalidatedRunnerIds,
		};
	}

	function runHotUpdate({
		environment,
		server,
		modules,
		file,
	}: {
		environment: MockEnvironment;
		server: MockServer;
		modules: MockModule[];
		file: string;
	}) {
		const plugin = hmrReload();
		const handler = getHotUpdateHandler(plugin);

		return handler.call(
			{ environment },
			{
				modules,
				server,
				timestamp: Date.now(),
				file,
			},
		);
	}

	it('invalidates dev-css virtual modules in module graph when a CSS file changes', () => {
		const devCssId1 = '\0virtual:astro:dev-css:src/pages/index@_@astro';
		const devCssId2 = '\0virtual:astro:dev-css:src/pages/posts/[id]@_@astro';

		const { environment, server, invalidatedModuleGraphIds } = createMockContext({
			moduleGraphEntries: [
				[devCssId1, { id: devCssId1 }],
				[devCssId2, { id: devCssId2 }],
				['some-other-module', { id: 'some-other-module' }],
			],
		});

		const result = runHotUpdate({
			environment,
			server,
			modules: [{ id: '/path/to/global.css', file: '/path/to/global.css' }],
			file: '/path/to/global.css',
		});

		assert.deepEqual(result, []);
		assert.deepEqual(invalidatedModuleGraphIds, [devCssId1, devCssId2]);
	});

	it('invalidates dev-css modules for SCSS file changes', () => {
		const devCssId = '\0virtual:astro:dev-css:src/pages/index@_@astro';

		const { environment, server, invalidatedModuleGraphIds } = createMockContext({
			moduleGraphEntries: [[devCssId, { id: devCssId }]],
		});

		const result = runHotUpdate({
			environment,
			server,
			modules: [{ id: '/path/to/styles.scss', file: '/path/to/styles.scss' }],
			file: '/path/to/styles.scss',
		});

		assert.deepEqual(result, []);
		assert.deepEqual(invalidatedModuleGraphIds, [devCssId]);
	});

	it('invalidates dev-css modules in the runner evaluation cache when runnable', () => {
		const devCssId = '\0virtual:astro:dev-css:src/pages/index@_@astro';

		const { environment, server, invalidatedRunnerIds } = createMockContext({
			runnable: true,
			moduleGraphEntries: [[devCssId, { id: devCssId }]],
		});

		const result = runHotUpdate({
			environment,
			server,
			modules: [{ id: '/path/to/styles.css', file: '/path/to/styles.css' }],
			file: '/path/to/styles.css',
		});

		assert.deepEqual(result, []);
		assert.deepEqual(invalidatedRunnerIds, [devCssId]);
	});

	it('does not invalidate dev-css modules when no style modules are present', () => {
		const devCssId = '\0virtual:astro:dev-css:src/pages/index@_@astro';

		const { environment, server, invalidatedModuleGraphIds } = createMockContext({
			moduleGraphEntries: [[devCssId, { id: devCssId }]],
		});

		server.environments.client.moduleGraph.getModuleById = (id) =>
			id === '/path/to/component.astro' ? { id } : null;

		const result = runHotUpdate({
			environment,
			server,
			modules: [{ id: '/path/to/component.astro', file: '/path/to/component.astro' }],
			file: '/path/to/component.astro',
		});

		assert.equal(result, undefined);
		assert.equal(invalidatedModuleGraphIds.length, 0);
	});

	it('returns empty array for CSS changes to prevent full page reload', () => {
		const { environment, server } = createMockContext({});

		const result = runHotUpdate({
			environment,
			server,
			modules: [{ id: '/path/to/styles.css', file: '/path/to/styles.css' }],
			file: '/path/to/styles.css',
		});

		assert.deepEqual(result, []);
	});

	it('handles empty dev-css module map gracefully', () => {
		const { environment, server, invalidatedModuleGraphIds } = createMockContext({
			moduleGraphEntries: [],
		});

		const result = runHotUpdate({
			environment,
			server,
			modules: [{ id: '/path/to/styles.css', file: '/path/to/styles.css' }],
			file: '/path/to/styles.css',
		});

		assert.deepEqual(result, []);
		assert.equal(invalidatedModuleGraphIds.length, 0);
	});
});
