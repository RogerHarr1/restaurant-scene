import type { SubscribeItem } from './types';
import { json, safeAsync } from './utils';
import { initSchema, importRestaurants, getRestaurantsToEnrich, getRestaurantsWithEnrichment, getRestaurantsQueue } from './db';
import { enrichRestaurant } from './enrich';
import { detectNewsletterProvider } from './providers';
import { handleSubscribeBatch } from './subscribe';

export interface AppEnv {
	DB: D1Database;
}

export default {
	async fetch(request: Request, env: AppEnv, ctx: ExecutionContext): Promise<Response> {
		const url = new URL(request.url);

		// Ensure schema exists on first request
		await initSchema(env.DB);

		// GET /health — simple health check
		if (url.pathname === '/health') {
			return json({ status: 'ok' });
		}

		// CORS preflight for /admin/queue
		if (request.method === 'OPTIONS' && url.pathname === '/admin/queue') {
			return new Response(null, {
				status: 204,
				headers: {
					'Access-Control-Allow-Origin': '*',
					'Access-Control-Allow-Methods': 'GET, OPTIONS',
					'Access-Control-Allow-Headers': 'Content-Type',
				},
			});
		}

		// GET /admin/queue — list all restaurants with enrichment status
		if (request.method === 'GET' && url.pathname === '/admin/queue') {
			const [rows, queryErr] = await safeAsync(() => getRestaurantsQueue(env.DB));
			if (queryErr) {
				return json({ error: queryErr.message }, 500);
			}

			const restaurants = (rows ?? []).map((r) => ({
				id: r.id,
				name: r.name,
				website_url: r.website_url,
				newsletter_provider: r.newsletter_provider,
				newsletter_form_html: r.newsletter_form_html,
				has_form: r.newsletter_form_html != null,
			}));

			const body = JSON.stringify({ restaurants }, null, 2);
			return new Response(body, {
				headers: {
					'Content-Type': 'application/json',
					'Access-Control-Allow-Origin': '*',
				},
			});
		}

		// GET /api/debug-detect — temporary diagnostic: fetch a URL and run detection
		if (request.method === 'GET' && url.pathname === '/api/debug-detect') {
			const targetUrl = url.searchParams.get('url');
			if (!targetUrl) {
				return json({ error: 'Missing ?url= query parameter' }, 400);
			}

			const [res, fetchErr] = await safeAsync(() =>
				fetch(targetUrl, {
					headers: {
						'User-Agent': 'Mozilla/5.0 (compatible; RestaurantScene/1.0)',
						Accept: 'text/html',
					},
					redirect: 'follow',
				})
			);

			if (fetchErr || !res || !res.ok) {
				return json({
					error: 'Fetch failed',
					detail: fetchErr?.message || `HTTP ${res?.status}`,
				}, 502);
			}

			const [html, textErr] = await safeAsync(() => res.text());
			if (textErr || !html) {
				return json({ error: 'Body read failed', detail: textErr?.message }, 502);
			}

			const detection = detectNewsletterProvider(html);

			return json({
				detection,
				htmlLength: html.length,
				stringChecks: {
					'newsletter-form': html.includes('newsletter-form'),
					'data-form-id': html.includes('data-form-id'),
					squarespace: html.toLowerCase().includes('squarespace'),
				},
			});
		}

		// POST /api/import — import restaurants into the database
		if (request.method === 'POST' && url.pathname === '/api/import') {
			const [body, parseErr] = await safeAsync(() =>
				request.json<{ restaurants: { id: string; name: string; website_url?: string | null }[] }>()
			);
			if (parseErr || !body?.restaurants?.length) {
				return json({ error: 'Request body must include restaurants array with id and name' }, 400);
			}

			const [count, dbErr] = await safeAsync(() =>
				importRestaurants(env.DB, body.restaurants)
			);
			if (dbErr) {
				return json({ error: dbErr.message }, 500);
			}

			return json({ imported: count });
		}

		// POST /api/enrich — enrich restaurants using detectNewsletterProvider + extractNewsletterCandidates
		// Accepts optional { restaurant_ids: string[] } to target specific restaurants,
		// or { items: [{ restaurant_id, website_url }] } for explicit targets,
		// or enriches all un-enriched restaurants if no filter is provided.
		if (request.method === 'POST' && url.pathname === '/api/enrich') {
			const [body] = await safeAsync(() =>
				request.json<{ restaurant_ids?: string[]; items?: { restaurant_id: string; website_url: string }[] }>()
			);

			// If caller passes explicit items, enrich those directly
			if (body?.items?.length) {
				const results = [];
				for (const item of body.items) {
					const [result, err] = await safeAsync(() =>
						enrichRestaurant(env.DB, item.restaurant_id, item.website_url)
					);
					results.push({
						restaurant_id: item.restaurant_id,
						...(err ? { error: err.message } : result),
					});
				}
				return json({ enriched: results.length, results });
			}

			// Otherwise query the restaurants table for un-enriched entries
			const [toEnrich, queryErr] = await safeAsync(() =>
				getRestaurantsToEnrich(env.DB)
			);
			if (queryErr) {
				return json({ error: queryErr.message }, 500);
			}

			let targets = toEnrich ?? [];
			// Filter to specific IDs if requested
			if (body?.restaurant_ids?.length) {
				const idSet = new Set(body.restaurant_ids);
				targets = targets.filter((r) => idSet.has(r.id));
			}

			if (targets.length === 0) {
				return json({ enriched: 0, results: [] });
			}

			const results = [];
			for (const restaurant of targets) {
				const [result, err] = await safeAsync(() =>
					enrichRestaurant(env.DB, restaurant.id, restaurant.website_url!)
				);
				results.push({
					restaurant_id: restaurant.id,
					...(err ? { error: err.message } : result),
				});
			}

			return json({ enriched: results.length, results });
		}

		// POST /api/subscribe — run the tiered subscribe pipeline (Tier 1/2/3)
		// Accepts { email, restaurant_ids? } or { items: SubscribeItem[] }
		if (request.method === 'POST' && url.pathname === '/api/subscribe') {
			const [body, parseErr] = await safeAsync(() =>
				request.json<{ email?: string; restaurant_ids?: string[]; items?: SubscribeItem[] }>()
			);
			if (parseErr) {
				return json({ error: 'Invalid JSON body' }, 400);
			}

			let items: SubscribeItem[] = [];

			if (body?.items?.length) {
				// Caller provided explicit items
				items = body.items;
			} else if (body?.email) {
				// Build items from enriched restaurants
				const [enriched, queryErr] = await safeAsync(() =>
					getRestaurantsWithEnrichment(env.DB)
				);
				if (queryErr) {
					return json({ error: queryErr.message }, 500);
				}

				let targets = enriched ?? [];
				if (body.restaurant_ids?.length) {
					const idSet = new Set(body.restaurant_ids);
					targets = targets.filter((r) => idSet.has(r.id));
				}

				items = targets.map((r) => ({
					restaurant_id: r.id,
					email: body.email!,
					website_url: r.website_url || '',
				}));
			}

			if (items.length === 0) {
				return json({ error: 'No subscribable restaurants found. Provide items[] or email + restaurant_ids.' }, 400);
			}

			const [results, subErr] = await safeAsync(() =>
				handleSubscribeBatch(env.DB, items)
			);
			if (subErr) {
				return json({ error: subErr.message }, 500);
			}

			return json({ subscribed: results!.length, results });
		}

		return json({
			status: 'ok',
			endpoints: ['/health', '/admin/queue', '/api/debug-detect', '/api/import', '/api/enrich', '/api/subscribe'],
		});
	},
} satisfies ExportedHandler<AppEnv>;
