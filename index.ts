// supabase/functions/scan-doc/index.ts
//
// POWER-IMS "add records from a photo".
// The app sends 1-3 compressed photos of a document (invoice, receipt, delivery note,
// handwritten list). This function asks a vision model to read it and returns clean,
// structured data. NOTHING is saved here and photos are never stored or logged:
// the app shows the result to the user for review first.
//
// ── Deploy ───────────────────────────────────────────────────────────────────
//   1. supabase secrets set ANTHROPIC_API_KEY=sk-ant-...        (required)
//      supabase secrets set SCAN_MODEL=claude-sonnet-5-5         (optional; this is the default)
//      supabase secrets set ALLOWED_ORIGIN=https://your-site     (optional; default "*")
//      supabase secrets set SCAN_DAILY_LIMIT=20                  (optional; scans per user per day)
//   2. supabase functions deploy scan-doc
//   (The function keeps JWT verification ON: only signed-in users can call it.)
//
// ── Optional: daily limit per user (only used when SCAN_DAILY_LIMIT is set) ──
//   create table if not exists public.scan_usage (
//     user_id uuid not null,
//     day     date not null,
//     count   int  not null default 0,
//     primary key (user_id, day)
//   );
//   alter table public.scan_usage enable row level security;   -- no policies: service role only
//
// ── Not included (add where marked) ──────────────────────────────────────────
//   ims-gate checks that an account is active/paid. This function only checks that
//   the caller is a signed-in user. If scans should be a paid feature, add the same
//   account/plan check at the "PLAN CHECK" marker below.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const ORIGIN = Deno.env.get("ALLOWED_ORIGIN") ?? "*";
const CORS = {
  "Access-Control-Allow-Origin": ORIGIN,
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

const MAX_BODY_CHARS = 14_000_000;   // ~10 MB of base64
const MAX_IMAGE_CHARS = 5_500_000;   // per photo
const MAX_PAGES = 3;
const MAX_ITEMS = 400;
const MAX_LINES = 60;

const SYSTEM = `You read photographed business documents (invoices, receipts, delivery notes, handwritten ledger pages) for a small shop in Ethiopia and turn them into structured data by calling the record_document tool.

Rules:
- Copy only what is written. Never invent a value. If a field is not visible or you cannot read it, use null.
- Numbers: remove thousands separators, use a dot for decimals. Amounts are normally Ethiopian Birr (ETB / Birr).
- Dates: report day, month, year exactly as written. Say which calendar it uses if you can tell (Ethiopian calendar years are about 2017-2019 right now, Gregorian about 2025-2026); otherwise "unknown". Never convert dates yourself.
- unit_price is the price of ONE unit. If only quantity and a line total are written, compute unit_price = line_total / quantity.
- Keep names in the original script (Amharic stays Amharic). Do not translate.
- If the product catalog is provided, set match_id to the catalog ID of the same product ONLY when you are confident; otherwise null. Several catalog items can share one part number (for example an original and a local part): tell them apart by name and description.
- confidence: "high" when clearly printed or written, "medium" when slightly unclear, "low" when you are guessing (smudged, cropped, hard handwriting).
- If the photo is not a document, or is unreadable, set readable=false and explain in warnings.`;

const TOOL = {
  name: "record_document",
  description: "Return the data read from the document.",
  input_schema: {
    type: "object",
    properties: {
      readable: { type: "boolean" },
      party: { type: ["string", "null"], description: "Supplier (purchase) or customer (sales) named on the document" },
      date: {
        type: "object",
        properties: {
          raw: { type: ["string", "null"] },
          day: { type: ["integer", "null"] },
          month: { type: ["integer", "null"] },
          year: { type: ["integer", "null"] },
          calendar: { type: "string", enum: ["ethiopian", "gregorian", "unknown"] },
        },
        required: ["raw", "day", "month", "year", "calendar"],
      },
      payment: { type: ["string", "null"], enum: ["CASH", "CREDIT", null], description: "Only if the document says how it was paid" },
      lines: {
        type: "array",
        description: "Products on a purchase or sales document (empty for expenses)",
        items: {
          type: "object",
          properties: {
            part_no: { type: ["string", "null"] },
            name: { type: ["string", "null"] },
            description: { type: ["string", "null"] },
            qty: { type: ["number", "null"] },
            unit_price: { type: ["number", "null"] },
            line_total: { type: ["number", "null"] },
            match_id: { type: ["string", "null"] },
            confidence: { type: "string", enum: ["high", "medium", "low"] },
          },
          required: ["part_no", "name", "description", "qty", "unit_price", "line_total", "match_id", "confidence"],
        },
      },
      expenses: {
        type: "array",
        description: "Expense lines (only for expense documents)",
        items: {
          type: "object",
          properties: {
            reason: { type: ["string", "null"] },
            amount: { type: ["number", "null"] },
            confidence: { type: "string", enum: ["high", "medium", "low"] },
          },
          required: ["reason", "amount", "confidence"],
        },
      },
      document_total: { type: ["number", "null"], description: "Grand total printed on the document, if any" },
      warnings: { type: "array", items: { type: "string" } },
    },
    required: ["readable", "party", "date", "payment", "lines", "expenses", "document_total", "warnings"],
  },
};

const str = (v: unknown, n: number) => (typeof v === "string" ? v.trim().slice(0, n) : "");
const num = (v: unknown) => {
  const x = typeof v === "number" ? v : parseFloat(String(v ?? ""));
  return Number.isFinite(x) && x >= 0 && x < 1e12 ? Math.round(x * 100) / 100 : null;
};
const conf = (v: unknown) => (v === "high" || v === "medium" || v === "low" ? v : "medium");
const int = (v: unknown, lo: number, hi: number) => {
  const x = typeof v === "number" ? Math.trunc(v) : NaN;
  return Number.isFinite(x) && x >= lo && x <= hi ? x : null;
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  // ── who is calling? ──
  const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!token) return json({ error: "auth_required" }, 401);
  const url = Deno.env.get("SUPABASE_URL")!;
  const sb = createClient(url, Deno.env.get("SUPABASE_ANON_KEY")!);
  const { data: u, error: uerr } = await sb.auth.getUser(token);
  if (uerr || !u?.user) return json({ error: "auth_required" }, 401);
  const userId = u.user.id;

  // PLAN CHECK: add an "is this account allowed to use scans?" check here if needed.

  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) return json({ error: "not_configured" }, 503);

  // ── read and validate the request ──
  let raw = "";
  try { raw = await req.text(); } catch { return json({ error: "bad_request" }, 400); }
  if (raw.length > MAX_BODY_CHARS) return json({ error: "too_large" }, 413);
  let body: any;
  try { body = JSON.parse(raw); } catch { return json({ error: "bad_request" }, 400); }

  const kind = body?.kind;
  if (kind !== "purchase" && kind !== "sales" && kind !== "expense") return json({ error: "bad_request" }, 400);
  const images: string[] = Array.isArray(body?.images) ? body.images : [];
  if (images.length < 1 || images.length > MAX_PAGES) return json({ error: "bad_request" }, 400);
  const blocks: unknown[] = [];
  for (const img of images) {
    const m = typeof img === "string" ? img.match(/^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/) : null;
    if (!m) return json({ error: "bad_request" }, 400);
    if (m[2].length > MAX_IMAGE_CHARS) return json({ error: "too_large" }, 413);
    blocks.push({ type: "image", source: { type: "base64", media_type: m[1], data: m[2] } });
  }

  // product catalog (purchase / sales only) so the model can suggest matches
  const catalog: { id: string; part: string; name: string; desc: string }[] = [];
  if (kind !== "expense" && Array.isArray(body?.items)) {
    for (const it of body.items.slice(0, MAX_ITEMS)) {
      const id = str(it?.id, 60);
      if (id) catalog.push({ id, part: str(it?.part, 60), name: str(it?.name, 80), desc: str(it?.desc, 80) });
    }
  }
  const ids = new Set(catalog.map((c) => c.id.toLowerCase()));

  // ── optional daily limit ──
  const LIMIT = Number(Deno.env.get("SCAN_DAILY_LIMIT") ?? 0);
  let admin: ReturnType<typeof createClient> | null = null;
  let used = 0;
  const day = new Date().toISOString().slice(0, 10);
  if (LIMIT > 0) {
    admin = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const { data: row } = await admin.from("scan_usage").select("count").eq("user_id", userId).eq("day", day).maybeSingle();
    used = row?.count ?? 0;
    if (used >= LIMIT) return json({ error: "limit_reached", limit: LIMIT }, 429);
  }

  // ── ask the model ──
  const what = kind === "purchase"
    ? "a PURCHASE document. party = the supplier (seller). Fill lines; leave expenses empty."
    : kind === "sales"
    ? "a SALES document. party = the customer (buyer). Fill lines; leave expenses empty."
    : "an EXPENSE document (rent, fuel, salary, transport...). Fill expenses (one entry per expense line, reason + amount); leave lines empty.";
  const catalogText = catalog.length
    ? "\n\nProduct catalog (ID | part number | name | description):\n" + catalog.map((c) => `${c.id} | ${c.part} | ${c.name} | ${c.desc}`).join("\n")
    : "";
  const instruction = `This is ${what} It may span ${images.length} photo(s) of the same document; combine them.${catalogText}`;

  let out: any = null;
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: Deno.env.get("SCAN_MODEL") ?? "claude-sonnet-5-5",
        max_tokens: 4096,
        system: SYSTEM,
        tools: [TOOL],
        tool_choice: { type: "tool", name: "record_document" },
        messages: [{ role: "user", content: [...blocks, { type: "text", text: instruction }] }],
      }),
      signal: AbortSignal.timeout(50_000),
    });
    if (!res.ok) {
      console.error("reader http", res.status);                    // status only, never the content
      return json({ error: "reader_failed" }, 502);
    }
    const data = await res.json();
    out = (data?.content ?? []).find((b: any) => b?.type === "tool_use" && b?.name === "record_document")?.input ?? null;
  } catch (e) {
    console.error("reader error", (e as Error)?.name);
    return json({ error: "reader_failed" }, 502);
  }
  if (!out) return json({ error: "reader_failed" }, 502);

  // ── clean the answer before it reaches the app ──
  const d = out.date ?? {};
  const doc = {
    kind,
    readable: out.readable !== false,
    party: str(out.party, 120) || null,
    date: {
      raw: str(d.raw, 40) || null,
      day: int(d.day, 1, 31),
      month: int(d.month, 1, 13),
      year: int(d.year, 1900, 2200),
      calendar: d.calendar === "ethiopian" || d.calendar === "gregorian" ? d.calendar : "unknown",
    },
    payment: out.payment === "CASH" || out.payment === "CREDIT" ? out.payment : null,
    lines: (Array.isArray(out.lines) ? out.lines : []).slice(0, MAX_LINES).map((l: any) => {
      const mid = str(l?.match_id, 60);
      return {
        part_no: str(l?.part_no, 60) || null,
        name: str(l?.name, 120) || null,
        description: str(l?.description, 160) || null,
        qty: num(l?.qty),
        unit_price: num(l?.unit_price),
        line_total: num(l?.line_total),
        match_id: mid && ids.has(mid.toLowerCase()) ? catalog.find((c) => c.id.toLowerCase() === mid.toLowerCase())!.id : null,
        confidence: conf(l?.confidence),
      };
    }),
    expenses: (Array.isArray(out.expenses) ? out.expenses : []).slice(0, MAX_LINES).map((x: any) => ({
      reason: str(x?.reason, 200) || null,
      amount: num(x?.amount),
      confidence: conf(x?.confidence),
    })),
    document_total: num(out.document_total),
    warnings: (Array.isArray(out.warnings) ? out.warnings : []).slice(0, 5).map((w: unknown) => str(w, 200)).filter(Boolean),
  };

  if (admin) {
    // not atomic: good enough as a soft cost guard
    await admin.from("scan_usage").upsert({ user_id: userId, day, count: used + 1 }, { onConflict: "user_id,day" });
  }
  return json({ ok: true, doc });
});
