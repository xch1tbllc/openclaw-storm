// @eyewallmarkets/openclaw-storm — agent-facing tools for Storm.
//
// Foundation slice (v0.1.0):
//   Free tools (no auth): storm_feed_top, storm_feed_topical,
//     storm_calibration_venue, storm_event_show
//   Bind flow:            storm_bind_init, storm_bind_status, storm_me_tier
//
// Tier discipline lives on the Storm side — every Pro/Edge gate is
// enforced by /skill/* responding 403 with an upsell payload. The plugin
// exposes the call surface and lets Storm decide entitlement.
//
// State is stored on the Storm side: an opaque skill_inbox_token issued
// at bind-confirm authenticates the user across plugin invocations.
// The plugin itself is stateless — the token is read from plugin config
// (set by the user after running storm_bind_init and clicking the email
// link) on every call.

import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

const DEFAULT_BASE_URL = "https://eyewallmarkets.com";

// JSON-Schema parameter blocks. Plain literals so the plugin has zero
// runtime dependencies — TypeBox would be nicer ergonomically but the
// install path doesn't auto-vendor deps and we'd rather not require an
// `npm install` step on every plugin sync.
const SCHEMAS = {
  feed_top: {
    type: "object",
    additionalProperties: false,
    properties: {
      limit: { type: "integer", minimum: 1, maximum: 50, default: 12, description: "Max items to return (1-50)." },
      min_edge_bps: { type: "integer", minimum: 0, default: 30, description: "Minimum net edge in basis points (after fees)." },
    },
  },
  feed_topical: {
    type: "object",
    additionalProperties: false,
    required: ["topics"],
    properties: {
      topics: { type: "array", items: { type: "string" }, description: "Topic slugs (e.g. ['us_elections', 'fed_policy'])." },
      limit: { type: "integer", minimum: 1, maximum: 50, default: 8 },
      min_edge_bps: { type: "integer", minimum: 0, default: 30 },
    },
  },
  calibration_venue: {
    type: "object",
    additionalProperties: false,
    properties: {
      venue: { type: "string", description: "Venue slug (polymarket, kalshi, etc.). Omit for cross-venue overview." },
      horizon_days: { type: "integer", minimum: 1, maximum: 365, default: 7 },
    },
  },
  event_show: {
    type: "object",
    additionalProperties: false,
    required: ["event_slug"],
    properties: {
      event_slug: { type: "string", description: "Storm event slug, e.g. '2026_us_house_majority'." },
    },
  },
  bind_init: {
    type: "object",
    additionalProperties: false,
    required: ["email", "openclaw_user_id"],
    properties: {
      email: { type: "string", description: "User's email address." },
      openclaw_user_id: { type: "string", description: "Stable identifier for the OpenClaw user — typically the agent runtime's user id." },
    },
  },
  empty: { type: "object", additionalProperties: false, properties: {} },
};

function asText(payload) {
  return { content: [{ type: "text", text: typeof payload === "string" ? payload : JSON.stringify(payload, null, 2) }] };
}

async function stormFetch(api, path, { method = "GET", body = null, skillToken = "none" } = {}) {
  // Read config fresh on every call so a user editing skillToken
  // doesn't have to restart the gateway. api.pluginConfig is the
  // documented register-time snapshot; api.config also resolves to
  // the same shape on most SDK versions — fall through both.
  const config = api.pluginConfig || api.config || {};
  const baseUrl = (config.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, "");
  const headers = { accept: "application/json" };
  if (body) headers["content-type"] = "application/json";
  // skillToken: "none"     — never send (free public endpoints)
  //             "optional"  — send if user has bound, otherwise omit
  //             "required"  — fail fast if no token (mutating Pro/Edge calls)
  if (skillToken === "required" || skillToken === "optional") {
    const token = config.skillToken;
    if (!token && skillToken === "required") {
      return { ok: false, reason: "not_bound", message: "This tool needs an Eyewall Markets account binding. Run storm_bind_init first; after you click the email link, paste the token shown into the plugin config under skillToken." };
    }
    if (token) headers.authorization = `Bearer ${token}`;
  }
  const url = `${baseUrl}${path}`;
  let res;
  try {
    res = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
  } catch (err) {
    return { ok: false, reason: "network_error", message: `Could not reach ${url}: ${err.message}` };
  }
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); }
  catch { return { ok: false, reason: "invalid_response", status: res.status, body: text.slice(0, 500) }; }
  if (!res.ok && json.ok !== true) {
    return { ok: false, status: res.status, ...json };
  }
  return json;
}

