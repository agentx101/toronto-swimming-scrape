import { createClient } from "npm:@supabase/supabase-js@2";

const allowedOrigins = new Set((Deno.env.get("ALLOWED_ORIGINS") || "").split(",").map((value) => value.trim()).filter(Boolean));
const encryptionSecret = Deno.env.get("CONTACT_ENCRYPTION_KEY") || "";
const hashSalt = Deno.env.get("CONTACT_HASH_SALT") || "";
const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const mixpanelToken = Deno.env.get("MIXPANEL_PROJECT_TOKEN") || "";
const supabase = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } });
const encoder = new TextEncoder();
const validEvents = new Set(["page_view", "scope_changed", "activity_filter_changed", "search_started", "search_completed", "contact_prompt_opened", "contact_prompt_skipped", "contact_submitted", "contact_submit_failed", "contact_link_clicked"]);

function cors(request: Request) {
  const origin = request.headers.get("origin") || "";
  return { "access-control-allow-origin": allowedOrigins.has(origin) ? origin : "", "access-control-allow-headers": "content-type", "access-control-allow-methods": "POST, OPTIONS", "content-type": "application/json; charset=utf-8", vary: "Origin" };
}
function response(request: Request, body: Record<string, unknown>, status = 200) { return new Response(JSON.stringify(body), { status, headers: cors(request) }); }
function bytesToBase64(bytes: Uint8Array) { let binary = ""; bytes.forEach((byte) => { binary += String.fromCharCode(byte); }); return btoa(binary); }
async function sha256(value: string) { const hash = await crypto.subtle.digest("SHA-256", encoder.encode(`${hashSalt}:${value}`)); return bytesToBase64(new Uint8Array(hash)); }
async function encrypt(value: string) {
  const rawKey = Uint8Array.from(atob(encryptionSecret), (char) => char.charCodeAt(0));
  if (rawKey.length !== 32) throw new Error("CONTACT_ENCRYPTION_KEY must be a base64-encoded 32-byte value.");
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await crypto.subtle.importKey("raw", rawKey, { name: "AES-GCM" }, false, ["encrypt"]);
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, encoder.encode(value));
  return { ciphertext: bytesToBase64(new Uint8Array(ciphertext)), iv: bytesToBase64(iv) };
}
function cleanPhone(value: unknown) { const digits = String(value || "").replace(/[^0-9]/g, ""); const normalized = digits.length === 10 ? `1${digits}` : digits; return normalized.length >= 11 && normalized.length <= 15 ? `+${normalized}` : ""; }
function safeFilters(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const input = value as Record<string, unknown>;
  return { scope: input.scope === "registered" ? "registered" : "dropin", kidOnly: Boolean(input.kidOnly), categories: Array.isArray(input.categories) ? input.categories.filter((item) => typeof item === "string").slice(0, 8) : [], groups: Array.isArray(input.groups) ? input.groups.filter((item) => typeof item === "string").slice(0, 30) : [], subsets: Array.isArray(input.subsets) ? input.subsets.filter((item) => typeof item === "string").slice(0, 50) : [] };
}
async function sendMixpanelEvents(rows: Array<{ visitor_hash: string; event_name: string; properties: Record<string, unknown>; occurred_at: string }>) {
  if (!mixpanelToken || !rows.length) return;
  try {
    const events = rows.map((row) => ({
      event: row.event_name,
      properties: { token: mixpanelToken, distinct_id: row.visitor_hash, time: Math.floor(new Date(row.occurred_at).getTime() / 1000), application: "toronto-activity-finder", ...row.properties },
    }));
    const result = await fetch("https://api.mixpanel.com/track?verbose=1", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(events) });
    if (!result.ok) console.error("Mixpanel event delivery failed", await result.text());
  } catch (error) { console.error("Mixpanel event delivery failed", error); }
}
async function updateMixpanelProfile(visitorHash: string, name: string, phone: string, address: string) {
  if (!mixpanelToken) return;
  try {
    const profile = { $token: mixpanelToken, $distinct_id: visitorHash, $set: { $name: name, $phone: phone, ...(address ? { address } : {}) } };
    const result = await fetch("https://api.mixpanel.com/engage", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify([profile]) });
    if (!result.ok) console.error("Mixpanel profile delivery failed", await result.text());
  } catch (error) { console.error("Mixpanel profile delivery failed", error); }
}

Deno.serve(async (request) => {
  const origin = request.headers.get("origin") || "";
  if (!allowedOrigins.has(origin)) return response(request, { error: "Origin is not allowed." }, 403);
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(request) });
  if (request.method !== "POST") return response(request, { error: "Method not allowed." }, 405);
  if (!encryptionSecret || !hashSalt || !supabaseUrl || !serviceRoleKey) return response(request, { error: "The update service is not configured." }, 503);
  try {
    const payload = await request.json();
    const deviceId = String(payload?.deviceId || "");
    if (!/^[a-zA-Z0-9_-]{20,120}$/.test(deviceId)) return response(request, { error: "Invalid device identifier." }, 400);
    const visitorHash = await sha256(deviceId);
    if (payload.action === "analytics") {
      const events = Array.isArray(payload.events) ? payload.events.slice(0, 20) : [];
      const rows = events.flatMap((event: Record<string, unknown>) => { const name = String(event?.name || ""); if (!validEvents.has(name)) return []; return [{ visitor_hash: visitorHash, event_name: name, properties: safeFilters(event?.properties), occurred_at: new Date().toISOString() }]; });
      if (rows.length) {
        const { error } = await supabase.from("portal_analytics_events").insert(rows);
        if (error) throw error;
        await sendMixpanelEvents(rows);
      }
      return response(request, { ok: true });
    }
    if (payload.action !== "contact") return response(request, { error: "Invalid action." }, 400);
    if (payload.consent !== true) return response(request, { error: "WhatsApp consent is required." }, 400);
    const name = String(payload.name || "").trim().slice(0, 80);
    const phone = cleanPhone(payload.phone);
    if (!name || !phone) return response(request, { error: "Enter your name and a valid phone number." }, 400);
    const address = String(payload.address || "").trim().slice(0, 180);
    const [phoneHash, encryptedPhone, encryptedName, encryptedAddress] = await Promise.all([
      sha256(phone), encrypt(phone), encrypt(name), address ? encrypt(address) : Promise.resolve(null),
    ]);
    // The required contact consent explicitly includes the private Mixpanel profile.
    const mixpanelConsent = true;
    const { error } = await supabase.from("portal_contacts").upsert({ device_hash: visitorHash, phone_hash: phoneHash, phone_ciphertext: encryptedPhone.ciphertext, phone_iv: encryptedPhone.iv, name_ciphertext: encryptedName.ciphertext, name_iv: encryptedName.iv, address_ciphertext: encryptedAddress?.ciphertext || null, address_iv: encryptedAddress?.iv || null, whatsapp_consent_at: new Date().toISOString(), mixpanel_consent_at: mixpanelConsent ? new Date().toISOString() : null, preferred_filters: safeFilters(payload.filters) }, { onConflict: "device_hash" });
    if (error) throw error;
    if (mixpanelConsent) await updateMixpanelProfile(visitorHash, name, phone, address);
    return response(request, { ok: true });
  } catch (error) { console.error("portal-intake error", error); return response(request, { error: "We could not save that information. Please try again." }, 500); }
});
