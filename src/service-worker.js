import { build, files, version } from '$service-worker';

/**
 * SERVICE WORKER FOR QURANWBW OFFLINE FUNCTIONALITY
 *
 * This service worker enables optional offline access to the website.
 * It does NOT automatically cache anything - users must explicitly enable offline mode.
 *
 * HOW IT WORKS:
 * 1. Service worker registers automatically when user visits the site (but does nothing)
 * 2. User initially downloads the core website files
 * 3. Service worker receives START_CACHING message
 * 4. All website pages are downloaded and cached on the user's device
 * 5. When offline, cached pages are served instead of showing errors
 *
 * UPDATES:
 * When we deploy a new version:
 * - Users with offline mode enabled will automatically get the updated cache
 * - Old cached data is deleted and replaced with new data
 * - Users without offline mode enabled see no difference
 */

// Different cache names for different data types
const cacheNames = {
	core: `quranwbw-cache-${version}`, // Core website files (versioned)
	config: 'quranwbw-config', // User preferences (survives across versions)
	chapterData: 'quranwbw-chapter-data', // Chapter routes and data
	juzData: 'quranwbw-juz-data', // Juz routes and data
	mushafData: 'quranwbw-mushaf-data', // Mushaf pages and fonts
	morphologyData: 'quranwbw-morphology-data', // Morphology data files
	tafisrData: 'quranwbw-tafisr-data' // Tafsir data files
};

// Files we should never cache (the service worker itself and its settings)
const stuffNotToCache = ['/service-worker.js', '/service-worker-settings.json'];

// Static files built by SvelteKit (CSS, JS, images from /static folder)
const precacheFiles = [
	...files, // Static files from /static folder
	...build // Generated JS/CSS chunks (includes the main bundle)
];

// Important pages we want to cache
const staticRoutesToCache = ['/about', '/bookmarks', '/changelog', '/duas', '/games/guess-the-word', '/morphology', '/offline', '/supplications'];

// This flag tracks whether the user has enabled offline mode
// Starts as false - user must explicitly enable it
let cachingEnabled = false;

/**
 * CHECK IF USER PREVIOUSLY ENABLED OFFLINE MODE
 * Reads from the config cache to see if caching was enabled before
 */
async function getCachingStatus() {
	try {
		const cache = await caches.open(cacheNames.config);
		const response = await cache.match('caching-enabled');
		if (response) {
			const data = await response.json();
			return data.enabled;
		}
	} catch (error) {
		console.warn('Could not read caching status:', error);
	}
	return false;
}

/**
 * SAVE USER'S OFFLINE MODE PREFERENCE
 * Stores whether caching is enabled so it persists across updates
 */
async function saveCachingStatus(enabled) {
	try {
		const cache = await caches.open(cacheNames.config);
		await cache.put(
			'caching-enabled',
			new Response(JSON.stringify({ enabled }), {
				headers: { 'Content-Type': 'application/json' }
			})
		);
	} catch (error) {
		console.warn('Could not save caching status:', error);
	}
}

/**
 * INSTALL EVENT
 * Runs when service worker is first installed
 * We skip waiting so the new service worker activates immediately
 */
self.addEventListener('install', () => {
	self.skipWaiting();
});

/**
 * ACTIVATE EVENT
 * Runs when service worker becomes active (takes control of the page)
 */
self.addEventListener('activate', (event) => {
	event.waitUntil(
		(async () => {
			cachingEnabled = await getCachingStatus();

			if (cachingEnabled) {
				const clients = await self.clients.matchAll();
				clients.forEach((client) => {
					client.postMessage({ type: 'CACHE_UPDATE_STARTED' });
				});

				await performCaching();

				// Delete ONLY old core caches, keep everything else
				const keys = await caches.keys();

				await Promise.all(
					keys.map((key) => {
						// Match old versioned core caches only
						if (key.startsWith('quranwbw-cache-') && key !== cacheNames.core) {
							console.log('Deleting old core cache:', key);
							return caches.delete(key);
						}
					})
				);

				const finalClients = await self.clients.matchAll();
				finalClients.forEach((client) => {
					client.postMessage({ type: 'CACHE_UPDATE_COMPLETE' });
				});
			}

			await self.clients.claim();
		})()
	);
});

/**
 * PERFORM CACHING
 * Downloads and caches all website content
 */
