export interface ProviderDetectionResult {
	provider: string | null;
	directEndpoint: string | null;
	confidence: number;
	extractedParams: Record<string, string>;
}

export interface SubmitResult {
	success: boolean;
	evidence: string;
}

export interface EnrichmentRecord {
	restaurant_id: string;
	website_url: string;
	newsletter_url: string | null;
	newsletter_form_html: string | null;
	newsletter_provider: string | null;
	newsletter_direct_endpoint: string | null;
	newsletter_extracted_params: string | null;
	enriched_at: string;
	updated_at: string;
}

export interface NewsletterCandidate {
	url: string;
	score: number;
	source: 'form_action' | 'link' | 'script_tag' | 'embed' | 'inline_script';
	formHtml?: string;
	positionRatio: number;
}

export interface SubscribeItem {
	restaurant_id: string;
	email: string;
	website_url: string;
}

export interface SubscribeResult {
	restaurant_id: string;
	tier: string;
	success: boolean;
	evidence: string;
}

export interface Restaurant {
	id: string;
	name: string;
	website_url: string | null;
	created_at: string;
}
