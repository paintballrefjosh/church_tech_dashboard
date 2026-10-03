/**
 * Inline HTML email template. One-shot — every email built from the same
 * shell with `{title}`, optional `{body}`, and a single `{link}` button.
 *
 * Why hand-rolled instead of mjml/handlebars/etc.: emails are universally
 * the same shape (subject + paragraph + button), the templates rarely
 * change, and adding a build-time transformer for this complicates the
 * Dockerfile for no real win at our scale.
 *
 * Email-client compatibility constraints baked in:
 *   - table-based layout (Outlook still scans tables; div-only layouts
 *     break on Outlook 365 / desktop)
 *   - inline styles only (Gmail strips <style> on mobile)
 *   - no external assets, no @media (the brand color is the brand color)
 */

interface TemplateInput {
  siteName: string;
  brandColor?: string;
  title: string;
  body?: string;
  cta?: { label: string; href: string };
  footer?: string;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

export function renderEmail(input: TemplateInput): { html: string; text: string } {
  const brand = input.brandColor ?? "#2563eb";
  const safeBody = input.body ? escapeHtml(input.body).replace(/\n/g, "<br>") : "";
  const cta = input.cta
    ? `
      <tr>
        <td style="padding:24px 0 0 0">
          <a href="${escapeHtml(input.cta.href)}" style="display:inline-block;background:${brand};color:#ffffff;text-decoration:none;padding:10px 18px;border-radius:6px;font-size:14px;font-weight:600">${escapeHtml(input.cta.label)}</a>
        </td>
      </tr>`
    : "";
  const html = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escapeHtml(input.title)}</title></head>
<body style="margin:0;padding:0;background:#f1f5f9;font-family:Arial,Helvetica,sans-serif;color:#0f172a">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:#f1f5f9;padding:24px 0">
    <tr>
      <td align="center">
        <table role="presentation" width="560" cellspacing="0" cellpadding="0" border="0" style="background:#ffffff;border-radius:8px;border:1px solid #e2e8f0;max-width:560px">
          <tr>
            <td style="padding:20px 24px;border-bottom:1px solid #e2e8f0;font-size:14px;font-weight:600;color:${brand}">${escapeHtml(input.siteName)}</td>
          </tr>
          <tr>
            <td style="padding:24px">
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
                <tr>
                  <td style="font-size:18px;font-weight:600;color:#0f172a;padding-bottom:8px">${escapeHtml(input.title)}</td>
                </tr>
                ${safeBody ? `<tr><td style="font-size:14px;line-height:1.55;color:#334155">${safeBody}</td></tr>` : ""}
                ${cta}
              </table>
            </td>
          </tr>
          ${
            input.footer
              ? `<tr><td style="padding:16px 24px;border-top:1px solid #e2e8f0;font-size:12px;color:#64748b">${escapeHtml(input.footer)}</td></tr>`
              : ""
          }
        </table>
      </td>
    </tr>
  </table>
</body></html>`;

  // Plain-text fallback — what email clients show when HTML is disabled.
  const text = [
    input.title,
    input.body ?? "",
    input.cta ? `\n${input.cta.label}: ${input.cta.href}` : "",
    input.footer ? `\n${input.footer}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  return { html, text };
}
