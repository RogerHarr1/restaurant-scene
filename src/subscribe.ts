import type { SubscribeItem, SubscribeResult, SubmitResult } from './types';
import { getEnrichment, logSubscriptionAttempt } from './db';
import { detectNewsletterProvider } from './providers';
import { submitMailchimp, submitKlaviyo, submitSquarespace, submitGenericProvider } from './providerSubmit';
import { extractNewsletterCandidates } from './enrich';
import { safeAsync, sleep } from './utils';

const CAPTCHA_SIGNALS = /captcha|recaptcha|hcaptcha|cf-turnstile|challenge-form|g-recaptcha/i;

/** Map provider name to its default email field name for generic submit */
const PROVIDER_EMAIL_FIELDS: Record<string, string> = {
	constant_contact: 'email',
	mailerlite: 'fields[email]',
	beehiiv: 'email',
	substack: 'email',
};

/**
 * Dispatch a Tier 1 direct-submit to the appropriate provider function.
 */
async function tier1Submit(
	provider: string,
	endpoint: string,
	params: Record<string, string>,
	email: string
): Promise<SubmitResult> {
	switch (provider) {
		case 'mailchimp':
			return submitMailchimp(endpoint, params, email);
		case 'klaviyo':
			return submitKlaviyo(endpoint, params, email);
		case 'squarespace':
			return submitSquarespace(endpoint, params, email);
		default: {
			const emailField = PROVIDER_EMAIL_FIELDS[provider] || 'email';
			return submitGenericProvider(endpoint, emailField, email);
		}
	}
}

/**
 * Tier 2: Fetch the website, detect forms, and submit via form POST.
 * Returns null if CAPTCHA is detected (caller should escalate to Tier 3).
 */
async function tier2FormSubmit(
	websiteUrl: string,
	email: string
): Promise<{ result: SubmitResult; provider: string | null; endpoint: string | null } | 'captcha' | 'no_form'> {
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
		return {
			result: {
				success: false,
				evidence: `Tier 2 fetch failed: ${fetchErr?.message || `HTTP ${res?.status}`}`,
			},
			provider: null,
			endpoint: websiteUrl,
		};
	}

	const [html, textErr] = await safeAsync(() => res.text());
	if (textErr || !html) {
		return {
			result: { success: false, evidence: `Tier 2 body read failed: ${textErr?.message}` },
			provider: null,
			endpoint: websiteUrl,
		};
	}

	// Check for CAPTCHA
	if (CAPTCHA_SIGNALS.test(html)) {
		return 'captcha';
	}

	// Try provider detection on fresh HTML
	const detection = detectNewsletterProvider(html);
	if (detection.directEndpoint && detection.provider) {
		const submitResult = await tier1Submit(
			detection.provider,
			detection.directEndpoint,
			detection.extractedParams,
			email
		);
		return { result: submitResult, provider: detection.provider, endpoint: detection.directEndpoint };
	}

	// Fall back to newsletter candidate extraction
	const candidates = extractNewsletterCandidates(html);
	if (candidates.length === 0) {
		return 'no_form';
	}

	const best = candidates[0];
	// Try submitting to the best candidate form action
	const submitResult = await submitGenericProvider(best.url, 'email', email);
	return { result: submitResult, provider: null, endpoint: best.url };
}

/**
 * Process a batch of subscription requests through the tiered pipeline:
 *   Tier 1: Direct provider submit (200ms pacing)
 *   Tier 2: Website fetch + form detection (800ms pacing)
 *   Tier 3: NeedsManual logging for CAPTCHA/blocked sites
 */
export async function handleSubscribeBatch(
	db: D1Database,
	items: SubscribeItem[]
): Promise<SubscribeResult[]> {
	const results: SubscribeResult[] = [];

	for (const item of items) {
		// Check enrichment for a pre-detected direct endpoint
		const enrichment = await getEnrichment(db, item.restaurant_id);

		if (enrichment?.newsletter_direct_endpoint && enrichment.newsletter_provider) {
			// --- Tier 1: Direct provider submit ---
			await sleep(200); // Provider infrastructure can handle faster pacing

			let extractedParams: Record<string, string> = {};
			// Read persisted params from enrichment
			if (enrichment.newsletter_extracted_params) {
				try {
					extractedParams = JSON.parse(enrichment.newsletter_extracted_params);
				} catch {
					// JSON parse failed, proceed without params
				}
			}

			const submitResult = await tier1Submit(
				enrichment.newsletter_provider,
				enrichment.newsletter_direct_endpoint,
				extractedParams,
				item.email
			);

			await logSubscriptionAttempt(db, {
				restaurant_id: item.restaurant_id,
				email: item.email,
				tier: 'tier1_direct',
				provider: enrichment.newsletter_provider,
				endpoint: enrichment.newsletter_direct_endpoint,
				success: submitResult.success,
				evidence: submitResult.evidence,
			});

			results.push({
				restaurant_id: item.restaurant_id,
				tier: 'tier1_direct',
				success: submitResult.success,
				evidence: submitResult.evidence,
			});
			continue;
		}

		// --- Tier 2: Website fetch + form detection ---
		await sleep(800); // Standard pacing for site requests

		const tier2Result = await tier2FormSubmit(item.website_url, item.email);

		if (tier2Result === 'captcha') {
			// --- Tier 3: NeedsManual ---
			await logSubscriptionAttempt(db, {
				restaurant_id: item.restaurant_id,
				email: item.email,
				tier: 'tier3_needs_manual',
				provider: null,
				endpoint: item.website_url,
				success: false,
				evidence: 'CAPTCHA or bot protection detected on website',
			});

			results.push({
				restaurant_id: item.restaurant_id,
				tier: 'tier3_needs_manual',
				success: false,
				evidence: 'CAPTCHA or bot protection detected on website',
			});
			continue;
		}

		if (tier2Result === 'no_form') {
			await logSubscriptionAttempt(db, {
				restaurant_id: item.restaurant_id,
				email: item.email,
				tier: 'tier2_form',
				provider: null,
				endpoint: item.website_url,
				success: false,
				evidence: 'No newsletter form found on website',
			});

			results.push({
				restaurant_id: item.restaurant_id,
				tier: 'tier2_form',
				success: false,
				evidence: 'No newsletter form found on website',
			});
			continue;
		}

		// Tier 2 got a result
		await logSubscriptionAttempt(db, {
			restaurant_id: item.restaurant_id,
			email: item.email,
			tier: 'tier2_form',
			provider: tier2Result.provider,
			endpoint: tier2Result.endpoint,
			success: tier2Result.result.success,
			evidence: tier2Result.result.evidence,
		});

		results.push({
			restaurant_id: item.restaurant_id,
			tier: 'tier2_form',
			success: tier2Result.result.success,
			evidence: tier2Result.result.evidence,
		});
	}

	return results;
}
