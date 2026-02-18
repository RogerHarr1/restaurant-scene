import type { EnrichmentRecord, Restaurant } from './types';

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS restaurants (
	id TEXT PRIMARY KEY,
	name TEXT NOT NULL,
	website_url TEXT,
	created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS restaurant_enrichment (
	restaurant_id TEXT PRIMARY KEY,
	website_url TEXT NOT NULL,
	newsletter_url TEXT,
	newsletter_form_html TEXT,
	newsletter_provider TEXT,
	newsletter_direct_endpoint TEXT,
	enriched_at TEXT NOT NULL,
	updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS subscription_attempt (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	restaurant_id TEXT NOT NULL,
	email TEXT NOT NULL,
	tier TEXT NOT NULL,
	provider TEXT,
	endpoint TEXT,
	success INTEGER NOT NULL DEFAULT 0,
	evidence TEXT NOT NULL DEFAULT '',
	attempted_at TEXT NOT NULL
);
`;

export async function initSchema(db: D1Database): Promise<void> {
	const statements = SCHEMA_SQL.split(';')
		.map((s) => s.trim())
		.filter((s) => s.length > 0);
	await db.batch(statements.map((sql) => db.prepare(sql)));
}

export async function upsertEnrichment(
	db: D1Database,
	record: Omit<EnrichmentRecord, 'updated_at'>
): Promise<void> {
	const now = new Date().toISOString();
	await db
		.prepare(
			`INSERT INTO restaurant_enrichment
				(restaurant_id, website_url, newsletter_url, newsletter_form_html,
				 newsletter_provider, newsletter_direct_endpoint, enriched_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT(restaurant_id) DO UPDATE SET
				website_url = excluded.website_url,
				newsletter_url = excluded.newsletter_url,
				newsletter_form_html = excluded.newsletter_form_html,
				newsletter_provider = excluded.newsletter_provider,
				newsletter_direct_endpoint = excluded.newsletter_direct_endpoint,
				enriched_at = excluded.enriched_at,
				updated_at = ?`
		)
		.bind(
			record.restaurant_id,
			record.website_url,
			record.newsletter_url,
			record.newsletter_form_html,
			record.newsletter_provider,
			record.newsletter_direct_endpoint,
			record.enriched_at,
			now,
			now
		)
		.run();
}

export async function getEnrichment(
	db: D1Database,
	restaurantId: string
): Promise<EnrichmentRecord | null> {
	const result = await db
		.prepare('SELECT * FROM restaurant_enrichment WHERE restaurant_id = ?')
		.bind(restaurantId)
		.first<EnrichmentRecord>();
	return result ?? null;
}

export async function logSubscriptionAttempt(
	db: D1Database,
	attempt: {
		restaurant_id: string;
		email: string;
		tier: string;
		provider: string | null;
		endpoint: string | null;
		success: boolean;
		evidence: string;
	}
): Promise<void> {
	await db
		.prepare(
			`INSERT INTO subscription_attempt
				(restaurant_id, email, tier, provider, endpoint, success, evidence, attempted_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
		)
		.bind(
			attempt.restaurant_id,
			attempt.email,
			attempt.tier,
			attempt.provider,
			attempt.endpoint,
			attempt.success ? 1 : 0,
			attempt.evidence,
			new Date().toISOString()
		)
		.run();
}

export async function importRestaurants(
	db: D1Database,
	items: { id: string; name: string; website_url?: string | null }[]
): Promise<number> {
	const now = new Date().toISOString();
	const stmts = items.map((r) =>
		db
			.prepare(
				`INSERT INTO restaurants (id, name, website_url, created_at)
				 VALUES (?, ?, ?, ?)
				 ON CONFLICT(id) DO UPDATE SET
					name = excluded.name,
					website_url = excluded.website_url`
			)
			.bind(r.id, r.name, r.website_url ?? null, now)
	);
	await db.batch(stmts);
	return items.length;
}

export async function getRestaurantsToEnrich(
	db: D1Database
): Promise<Restaurant[]> {
	const { results } = await db
		.prepare(
			`SELECT r.id, r.name, r.website_url, r.created_at
			 FROM restaurants r
			 LEFT JOIN restaurant_enrichment e ON r.id = e.restaurant_id
			 WHERE r.website_url IS NOT NULL AND e.restaurant_id IS NULL`
		)
		.all<Restaurant>();
	return results;
}

interface RestaurantWithEnrichment extends Restaurant {
	newsletter_provider: string | null;
	newsletter_direct_endpoint: string | null;
	newsletter_url: string | null;
}

export async function getRestaurantsWithEnrichment(
	db: D1Database
): Promise<RestaurantWithEnrichment[]> {
	const { results } = await db
		.prepare(
			`SELECT r.id, r.name, r.website_url, r.created_at,
					e.newsletter_provider, e.newsletter_direct_endpoint, e.newsletter_url
			 FROM restaurants r
			 INNER JOIN restaurant_enrichment e ON r.id = e.restaurant_id
			 WHERE e.newsletter_url IS NOT NULL OR e.newsletter_direct_endpoint IS NOT NULL`
		)
		.all<RestaurantWithEnrichment>();
	return results;
}
