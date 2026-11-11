// routes/sendgridWebhook.js
/**
 * POST /api/webhooks/sendgrid — receives SendGrid's Signed Event Webhook.
 *
 * SendGrid says "202 Accepted" when it QUEUES an e-mail. Whether Gmail actually took it (delivered), pushed
 * back (deferred) or refused it (bounce / dropped / blocked) only shows up here. Events are turned into log
 * lines by emailService.recordSendGridEvents(); nothing is stored.
 *
 * Security: every request must carry a valid ECDSA signature (headers X-Twilio-Email-Event-Webhook-Signature
 * and -Timestamp) made with the private key that matches SENDGRID_WEBHOOK_PUBLIC_KEY[2..5]. No key configured
 * → the route answers 404 (feature off). A bad signature → 401 and a warning in the log.
 *
 * Mounted in server.js BEFORE express.json()/session, because the signature covers the raw request bytes.
 *
 * SendGrid setup (once per SendGrid account): Settings → Mail Settings → Event Webhook →
 *   HTTP POST URL  https://<your-app>/api/webhooks/sendgrid
 *   Events         Processed, Deferred, Delivered, Bounced, Dropped (and Spam Reports if you like)
 *   Signature      turn on "Signature Verification", copy the Verification Key into Railway
 *                  (SENDGRID_WEBHOOK_PUBLIC_KEY for account 1, SENDGRID_WEBHOOK_PUBLIC_KEY2 for account 2, …)
 *   Then press "Test Your Integration" — you should see no error and (with the key set) a 200.
 */
'use strict';

const express = require('express');
const crypto  = require('crypto');
const log     = require('../utils/logger');
const { recordSendGridEvents, getWebhookKeys } = require('../utils/emailService');

const router = express.Router();

const parseJson = express.json({
  limit: '5mb',
  verify: (req, _res, buf) => { req.rawBody = buf; }, // keep the exact bytes the signature was made over
});

router.post('/', parseJson, (req, res) => {
  const keys = getWebhookKeys();
  if (!keys.length) return res.status(404).json({ error: 'Not found' });

  const signature = req.get('x-twilio-email-event-webhook-signature');
  const timestamp = req.get('x-twilio-email-event-webhook-timestamp');
  const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.ip;

  if (!signature || !timestamp || !req.rawBody) {
    log.warn(`[MAIL-EVT] webhook rejected: missing signature headers or body | ip=${ip}`);
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const signed = Buffer.concat([Buffer.from(timestamp), req.rawBody]);
  const sig    = Buffer.from(signature, 'base64');
  const valid  = keys.some(({ key }) => {
    try { return crypto.verify('sha256', signed, key, sig); } catch { return false; }
  });
  if (!valid) {
    log.warn(`[MAIL-EVT] webhook rejected: bad signature (wrong SENDGRID_WEBHOOK_PUBLIC_KEY, or not from SendGrid) | ip=${ip}`);
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const handled = recordSendGridEvents(req.body);
  return res.status(200).json({ ok: true, events: handled });
});

// Malformed JSON etc. — answer 400 instead of falling through to the app-wide error page.
router.use((err, _req, res, _next) => {
  log.warn(`[MAIL-EVT] webhook body rejected: ${err.message}`);
  res.status(400).json({ error: 'Bad request' });
});

module.exports = router;
