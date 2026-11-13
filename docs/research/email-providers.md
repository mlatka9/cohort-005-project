# Transactional Email Providers Comparison for Cadence

Part of issue #9 (Notifications map). Resolves issue #11 (`wayfinder:research`).

This document provides a factual comparison of five transactional email providers—**Postmark** (incumbent), **Resend**, **SendGrid** (Twilio), **Amazon SES**, and **Mailgun**—investigated against primary sources (official documentation, API references, and official pricing pages as of November 2026). Per ticket requirements, no recommendation is made; this provides the factual baseline for decision ticket #12 ("Choose the email provider").

---

## 1. Comparison Matrix

### Criterion 1: Pricing and Free Tier

| Dimension | Postmark (Incumbent) | Resend | SendGrid (Twilio) | Amazon SES | Mailgun |
|---|---|---|---|---|---|
| **Free Tier** | 100 emails/month, never expires, no overages allowed | 3,000 emails/month, capped at 100 emails/day | 60-day free trial: 100 emails/day (no permanent free tier) | AWS Free Tier credits: up to $200 (free plan lasts 6 months). No permanent standalone free email volume | 100 emails/day (free plan) |
| **Credit Card Required for Free** | No ("No credit card required" on message-streams page) | Not stated on pricing page | No credit card required for 60-day trial | Yes (valid payment method required for AWS account creation) | Not stated for free plan; dedicated IPs require card on file |
| **Entry Paid Plan** | Basic: $15/month for 10,000 emails | Pro: $20/month for 50,000 emails | Essentials: $19.95/month for 50,000 emails | Essentials: pay-as-you-go from $0.16 / 1,000 emails ($0 monthly minimum) | Basic: $15/month for 10,000 emails |
| **Cost at ~10k emails/month** | $15 (Basic), $16.50 (Pro) | $20 (smallest paid plan covers up to 50k) | $19.95 (Essentials 50k plan) | $1.60 (derived at $0.16/1k rate) | $15 (Basic 10k) |
| **Cost at 50k emails/month** | $55 (Basic), $60.50 (Pro), $66 (Platform) | $20 (Pro 50k) | $19.95 (Essentials 50k) | $8.00 (derived at $0.16/1k rate) | $35 (Foundation 50k, includes 1-month trial) |
| **Cost at 100k emails/month** | Not published for exact 100k; jumps from 50k ($55) to 125k ($115) on Basic | $35 (Pro 100k) or $90 (Scale 100k) | $34.95 (Essentials 100k) or $89.95 (Pro 100k) | $16.00 (derived at $0.16/1k rate) | $90 (Scale 100k, includes 1-month trial) |
| **Overage Pricing** | Per 1,000: Basic $1.70–$1.80, Pro $1.20–$1.30, Platform $1.15–$1.20. Free tier: overage not allowed | $0.90 / 1,000 on Pro; Scale tiers range $0.46–$0.90 / 1,000 | Overage charges apply per tier (documented in customer FAQ) | Pure pay-as-you-go ($0.16/1k); +$0.12/GB attachment data | Per 1,000: Basic $1.80, Foundation $1.30, Scale $1.10 |
| **Dedicated IP Cost** | $50/IP/month (Pro or Platform only, minimum 300k volume) | $30/IP/month add-on (Scale plan only, minimum 3k emails/day) | 1 included with Pro plan; additional IPs purchasable | Standard: $24.95/IP/month. Managed (automated warmup): $15/mo + $0.08/1k | 1 included at 100k+ volume (Scale/Foundation 100k); extra $59/IP/month |

---

### Criteria 2 & 3: Deliverability and API Fit (Node `fetch()`)