export default definePluginEntry({
  id: "openclaw-storm",
  name: "Storm",
  description: "Storm prediction-market arbitrage feed + Pro/Edge upsell flow",
  register(api) {
    api.registerTool({
      name: "storm_feed_top",
      description: "Fetch the top cross-venue arbitrage opportunities Storm is currently tracking. Returns up to `limit` items, each with the event title, the two venues, the price legs, and the net edge in basis points after estimated fees. Use this to surface what's most actionable right now without any user binding required.",
      parameters: SCHEMAS.feed_top,
      async execute(_id, params) {
        const url = `/api/v1/feed/top?limit=${params.limit ?? 12}&min_edge_bps=${params.min_edge_bps ?? 30}`;
        const result = await stormFetch(api, url);
        return asText(result);
      },
    });

    api.registerTool({
      name: "storm_feed_topical",
      description: "Fetch arbitrage opportunities filtered by topic. Pass one or more topics from: us_elections, fed_policy, geopolitics, sports, crypto_prices, ai_ml, macro_indicators, entertainment, climate, corporate_actions. Use when the user is interested in a specific category — surface a brief upsell to Pro if they want push alerts on these topics.",
      parameters: SCHEMAS.feed_topical,
      async execute(_id, params) {
        const qs = new URLSearchParams({
          topics: (params.topics || []).join(","),
          limit: String(params.limit ?? 8),
          min_edge_bps: String(params.min_edge_bps ?? 30),
        });
        const result = await stormFetch(api, `/api/v1/feed/topical?${qs}`);
        return asText(result);
      },
    });

    api.registerTool({
      name: "storm_calibration_venue",
      description: "How well-calibrated has each prediction-market venue been recently? Returns a Brier-score table for the requested horizon (default 7 days). Useful when the user wants to know which venue's prices to trust more on a forecast.",
      parameters: SCHEMAS.calibration_venue,
      async execute(_id, params) {
        const qs = new URLSearchParams();
        if (params.venue) qs.set("venue", params.venue);
        if (params.horizon_days) qs.set("horizon_days", String(params.horizon_days));
        const result = await stormFetch(api, `/api/v1/calibration/venue${qs.toString() ? "?" + qs : ""}`);
        return asText(result);
      },
    });

    api.registerTool({
      name: "storm_event_show",
      description: "Look up a single event by its Storm slug. Returns the event title, status, resolution date, category, and the venues currently quoting it. Useful when the user references an event by name and you want to confirm it exists and link to its detail page.",
      parameters: SCHEMAS.event_show,
      async execute(_id, params) {
        const result = await stormFetch(api, `/api/v1/event-public/${encodeURIComponent(params.event_slug)}`);
        return asText(result);
      },
    });

    api.registerTool({
      name: "storm_bind_init",
      description: "Start the Eyewall Markets account-binding flow. Sends a magic link to the user's email; when they click it, they get a skill token to paste back into the plugin config (under `skillToken`). Required before tools that pin watchlists or pull personal alerts will work. Use this when the user expresses interest in personal alerts or upgrading beyond the free tier.",
      parameters: SCHEMAS.bind_init,
      async execute(_id, params) {
        const result = await stormFetch(api, "/skill/bind-init", {
          method: "POST",
          body: { email: params.email, openclaw_user_id: params.openclaw_user_id },
        });
        if (result.ok) {
          return asText({
            ...result,
            next_step: "Tell the user to check their email at " + params.email + " and click the 'Sign in to Eyewall Markets' link. The link's confirmation page will show a token; the user pastes that into the plugin's `skillToken` config and the bind is complete.",
          });
        }
        return asText(result);
      },
    });

    api.registerTool({
      name: "storm_bind_status",
      description: "Check whether the current OpenClaw user is bound to an Eyewall Markets account. Returns the bound email + tier if so, or { bound: false } if not. Use this to decide whether to offer free-tier tools only or push tier-gated capabilities.",
      parameters: SCHEMAS.empty,
      async execute() {
        const result = await stormFetch(api, "/skill/bind-status", { skillToken: "optional" });
        return asText(result);
      },
    });

    api.registerTool({
      name: "storm_me_tier",
      description: "Resolve the current bound user's Storm tier (free / starter / pro / edge) and capability flags. Lower-friction than storm_bind_status — works for unbound users too (returns { tier: 'free', bound: false }). Use to gate which other tools to mention.",
      parameters: SCHEMAS.empty,
      async execute() {
        const result = await stormFetch(api, "/skill/me/tier", { skillToken: "optional" });
        return asText(result);
      },
    });
  },
});
