export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      const r = await env.DB.prepare("SELECT 1 AS ok").first();
      return Response.json({ ok: true, db: r?.ok === 1 });
    }

    if (url.pathname === "/api/import" && request.method === "POST") {
      return handleImport(request, env);
    }

    if (url.pathname === "/api/enrich" && request.method === "POST") {
      const batchId = url.searchParams.get("batchId");
      const limit = parseInt(url.searchParams.get("limit") ?? "25", 10);
      if (!batchId) return Response.json({ ok: false, error: "Missing batchId" }, { status: 400 });

      const result = await handleEnrichBatch(batchId, Math.max(1, Math.min(limit, 50)), env);
      return Response.json({ ok: true, ...result });
    }

    return Response.json({ error: "Not Found" }, { status: 404 });
  },
};

interface Env {
  DB: D1Database;
}

/* -------------------- IMPORT -------------------- */

async function handleImport(request: Request, env: Env): Promise<Response> {
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
      normalizeUrl(r.Website) ?? null,
      now
    ).run();
  }

  await env.DB.prepare(
    `UPDATE batch SET status = ?, total_rows = ?, processed_rows = ? WHERE id = ?`
  ).bind("complete", rows.length, rows.length, batchId).run();

  return Response.json({ ok: true, batchId, rowsInserted: rows.length });
}

/* -------------------- ENRICH -------------------- */

type LinkCandidate = { url: string; text: string; score: number; typeGuess: LinkType };
type LinkType = "ORDERING" | "NEWSLETTER" | "MENU" | "OTHER";

async function handleEnrichBatch(batchId: string, limit: number, env: Env) {
  const rows = await env.DB.prepare(
    `SELECT id, restaurant_name, provided_website
     FROM restaurant_input
     WHERE batch_id = ?
     ORDER BY id
     LIMIT ?`
  ).bind(batchId, limit).all();

  const items = rows.results ?? [];
  let enriched = 0;
  const errors: Array<{ restaurant_input_id: number; error: string }> = [];

  for (const item of items as any[]) {
    const rid = item.id as number;
    const website = item.provided_website as string | null;

    if (!website) {
      await upsertEnrichment(env, rid, {
        foundWebsite: null,
        websiteConfidence: 0,
        orderingUrl: null,
        orderingConfidence: 0,
        orderingProvider: null,
        newsletterUrl: null,
        newsletterConfidence: 0,
        evidence: "No website provided; skipping fetch.",
      });
      continue;
    }

    const normalizedWebsite = normalizeUrl(website);
    if (!normalizedWebsite) {
      await upsertEnrichment(env, rid, {
        foundWebsite: null,
        websiteConfidence: 0,
        orderingUrl: null,
        orderingConfidence: 0,
        orderingProvider: null,
        newsletterUrl: null,
        newsletterConfidence: 0,
        evidence: "Website value present but could not be normalized.",
      });
      continue;
    }

    try {
      const fetchRes = await fetch(normalizedWebsite, {
        headers: {
          "User-Agent": "SpecialtyProduceRestaurantSceneBot/1.0",
          "Accept": "text/html,application/xhtml+xml",
        },
      });

      const status = fetchRes.status;
      const ct = fetchRes.headers.get("content-type") ?? "";
      const html = ct.includes("text/html") ? await fetchRes.text() : "";

      if (!fetchRes.ok || !html) {
        await upsertEnrichment(env, rid, {
          foundWebsite: normalizedWebsite,
          websiteConfidence: fetchRes.ok ? 0.7 : 0.4,
          orderingUrl: null,
          orderingConfidence: 0,
          orderingProvider: null,
          newsletterUrl: null,
          newsletterConfidence: 0,
          evidence: `Fetch failed or non-HTML. status=${status}, content-type=${ct}`,
        });
        continue;
      }

      const links = extractLinks(html, normalizedWebsite);

      // store candidates
      for (const l of links) {
        await env.DB.prepare(
          `INSERT INTO link_candidates (restaurant_input_id, url, anchor_text, score, link_type_guess, discovered_at)
           VALUES (?, ?, ?, ?, ?, ?)`
        ).bind(rid, l.url, l.text?.slice(0, 500) ?? null, l.score, l.typeGuess, new Date().toISOString()).run();
      }

      // choose best ordering + newsletter
      const bestOrdering = pickBest(links, "ORDERING");
      const bestNewsletter = pickBest(links, "NEWSLETTER");

      const orderingProvider = bestOrdering ? detectOrderingProvider(bestOrdering.url) : null;

      const evidenceParts: string[] = [];
      evidenceParts.push(`Fetched ${normalizedWebsite} OK; extracted ${links.length} links.`);
      if (bestOrdering) evidenceParts.push(`Best ORDERING: ${bestOrdering.url} (score=${bestOrdering.score}, text="${bestOrdering.text}")`);
      if (bestNewsletter) evidenceParts.push(`Best NEWSLETTER: ${bestNewsletter.url} (score=${bestNewsletter.score}, text="${bestNewsletter.text}")`);

      await upsertEnrichment(env, rid, {
        foundWebsite: normalizedWebsite,
        websiteConfidence: 0.9,
        orderingUrl: bestOrdering?.url ?? null,
        orderingConfidence: bestOrdering ? clamp01(bestOrdering.score / 100) : 0,
        orderingProvider,
        newsletterUrl: bestNewsletter?.url ?? null,
        newsletterConfidence: bestNewsletter ? clamp01(bestNewsletter.score / 100) : 0,
        evidence: evidenceParts.join(" "),
      });

      enriched++;
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      errors.push({ restaurant_input_id: rid, error: msg });

      await upsertEnrichment(env, rid, {
        foundWebsite: normalizedWebsite,
        websiteConfidence: 0.5,
        orderingUrl: null,
        orderingConfidence: 0,
        orderingProvider: null,
        newsletterUrl: null,
        newsletterConfidence: 0,
        evidence: `Exception during fetch/parse: ${msg}`,
      });
    }
  }

  return { batchId, attempted: items.length, enriched, errors };
}