async function performCaching() {
	const cache = await caches.open(cacheNames.core);

	// Cache the homepage and all build files
	await cache.addAll(['/', ...precacheFiles]);

	const backgroundCache = async (routes, label) => {
		const total = routes.length;

		for (let i = 0; i < routes.length; i++) {
			try {
				// Normalize URL before caching
				const url = new URL(routes[i], self.location.origin);
				const response = await fetch(url);
				if (response.ok) {
					await cache.put(url.toString(), response.clone());
				}
			} catch (error) {
				console.warn('Install cache failed for:', routes[i], error);
			}

			const progressClients = await self.clients.matchAll();
			progressClients.forEach((client) => {
				client.postMessage({
					type: 'CACHE_PROGRESS',
					category: label,
					current: i + 1,
					total: total
				});
			});
		}
	};

	await backgroundCache(staticRoutesToCache, 'static-routes');
}

/**
 * MESSAGE EVENT
 */
self.addEventListener('message', (event) => {
	if (event.data.type === 'START_CACHING') {
		cachingEnabled = true;
		saveCachingStatus(true);

		event.waitUntil(
			(async () => {
				const clients = await self.clients.matchAll();
				clients.forEach((client) => {
					client.postMessage({ type: 'CACHE_STARTED' });
				});

				await performCaching();

				const finalClients = await self.clients.matchAll();
				finalClients.forEach((client) => {
					client.postMessage({
						type: 'CACHE_COMPLETE',
						cacheName: cacheNames.core
					});
				});
			})()
		);
	} else if (event.data.type === 'CACHE_URL') {
		event.waitUntil(
			(async () => {
				try {
					const cacheName = event.data.cacheName || cacheNames.core;
					const cache = await caches.open(cacheName);
					const response = await fetch(event.data.url);
					if (response.ok) {
						await cache.put(event.data.url, response);
					}
				} catch (error) {
					console.warn('Failed to cache URL:', event.data.url, error);
				}
			})()
		);
	} else if (event.data.type === 'DELETE_CACHE') {
		event.waitUntil(
			(async () => {
				await caches.delete(event.data.cacheName);

				const clients = await self.clients.matchAll();
				clients.forEach((client) => {
					client.postMessage({
						type: 'CACHE_DELETED',
						cacheName: event.data.cacheName
					});
				});
			})()
		);
	} else if (event.data.type === 'DISABLE_CACHING') {
		cachingEnabled = false;
		saveCachingStatus(false);

		event.waitUntil(
			(async () => {
				const keys = await caches.keys();
				await Promise.all(keys.map((key) => caches.delete(key)));

				const clients = await self.clients.matchAll();
				clients.forEach((client) => {
					client.postMessage({ type: 'CACHE_CLEARED' });
				});
			})()
		);
	}
});

/**
 * FETCH EVENT
 */
self.addEventListener('fetch', (event) => {
	const url = new URL(event.request.url);

	if (event.request.method !== 'GET' || stuffNotToCache.some((excluded) => url.pathname.includes(excluded))) {
		return;
	}

	// Handle navigation requests FIRST
	if (event.request.mode === 'navigate' && cachingEnabled) {
		event.respondWith(handleNavigationRequest(event.request));
		return;
	}

	event.respondWith(
		(async () => {
			if (cachingEnabled) {
				const allCacheNames = Object.values(cacheNames);
				for (const cacheName of allCacheNames) {
					const cache = await caches.open(cacheName);
					const cachedResponse = await cache.match(event.request);
					if (cachedResponse) {
						return cachedResponse;
					}
				}
			}

			try {
				const networkResponse = await fetch(event.request);

				if (!networkResponse || networkResponse.status !== 200) {
					return networkResponse;
				}

				if (cachingEnabled) {
					const cache = await caches.open(cacheNames.core);
					cache.put(event.request, networkResponse.clone());
				}

				return networkResponse;
			} catch (error) {
				if (event.request.mode === 'navigate' && cachingEnabled) {
					const cache = await caches.open(cacheNames.core);
					return cache.match('/offline') || cache.match('/');
				}

				console.warn(error);

				return new Response('Offline - resource not cached', {
					status: 503,
					statusText: 'Service Unavailable'
				});
			}
		})()
	);
});

/**
 * Dedicated navigation handler
 * This solves full device-offline + Cloudflare URL mismatch issues
 */
async function handleNavigationRequest(request) {
	const cache = await caches.open(cacheNames.core);

	let cached = await cache.match(request);
	if (cached) return cached;

	cached = await cache.match(new Request(new URL(request.url).pathname));
	if (cached) return cached;

	return new Response('Offline', { status: 503 });
}