| Dimension | Postmark (Incumbent) | Resend | SendGrid | Amazon SES | Mailgun |
|---|---|---|---|---|---|
| **Default IP Pool** | Shared "pristine" IP pool; dedicated IPs are never pre-warmed | Shared pool by default; managed dedicated pools with auto-warmup | Trial/Essentials: shared IP groups; dedicated on Pro | Shared by default; dedicated options are Standard (manual) or Managed (auto-warmup) | Shared IP by default; dedicated IPs on request or plan tier |
| **Sender Vetting** | Manual account review (<24h on weekdays); restricted to sending to verified domain until approved | Domain verification required; `resend.dev` only delivers to account owner's email | Sender Authentication required (single verified sender or domain authentication) | Starts in AWS Sandbox; production access requires manual quota request | Account review on signup; IPs tested before allocation |
| **Transactional vs Marketing Isolation** | Strict Message Streams: separate IP pools per stream; transactional traffic never mixes with broadcasts | Subdomain isolation recommended; Broadcasts/Marketing is a separate product | Recommends separate dedicated IPs/pools and subusers for marketing vs transactional | Configuration sets, tenants, and distinct IP pools | Separate IP pools, subaccounts, and per-domain isolation |
| **Raw `fetch()` Authentication** | Header: `X-Postmark-Server-Token: <token>` | Header: `Authorization: Bearer <key>` (Note: `User-Agent` header is mandatory; 403 without it) | Header: `Authorization: Bearer <key>` | AWS SigV4 request signing (complex without AWS SDK or signing utility) | HTTP Basic Auth: username `api`, password `<api-key>` |
| **HTTP Endpoint** | `POST https://api.postmarkapp.com/email` | `POST https://api.resend.com/emails` | `POST https://api.sendgrid.com/v3/mail/send` (EU: `api.eu.sendgrid.com`) | `POST https://email.<region>.amazonaws.com/v2/email/outbound-emails` | `POST https://api.mailgun.net/v3/{domain}/messages` (EU: `api.eu.mailgun.net`) |
| **Payload Format** | Flat JSON: `From`, `To`, `Subject`, `TextBody`/`HtmlBody` (PascalCase) | Flat JSON: `from`, `to`, `subject`, `text`/`html` (camelCase) | Nested JSON: `personalizations[]`, `from`, `content[]` | Nested JSON: `Destination.ToAddresses[]`, `Content.Simple.Subject`, `Content.Simple.Body` | `multipart/form-data` required per OpenAPI spec (FormData: `from`, `to`, `subject`, `text`/`html`) |
| **Rate Limits** | Non-numeric in docs; returns HTTP 429 when limited | 10 req/s per team by default; provides IETF standard rate limit headers | Per-endpoint rate limits with `X-RateLimit-*` headers; returns 429 | Sandbox: 1 msg/s, 200/day; Production: per-region sending quotas | Account-level rate limits; 429 on throttle |
| **Payload & Batch Limits** | Max 50 recipients per message, 10 MB total size, batch endpoint up to 500 | Max 50 `to` recipients, 40 MB total size, batch endpoint up to 100 | Max 1,000 recipients, 30 MB total size | Max 50 destinations per request, 10 MB per email (or 40 MB with raw) | Max 1,000 recipients (batch sending), 25 MB total size |

---

### Criteria 4 & 5: Templates and Webhooks

