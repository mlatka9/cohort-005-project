import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// ─── Transactional email ───
// Resend delivers every email when RESEND_API_KEY is set. Without an API
// key (local dev, tests) each message is written to .outbox/ as a JSON file
// instead, so it can be read without sending anything.

export type Email = {
  to: string;
  subject: string;
  body: string;
};

export interface MailTransport {
  send(email: Email): Promise<void>;
}

export const FROM_ADDRESS = "Cadence <hello@cadence.dev>";

export function resendTransport(apiKey: string): MailTransport {
  return {
    async send(email) {
      const response = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
          "User-Agent": "cadence-app",
        },
        body: JSON.stringify({
          from: FROM_ADDRESS,
          to: email.to,
          subject: email.subject,
          text: email.body,
        }),
      });

      if (!response.ok) {
        let details = "";
        try {
          details = await response.text();
        } catch {}
        throw new Error(
          `Resend rejected the email to ${email.to}: ${response.status}${details ? ` ${details}` : ""}`
        );
      }
    },
  };
}

export function outboxTransport(directory: string): MailTransport {
  return {
    async send(email) {
      mkdirSync(directory, { recursive: true });
      const file = join(directory, `${Date.now()}-${email.to}.json`);
      writeFileSync(
        file,
        JSON.stringify({ from: FROM_ADDRESS, ...email }, null, 2)
      );
    },
  };
}

export function defaultTransport(): MailTransport {
  const apiKey = process.env.RESEND_API_KEY;
  return apiKey && apiKey.trim() !== ""
    ? resendTransport(apiKey.trim())
    : outboxTransport(".outbox");
}

export async function sendEmail(
  email: Email,
  transport: MailTransport = defaultTransport()
): Promise<void> {
  await transport.send(email);
}
