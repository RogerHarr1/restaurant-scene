import type { SubscribeItem } from './types';
import { json, safeAsync } from './utils';
import { initSchema, importRestaurants, getRestaurantsToEnrich, getRestaurantsWithEnrichment } from './db';
import { enrichRestaurant } from './enrich';
import { detectNewsletterProvider } from './providers';
import { handleSubscribeBatch } from './subscribe';

export interface AppEnv {
	DB: D1Database;
}

export default {
	async fetch(request: Request, env: AppEnv, ctx: ExecutionContext): Promise<Response> {
		const url = new URL(request.url);

		await initSchema(env.DB);

		if (url.pathname === '/health') {
			return json({ status: 'ok' });
		}

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

		if (request.method === 'POST' && url.pathname === '/api/enrich') {
			const [body] = await safeAsync(() =>
				request.json<{ restaurant_ids?: string[]; items?: { restaurant_id: string; website_url: string }[] }>()
			);

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

			const [toEnrich, queryErr] = await safeAsync(() =>
				getRestaurantsToEnrich(env.DB)
			);
			if (queryErr) {
				return json({ error: queryErr.message }, 500);
			}

			let targets = toEnrich ?? [];
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

		if (request.method === 'POST' && url.pathname === '/api/subscribe') {
			const [body, parseErr] = await safeAsync(() =>
				request.json<{ email?: string; restaurant_ids?: string[]; items?: SubscribeItem[] }>()
			);
			if (parseErr) {
				return json({ error: 'Invalid JSON body' }, 400);
			}

			let items: SubscribeItem[] = [];

			if (body?.items?.length) {
				items = body.items;
			} else if (body?.email) {
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
			endpoints: ['/health', '/api/debug-detect', '/api/import', '/api/enrich', '/api/subscribe'],
		});
	},
} satisfies ExportedHandler<AppEnv>;