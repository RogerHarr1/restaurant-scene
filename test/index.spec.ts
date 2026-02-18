import { env, createExecutionContext, waitOnExecutionContext, SELF } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import worker from '../src/index';

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

describe('Restaurant Scene worker', () => {
	it('returns endpoint listing on GET /', async () => {
		const request = new IncomingRequest('http://example.com/');
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);
		const body = await response.json<{ status: string; endpoints: string[] }>();
		expect(body.status).toBe('ok');
		expect(body.endpoints).toContain('/enrich');
		expect(body.endpoints).toContain('/subscribe/batch');
	});

	it('rejects enrich without required fields', async () => {
		const request = new IncomingRequest('http://example.com/enrich', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({}),
		});
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(400);
	});

	it('rejects subscribe/batch without required fields', async () => {
		const request = new IncomingRequest('http://example.com/subscribe/batch', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({}),
		});
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(400);
	});
});
