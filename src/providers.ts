import type { ProviderDetectionResult } from './types';

interface ProviderMatcher {
	name: string;
	detect: (html: string) => {
		matched: boolean;
		confidence: number;
		endpoint: string | null;
		params: Record<string, string>;
	};
}

function tryUrlParam(url: string, param: string): string | null {
	try {
		return new URL(url).searchParams.get(param);
	} catch {
		return null;
	}
}

function extractHiddenInputs(formHtml: string): Record<string, string> {
	const params: Record<string, string> = {};
	const inputRegex = /<input[^>]+type=["']hidden["'][^>]*>/gi;
	for (const inputMatch of formHtml.matchAll(inputRegex)) {
		const tag = inputMatch[0];
		const nameMatch = tag.match(/name=["']([^"']+)["']/);
		const valueMatch = tag.match(/value=["']([^"']*?)["']/);
		if (nameMatch) {
			params[nameMatch[1]] = valueMatch ? valueMatch[1] : '';
		}
	}
	return params;
}

function findFormContaining(html: string, pattern: RegExp): string | null {
	const formRegex = /<form[^>]*>[\s\S]*?<\/form>/gi;
	for (const m of html.matchAll(formRegex)) {
		if (pattern.test(m[0])) return m[0];
	}
	return null;
}

const matchers: ProviderMatcher[] = [
	{
		name: 'mailchimp',
		detect(html) {
			let confidence = 0;
			let endpoint: string | null = null;
			const params: Record<string, string> = {};

			// Form actions containing list-manage.com/subscribe/post
			const formActionMatch = html.match(
				/action=["'](https?:\/\/[^"']*list-manage\.com\/subscribe\/post[^"']*)["']/i
			);
			if (formActionMatch) {
				confidence += 50;
				endpoint = formActionMatch[1];
				const u = tryUrlParam(endpoint, 'u');
				const id = tryUrlParam(endpoint, 'id');
				if (u) params['u'] = u;
				if (id) params['id'] = id;

				// Extract hidden inputs from the Mailchimp form
				const form = findFormContaining(html, /list-manage\.com/i);
				if (form) Object.assign(params, extractHiddenInputs(form));
			}

			// Script src for mc.us*.list-manage.com
			const scriptMatch = html.match(
				/src=["'](https?:\/\/mc\.us\d+\.list-manage\.com[^"']*)["']/i
			);
			if (scriptMatch) {
				confidence += 30;
				if (!endpoint) {
					const serverMatch = scriptMatch[1].match(/mc\.(us\d+)\.list-manage\.com/);
					if (serverMatch) params['server'] = serverMatch[1];
				}
			}

			return { matched: confidence > 0, confidence, endpoint, params };
		},
	},
	{
		name: 'klaviyo',
		detect(html) {
			let confidence = 0;
			let endpoint: string | null = null;
			const params: Record<string, string> = {};

			// Form actions containing klaviyo.com
			const formMatch = html.match(
				/action=["'](https?:\/\/[^"']*klaviyo\.com[^"']*)["']/i
			);
			if (formMatch) {
				confidence += 50;
				endpoint = formMatch[1];
			}

			// Script tags containing static.klaviyo.com
			if (/src=["'][^"']*static\.klaviyo\.com[^"']*["']/i.test(html)) {
				confidence += 30;
			}

			// Inline scripts containing klaviyoForms
			if (/klaviyoForms/i.test(html)) {
				confidence += 20;
			}

			// Extract company_id from Klaviyo onsite script
			const companyMatch = html.match(
				/klaviyo\.com\/media\/js\/onsite\/onsite\.js\?company_id=([^"'&\s]+)/i
			);
			if (companyMatch) {
				params['company_id'] = companyMatch[1];
				confidence += 10;
				if (!endpoint) {
					endpoint = 'https://a.klaviyo.com/api/v2/list/subscribe';
				}
			}

			// Extract list_id from data attribute
			const listMatch = html.match(/data-klaviyo-list-id=["']([^"']+)["']/i);
			if (listMatch) {
				params['list_id'] = listMatch[1];
			}

			return { matched: confidence > 0, confidence, endpoint, params };
		},
	},
	{
		name: 'constant_contact',
		detect(html) {
			let confidence = 0;
			let endpoint: string | null = null;
			const params: Record<string, string> = {};

			// Form actions containing constantcontact.com
			const formMatch = html.match(
				/action=["'](https?:\/\/[^"']*constantcontact\.com[^"']*)["']/i
			);
			if (formMatch) {
				confidence += 50;
				endpoint = formMatch[1];
			}

			// Embeds/iframes containing constantcontact.com
			const embedMatch = html.match(
				/src=["'](https?:\/\/[^"']*constantcontact\.com[^"']*)["']/i
			);
			if (embedMatch) {
				confidence += 30;
				if (!endpoint) endpoint = embedMatch[1];
			}

			// Links containing constantcontact.com
			if (/href=["'][^"']*constantcontact\.com[^"']*["']/i.test(html)) {
				confidence += 10;
			}

			return { matched: confidence > 0, confidence, endpoint, params };
		},
	},
	{
		name: 'mailerlite',
		detect(html) {
			let confidence = 0;
			let endpoint: string | null = null;
			const params: Record<string, string> = {};

			// Form actions for mailerlite.com or ml.com
			const formMatch = html.match(
				/action=["'](https?:\/\/[^"']*(?:mailerlite\.com|assets\.mailerlite\.com|ml\.com)[^"']*)["']/i
			);
			if (formMatch) {
				confidence += 50;
				endpoint = formMatch[1];
			}

			// Script src for mailerlite.com or ml.com
			if (/src=["'][^"']*(?:mailerlite\.com|static\.mailerlite\.com|ml\.com)[^"']*["']/i.test(html)) {
				confidence += 30;
			}

			// MailerLite universal snippet: ml('account', 'XXXXX')
			const mlAccountMatch = html.match(/ml\(\s*['"]account['"]\s*,\s*['"](\w+)['"]\s*\)/i);
			if (mlAccountMatch) {
				params['account_id'] = mlAccountMatch[1];
				confidence += 20;
			}

			// Extract group/form ID
			const groupMatch = html.match(/data-ml-group=["']([^"']+)["']/i);
			if (groupMatch) {
				params['group_id'] = groupMatch[1];
			}

			return { matched: confidence > 0, confidence, endpoint, params };
		},
	},
	{
		name: 'beehiiv',
		detect(html) {
			let confidence = 0;
			let endpoint: string | null = null;
			const params: Record<string, string> = {};

			// Form actions for beehiiv.com
			const formMatch = html.match(
				/action=["'](https?:\/\/[^"']*beehiiv\.com[^"']*)["']/i
			);
			if (formMatch) {
				confidence += 50;
				endpoint = formMatch[1];
			}

			// Embeds/iframes for beehiiv.com
			const embedMatch = html.match(
				/(?:src|data-src)=["'](https?:\/\/[^"']*beehiiv\.com[^"']*)["']/i
			);
			if (embedMatch) {
				confidence += 40;
				if (!endpoint) endpoint = embedMatch[1];
			}

			// Links for beehiiv.com
			const linkMatch = html.match(
				/href=["'](https?:\/\/[^"']*beehiiv\.com[^"']*)["']/i
			);
			if (linkMatch) {
				confidence += 20;
				if (!endpoint) endpoint = linkMatch[1];
			}

			// Extract publication ID from URL path
			const pubMatch = (endpoint || '').match(/beehiiv\.com\/v1\/([^/"'?\s]+)/);
			if (pubMatch) {
				params['publication_id'] = pubMatch[1];
			}

			return { matched: confidence > 0, confidence, endpoint, params };
		},
	},
	{
		name: 'squarespace',
		detect(html) {
			let confidence = 0;
			let endpoint: string | null = null;
			const params: Record<string, string> = {};

			// class="newsletter-form" is the primary Squarespace signal
			const hasNewsletterForm = /class=["'][^"']*newsletter-form[^"']*["']/i.test(html);
			if (hasNewsletterForm) {
				confidence += 40;
			}

			// data-form-id anywhere in the HTML combined with squarespace
			const formIdMatch = html.match(/data-form-id=["']([^"']+)["']/i);
			if (formIdMatch) {
				params['formId'] = formIdMatch[1];
				if (/squarespace/i.test(html)) {
					confidence += 40;
				} else {
					confidence += 10;
				}
			}

			// Extract collectionId from inline onsubmit or nearby script
			const collectionMatch = html.match(/collectionId["'\s:=]+["']([^"']+)["']/i);
			if (collectionMatch) {
				params['collectionId'] = collectionMatch[1];
				confidence += 10;
			}

			// Build the direct submit endpoint from the page's own domain
			if (confidence > 0 && params['formId']) {
				// Try to find the site domain from a canonical link or og:url
				const canonicalMatch = html.match(
					/<link[^>]+rel=["']canonical["'][^>]+href=["'](https?:\/\/[^"'/]+)/i
				);
				const ogMatch = html.match(
					/<meta[^>]+property=["']og:url["'][^>]+content=["'](https?:\/\/[^"'/]+)/i
				);
				const domain = canonicalMatch?.[1] || ogMatch?.[1] || null;
				if (domain) {
					endpoint = `${domain}/api/form/FormSubmit`;
				}
			}

			return { matched: confidence > 0, confidence, endpoint, params };
		},
	},
	{
		name: 'substack',
		detect(html) {
			let confidence = 0;
			let endpoint: string | null = null;
			const params: Record<string, string> = {};

			// Links for substack.com
			const linkMatch = html.match(
				/href=["'](https?:\/\/[^"']*\.substack\.com[^"']*)["']/i
			);
			if (linkMatch) {
				confidence += 40;
				endpoint = linkMatch[1];
			}

			// Embeds for substack.com
			const embedMatch = html.match(
				/src=["'](https?:\/\/[^"']*substack\.com[^"']*)["']/i
			);
			if (embedMatch) {
				confidence += 30;
				if (!endpoint) endpoint = embedMatch[1];
			}

			// Derive direct subscribe endpoint from subdomain
			const subdomainMatch = (endpoint || '').match(
				/https?:\/\/([^.]+)\.substack\.com/i
			);
			if (subdomainMatch) {
				params['subdomain'] = subdomainMatch[1];
				endpoint = `https://${subdomainMatch[1]}.substack.com/api/v1/free`;
			}

			return { matched: confidence > 0, confidence, endpoint, params };
		},
	},
];

export function detectNewsletterProvider(html: string): ProviderDetectionResult {
	let best: ProviderDetectionResult = {
		provider: null,
		directEndpoint: null,
		confidence: 0,
		extractedParams: {},
	};

	for (const matcher of matchers) {
		const result = matcher.detect(html);
		if (result.matched && result.confidence > best.confidence) {
			best = {
				provider: matcher.name,
				directEndpoint: result.endpoint,
				confidence: result.confidence,
				extractedParams: result.params,
			};
		}
	}

	return best;
}