| Dimension | Postmark (Incumbent) | Resend | SendGrid | Amazon SES | Mailgun |
|---|---|---|---|---|---|
| **Template Engine** | Mustachio (Mustache superset with template inheritance) | Triple-brace `{{{VAR}}}` variables in dashboard; React Email supported via Node SDK | Handlebars syntax (`{{var}}`, conditionals, loops) in Dynamic Templates | Handlebars syntax stored in SES or inline in API calls | Customized Handlebars (`{{if}}`, `{{unless}}`, `{{each}}`, `{{with}}`, `{{equal}}`) |
| **Send by Template API** | `POST /email/withTemplate` with `TemplateId` / `TemplateAlias` and `TemplateModel` | `POST /emails` with `template: { id, variables }` (mutually exclusive with `html`/`text`) | `POST /v3/mail/send` with `template_id` (`d-...`) and `dynamic_template_data` | `POST /v2/email/outbound-emails` with `Content.Template: { TemplateName, TemplateData }` | `POST /v3/{domain}/messages` with `template` and `t:variables` (JSON string) |
| **Template Versioning** | No native template version history found in documentation | Draft vs Published versions with visual history log | Multiple versions per template (`d-...`), one active version | Not natively versioned (API updates overwrite template) | Versioning supported per template (`t:version`), up to 40 versions |
| **Dashboard vs Code Editing** | Both: Web editor and Templates API (max 100 templates per server) | Both: Web dashboard, React Email components, API, CLI | Both: Visual Design Editor, Code Editor, and API | API / CLI driven primarily; AWS Console has limited template authoring | Both: Web Template Builder and REST API (100 templates per domain/account) |
| **Webhook Event Types** | Delivery, Bounce, SpamComplaint, Open, Click, SubscriptionChange, Inbound | Sent, Delivered, DeliveryDelayed, Bounced, Complained, Failed, Opened, Clicked, Suppressed | Processed, Delivered, Deferred, Bounce, Dropped, Open, Click, SpamReport, Unsubscribe, GroupUnsubscribe | Send, Delivery, Bounce, Complaint, Reject, Open, Click, RenderingFailure, DeliveryDelay, Subscription | Accepted, Delivered, TemporaryFail, PermanentFail, Opened, Clicked, Unsubscribed, Complained |
| **Webhook Delivery & Verification** | HTTP POST. **No HMAC signature verification supported.** Uses Basic Auth in webhook URL and IP allowlisting | HTTP POST powered by Svix. Verified via Svix headers: `svix-id`, `svix-timestamp`, `svix-signature` | HTTP POST (batched array). Verified via ECDSA public key (`X-Twilio-Email-Event-Webhook-Signature`) or OAuth 2.0 | AWS SNS / EventBridge / Kinesis. HTTPS endpoint receives signed SNS JSON; verified via signing cert | HTTP POST. Verified via HMAC-SHA256 signature over `timestamp + token` using account Webhook Signing Key |

---

### Criteria 6 & 7: Unsubscribe Handling and Dev/Test Story

| Dimension | Postmark (Incumbent) | Resend | SendGrid | Amazon SES | Mailgun |
|---|---|---|---|---|---|
| **`List-Unsubscribe` Header** | Automatic on Broadcast streams; Transactional streams default to "none", custom headers allowed | Manual for transactional mail (`headers: { 'List-Unsubscribe': '...' }`); automatic on marketing/audiences | Automatic when Subscription Tracking is enabled in settings or API | Automatic when using SES `ListManagementOptions` with Contact List & Topic | Supported via custom headers (`h:List-Unsubscribe`) or automated unsubscribe links |
| **Suppression Management** | Stream-level suppression lists (reasons: `HardBounce`, `SpamComplaint`, `ManualSuppression`). API to query, add, delete | Team-wide suppression list (reasons: bounce, complaint, manual). Full Dashboard and REST API | Global suppression list + Unsubscribe Groups. `bypass_list_management` flag per message | Account-level and tenant-level suppression lists. Configurable bounce/complaint handling | Domain-level suppression lists for unsubscribes, bounces, and complaints. Auto-drops suppressed recipients |
| **Granular / Topic Preferences** | Per Message Stream (transactional vs broadcast) | Topics (opt-in / opt-out) supported via Audience and `topic_id` | Advanced: Unsubscribe Groups (`asm.group_id`, `groups_to_display`) | Contact lists and topics configured in SES | Tags and mailing lists with `%tag_unsubscribe_url%`, `%unsubscribe_url%` |
| **Sandbox / Test Story** | 1. Sandbox Server mode (black holes emails, logs API traffic, counts toward quota)<br>2. API Test token `POSTMARK_API_TEST`<br>3. Fake bounce domains (`@bounce-testing.postmarkapp.com`) | 1. `resend.dev` test addresses: `delivered@`, `bounced@`, `complained@`, `suppressed@`<br>2. In sandbox, sends only to own account address | 1. `mail_settings.sandbox_mode.enable: true` (validates schema/payload without sending or charging)<br>2. No webhook events in sandbox mode | 1. Account sandbox (can only send to verified emails)<br>2. Amazon Mailbox Simulator addresses (`success@simulator.amazonses.com`, `bounce@`, etc.) | 1. Sandbox domain `sandbox<id>.mailgun.org` (up to 5 authorized recipients)<br>2. Parameter `o:testmode=yes` (validates without sending, still billed) |
| **Domain Verification in Dev** | Sender Signature or verified domain required. Can only send to verified domain addresses until account is approved | `onboarding@resend.dev` provided for immediate testing to developer's email without custom domain | Single Sender Verification (email address) or Domain Authentication required | Must verify sender address or domain; in sandbox, recipient must also be verified | Sandbox domain does not require DNS verification (restricted to 5 authorized recipients) |