function extractLinks(html: string, baseUrl: string): LinkCandidate[] {
  // Very simple anchor parser; good enough for MVP
  const out: LinkCandidate[] = [];
  const re = /<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>(.*?)<\/a>/gis;

  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const hrefRaw = (m[1] ?? "").trim();
    const innerHtml = m[2] ?? "";
    const text = stripHtml(innerHtml).trim().replace(/\s+/g, " ").slice(0, 200);

    const abs = toAbsoluteUrl(hrefRaw, baseUrl);
    if (!abs) continue;

    const { score, typeGuess } = scoreLink(abs, text);
    out.push({ url: abs, text, score, typeGuess });
  }

  // de-dupe by url keep max score
  const map = new Map<string, LinkCandidate>();
  for (const l of out) {
    const existing = map.get(l.url);
    if (!existing || l.score > existing.score) map.set(l.url, l);
  }
  return [...map.values()].sort((a, b) => b.score - a.score);
}

function scoreLink(url: string, text: string): { score: number; typeGuess: LinkType } {
  const u = url.toLowerCase();
  const t = (text ?? "").toLowerCase();

  let order = 0;
  let news = 0;
  let menu = 0;

  // Ordering keywords
  if (t.includes("order")) order += 35;
  if (t.includes("pickup") || t.includes("pick-up") || t.includes("to-go") || t.includes("takeout") || t.includes("take-out")) order += 25;
  if (t.includes("delivery")) order += 20;
  if (t.includes("start order")) order += 30;
  if (u.includes("/order") || u.includes("ordering")) order += 25;

  // Ordering providers
  const providers = ["toasttab.com", "chownow.com", "doordash.com", "ubereats.com", "grubhub.com", "postmates.com", "olo.com", "clover.com", "square.site", "order.online"];
  if (providers.some(p => u.includes(p))) order += 60;

  // Newsletter keywords
  if (t.includes("newsletter")) news += 50;
  if (t.includes("subscribe")) news += 40;
  if (t.includes("join") && t.includes("list")) news += 35;
  if (t.includes("email") && t.includes("list")) news += 35;
  if (u.includes("newsletter") || u.includes("subscribe")) news += 25;

  // Newsletter providers
  const mailProviders = ["list-manage.com", "mailchimp.com", "klaviyo.com", "campaignmonitor.com"];
  if (mailProviders.some(p => u.includes(p))) news += 60;

  // Menu keywords
  if (t === "menu" || t.includes("view menu")) menu += 45;
  if (u.includes("/menu")) menu += 30;

  // pick type
  const max = Math.max(order, news, menu);
  let typeGuess: LinkType = "OTHER";
  let score = max;

  if (max === 0) return { score: 0, typeGuess: "OTHER" };
  if (max === order) typeGuess = "ORDERING";
  else if (max === news) typeGuess = "NEWSLETTER";
  else typeGuess = "MENU";

  // cap
  score = Math.min(100, score);
  return { score, typeGuess };
}

