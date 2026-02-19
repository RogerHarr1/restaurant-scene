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

		// GET /admin — HTML dashboard for newsletter subscription queue
		if (request.method === 'GET' && url.pathname === '/admin') {
			const adminHtml = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Restaurant Scene - Newsletter Queue</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0f1117; color: #e1e4e8; min-height: 100vh; }
  .container { max-width: 960px; margin: 0 auto; padding: 24px 16px; }
  h1 { font-size: 22px; font-weight: 600; margin-bottom: 4px; }
  .subtitle { color: #8b949e; font-size: 14px; margin-bottom: 20px; }
  .stats { display: flex; gap: 12px; margin-bottom: 20px; flex-wrap: wrap; }
  .stat { background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 12px 16px; min-width: 120px; }
  .stat-value { font-size: 24px; font-weight: 700; color: #58a6ff; }
  .stat-label { font-size: 12px; color: #8b949e; margin-top: 2px; }
  .tabs { display: flex; gap: 4px; margin-bottom: 16px; border-bottom: 1px solid #30363d; padding-bottom: 0; }
  .tab { background: none; border: none; color: #8b949e; padding: 8px 14px; cursor: pointer; font-size: 13px; font-weight: 500; border-bottom: 2px solid transparent; margin-bottom: -1px; transition: color .15s, border-color .15s; }
  .tab:hover { color: #e1e4e8; }
  .tab.active { color: #58a6ff; border-bottom-color: #58a6ff; }
  .tab .count { background: #30363d; color: #8b949e; border-radius: 10px; padding: 1px 7px; font-size: 11px; margin-left: 5px; }
  .tab.active .count { background: rgba(56,139,253,0.15); color: #58a6ff; }
  table { width: 100%; border-collapse: collapse; }
  thead th { text-align: left; font-size: 12px; font-weight: 500; color: #8b949e; padding: 8px 10px; border-bottom: 1px solid #30363d; text-transform: uppercase; letter-spacing: 0.5px; }
  tbody tr { border-bottom: 1px solid #21262d; transition: background .1s; }
  tbody tr:hover { background: #161b22; }
  tbody tr.done { opacity: 0.45; }
  td { padding: 10px; font-size: 14px; vertical-align: middle; }
  .name { font-weight: 600; }
  .provider-badge { display: inline-block; font-size: 11px; font-weight: 600; padding: 2px 8px; border-radius: 10px; background: rgba(56,139,253,0.15); color: #58a6ff; }
  .provider-badge.form { background: rgba(210,153,34,0.15); color: #d29922; }
  .provider-badge.none { background: #21262d; color: #8b949e; }
  a.site-link { color: #58a6ff; text-decoration: none; font-size: 13px; }
  a.site-link:hover { text-decoration: underline; }
  .btn { background: #21262d; border: 1px solid #30363d; color: #e1e4e8; padding: 4px 10px; border-radius: 6px; font-size: 12px; cursor: pointer; transition: background .15s, border-color .15s; white-space: nowrap; }
  .btn:hover { background: #30363d; border-color: #484f58; }
  .btn.copied { background: rgba(46,160,67,0.15); border-color: #2ea043; color: #3fb950; }
  .btn.mark-done { }
  .btn.mark-done.is-done { background: rgba(46,160,67,0.15); border-color: #2ea043; color: #3fb950; }
  .actions { display: flex; gap: 6px; }
  .empty { text-align: center; padding: 48px 16px; color: #8b949e; }
  .loading { text-align: center; padding: 48px 16px; color: #8b949e; }
</style>
</head>
<body>
<div class="container">
  <h1>Newsletter Queue</h1>
  <p class="subtitle">Restaurant Scene subscription dashboard</p>
  <div class="stats" id="stats"></div>
  <div class="tabs" id="tabs"></div>
  <table>
    <thead><tr><th>Restaurant</th><th>Provider</th><th>Website</th><th>Actions</th></tr></thead>
    <tbody id="tbody"><tr><td colspan="4" class="loading">Loading...</td></tr></tbody>
  </table>
</div>
<script>
const EMAIL = 'scene@specialtyproduce.com';
let allRows = [];
let doneSet = new Set(JSON.parse(localStorage.getItem('queue_done') || '[]'));
let activeFilter = 'all';

async function load() {
  const base = window.location.origin;
  const res = await fetch(base + '/admin/queue');
  const data = await res.json();
  allRows = data.restaurants || [];
  render();
}

function saveDone() {
  localStorage.setItem('queue_done', JSON.stringify([...doneSet]));
}

function toggleDone(id) {
  if (doneSet.has(id)) doneSet.delete(id); else doneSet.add(id);
  saveDone();
  render();
}

function copyEmail(btn) {
  navigator.clipboard.writeText(EMAIL).then(() => {
    btn.textContent = 'Copied!';
    btn.classList.add('copied');
    setTimeout(() => { btn.textContent = 'Copy Email'; btn.classList.remove('copied'); }, 1500);
  });
}

function setFilter(f) {
  activeFilter = f;
  render();
}

function filtered() {
  return allRows.filter(r => {
    if (activeFilter === 'provider') return !!r.newsletter_provider;
    if (activeFilter === 'form') return !r.newsletter_provider && r.has_form;
    if (activeFilter === 'none') return !r.newsletter_provider && !r.has_form;
    if (activeFilter === 'done') return doneSet.has(r.id);
    if (activeFilter === 'todo') return !doneSet.has(r.id);
    return true;
  });
}

function render() {
  const withProvider = allRows.filter(r => !!r.newsletter_provider).length;
  const withForm = allRows.filter(r => !r.newsletter_provider && r.has_form).length;
  const noDetection = allRows.filter(r => !r.newsletter_provider && !r.has_form).length;
  const done = allRows.filter(r => doneSet.has(r.id)).length;

  document.getElementById('stats').innerHTML =
    '<div class="stat"><div class="stat-value">' + allRows.length + '</div><div class="stat-label">Total</div></div>' +
    '<div class="stat"><div class="stat-value">' + withProvider + '</div><div class="stat-label">Provider detected</div></div>' +
    '<div class="stat"><div class="stat-value">' + withForm + '</div><div class="stat-label">Form HTML only</div></div>' +
    '<div class="stat"><div class="stat-value">' + done + '</div><div class="stat-label">Done</div></div>';

  const tabs = [
    ['all', 'All', allRows.length],
    ['provider', 'Provider', withProvider],
    ['form', 'Form Only', withForm],
    ['none', 'No Detection', noDetection],
    ['todo', 'To Do', allRows.length - done],
    ['done', 'Done', done],
  ];
  document.getElementById('tabs').innerHTML = tabs.map(([key, label, count]) =>
    '<button class="tab' + (activeFilter === key ? ' active' : '') + '" onclick="setFilter(\\''+key+'\\')">'+label+'<span class="count">'+count+'</span></button>'
  ).join('');

  const rows = filtered();
  if (rows.length === 0) {
    document.getElementById('tbody').innerHTML = '<tr><td colspan="4" class="empty">No restaurants match this filter.</td></tr>';
    return;
  }
  document.getElementById('tbody').innerHTML = rows.map(r => {
    const isDone = doneSet.has(r.id);
    const badge = r.newsletter_provider
      ? '<span class="provider-badge">' + r.newsletter_provider + '</span>'
      : r.has_form
        ? '<span class="provider-badge form">form detected</span>'
        : '<span class="provider-badge none">none</span>';
    const site = r.website_url
      ? '<a class="site-link" href="' + r.website_url + '" target="_blank" rel="noopener">Visit Site</a>'
      : '<span style="color:#484f58">No URL</span>';
    return '<tr class="' + (isDone ? 'done' : '') + '">' +
      '<td class="name">' + r.name + '</td>' +
      '<td>' + badge + '</td>' +
      '<td>' + site + '</td>' +
      '<td><div class="actions">' +
        '<button class="btn" onclick="copyEmail(this)">Copy Email</button>' +
        '<button class="btn mark-done' + (isDone ? ' is-done' : '') + '" onclick="toggleDone(\\''+r.id+'\\')">'+( isDone ? 'Done' : 'Mark Done')+'</button>' +
      '</div></td></tr>';
  }).join('');
}

load();
</script>
</body>
</html>`;
			return new Response(adminHtml, {
				headers: { 'Content-Type': 'text/html' },
			});
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
			endpoints: ['/health', '/admin', '/admin/queue', '/api/debug-detect', '/api/import', '/api/enrich', '/api/subscribe'],
		});
	},
} satisfies ExportedHandler<AppEnv>;
