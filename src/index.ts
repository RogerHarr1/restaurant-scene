import type { SubscribeItem } from './types';
import { json, safeAsync } from './utils';
import { initSchema } from './db';
import { enrichRestaurant } from './enrich';
import { handleSubscribeBatch } from './subscribe';

export interface AppEnv {
	DB: D1Database;
}

export default {
	async fetch(request: Request, env: AppEnv, ctx: ExecutionContext): Promise<Response> {
		const url = new URL(request.url);

		// Ensure schema exists on first request
		await initSchema(env.DB);

		// POST /enrich — enrich a single restaurant
		if (request.method === 'POST' && url.pathname === '/enrich') {
			const [body, parseErr] = await safeAsync(() =>
				request.json<{ restaurant_id: string; website_url: string }>()
			);
			if (parseErr || !body?.restaurant_id || !body?.website_url) {
				return json({ error: 'Request body must include restaurant_id and website_url' }, 400);
			}

			const [result, enrichErr] = await safeAsync(() =>
				enrichRestaurant(env.DB, body.restaurant_id, body.website_url)
			);
			if (enrichErr) {
				return json({ error: enrichErr.message }, 500);
			}

			return json({ restaurant_id: body.restaurant_id, ...result });
		}

		// POST /enrich/batch — enrich multiple restaurants
		if (request.method === 'POST' && url.pathname === '/enrich/batch') {
			const [body, parseErr] = await safeAsync(() =>
				request.json<{ items: { restaurant_id: string; website_url: string }[] }>()
			);
			if (parseErr || !body?.items?.length) {
				return json({ error: 'Request body must include items array' }, 400);
			}

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

			return json({ results });
		}

		// POST /subscribe/batch — subscribe to newsletters
		if (request.method === 'POST' && url.pathname === '/subscribe/batch') {
			const [body, parseErr] = await safeAsync(() =>
				request.json<{ items: SubscribeItem[] }>()
			);
			if (parseErr || !body?.items?.length) {
				return json({ error: 'Request body must include items array with restaurant_id, email, website_url' }, 400);
			}

			const [results, subErr] = await safeAsync(() =>
				handleSubscribeBatch(env.DB, body.items)
			);
			if (subErr) {
				return json({ error: subErr.message }, 500);
			}

			return json({ results });
		}

		return json({ status: 'ok', endpoints: ['/enrich', '/enrich/batch', '/subscribe/batch'] });
	},
} satisfies ExportedHandler<AppEnv>;
