// The app's own emails (not login emails: those go through Supabase's SMTP).
// Sent with SMTP from the environment, server-side only:
//
//   SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASSWORD, SMTP_FROM
//
// Not configured: nothing is sent and sendEmail() returns false. Callers treat
// email as a courtesy: everything it announces is also shown in the app.

import nodemailer from 'nodemailer'

let transport: ReturnType<typeof nodemailer.createTransport> | null = null

export function emailConfigured(): boolean {
  return Boolean(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASSWORD)
}

function getTransport() {
  if (!transport) {
    const port = Number(process.env.SMTP_PORT || 587)
    transport = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port,
      secure: port === 465,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD },
    })
  }
  return transport
}

const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

// A short, plain email: a few paragraphs and one button. Text and HTML parts.
export async function sendEmail(input: {
  to: string[]
  subject: string
  paragraphs: string[]
  button?: { label: string; url: string }
}): Promise<boolean> {
  if (!emailConfigured() || input.to.length === 0) return false
  const text = [...input.paragraphs, ...(input.button ? [`${input.button.label}: ${input.button.url}`] : [])].join('\n\n')
  const html =
    `<div style="font-family:system-ui,sans-serif;font-size:14px;line-height:1.5;color:#101312;max-width:520px">` +
    input.paragraphs.map((p) => `<p>${escapeHtml(p)}</p>`).join('') +
    (input.button
      ? `<p><a href="${escapeHtml(input.button.url)}" style="display:inline-block;background:#16181f;color:#f2f5f4;padding:9px 16px;border-radius:999px;text-decoration:none">${escapeHtml(input.button.label)}</a></p>`
      : '') +
    `</div>`
  try {
    await getTransport().sendMail({
      from: process.env.SMTP_FROM || process.env.SMTP_USER,
      to: input.to.join(', '),
      subject: input.subject,
      text,
      html,
    })
    return true
  } catch (err) {
    console.error('[email] send failed:', (err as Error).message)
    return false
  }
}
