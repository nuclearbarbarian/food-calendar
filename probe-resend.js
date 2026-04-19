'use strict';

// One-time probe: sends a test email via Resend to confirm the key works and
// the sender domain is verified. Run once during Phase 0 setup, then ignored.

require('dotenv').config();
const { Resend } = require('resend');

async function main() {
  const { RESEND_API_KEY, DIGEST_FROM, DIGEST_TO } = process.env;
  if (!RESEND_API_KEY || !DIGEST_FROM || !DIGEST_TO) {
    console.error('Missing RESEND_API_KEY, DIGEST_FROM, or DIGEST_TO in .env.');
    process.exit(1);
  }

  const resend = new Resend(RESEND_API_KEY);
  const { data, error } = await resend.emails.send({
    from: DIGEST_FROM,
    to: DIGEST_TO,
    subject: 'Food — Phase 0 probe',
    html: '<p style="font-family: Georgia, serif;">If you received this, the Food app\'s Resend key and sender domain are working. Nothing else to do.</p>',
  });

  if (error) {
    console.error('Resend error:', error);
    process.exit(1);
  }
  console.log('Sent probe email. ID:', data.id);
}

main();
