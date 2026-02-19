-- Imported restaurants
CREATE TABLE IF NOT EXISTS restaurants (
	id TEXT PRIMARY KEY,
	name TEXT NOT NULL,
	website_url TEXT,
	created_at TEXT NOT NULL
);

-- Restaurant enrichment data including detected newsletter provider info
CREATE TABLE IF NOT EXISTS restaurant_enrichment (
	restaurant_id TEXT PRIMARY KEY,
	website_url TEXT NOT NULL,
	newsletter_url TEXT,
	newsletter_form_html TEXT,
	newsletter_provider TEXT,
	newsletter_direct_endpoint TEXT,
	newsletter_extracted_params TEXT,
	enriched_at TEXT NOT NULL,
	updated_at TEXT NOT NULL
);

-- Log of every subscription attempt for auditing and debugging
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
