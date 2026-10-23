// Made With Love proposal API. Storage: Netlify Blobs (no extra setup needed on Netlify).
//   mwl-proposals : p/<id> = full proposal JSON, _index = list summaries, _counter = number sequence
//   mwl-images    : uploaded photos and logos
//   mwl-files     : the original Excel files used for each proposal
// Access: one shared password in the APP_PASSWORD environment variable, kept as a signed HttpOnly cookie.
import { getStore } from "@netlify/blobs";
import crypto from "node:crypto";

const proposals = () => getStore({ name: "mwl-proposals", consistency: "strong" });
const images = () => getStore({ name: "mwl-images", consistency: "strong" });
const files = () => getStore({ name: "mwl-files", consistency: "strong" });

const MAX_IMAGE = 5 * 1024 * 1024;
const MAX_FILE = 10 * 1024 * 1024;
const IMG_TYPES = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif", "image/svg+xml": "svg" };
const ID_RE = /^[A-Za-z0-9-]{8,64}$/;
const IMG_RE = /^[a-f0-9-]{36}\.(jpg|png|webp|gif|svg)$/;

const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...headers } });
const sha = (s) => crypto.createHash("sha256").update(String(s)).digest();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const S = (v, n = 200) => String(v ?? "").slice(0, n);

const sessionToken = () => crypto.createHmac("sha256", process.env.APP_PASSWORD).update("mwl-session-v1").digest("hex");
function authed(req) {
  const m = /(?:^|;\s*)mwl_session=([a-f0-9]+)/.exec(req.headers.get("cookie") || "");
  if (!m) return false;
  const a = Buffer.from(m[1]), b = Buffer.from(sessionToken());
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function cleanSummary(s = {}) {
  return {
    no: S(s.no, 60), customer: S(s.customer), company: S(s.company), cat: S(s.cat, 20),
    count: +s.count || 0, pieces: +s.pieces || 0, total: +s.total || 0,
    currency: S(s.currency, 5), status: S(s.status, 20), date: S(s.date, 12), valid: S(s.valid, 12),
  };
}

async function readIndex(store) {
  const idx = await store.get("_index", { type: "json" });
  if (Array.isArray(idx)) return idx;
  // Rebuild from the stored proposals if the index is missing.
  const { blobs } = await store.list({ prefix: "p/" });
  const out = [];
  for (const b of blobs) {
    const d = await store.get(b.key, { type: "json" });
    if (d) out.push({ id: d.id, ...cleanSummary(d.summary), createdAt: d.createdAt, updatedAt: d.updatedAt });
  }
  await store.setJSON("_index", out);
  return out;
}

function nextNumber(prefix, n) {
  const d = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
  return `${prefix}-${String(d.getFullYear()).slice(2)}${String(d.getMonth() + 1).padStart(2, "0")}-${String(n + 1).padStart(4, "0")}`;
}

function imageKeysIn(doc) {
  const keys = new Set();
  const add = (u) => { const m = /^\/api\/images\/([a-f0-9-]{36}\.\w+)$/.exec(String(u || "")); if (m) keys.add(m[1]); };
  (doc.items || []).forEach((it) => add(it.image));
  return [...keys];
}

export default async (req) => {
  const url = new URL(req.url);
  const parts = url.pathname.replace(/^\/api\/?/, "").split("/").filter(Boolean).map(decodeURIComponent);
  const route = parts[0] || "";
  const method = req.method;

  if (!process.env.APP_PASSWORD) return json({ error: "not_configured", message: "Set the APP_PASSWORD environment variable in Netlify." }, 503);

  if (route === "login" && method === "POST") {
    const b = await req.json().catch(() => ({}));
    const ok = crypto.timingSafeEqual(sha(b.password || ""), sha(process.env.APP_PASSWORD));
    if (!ok) { await sleep(600); return json({ error: "bad_password" }, 401); }
    return json({ ok: true }, 200, { "set-cookie": `mwl_session=${sessionToken()}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000` });
  }
  if (route === "logout" && method === "POST") return json({ ok: true }, 200, { "set-cookie": "mwl_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0" });
  if (!authed(req)) return json({ error: "unauthorized" }, 401);
  if (route === "session") return json({ ok: true });

  try {
    /* ---------- proposals ---------- */
    if (route === "proposals") {
      const store = proposals();
      const id = parts[1];
      if (!id && method === "GET") {
        const idx = await readIndex(store);
        return json(idx.slice().sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))));
      }
      if (!id || !ID_RE.test(id)) return json({ error: "bad_id" }, 400);
      if (method === "GET") {
        const d = await store.get(`p/${id}`, { type: "json" });
        return d ? json(d) : json({ error: "not_found" }, 404);
      }
      if (method === "PUT") {
        const body = await req.json().catch(() => null);
        if (!body || body.id !== id || !Array.isArray(body.items)) return json({ error: "bad_body" }, 400);
        const prev = await store.get(`p/${id}`, { type: "json" });
        const idx = await readIndex(store);
        const summary = cleanSummary(body.summary);
        if (!prev && summary.no && idx.some((x) => x.no === summary.no && x.id !== id)) return json({ error: "number_taken", no: summary.no }, 409);
        const now = new Date().toISOString();
        const doc = { ...body, summary, createdAt: prev ? prev.createdAt : now, updatedAt: now };
        await store.setJSON(`p/${id}`, doc);
        const entry = { id, ...summary, createdAt: doc.createdAt, updatedAt: now };
        const i = idx.findIndex((x) => x.id === id);
        if (i >= 0) idx[i] = entry; else idx.push(entry);
        await store.setJSON("_index", idx);
        const m = /^(MWL|WSL)-\d{4}-(\d+)$/.exec(summary.no);
        if (m) {
          const c = (await store.get(`_counter_${m[1]}`, { type: "json" })) || { n: 0 };
          if (+m[2] > c.n) await store.setJSON(`_counter_${m[1]}`, { n: +m[2] });
        }
        return json({ ok: true, id, createdAt: doc.createdAt, updatedAt: now });
      }
      if (method === "DELETE") {
        const d = await store.get(`p/${id}`, { type: "json" });
        if (d) {
          const imgs = images();
          for (const k of imageKeysIn(d)) await imgs.delete(k);
          const fs = files();
          const { blobs } = await fs.list({ prefix: `${id}/` });
          for (const b of blobs) await fs.delete(b.key);
        }
        await store.delete(`p/${id}`);
        const idx = (await readIndex(store)).filter((x) => x.id !== id);
        await store.setJSON("_index", idx);
        return json({ ok: true });
      }
    }

    if (route === "next-number" && method === "GET") {
      const prefix = url.searchParams.get("prefix") === "WSL" ? "WSL" : "MWL";
      const c = (await proposals().get(`_counter_${prefix}`, { type: "json" })) || { n: 0 };
      return json({ no: nextNumber(prefix, c.n) });
    }

    /* ---------- images ---------- */
    if (route === "images") {
      if (method === "POST") {
        const type = (req.headers.get("content-type") || "").split(";")[0].trim();
        const ext = IMG_TYPES[type];
        if (!ext) return json({ error: "bad_type" }, 415);
        const buf = await req.arrayBuffer();
        if (!buf.byteLength || buf.byteLength > MAX_IMAGE) return json({ error: "bad_size" }, 413);
        const key = `${crypto.randomUUID()}.${ext}`;
        await images().set(key, buf, { metadata: { type } });
        return json({ url: `/api/images/${key}` });
      }
      if (method === "GET" && IMG_RE.test(parts[1] || "")) {
        const r = await images().getWithMetadata(parts[1], { type: "arrayBuffer" });
        if (!r) return json({ error: "not_found" }, 404);
        return new Response(r.data, { headers: { "content-type": (r.metadata && r.metadata.type) || "application/octet-stream", "cache-control": "private, max-age=31536000, immutable", "x-content-type-options": "nosniff", "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'" } });
      }
    }

    /* ---------- original Excel files ---------- */
    if (route === "files") {
      if (method === "POST") {
        const id = url.searchParams.get("proposal") || "";
        const name = (url.searchParams.get("name") || "upload.xlsx").replace(/[^\w.\- ()]/g, "_").slice(0, 120);
        if (!ID_RE.test(id)) return json({ error: "bad_id" }, 400);
        const buf = await req.arrayBuffer();
        if (!buf.byteLength || buf.byteLength > MAX_FILE) return json({ error: "bad_size" }, 413);
        await files().set(`${id}/${name}`, buf, { metadata: { name, size: buf.byteLength } });
        return json({ name, size: buf.byteLength, url: `/api/files/${id}/${encodeURIComponent(name)}`, uploadedAt: new Date().toISOString() });
      }
      if (method === "GET" && parts.length === 3 && ID_RE.test(parts[1])) {
        const r = await files().getWithMetadata(`${parts[1]}/${parts[2]}`, { type: "arrayBuffer" });
        if (!r) return json({ error: "not_found" }, 404);
        return new Response(r.data, { headers: { "content-type": "application/octet-stream", "content-disposition": `attachment; filename="${parts[2].replace(/"/g, "")}"` } });
      }
    }
  } catch (err) {
    console.error(err);
    return json({ error: "server_error", message: String(err && err.message || err) }, 500);
  }
  return json({ error: "not_found" }, 404);
};

export const config = { path: "/api/*" };
