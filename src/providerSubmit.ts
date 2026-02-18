import type { SubmitResult } from './types';
import { safeAsync } from './utils';

/**
 * POST to the Mailchimp list-manage.com subscribe endpoint.
 * Uses form-urlencoded with the EMAIL field plus any extracted hidden params (u, id, etc.).
 */
export async function submitMailchimp(
	endpoint: string,
	params: Record<string, string>,
	email: string
): Promise<SubmitResult> {
	const body = new URLSearchParams({ EMAIL: email, ...params });

	const [res, err] = await safeAsync(() =>
		fetch(endpoint, {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			body: body.toString(),
			redirect: 'follow',
		})
	);

	if (err) {
		return { success: false, evidence: `Mailchimp POST failed: ${err.message}` };
	}

	const status = res.status;
	const text = await safeAsync(() => res.text());
	const responseSnippet = text[0] ? text[0].slice(0, 500) : '';

	if (status >= 200 && status < 400) {
		return {
			success: true,
			evidence: `Mailchimp POST ${status} to ${endpoint} — ${responseSnippet}`,
		};
	}

	return {
		success: false,
		evidence: `Mailchimp POST returned ${status} — ${responseSnippet}`,
	};
}

/**
 * POST to Klaviyo's subscribe API endpoint.
 * Uses JSON body with email and any extracted params (company_id, list_id).
 */
export async function submitKlaviyo(
	endpoint: string,
	params: Record<string, string>,
	email: string
): Promise<SubmitResult> {
	const payload: Record<string, unknown> = {
		email,
		...(params['list_id'] ? { g: params['list_id'] } : {}),
		...(params['company_id'] ? { $company_id: params['company_id'] } : {}),
	};

	const [res, err] = await safeAsync(() =>
		fetch(endpoint, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(payload),
			redirect: 'follow',
		})
	);

	if (err) {
		return { success: false, evidence: `Klaviyo POST failed: ${err.message}` };
	}

	const status = res.status;
	const text = await safeAsync(() => res.text());
	const responseSnippet = text[0] ? text[0].slice(0, 500) : '';

	if (status >= 200 && status < 400) {
		return {
			success: true,
			evidence: `Klaviyo POST ${status} to ${endpoint} — ${responseSnippet}`,
		};
	}

	return {
		success: false,
		evidence: `Klaviyo POST returned ${status} — ${responseSnippet}`,
	};
}

/**
 * Fallback POST for other known providers (Constant Contact, MailerLite, Beehiiv, Substack).
 * Posts form-urlencoded with a configurable email field name.
 */
export async function submitGenericProvider(
	endpoint: string,
	emailFieldName: string,
	email: string
): Promise<SubmitResult> {
	const body = new URLSearchParams({ [emailFieldName]: email });

	const [res, err] = await safeAsync(() =>
		fetch(endpoint, {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			body: body.toString(),
			redirect: 'follow',
		})
	);

	if (err) {
		return { success: false, evidence: `Generic provider POST failed: ${err.message}` };
	}

	const status = res.status;
	const text = await safeAsync(() => res.text());
	const responseSnippet = text[0] ? text[0].slice(0, 500) : '';

	if (status >= 200 && status < 400) {
		return {
			success: true,
			evidence: `Provider POST ${status} to ${endpoint} — ${responseSnippet}`,
		};
	}

	return {
		success: false,
		evidence: `Provider POST returned ${status} — ${responseSnippet}`,
	};
}
