import type { EnrichmentRecord } from './types';

const SCHEMA_SQL = `
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
