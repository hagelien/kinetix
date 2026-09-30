/**
 * Minimal Resend client for one-time-code emails.
 *
 * Required env vars (configure in Vercel):
 *   RESEND_API_KEY    - API key from https://resend.com
 *   RESEND_FROM_EMAIL - verified sender, e.g. "Kinetix <noreply@kinetix.no>"
 *   PUBLIC_APP_URL    - e.g. "https://kinetix.no" (optional; used when
 *                       building absolute URLs if no origin header is present)
 */

interface SendEmailParams {
  to: string;
  subject: string;
  html: string;
  text?: string;
}

export async function sendEmail(params: SendEmailParams): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.RESEND_FROM_EMAIL;
  if (!apiKey || !from) {
    throw new Error('RESEND_API_KEY and RESEND_FROM_EMAIL must be configured');
  }

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    signal: AbortSignal.timeout(10_000),
    body: JSON.stringify({
      from,
      to: [params.to],
      subject: params.subject,
      html: params.html,
      ...(params.text ? { text: params.text } : {}),
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Resend API error ${res.status}: ${body.slice(0, 300)}`);
  }
}

export async function sendLoginCode(email: string, code: string): Promise<void> {
  const html = `
    <div style="font-family: system-ui, sans-serif; max-width: 520px; margin: 0 auto; padding: 24px;">
      <h1 style="font-size: 20px; margin-bottom: 8px;">Sign in to Kinetix</h1>
      <p style="color: #555; line-height: 1.5;">
        Enter this code on the login page to sign in.
        It is valid for 15 minutes and can only be used once.
      </p>
      <p style="margin: 24px 0; text-align: center;">
        <span style="display: inline-block; padding: 16px 32px; background: #0f172a; color: #fff; border-radius: 8px; font-size: 32px; font-weight: 700; letter-spacing: 8px; font-family: monospace;">
          ${code}
        </span>
      </p>
      <p style="color: #888; font-size: 12px;">
        If you didn't request this email you can safely ignore it.
      </p>
    </div>
  `;
  const text = `Sign in to Kinetix\n\nYour login code: ${code}\n\nEnter this code on the login page within 15 minutes.\n\nIf you didn't request this email you can safely ignore it.`;
  await sendEmail({
    to: email,
    subject: `${code} - Your Kinetix sign-in code`,
    html,
    text,
  });
}
