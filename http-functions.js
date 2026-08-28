// backend/http-functions.js

import { ok, badRequest, serverError, forbidden } from 'wix-http-functions';
import { getSecret }                    from 'wix-secrets-backend';
import wixData                          from 'wix-data';
import { mediaManager }                 from 'wix-media-backend';

const ALLOWED_VARIABLES = [
  "customer_name", "order_number", "pickup_location", "pickup_address",
  "delivery_address", "tracking_number", "courier_name", "coupon_code",
  "discount_reward", "expiry_date", "review_link", "delivery_method", "delivery_eta"
];

// ─────────────────────────────────────────────────────────────────────────────
// NEW — PLS HQ bridge: mirrors events into Firestore so the PLS HQ Inbox can
// show them in real time. Purely additive — every existing code path below
// (IncomingMessages, WhatsAppLogs, OrderOpStatus, Contacts) is untouched.
// If this fails for any reason, it's swallowed — it must never break the
// existing, working WhatsApp flow.
// ─────────────────────────────────────────────────────────────────────────────

const FIREBASE_INGEST_URL = "https://us-central1-pls-hq.cloudfunctions.net/ingestWhatsAppEvent";

async function checkBridgeSecret(request) {
  const provided = (request.headers && (request.headers["x-bridge-secret"] || request.headers["X-Bridge-Secret"])) || "";
  const expected = await getSecret("BRIDGE_SECRET");
  return provided && expected && provided === expected;
}

async function relayToFirebase(payload) {
  if (!FIREBASE_INGEST_URL || FIREBASE_INGEST_URL.startsWith("PASTE_")) {
    console.warn("relayToFirebase skipped — FIREBASE_INGEST_URL is still the placeholder, not a real URL.");
    return;
  }
  try {
    const bridgeSecret = await getSecret("BRIDGE_SECRET");
    const res = await fetch(FIREBASE_INGEST_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Bridge-Secret": bridgeSecret },
      body: JSON.stringify(payload)
    });
    const text = await res.text();
    if (res.ok) {
      console.log("relayToFirebase succeeded:", text);
    } else {
      console.warn("relayToFirebase got a non-OK response:", res.status, text);
    }
  } catch (e) {
    console.warn("relayToFirebase failed (non-fatal, PLS HQ Inbox mirror only):", e.message);
  }
}

function cleanPhoneNumber(phone) {
  if (!phone) return null;
  let c = String(phone).replace(/\D/g, "");
  if (c.startsWith("0")) c = "27" + c.substring(1);
  return c.length < 10 ? null : c;
}

function cleanText(value, fallback = "there") {
  if (value === undefined || value === null || String(value).trim() === "") return fallback;
  return String(value).trim();
}

function getRecipients(toValue) {
  return String(toValue || "").split(",").map(p => cleanPhoneNumber(p.trim())).filter(Boolean);
}

function buildNamedBodyParams(data) {
  return ALLOWED_VARIABLES
    .filter(k => data[k] !== undefined && data[k] !== null && String(data[k]).trim() !== "")
    .map(k => ({ type: "text", parameter_name: k, text: cleanText(data[k]) }));
}