---

## 2. Per-Provider Deep-Dive & Primary Sources

### Postmark (Incumbent)
- **Primary Sources**:
  - Pricing: [https://postmarkapp.com/pricing](https://postmarkapp.com/pricing) and machine-readable [https://postmarkapp.com/pricing.txt](https://postmarkapp.com/pricing.txt)
  - Dedicated IPs: [https://postmarkapp.com/dedicated-ips](https://postmarkapp.com/dedicated-ips)
  - Email API reference: [https://postmarkapp.com/developer/api/email-api](https://postmarkapp.com/developer/api/email-api)
  - API Overview & Test token: [https://postmarkapp.com/developer/api/overview](https://postmarkapp.com/developer/api/overview)
  - Templates API: [https://postmarkapp.com/developer/api/templates-api](https://postmarkapp.com/developer/api/templates-api)
  - Template Syntax: [https://postmarkapp.com/support/article/1077-template-syntax](https://postmarkapp.com/support/article/1077-template-syntax)
  - Webhooks Overview: [https://postmarkapp.com/developer/webhooks/webhooks-overview](https://postmarkapp.com/developer/webhooks/webhooks-overview)
  - Subscription Change Webhook: [https://postmarkapp.com/developer/webhooks/subscription-change-webhook](https://postmarkapp.com/developer/webhooks/subscription-change-webhook)
  - Message Streams: [https://postmarkapp.com/message-streams](https://postmarkapp.com/message-streams) and [https://postmarkapp.com/developer/api/message-streams-api](https://postmarkapp.com/developer/api/message-streams-api)
  - List-Unsubscribe Header: [https://postmarkapp.com/blog/list-unsubscribe-header](https://postmarkapp.com/blog/list-unsubscribe-header)
  - Suppressions API: [https://postmarkapp.com/developer/api/suppressions-api](https://postmarkapp.com/developer/api/suppressions-api)
  - Account Approval: [https://postmarkapp.com/support/article/1084-how-does-the-account-approval-process-work](https://postmarkapp.com/support/article/1084-how-does-the-account-approval-process-work)
  - Sandbox Server Mode: [https://postmarkapp.com/developer/user-guide/sandbox-mode/server-sandbox-mode](https://postmarkapp.com/developer/user-guide/sandbox-mode/server-sandbox-mode)
  - Fake Bounces: [https://postmarkapp.com/developer/user-guide/sandbox-mode/generate-fake-bounces](https://postmarkapp.com/developer/user-guide/sandbox-mode/generate-fake-bounces)
- **Key Architectural Findings**:
  - Cadence already has an implementation in `app/lib/mailer.server.ts` using `X-Postmark-Server-Token` and flat JSON payloads (`From`, `To`, `Subject`, `TextBody`, `MessageStream: "outbound"`).
  - Delivery reputation is strictly segmented by Message Streams (transactional vs broadcast).
  - Webhook security note: Postmark officially does not sign webhooks with HMAC. Endpoint security relies on Basic Authentication credentials embedded in the destination URL and restricting traffic by Postmark IP ranges.

### Resend
- **Primary Sources**:
  - Pricing: [https://resend.com/pricing](https://resend.com/pricing)
  - API Introduction & Headers: [https://resend.com/docs/api-reference/introduction.md](https://resend.com/docs/api-reference/introduction.md)
  - Send Email API: [https://resend.com/docs/api-reference/emails/send-email.md](https://resend.com/docs/api-reference/emails/send-email.md)
  - Rate Limits & Idempotency: [https://resend.com/docs/api-reference/rate-limit.md](https://resend.com/docs/api-reference/rate-limit.md)
  - Templates Overview: [https://resend.com/docs/dashboard/templates/introduction.md](https://resend.com/docs/dashboard/templates/introduction.md)
  - Template Variables: [https://resend.com/docs/dashboard/templates/template-variables.md](https://resend.com/docs/dashboard/templates/template-variables.md)
  - Template Version History: [https://resend.com/docs/dashboard/templates/version-history.md](https://resend.com/docs/dashboard/templates/version-history.md)
  - Webhook Event Types: [https://resend.com/docs/webhooks/event-types.md](https://resend.com/docs/webhooks/event-types.md)
  - Webhook Verification: [https://resend.com/docs/webhooks/verify-webhooks-requests.md](https://resend.com/docs/webhooks/verify-webhooks-requests.md)
  - Domains & Reputation: [https://resend.com/docs/dashboard/domains/introduction.md](https://resend.com/docs/dashboard/domains/introduction.md)
  - Dedicated IPs: [https://resend.com/docs/knowledge-base/how-do-dedicated-ips-work.md](https://resend.com/docs/knowledge-base/how-do-dedicated-ips-work.md)
  - IP Warmup: [https://resend.com/docs/knowledge-base/warming-up.md](https://resend.com/docs/knowledge-base/warming-up.md)
  - Unsubscribe in Transactional: [https://resend.com/docs/dashboard/emails/add-unsubscribe-to-transactional-emails.md](https://resend.com/docs/dashboard/emails/add-unsubscribe-to-transactional-emails.md)
  - Suppressions: [https://resend.com/docs/dashboard/emails/email-suppressions.md](https://resend.com/docs/dashboard/emails/email-suppressions.md)
  - Topics: [https://resend.com/docs/knowledge-base/why-use-topics.md](https://resend.com/docs/knowledge-base/why-use-topics.md)
  - Testing & Magic Addresses: [https://resend.com/docs/dashboard/emails/send-test-emails.md](https://resend.com/docs/dashboard/emails/send-test-emails.md)
  - Test Address Restrictions: [https://resend.com/docs/knowledge-base/what-email-addresses-to-use-for-testing.md](https://resend.com/docs/knowledge-base/what-email-addresses-to-use-for-testing.md)
- **Key Architectural Findings**:
  - Very clean REST API fit: `Authorization: Bearer re_...` with standard camelCase JSON (`from`, `to`, `subject`, `text`, `html`).
  - Strict requirement: A `User-Agent` header is mandatory on all HTTP requests (omitting it yields a 403 Forbidden).
  - Built-in `Idempotency-Key` header support with 24-hour expiration.
  - Webhooks use Svix signatures (`svix-id`, `svix-timestamp`, `svix-signature`), standard in modern TypeScript/Node environments.

### SendGrid (Twilio SendGrid)
- **Primary Sources**:
  - Pricing: [https://www.twilio.com/en-us/products/email-api/pricing](https://www.twilio.com/en-us/products/email-api/pricing)
  - Overage Rates FAQ: [https://support.sendgrid.com/hc/en-us/articles/40779261694875-Twilio-SendGrid-Overage-Rates](https://support.sendgrid.com/hc/en-us/articles/40779261694875-Twilio-SendGrid-Overage-Rates)
  - Mail Send API Reference: [https://www.twilio.com/docs/sendgrid/api-reference/mail-send/mail-send](https://www.twilio.com/docs/sendgrid/api-reference/mail-send/mail-send)
  - API Authentication: [https://www.twilio.com/docs/sendgrid/api-reference/how-to-use-the-sendgrid-v3-api/authentication.md](https://www.twilio.com/docs/sendgrid/api-reference/how-to-use-the-sendgrid-v3-api/authentication.md)
  - Rate Limits: [https://www.twilio.com/docs/sendgrid/api-reference/how-to-use-the-sendgrid-v3-api/rate-limits](https://www.twilio.com/docs/sendgrid/api-reference/how-to-use-the-sendgrid-v3-api/rate-limits)
  - Dynamic Templates: [https://www.twilio.com/docs/sendgrid/ui/sending-email/how-to-send-an-email-with-dynamic-templates.md](https://www.twilio.com/docs/sendgrid/ui/sending-email/how-to-send-an-email-with-dynamic-templates.md)
  - Event Webhook Overview: [https://www.twilio.com/docs/sendgrid/for-developers/tracking-events/event](https://www.twilio.com/docs/sendgrid/for-developers/tracking-events/event)
  - Event Webhook Security (ECDSA & OAuth): [https://www.twilio.com/docs/sendgrid/for-developers/tracking-events/getting-started-event-webhook-security-features](https://www.twilio.com/docs/sendgrid/for-developers/tracking-events/getting-started-event-webhook-security-features)
  - Dedicated IP Addresses: [https://www.twilio.com/docs/sendgrid/ui/account-and-settings/dedicated-ip-addresses](https://www.twilio.com/docs/sendgrid/ui/account-and-settings/dedicated-ip-addresses)
  - IP Warmup: [https://www.twilio.com/docs/sendgrid/concepts/reputation/warm-up-ip-addresses.md](https://www.twilio.com/docs/sendgrid/concepts/reputation/warm-up-ip-addresses.md)
  - Unsubscribe Groups API: [https://www.twilio.com/docs/sendgrid/api-reference/suppressions-unsubscribe-groups.md](https://www.twilio.com/docs/sendgrid/api-reference/suppressions-unsubscribe-groups.md)
  - Global Suppressions API: [https://www.twilio.com/docs/sendgrid/api-reference/suppressions-suppressions.md](https://www.twilio.com/docs/sendgrid/api-reference/suppressions-suppressions.md)
  - Subscription Tracking: [https://www.twilio.com/docs/sendgrid/ui/sending-email/subscription-tracking.md](https://www.twilio.com/docs/sendgrid/ui/sending-email/subscription-tracking.md)
  - Sandbox Mode: [https://www.twilio.com/docs/sendgrid/for-developers/sending-email/sandbox-mode](https://www.twilio.com/docs/sendgrid/for-developers/sending-email/sandbox-mode)
  - Sender Verification: [https://www.twilio.com/docs/sendgrid/ui/sending-email/sender-verification.md](https://www.twilio.com/docs/sendgrid/ui/sending-email/sender-verification.md)
- **Key Architectural Findings**:
  - API payload structure is deeply nested (`personalizations: [{ to: [{ email }] }]`, `content: [{ type, value }]`), requiring more boilerplate in a custom `MailTransport` than Postmark or Resend.
  - Very mature unsubscribe groups (`asm.group_id`), allowing recipients to opt out of specific categories without unsubscribing from transactional receipts.
  - Webhooks use ECDSA signatures with public key verification; webhooks deliver batched arrays of event objects rather than single events.

### Amazon SES (Simple Email Service)
- **Primary Sources**:
  - Pricing: [https://aws.amazon.com/ses/pricing/](https://aws.amazon.com/ses/pricing/)
  - AWS Free Tier Details: [https://docs.aws.amazon.com/awsaccountbilling/latest/aboutv2/free-tier-plans.html](https://docs.aws.amazon.com/awsaccountbilling/latest/aboutv2/free-tier-plans.html)
  - AWS Account Creation: [https://docs.aws.amazon.com/accounts/latest/reference/manage-acct-creating.html](https://docs.aws.amazon.com/accounts/latest/reference/manage-acct-creating.html)
  - SendEmail API v2: [https://docs.aws.amazon.com/ses/latest/APIReference-V2/API_SendEmail.html](https://docs.aws.amazon.com/ses/latest/APIReference-V2/API_SendEmail.html)
  - Common Parameters & SigV4: [https://docs.aws.amazon.com/ses/latest/APIReference-V2/CommonParameters.html](https://docs.aws.amazon.com/ses/latest/APIReference-V2/CommonParameters.html)
  - Sending Quotas: [https://docs.aws.amazon.com/ses/latest/dg/manage-sending-quotas.html](https://docs.aws.amazon.com/ses/latest/dg/manage-sending-quotas.html)
  - Production Access Request: [https://docs.aws.amazon.com/ses/latest/dg/request-production-access.html](https://docs.aws.amazon.com/ses/latest/dg/request-production-access.html)
  - Amazon Mailbox Simulator: [https://docs.aws.amazon.com/ses/latest/dg/send-an-email-from-console.html](https://docs.aws.amazon.com/ses/latest/dg/send-an-email-from-console.html)
  - Personalized Email / Templates: [https://docs.aws.amazon.com/ses/latest/dg/send-personalized-email-api.html](https://docs.aws.amazon.com/ses/latest/dg/send-personalized-email-api.html) and [https://docs.aws.amazon.com/ses/latest/dg/send-personalized-email-advanced.html](https://docs.aws.amazon.com/ses/latest/dg/send-personalized-email-advanced.html)
  - Event Publishing & SNS: [https://docs.aws.amazon.com/ses/latest/dg/monitor-using-event-publishing.html](https://docs.aws.amazon.com/ses/latest/dg/monitor-using-event-publishing.html) and [https://docs.aws.amazon.com/sns/latest/dg/sns-verify-signature-of-message.html](https://docs.aws.amazon.com/sns/latest/dg/sns-verify-signature-of-message.html)
  - Dedicated IPs: [https://docs.aws.amazon.com/ses/latest/dg/dedicated-ip.html](https://docs.aws.amazon.com/ses/latest/dg/dedicated-ip.html)
  - Address & Domain Verification: [https://docs.aws.amazon.com/ses/latest/dg/verify-addresses-and-domains.html](https://docs.aws.amazon.com/ses/latest/dg/verify-addresses-and-domains.html)
  - Subscription Management: [https://docs.aws.amazon.com/ses/latest/dg/sending-email-subscription-management.html](https://docs.aws.amazon.com/ses/latest/dg/sending-email-subscription-management.html)
  - Account Suppression List: [https://docs.aws.amazon.com/ses/latest/dg/sending-email-suppression-list.html](https://docs.aws.amazon.com/ses/latest/dg/sending-email-suppression-list.html)
- **Key Architectural Findings**:
  - Lowest unit cost by a wide margin ($0.16 / 1k emails, pay-as-you-go).
  - Raw `fetch()` integration is significantly more complex than competitors: requires AWS Signature Version 4 (SigV4) calculation over headers, body, timestamp, and region. Standard practice requires `@aws-sdk/client-sesv2` or a standalone SigV4 signer.
  - Webhooks are not sent directly as HTTP callbacks to a web URL: SES publishes events to Amazon SNS, EventBridge, or Kinesis Firehose. Receiving webhooks in Cadence requires an SNS HTTP subscription with subscription confirmation and SNS message signature verification.

### Mailgun
- **Primary Sources**:
  - Pricing: [https://www.mailgun.com/pricing/](https://www.mailgun.com/pricing/)
  - Authentication (HTTP Basic & Domain Keys): [https://documentation.mailgun.com/docs/mailgun/api-reference/mg-auth.md](https://documentation.mailgun.com/docs/mailgun/api-reference/mg-auth.md)
  - Send Messages API: [https://documentation.mailgun.com/docs/mailgun/api-reference/send/mailgun/messages/post-v3--domain-name--messages.md](https://documentation.mailgun.com/docs/mailgun/api-reference/send/mailgun/messages/post-v3--domain-name--messages.md)
  - Sending via HTTP: [https://documentation.mailgun.com/docs/mailgun/user-manual/sending-messages/send-http.md](https://documentation.mailgun.com/docs/mailgun/user-manual/sending-messages/send-http.md)
  - Templates Manual: [https://documentation.mailgun.com/docs/mailgun/user-manual/sending-messages/send-templates.md](https://documentation.mailgun.com/docs/mailgun/user-manual/sending-messages/send-templates.md)
  - Webhooks Overview: [https://documentation.mailgun.com/docs/mailgun/user-manual/webhooks/webhooks.md](https://documentation.mailgun.com/docs/mailgun/user-manual/webhooks/webhooks.md)
  - Securing Webhooks (HMAC-SHA256): [https://documentation.mailgun.com/docs/mailgun/user-manual/webhooks/securing-webhooks.md](https://documentation.mailgun.com/docs/mailgun/user-manual/webhooks/securing-webhooks.md)
  - Tracking Unsubscribes: [https://documentation.mailgun.com/docs/mailgun/user-manual/tracking-messages/tracking-unsubscribes.md](https://documentation.mailgun.com/docs/mailgun/user-manual/tracking-messages/tracking-unsubscribes.md)
  - Unsubscribe Best Practices: [https://documentation.mailgun.com/docs/mailgun/email-best-practices/unsubscribe.md](https://documentation.mailgun.com/docs/mailgun/email-best-practices/unsubscribe.md)
  - Reputation & Warmup: [https://documentation.mailgun.com/docs/mailgun/email-best-practices/reputation.md](https://documentation.mailgun.com/docs/mailgun/email-best-practices/reputation.md)
  - IP Pools: [https://documentation.mailgun.com/docs/inboxready/api-reference/optimize/mailgun/ip-pools.md](https://documentation.mailgun.com/docs/inboxready/api-reference/optimize/mailgun/ip-pools.md)
  - Test Mode: [https://documentation.mailgun.com/docs/mailgun/user-manual/sending-messages/test-mode.md](https://documentation.mailgun.com/docs/mailgun/user-manual/sending-messages/test-mode.md)
  - Sandbox Domains: [https://documentation.mailgun.com/docs/mailgun/user-manual/domains/domains-sandbox.md](https://documentation.mailgun.com/docs/mailgun/user-manual/domains/domains-sandbox.md)
- **Key Architectural Findings**:
  - API endpoint requires `multipart/form-data` (`FormData` object in Node `fetch()`). Unlike Postmark/Resend/SendGrid, sending plain `application/json` is not the standard `/messages` endpoint convention.
  - Authentication uses HTTP Basic Auth (`api:<API_KEY>`), which translates in Node `fetch` to `Authorization: Basic ${Buffer.from('api:' + key).toString('base64')}`.
  - Webhooks provide a clean HMAC-SHA256 signature verification over `timestamp + token` using the account's webhook signing key.
  - Up to 40 stored versions per template.

---

## 3. Gaps and Verification Notes
- **Postmark 100k pricing**: Postmark's interactive pricing slider jumps from 50k ($55) to 125k ($115); exact 100k tier pricing is not published on static tables.
- **Amazon SES derived pricing**: The $1.60 (10k), $8.00 (50k), and $16.00 (100k) figures are direct calculations from the published $0.16 / 1,000 emails rate; they do not include optional dedicated IP costs or data/attachment fees ($0.12/GB).
- **SendGrid overage details**: SendGrid Essentials and Pro tier baseline pricing is published, but exact per-thousand overage rates vary by contract/FAQ and require checking against specific plan agreements.
- **Free tier credit card requirements**: Postmark explicitly documents "No credit card required" for free tiers. SendGrid documents "No credit card required" for the 60-day trial. AWS explicitly requires a valid payment method upon account creation. Resend and Mailgun free plan credit card policies are not explicitly declared on their public pricing tables.
