import type { NewsletterCandidate } from './types';
import { detectNewsletterProvider } from './providers';
import { upsertEnrichment } from './db';
import { safeAsync, sleep } from './utils';

const NEWSLETTER_KEYWORDS = /newsletter|subscribe|signup|sign-up|mailing.?list|email.?list|stay.?in.?touch|join.?our/i;

const PROVIDER_DOMAINS = [
	'list-manage.com',
	'klaviyo.com',
	'constantcontact.com',
	'mailerlite.com',
	'ml.com',
	'beehiiv.com',
	'substack.com',
	'squarespace.com',
];

/**
 * Extract newsletter candidate links/forms from raw HTML.
 * Scans form actions, anchor hrefs, embed/iframe src, <script src>, and inline <script> blocks.
 */
export function extractNewsletterCandidates(html: string): NewsletterCandidate[] {
	const candidates: NewsletterCandidate[] = [];
	const htmlLength = html.length;

	// 1. Form actions
	const formActionRegex = /<form[^>]*action=["']([^"']+)["'][^>]*>[\s\S]*?<\/form>/gi;
	for (const match of html.matchAll(formActionRegex)) {
		const url = match[1];
		const formHtml = match[0];
		const positionRatio = match.index! / htmlLength;
		let score = 0;

		// Score based on provider domain in action URL
		if (PROVIDER_DOMAINS.some((d) => url.includes(d))) {
			score += 30;
		}

		// Score based on newsletter keywords in form content
		if (NEWSLETTER_KEYWORDS.test(formHtml)) {
			score += 20;
		}

		// Score if form contains an email input
		if (/type=["']email["']/i.test(formHtml) || /name=["'](?:email|EMAIL)["']/i.test(formHtml)) {
			score += 10;
		}

		if (score > 0) {
			candidates.push({ url, score, source: 'form_action', formHtml, positionRatio });
		}
	}

	// 1b. Forms WITHOUT an action attribute but WITH a type="email" input
	// Squarespace and other JS-driven forms often submit via script, not action.
	const actionlessFormRegex = /<form(?=[^>]*>)(?![^>]*action=)[^>]*>([\s\S]*?)<\/form>/gi;
	for (const match of html.matchAll(actionlessFormRegex)) {
		const formHtml = match[0];
		const positionRatio = match.index! / htmlLength;

		// Only consider if the form has an email input
		if (!/type=["']email["']/i.test(formHtml) && !/name=["'](?:email|EMAIL)["']/i.test(formHtml)) {
			continue;
		}

		let score = 10; // baseline: it has an email input

		if (NEWSLETTER_KEYWORDS.test(formHtml)) {
			score += 20;
		}

		// Squarespace markers inside the form
		if (/class=["'][^"']*newsletter-form/i.test(formHtml) || /data-form-id/i.test(formHtml)) {
			score += 25;
		}

		// Use a placeholder URL — the real endpoint comes from provider detection
		const url = '#actionless-email-form';
		candidates.push({ url, score, source: 'form_action', formHtml, positionRatio });
	}

	// 2. Anchor hrefs (newsletter-related links)
	const linkRegex = /<a\s[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
	for (const match of html.matchAll(linkRegex)) {
		const url = match[1];
		const linkText = match[2];
		const positionRatio = match.index! / htmlLength;
		let score = 0;

		if (PROVIDER_DOMAINS.some((d) => url.includes(d))) {
			score += 25;
		}
		if (NEWSLETTER_KEYWORDS.test(linkText) || NEWSLETTER_KEYWORDS.test(url)) {
			score += 15;
		}

		if (score > 0) {
			candidates.push({ url, score, source: 'link', positionRatio });
		}
	}

	// 3. Embed/iframe src
	const embedRegex = /<(?:iframe|embed)\s[^>]*src=["']([^"']+)["'][^>]*>/gi;
	for (const match of html.matchAll(embedRegex)) {
		const url = match[1];
		const positionRatio = match.index! / htmlLength;
		let score = 0;

		if (PROVIDER_DOMAINS.some((d) => url.includes(d))) {
			score += 25;
		}

		if (score > 0) {
			candidates.push({ url, score, source: 'embed', positionRatio });
		}
	}

	// 4. <script src="..."> tags — provider CDNs are strong evidence
	const scriptSrcRegex = /<script\s[^>]*src=["']([^"']+)["'][^>]*>/gi;
	for (const match of html.matchAll(scriptSrcRegex)) {
		const url = match[1];
		const positionRatio = match.index! / htmlLength;
		let score = 0;

		if (PROVIDER_DOMAINS.some((d) => url.includes(d))) {
			score += 25;
		}

		if (score > 0) {
			candidates.push({ url, score, source: 'script_tag', positionRatio });
		}
	}

	// 5. Inline <script> blocks — check for provider domain references
	const inlineScriptRegex = /<script(?:\s[^>]*)?>(?![\s\S]*?src=)([\s\S]*?)<\/script>/gi;
	for (const match of html.matchAll(inlineScriptRegex)) {
		const scriptBody = match[1];
		const positionRatio = match.index! / htmlLength;

		for (const domain of PROVIDER_DOMAINS) {
			if (scriptBody.includes(domain)) {
				// Extract the full URL from the script body if possible
				const urlMatch = scriptBody.match(
					new RegExp(`(https?://[^"'\\s]*${domain.replace('.', '\\.')}[^"'\\s]*)`, 'i')
				);
				const url = urlMatch ? urlMatch[1] : domain;
				candidates.push({
					url,
					score: 25,
					source: 'inline_script',
					positionRatio,
				});
				break; // one match per script block is enough
			}
		}
	}

	// Apply footer weighting: +15 if match appears in bottom 30% of HTML
	for (const candidate of candidates) {
		if (candidate.positionRatio >= 0.7) {
			candidate.score += 15;
		}
	}

	// Sort by score descending
	candidates.sort((a, b) => b.score - a.score);

	return candidates;
}

/**
 * Enrich a single restaurant: fetch its website, detect newsletter provider,
 * extract newsletter candidates, and store results.
 */
export async function enrichRestaurant(
	db: D1Database,
	restaurantId: string,
	websiteUrl: string
): Promise<{ provider: string | null; endpoint: string | null }> {
	// Respect 800ms pacing for site requests
	await sleep(800);

	const [res, fetchErr] = await safeAsync(() =>
		fetch(websiteUrl, {
			headers: {
				'User-Agent': 'Mozilla/5.0 (compatible; RestaurantScene/1.0)',
				Accept: 'text/html',
			},
			redirect: 'follow',
		})
	);

	if (fetchErr || !res || !res.ok) {
		const evidence = fetchErr ? fetchErr.message : `HTTP ${res?.status}`;
		await upsertEnrichment(db, {
			restaurant_id: restaurantId,
			website_url: websiteUrl,
			newsletter_url: null,
			newsletter_form_html: null,
			newsletter_provider: null,
			newsletter_direct_endpoint: null,
			newsletter_extracted_params: null,
			enriched_at: new Date().toISOString(),
		});
		return { provider: null, endpoint: null };
	}

	const [html, textErr] = await safeAsync(() => res.text());
	if (textErr || !html) {
		await upsertEnrichment(db, {
			restaurant_id: restaurantId,
			website_url: websiteUrl,
			newsletter_url: null,
			newsletter_form_html: null,
			newsletter_provider: null,
			newsletter_direct_endpoint: null,
			newsletter_extracted_params: null,
			enriched_at: new Date().toISOString(),
		});
		return { provider: null, endpoint: null };
	}

	// Detect newsletter provider from raw HTML
	const detection = detectNewsletterProvider(html);

	// Extract newsletter candidates (forms, links, script tags)
	const candidates = extractNewsletterCandidates(html);
	const topCandidate = candidates[0] || null;

	// Determine the best newsletter URL and form HTML
	const newsletterUrl = detection.directEndpoint || topCandidate?.url || null;
	const newsletterFormHtml = topCandidate?.formHtml?.slice(0, 5000) || null;

	// Serialize extracted params (formId, collectionId, etc.) for later use
	const serializedParams = Object.keys(detection.extractedParams).length > 0
		? JSON.stringify(detection.extractedParams)
		: null;

	await upsertEnrichment(db, {
		restaurant_id: restaurantId,
		website_url: websiteUrl,
		newsletter_url: newsletterUrl,
		newsletter_form_html: newsletterFormHtml,
		newsletter_provider: detection.provider,
		newsletter_direct_endpoint: detection.directEndpoint,
		newsletter_extracted_params: serializedParams,
		enriched_at: new Date().toISOString(),
	});

	return { provider: detection.provider, endpoint: detection.directEndpoint };
}
