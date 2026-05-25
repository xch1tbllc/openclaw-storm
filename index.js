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
    required: ["email", "bind_external_user_id"],
    properties: {
      email: { type: "string", description: "User's email address." },
      bind_external_user_id: { type: "string", description: "Stable identifier for the OpenClaw user — typically the agent runtime's user id. Sent to Storm as the bind_external_user_id field." },
    },
  },
  watchlist_pin: {
    type: "object",
    additionalProperties: false,
    required: ["event_slug"],
    properties: {
      event_slug: { type: "string", description: "Storm event slug to pin." },
      notes: { type: "string", description: "Optional free-text note attached to the pin (max ~280 chars)." },
    },
  },
  watchlist_unpin: {
    type: "object",
    additionalProperties: false,
    required: ["event_slug"],
    properties: {
      event_slug: { type: "string", description: "Storm event slug to unpin." },
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
          body: { email: params.email, bind_external_user_id: params.bind_external_user_id },
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

    // ——— Pro / Edge tools ————————————————————————————————————————————

    api.registerTool({
      name: "storm_watchlist_pin",
      description: "Pin an event to the user's Storm watchlist. Watchlisted events trigger price-move and news-event push alerts (Pro+) into the plugin inbox once their alert_rule.channel is set to 'skill_inbox'. Requires a bound Pro or Edge account; will return 403 with an upsell payload otherwise.",
      parameters: SCHEMAS.watchlist_pin,
      async execute(_id, params) {
        const result = await stormFetch(api, "/skill/watchlist/pin", {
          method: "POST",
          body: { event_slug: params.event_slug, notes: params.notes ?? null },
          skillToken: "required",
        });
        return asText(result);
      },
    });

    api.registerTool({
      name: "storm_watchlist_unpin",
      description: "Remove an event from the user's Storm watchlist. Idempotent — unpinning a non-pinned event is a quiet no-op. Requires a bound Pro or Edge account.",
      parameters: SCHEMAS.watchlist_unpin,
      async execute(_id, params) {
        const result = await stormFetch(api, "/skill/watchlist/unpin", {
          method: "POST",
          body: { event_slug: params.event_slug },
          skillToken: "required",
        });
        return asText(result);
      },
    });

    api.registerTool({
      name: "storm_inbox_pull",
      description: "Pull pending push-alert payloads queued for this user. Returns up to 50 items (oldest first); items are stamped delivered_at on read so subsequent calls only return new alerts. Use this on every user turn for Pro+Edge users to surface fresh signal. Free/starter users get tier_required.",
      parameters: SCHEMAS.empty,
      async execute() {
        const result = await stormFetch(api, "/skill/inbox", { skillToken: "required" });
        return asText(result);
      },
    });

    api.registerTool({
      name: "storm_install_mcp",
      description: "Edge-only. Generate the openclaw command to register the @eyewallmarkets/storm-mcp server in this gateway. The MCP server gives the agent 7 deeper read-only tools (storm_list_events, storm_get_event, storm_list_spreads, storm_get_market, storm_list_venues, storm_get_alerts_inbox, storm_ack_alerts) for power-user / programmatic-feed use cases. The tool fetches the user's api_key from /skill/api-key and returns the fully-populated `openclaw mcp set storm '<json>'` command — agent should execute it, then restart the gateway. Returns tier_required for non-Edge users.",
      parameters: SCHEMAS.empty,
      async execute() {
        // Fetch the api_key in one call. /skill/api-key is Edge-gated
        // server-side, so a non-Edge user gets the structured 403 here
        // and we surface that directly without doing a separate tier
        // probe.
        const keyResp = await stormFetch(api, "/skill/api-key", { skillToken: "required" });
        if (!keyResp?.ok) return asText(keyResp);
        const config = api.pluginConfig || api.config || {};
        const baseUrl = (config.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, "");
        const mcpJson = {
          command: "npx",
          args: ["-y", "@eyewallmarkets/storm-mcp"],
          env: {
            STORM_API_KEY: keyResp.api_key,
            STORM_BASE_URL: baseUrl,
          },
        };
        const cmd = `openclaw mcp set storm '${JSON.stringify(mcpJson)}'`;
        return asText({
          ok: true,
          message: "Run this command to register the storm-mcp server:",
          command: cmd,
          followup: "After running the command, restart the gateway with: `openclaw gateway restart` (or `docker compose restart openclaw-gateway` if running in a container). Then call any of the 7 storm-mcp tools (storm_list_events, storm_get_event, etc.) directly.",
          mcp_config: mcpJson,
        });
      },
    });
  },
});
