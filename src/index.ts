export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Quick DB connectivity check
    if (url.pathname === "/health") {
      const r = await env.DB.prepare("SELECT 1 AS ok").first();
      return Response.json({ ok: true, db: r?.ok === 1 });
    }

    // CSV import endpoint
    if (url.pathname === "/api/import" && request.method === "POST") {
      const csvText = await request.text();

      if (!csvText || !csvText.trim()) {
        return Response.json({ ok: false, error: "Empty CSV" }, { status: 400 });
      }

      const batchId = crypto.randomUUID();
      const now = new Date().toISOString();

      await env.DB.prepare(
        `INSERT INTO batch (id, created_at, status, total_rows, processed_rows)
         VALUES (?, ?, ?, 0, 0)`
      ).bind(batchId, now, "pending").run();

      const rows = parseCSV(csvText);

      for (const r of rows) {
        await env.DB.prepare(
          `INSERT INTO restaurant_input
           (batch_id, customer_id, restaurant_name, street, city, state, zip, phone, provided_website, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).bind(
          batchId,
          r.CustomerId ?? null,
          r.RestaurantName,
          r.Street ?? null,
          r.City ?? null,
          r.State ?? null,
          r.Zip ?? null,
          r.Phone ?? null,
          r.Website ?? null,
          now
        ).run();
      }

      await env.DB.prepare(
        `UPDATE batch SET status = ?, total_rows = ?, processed_rows = ? WHERE id = ?`
      ).bind("complete", rows.length, rows.length, batchId).run();

      return Response.json({ ok: true, batchId, rowsInserted: rows.length });
    }

    return Response.json({ error: "Not Found" }, { status: 404 });
  },
};

interface Env {
  DB: D1Database;
}

// MVP CSV parser (no quoted-comma support yet)
function parseCSV(text: string): Array<Record<string, string>> {
  const lines = text.replace(/\r/g, "").split("\n").filter((l) => l.trim().length);
  if (lines.length < 2) return [];

  const headers = lines[0].split(",").map((h) => h.trim());
  const out: Array<Record<string, string>> = [];

  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(",").map((c) => c.trim());
    const obj: Record<string, string> = {};
    headers.forEach((h, idx) => (obj[h] = cols[idx] ?? ""));
    if (obj.RestaurantName?.trim()) out.push(obj);
  }

  return out;
}
