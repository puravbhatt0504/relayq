import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";
import nodemailer, { type Transporter } from "nodemailer";
import type { Handler } from "./types.js";

let transport: Transporter | undefined;
// SMTP_URL (MailHog locally) wins; otherwise SES with the default AWS credential chain.
const getTransport = () =>
  (transport ??= process.env.SMTP_URL
    ? nodemailer.createTransport(process.env.SMTP_URL)
    : nodemailer.createTransport({ SES: { sesClient: new SESv2Client({}), SendEmailCommand } }));

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export function renderDigest(userName: string, items: { title: string; url?: string }[]) {
  const li = items.map(({ title, url }) =>
    url && /^https?:\/\//i.test(url) ? `<li><a href="${esc(url)}">${esc(title)}</a></li>` : `<li>${esc(title)}</li>`,
  );
  return `<p>Hi ${esc(userName)},</p><p>Here's what happened:</p><ul>${li.join("")}</ul>`;
}

// SES has no idempotency key, so the sent-log in once() is the only guard: a crash between the
// send and its EffectLog commit can still send twice. That window is milliseconds; it isn't zero.
export const emailDigest: Handler<"email.digest"> = async ({ to, userName, items }, { once }) =>
  once("send", async () => {
    const info = await getTransport().sendMail({
      from: process.env.MAIL_FROM ?? "relayq@localhost",
      to,
      subject: `Your digest: ${items.length} update${items.length === 1 ? "" : "s"}`,
      html: renderDigest(userName, items),
    });
    return { messageId: info.messageId };
  });
