export function json(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data, null, 2), {
		status,
		headers: { 'Content-Type': 'application/json' },
	});
}

export type SafeResult<T> = [T, null] | [null, Error];

export async function safeAsync<T>(fn: () => Promise<T>): Promise<SafeResult<T>> {
	try {
		const result = await fn();
		return [result, null];
	} catch (err) {
		return [null, err instanceof Error ? err : new Error(String(err))];
	}
}

export function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