async function sendToMeta(payload) {
  const token   = await getSecret("META_WHATSAPP_TOKEN");
  const phoneId = await getSecret("META_PHONE_NUMBER_ID");
  const response = await fetch(`https://graph.facebook.com/v23.0/${phoneId}/messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  const result = await response.json();
  console.log("META RESPONSE:", result);
  return { response, result };
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /_functions/sendTemplate
// Sends a WhatsApp template message. Used by admin page buttons.
// CHANGED: now requires the X-Bridge-Secret header (this endpoint had no
// authentication at all before — anyone who found the URL could send WhatsApps
// as the business). PLS HQ's Cloud Function sends this header automatically.
// ─────────────────────────────────────────────────────────────────────────────

export async function use_sendTemplate(request) {
  try {
    if (request.method !== "POST") {
      return ok({ headers: { "Content-Type": "application/json" },
        body: { status: "Endpoint is live", message: "Use POST to send WhatsApp templates" } });
    }

    if (!(await checkBridgeSecret(request))) {
      return forbidden({ headers: { "Content-Type": "application/json" },
        body: { success: false, error: "Unauthorized" } });
    }

    const body       = await request.body.json();
    const data       = body.data || body;
    const template   = cleanText(data.template, null);
    const recipients = getRecipients(data.to);
    const language   = cleanText(data.language, "en");

    if (!template) return badRequest({ headers: { "Content-Type": "application/json" },
      body: { success: false, error: "Missing template name." } });

    if (!recipients.length) return badRequest({ headers: { "Content-Type": "application/json" },
      body: { success: false, error: "Missing recipient phone number." } });

    const bodyParams = buildNamedBodyParams(data);
    const results    = [];

    for (const recipient of recipients) {
      const metaPayload = {
        messaging_product: "whatsapp", to: recipient, type: "template",
        template: { name: template, language: { code: language } }
      };
      if (bodyParams.length > 0) {
        metaPayload.template.components = [{ type: "body", parameters: bodyParams }];
      }
      const { response, result } = await sendToMeta(metaPayload);
      results.push({ recipient, success: response.ok, metaResponse: result });
    }

    return ok({ headers: { "Content-Type": "application/json" },
      body: { success: results.every(r => r.success), results } });

  } catch (err) {
    console.error("sendTemplate error:", err);
    return serverError({ headers: { "Content-Type": "application/json" },
      body: { success: false, error: err.message } });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /_functions/whatsappWebhook
// Meta webhook verification — called once when you set up the webhook in Meta.
// UNCHANGED.
// ─────────────────────────────────────────────────────────────────────────────

export async function get_whatsappWebhook(request) {
  try {
    const VERIFY_TOKEN = "packlife2026";
    const mode      = request.query["hub.mode"];
    const token     = request.query["hub.verify_token"];
    const challenge = request.query["hub.challenge"];

    if (mode === "subscribe" && token === VERIFY_TOKEN) {
      console.log("WhatsApp webhook verified successfully");
      return ok({
        headers: { "Content-Type": "text/plain" },
        body: challenge
      });
    }

    return badRequest({
      headers: { "Content-Type": "application/json" },
      body: { success: false, error: "Verification failed" }
    });

  } catch (err) {
    console.error("webhook verification error:", err);
    return serverError({ headers: { "Content-Type": "application/json" },
      body: { success: false, error: err.message } });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// NEW — media handling. WhatsApp only gives you a media ID + a short-lived
// authenticated download URL, not something a browser can display directly.
// For images: fetch the bytes with the access token, upload them into Wix's
// own Media Manager, and store the resulting permanent static.wixstatic.com
// URL. Video/audio/documents need Wix's separate async "transcoding" step
// before they're viewable, which is real added complexity — deferred for
// now in favour of a clear, honest label instead of a silent failure.
// ─────────────────────────────────────────────────────────────────────────────

function wixFileUrlToStaticUrl(fileUrl) {
  // fileUrl looks like: wix:image://v1/<uri>/<filename>#originWidth=...&originHeight=...
  const match = String(fileUrl || "").match(/wix:image:\/\/v1\/([^/]+)\//);
  return match ? `https://static.wixstatic.com/media/${match[1]}` : null;
}

// Downloads media from Meta (using the token) and uploads it into Wix's Media
// Manager. Returns { fileUrl, publicUrl } where:
//  - fileUrl is Wix's permanent internal reference (wix:image://, wix:video://
//    etc.) — never expires, safe to store forever.
//  - publicUrl is a ready-to-use link RIGHT NOW, only for image/video —
//    for audio/document it's null, because Wix only gives out temporary
//    (10-hour) links for those, so we resolve a fresh one on demand instead
//    of storing something that would quietly go dead.
async function downloadAndStoreMedia(mediaId, token, category) {
  try {
    const lookupRes = await fetch(`https://graph.facebook.com/v23.0/${mediaId}`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    const lookup = await lookupRes.json();
    if (!lookupRes.ok || !lookup.url) { console.warn("Media lookup failed:", JSON.stringify(lookup)); return null; }

    const fileRes = await fetch(lookup.url, { headers: { Authorization: `Bearer ${token}` } });
    if (!fileRes.ok) { console.warn("Media download failed:", fileRes.status); return null; }
    const arrayBuffer = await fileRes.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    const ext = (lookup.mime_type || "").split("/")[1] || "bin";
    const uploaded = await mediaManager.upload(
      "/whatsapp-media",
      buffer,
      `wa_${mediaId}.${ext}`,
      { mediaOptions: { mimeType: lookup.mime_type || "application/octet-stream", mediaType: category },
        metadataOptions: { isPrivate: false, isVisitorUpload: false } }
    );

    if (category === "image") {
      return { fileUrl: uploaded.fileUrl, publicUrl: wixFileUrlToStaticUrl(uploaded.fileUrl) };
    }
    if (category === "video") {
      try {
        const playbackUrl = await mediaManager.getVideoPlaybackUrl(uploaded.fileUrl);
        return { fileUrl: uploaded.fileUrl, publicUrl: playbackUrl || null };
      } catch (e) {
        console.warn("getVideoPlaybackUrl failed, video saved but not yet playable:", e.message);
        return { fileUrl: uploaded.fileUrl, publicUrl: null };
      }
    }
    // audio / document: no stable public URL available — resolved on demand
    return { fileUrl: uploaded.fileUrl, publicUrl: null };
  } catch (e) {
    console.warn("downloadAndStoreMedia failed (non-fatal, message still saves as text):", e.message);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /_functions/getMediaLink
// NEW — resolves a FRESH, working link for audio/document attachments,
// called on demand right when an agent opens one in the Inbox (rather than
// storing a link upfront that would expire after ~10 hours).
// ─────────────────────────────────────────────────────────────────────────────

export async function post_getMediaLink(request) {
  try {
    if (!(await checkBridgeSecret(request))) {
      return forbidden({ headers: { "Content-Type": "application/json" },
        body: { success: false, error: "Unauthorized" } });
    }
    const body = await request.body.json();
    const fileUrl = body.fileUrl;
    if (!fileUrl) return badRequest({ headers: { "Content-Type": "application/json" },
      body: { success: false, error: "Missing fileUrl" } });

    const url = await mediaManager.getFileUrl(fileUrl);
    return ok({ headers: { "Content-Type": "application/json" }, body: { success: true, url } });
  } catch (err) {
    console.error("getMediaLink error:", err);
    return serverError({ headers: { "Content-Type": "application/json" },
      body: { success: false, error: err.message } });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /_functions/whatsappWebhook
// Receives incoming WhatsApp messages AND status updates from Meta.
// Saves messages to IncomingMessages CMS collection — EXACTLY as before.
// CHANGED: now also (a) reads value.statuses, which used to be silently
// discarded, (b) mirrors both messages and statuses into Firestore for
// the PLS HQ Inbox, and (c) downloads + stores images so they're viewable
// instead of showing as "[media/unsupported]". All three additions are
// wrapped so a failure in any of them can never affect the existing
// IncomingMessages write.
// ─────────────────────────────────────────────────────────────────────────────

export async function post_whatsappWebhook(request) {
  try {
    const body = await request.body.json();
    console.log("WhatsApp webhook received:", JSON.stringify(body));

    const entry    = body.entry?.[0];
    const changes  = entry?.changes?.[0];
    const value    = changes?.value;
    const messages = value?.messages;
    const statuses = value?.statuses;

    // ── Status updates (delivered / read / failed) — previously ignored ──
    if (statuses && statuses.length) {
      for (const s of statuses) {
        await relayToFirebase({
          type: "status",
          recipientPhone: s.recipient_id || "",
          messageId: s.id || "",
          status: s.status || "unknown"
        });
      }
    }

    if (!messages || !messages.length) {
      // Status-only payload (or something else) — acknowledge and stop, same as before
      return ok({ headers: { "Content-Type": "application/json" }, body: { success: true } });
    }

    for (const msg of messages) {
      const from      = msg.from || "";
      const timestamp = new Date(parseInt(msg.timestamp || Date.now() / 1000) * 1000);
      const msgId     = msg.id || "";

      // Work out the message text/label and, where possible, a real viewable link.
      let text = msg.text?.body || msg.button?.text || msg.interactive?.button_reply?.title || null;
      let mediaUrl = null;
      let mediaFileRef = null;
      let mediaType = null;
      if (!text) {
        const token = await getSecret("META_WHATSAPP_TOKEN");
        if (msg.image) {
          mediaType = "image";
          const stored = await downloadAndStoreMedia(msg.image.id, token, "image");
          mediaUrl = stored?.publicUrl || null;
          text = msg.image.caption ? `📷 ${msg.image.caption}` : (mediaUrl ? "📷 Photo" : "📷 Photo (couldn't load — open WhatsApp to view)");
        } else if (msg.video) {
          mediaType = "video";
          const stored = await downloadAndStoreMedia(msg.video.id, token, "video");
          mediaUrl = stored?.publicUrl || null;
          text = msg.video.caption ? `🎥 ${msg.video.caption}` : (mediaUrl ? "🎥 Video" : "🎥 Sent a video (open WhatsApp to view)");
        } else if (msg.audio || msg.voice) {
          mediaType = "audio";
          const stored = await downloadAndStoreMedia((msg.audio || msg.voice).id, token, "audio");
          mediaFileRef = stored?.fileUrl || null;
          text = mediaFileRef ? "🎤 Voice note" : "🎤 Sent a voice note (open WhatsApp to view)";
        } else if (msg.document) {
          mediaType = "document";
          const stored = await downloadAndStoreMedia(msg.document.id, token, "document");
          mediaFileRef = stored?.fileUrl || null;
          text = `📄 ${msg.document.filename || "Document"}` + (mediaFileRef ? "" : " (couldn't load — open WhatsApp to view)");
        } else if (msg.sticker) {
          mediaType = "sticker"; text = "😀 Sent a sticker";
        } else if (msg.location) {
          mediaType = "location"; text = "📍 Shared a location";
        } else {
          text = "[unsupported message type]";
        }
      }

      // Look up customer name from Contacts — UNCHANGED
      let customerName = from;
      try {
        const contactResult = await wixData
          .query("Contacts")
          .eq("phone", from)
          .find({ suppressAuth: true });
        if (contactResult.items[0]?.customerName) {
          customerName = contactResult.items[0].customerName;
        }
      } catch (e) { console.warn("Could not look up contact for", from); }

      // Check for duplicate (Meta sometimes sends the same message twice) — UNCHANGED
      if (msgId) {
        const existing = await wixData
          .query("IncomingMessages")
          .eq("messageId", msgId)
          .find({ suppressAuth: true });
        if (existing.items.length > 0) {
          console.log("Duplicate message ignored:", msgId);
          continue;
        }
      }

      await wixData.insert("IncomingMessages", {
        from,
        customerName,
        message:   text,
        messageId: msgId,
        timestamp,
        read:      false,
        replied:   false
      }, { suppressAuth: true });

      console.log("Saved incoming message from", from, ":", text);

      // Mirror to Firestore for the PLS HQ Inbox — NEW, non-fatal if it fails
      await relayToFirebase({
        type: "message",
        from,
        customerName,
        text,
        messageId: msgId,
        timestamp: timestamp.toISOString(),
        mediaUrl,
        mediaFileRef,
        mediaType
      });
    }

    return ok({ headers: { "Content-Type": "application/json" }, body: { success: true } });

  } catch (err) {
    console.error("whatsappWebhook error:", err);
    // Always return 200 to Meta even on error — otherwise Meta retries endlessly
    return ok({ headers: { "Content-Type": "application/json" },
      body: { success: false, error: err.message } });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /_functions/sendReply
// Sends a free-text reply to a customer from the admin inbox.
// Only works within 24 hours of the customer's last message.
// CHANGED: now requires the X-Bridge-Secret header (see note on sendTemplate
// above — same previously-open-endpoint issue, same fix).
// ─────────────────────────────────────────────────────────────────────────────

export async function post_sendReply(request) {
  try {
    if (!(await checkBridgeSecret(request))) {
      return forbidden({ headers: { "Content-Type": "application/json" },
        body: { success: false, error: "Unauthorized" } });
    }

    const body    = await request.body.json();
    const to      = cleanPhoneNumber(body.to);
    const message = String(body.message || "").trim();

    if (!to)      return badRequest({ headers: { "Content-Type": "application/json" },
      body: { success: false, error: "Missing recipient phone" } });
    if (!message) return badRequest({ headers: { "Content-Type": "application/json" },
      body: { success: false, error: "Missing message text" } });

    const token   = await getSecret("META_WHATSAPP_TOKEN");
    const phoneId = await getSecret("META_PHONE_NUMBER_ID");

    const res = await fetch(`https://graph.facebook.com/v23.0/${phoneId}/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to,
        type: "text",
        text: { body: message }
      })
    });

    const result = await res.json();
    console.log("sendReply META RESPONSE:", result);

    if (!res.ok) {
      return ok({ headers: { "Content-Type": "application/json" },
        body: { success: false, error: result } });
    }

    // Log the sent reply in WhatsAppLogs — UNCHANGED
    await wixData.insert("WhatsAppLogs", {
      template:     "manual_reply",
      phone:        to,
      customerName: body.customerName || to,
      source:       "Admin Inbox — Manual Reply",
      status:       "Sent",
      metaResponse: JSON.stringify(result),
      sentAt:       new Date()
    }, { suppressAuth: true });

    return ok({ headers: { "Content-Type": "application/json" },
      body: { success: true, result } });

  } catch (err) {
    console.error("sendReply error:", err);
    return serverError({ headers: { "Content-Type": "application/json" },
      body: { success: false, error: err.message } });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /_functions/getContacts
// NEW — returns Contacts for the PLS HQ Customers tab. Read-only, no writes.
// Protected by the same bridge secret as the other new endpoints.
// ─────────────────────────────────────────────────────────────────────────────

export async function post_getContacts(request) {
  try {
    if (!(await checkBridgeSecret(request))) {
      return forbidden({ headers: { "Content-Type": "application/json" },
        body: { success: false, error: "Unauthorized" } });
    }
    const body = await request.body.json().catch(() => ({}));
    const limit = Math.min(Math.max(parseInt(body.limit) || 200, 1), 1000);
    const search = (body.search || "").trim();

    let query = wixData.query("Contacts").descending("lastOrderDate").limit(limit);
    if (search) {
      // Wix Data doesn't support OR across fields in one query easily — search phone first, fall back to name
      const byPhone = await wixData.query("Contacts").contains("phone", search).limit(limit).find({ suppressAuth: true });
      const byName  = await wixData.query("Contacts").contains("customerName", search).limit(limit).find({ suppressAuth: true });
      const merged = [...byPhone.items, ...byName.items.filter(n => !byPhone.items.some(p => p._id === n._id))];
      return ok({ headers: { "Content-Type": "application/json" }, body: { success: true, contacts: merged } });
    }

    const result = await query.find({ suppressAuth: true });
    return ok({ headers: { "Content-Type": "application/json" }, body: { success: true, contacts: result.items } });
  } catch (err) {
    console.error("getContacts error:", err);
    return serverError({ headers: { "Content-Type": "application/json" },
      body: { success: false, error: err.message } });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /_functions/getTemplates
// NEW — lists WhatsApp message templates directly from Meta for the PLS HQ
// Templates tab. Read-only. Requires META_WABA_ID to be added as a new Wix
// Secret (not sensitive — it's an account identifier, not a credential — but
// kept as a secret for consistency with the other two).
// ─────────────────────────────────────────────────────────────────────────────

export async function post_getTemplates(request) {
  try {
    if (!(await checkBridgeSecret(request))) {
      return forbidden({ headers: { "Content-Type": "application/json" },
        body: { success: false, error: "Unauthorized" } });
    }
    const token  = await getSecret("META_WHATSAPP_TOKEN");
    const wabaId = await getSecret("META_WABA_ID");

    const res = await fetch(`https://graph.facebook.com/v23.0/${wabaId}/message_templates?limit=200`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    const result = await res.json();
    if (!res.ok) {
      return ok({ headers: { "Content-Type": "application/json" }, body: { success: false, error: result } });
    }
    return ok({ headers: { "Content-Type": "application/json" }, body: { success: true, templates: result.data || [] } });
  } catch (err) {
    console.error("getTemplates error:", err);
    return serverError({ headers: { "Content-Type": "application/json" },
      body: { success: false, error: err.message } });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /_functions/editTemplate
// NEW — edits an existing template's body/components via Meta's API.
// IMPORTANT: Meta requires most content edits to an already-APPROVED template
// to go through review again (the template is unusable while pending). This
// endpoint just relays whatever Meta says — including rejections — rather
// than pretending edits are always instant.
// ─────────────────────────────────────────────────────────────────────────────

export async function post_editTemplate(request) {
  try {
    if (!(await checkBridgeSecret(request))) {
      return forbidden({ headers: { "Content-Type": "application/json" },
        body: { success: false, error: "Unauthorized" } });
    }
    const body = await request.body.json();
    const templateId = body.templateId;
    const components = body.components;
    if (!templateId) return badRequest({ headers: { "Content-Type": "application/json" },
      body: { success: false, error: "Missing templateId" } });
    if (!components) return badRequest({ headers: { "Content-Type": "application/json" },
      body: { success: false, error: "Missing components" } });

    const token = await getSecret("META_WHATSAPP_TOKEN");
    const res = await fetch(`https://graph.facebook.com/v23.0/${templateId}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ components })
    });
    const result = await res.json();
    return ok({ headers: { "Content-Type": "application/json" }, body: { success: res.ok, result } });
  } catch (err) {
    console.error("editTemplate error:", err);
    return serverError({ headers: { "Content-Type": "application/json" },
      body: { success: false, error: err.message } });
  }
}
