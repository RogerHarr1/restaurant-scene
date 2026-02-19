import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import worker from '../src/index';

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

describe('Restaurant Scene worker', () => {
	it('GET /health returns ok', async () => {
		const request = new IncomingRequest('http://example.com/health');
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);
		const body = await response.json<{ status: string }>();
		expect(body.status).toBe('ok');
	});

	it('GET / returns endpoint listing', async () => {
		const request = new IncomingRequest('http://example.com/');
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);
		const body = await response.json<{ status: string; endpoints: string[] }>();
		expect(body.status).toBe('ok');
		expect(body.endpoints).toContain('/health');
		expect(body.endpoints).toContain('/api/import');
		expect(body.endpoints).toContain('/api/enrich');
		expect(body.endpoints).toContain('/api/subscribe');
	});

	it('POST /api/import rejects empty body', async () => {
		const request = new IncomingRequest('http://example.com/api/import', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({}),
		});
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(400);
	});

	it('POST /api/import accepts valid restaurants', async () => {
		const request = new IncomingRequest('http://example.com/api/import', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				restaurants: [
					{ id: 'r1', name: 'Test Bistro', website_url: 'https://testbistro.com' },
					{ id: 'r2', name: 'Pizza Place', website_url: 'https://pizzaplace.com' },
				],
			}),
		});
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(200);
		const body = await response.json<{ imported: number }>();
		expect(body.imported).toBe(2);
	});

	it('POST /api/enrich returns empty when nothing to enrich', async () => {
		const request = new IncomingRequest('http://example.com/api/enrich', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({}),
		});
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(200);
		const body = await response.json<{ enriched: number }>();
		expect(body.enriched).toBe(0);
	});

	it('POST /api/subscribe rejects missing fields', async () => {
		const request = new IncomingRequest('http://example.com/api/subscribe', {
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