function pickBest(links: LinkCandidate[], type: LinkType): LinkCandidate | null {
  const filtered = links.filter(l => l.typeGuess === type && l.score >= 40);
  if (filtered.length === 0) return null;
  return filtered[0];
}

function detectOrderingProvider(url: string): string | null {
  const u = url.toLowerCase();
  if (u.includes("toasttab.com")) return "Toast";
  if (u.includes("chownow.com")) return "ChowNow";
  if (u.includes("doordash.com")) return "DoorDash";
  if (u.includes("ubereats.com")) return "UberEats";
  if (u.includes("grubhub.com")) return "Grubhub";
  if (u.includes("olo.com")) return "Olo";
  if (u.includes("square.site")) return "Square";
  if (u.includes("order.online")) return "OrderOnline";
  return null;
}

function stripHtml(s: string): string {
  return s.replace(/<[^>]+>/g, "");
}

function toAbsoluteUrl(href: string, baseUrl: string): string | null {
  if (!href) return null;
  const h = href.trim();

  // ignore anchors, mailto, tel, javascript
  if (h.startsWith("#")) return null;
  if (/^(mailto:|tel:|javascript:)/i.test(h)) return null;

  try {
    // Already absolute?
    if (/^https?:\/\//i.test(h)) return normalizeUrl(h);
    if (h.startsWith("//")) return normalizeUrl("https:" + h);

    const abs = new URL(h, baseUrl).toString();
    return normalizeUrl(abs);
  } catch {
    return null;
  }
}

function normalizeUrl(input?: string | null): string | null {
  if (!input) return null;
  let u = input.trim();

  // strip trailing punctuation
  while (u.length && /[.,;)]$/.test(u)) u = u.slice(0, -1).trim();
  if (!u) return null;

  // upgrade http -> https
  if (/^https?:\/\//i.test(u)) return u.replace(/^http:\/\//i, "https://");

  // protocol-relative
  if (u.startsWith("//")) return "https:" + u;

  return "https://" + u;
}

function clamp01(x: number): number {
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

async function upsertEnrichment(
  env: Env,
  restaurantInputId: number,
  data: {
    foundWebsite: string | null;
    websiteConfidence: number;
    orderingUrl: string | null;
    orderingConfidence: number;
    orderingProvider: string | null;
    newsletterUrl: string | null;
    newsletterConfidence: number;
    evidence: string;
  }
) {
  // simple pattern: delete existing then insert (MVP)
  await env.DB.prepare(`DELETE FROM restaurant_enrichment WHERE restaurant_input_id = ?`)
    .bind(restaurantInputId)
    .run();

  await env.DB.prepare(
    `INSERT INTO restaurant_enrichment
     (restaurant_input_id, found_website, website_confidence, ordering_url, ordering_confidence, ordering_provider,
      newsletter_url, newsletter_confidence, evidence, enriched_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    restaurantInputId,
    data.foundWebsite,
    data.websiteConfidence,
    data.orderingUrl,
    data.orderingConfidence,
    data.orderingProvider,
    data.newsletterUrl,
    data.newsletterConfidence,
    data.evidence,
    new Date().toISOString()
  ).run();
}

/* -------------------- CSV PARSE -------------------- */

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
