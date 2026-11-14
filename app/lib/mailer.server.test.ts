import { mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { outboxTransport, resendTransport, sendEmail } from "./mailer.server";

describe("resendTransport", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("posts to Resend API with correct headers, user-agent, and payload", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ id: "email_123" }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const transport = resendTransport("re_test_key_123");
    await transport.send({
      to: "student@example.com",
      subject: "Welcome",
      body: "Welcome to Cadence",
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.resend.com/emails");
    expect(options.method).toBe("POST");
    expect(options.headers).toMatchObject({
      Accept: "application/json",
      "Content-Type": "application/json",
      Authorization: "Bearer re_test_key_123",
      "User-Agent": "cadence-app",
    });

    const parsedBody = JSON.parse(options.body);
    expect(parsedBody).toEqual({
      from: "Cadence <hello@cadence.dev>",
      to: "student@example.com",
      subject: "Welcome",
      text: "Welcome to Cadence",
    });
  });

  it("throws an error when Resend rejects the request", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
      text: async () => "Forbidden: User-Agent header is required",
    });
    vi.stubGlobal("fetch", fetchMock);

    const transport = resendTransport("invalid_key");
    await expect(
      transport.send({
        to: "student@example.com",
        subject: "Welcome",
        body: "Welcome to Cadence",
      })
    ).rejects.toThrow(/Resend rejected the email to student@example\.com: 403/);
  });
});

describe("sendEmail and outbox fallback", () => {
  const testDir = join(process.cwd(), ".test-mailer-outbox");

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
    delete process.env.RESEND_API_KEY;
  });

  it("writes the message to the outbox when using outboxTransport", async () => {
    mkdirSync(testDir, { recursive: true });

    await sendEmail(
      { to: "liam@example.com", subject: "Hello", body: "Hi Liam" },
      outboxTransport(testDir)
    );

    const files = readdirSync(testDir);
    expect(files).toHaveLength(1);
    const written = JSON.parse(readFileSync(join(testDir, files[0]), "utf8"));
    expect(written).toMatchObject({
      from: "Cadence <hello@cadence.dev>",
      to: "liam@example.com",
      subject: "Hello",
      body: "Hi Liam",
    });
  });

  it("falls back to outbox when RESEND_API_KEY is missing or empty", async () => {
    delete process.env.RESEND_API_KEY;
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    // Default transport should not call fetch when RESEND_API_KEY is not set
    await sendEmail(
      { to: "dev@example.com", subject: "Dev test", body: "Dev body" },
      outboxTransport(testDir)
    );

    expect(fetchMock).not.toHaveBeenCalled();
    const files = readdirSync(testDir);
    expect(files).toHaveLength(1);
  });
});
