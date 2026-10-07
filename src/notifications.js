import twilio from "twilio";

const sendEmail = async ({ to, subject, text, html }) => {
  if (!process.env.RESEND_API_KEY || !process.env.RESEND_FROM) throw new Error("RESEND_API_KEY and RESEND_FROM must be configured.");

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: process.env.RESEND_FROM,
      to,
      subject,
      text,
      ...(html ? { html } : {}),
    }),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.message || `Resend email request failed (${response.status}).`);
};

const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);

export async function sendTestEmail() {
  if (!process.env.OWNER_EMAIL) throw new Error("OWNER_EMAIL must be configured.");
  await sendEmail({
    to: process.env.OWNER_EMAIL,
    subject: "Milk Villa email test",
    text: "This is a test email from Milk Villa. Your email configuration is working.",
  });
}

export async function sendVerificationEmail(email, verificationUrl) {
  await sendEmail({
    to: email,
    subject: "Verify your email for Milk Villa",
    text: `Confirm your email address to place your Milk Villa order:\n\n${verificationUrl}\n\nThis link expires in 30 minutes.`,
    html: `<p>Confirm your email address to place your Milk Villa order.</p><p><a href="${verificationUrl}">Verify my email</a></p><p>This link expires in 30 minutes.</p>`,
  });
}

export async function sendCustomerOrderConfirmationEmail(order) {
  if (!order.email) throw new Error("This order has no customer email address.");
  const customerName = escapeHtml(order.customerName);
  const orderId = escapeHtml(order.id);
  const address = escapeHtml(`${order.address}, ${order.city}, ${order.pincode}`);
  const itemText = order.items.map((item) => `${item.name} x ${item.quantity} = Rs ${item.total}`).join("\n");
  const itemRows = order.items.map((item) => `<tr><td>${escapeHtml(item.name)} × ${item.quantity}</td><td>₹${item.total}</td></tr>`).join("");
  await sendEmail({
    to: order.email,
    subject: `Order ${order.id} placed with Milk Villa`,
    text: `Hello ${order.customerName},\n\nYour Milk Villa order ${order.id} has been placed successfully.\n\n${itemText}\n\nDelivery address: ${order.address}, ${order.city}, ${order.pincode}\nDistance: ${order.distanceKm} km\nTotal: Rs ${order.total}\nPayment: Cash on delivery\n\nThank you,\nMilk Villa`,
    html: `<p>Hello ${customerName},</p><p>Your Milk Villa order <strong>${orderId}</strong> has been placed successfully.</p><table><tbody>${itemRows}</tbody></table><p>Delivery address: ${address}<br>Distance: ${order.distanceKm} km<br>Total: <strong>₹${order.total}</strong><br>Payment: Cash on delivery</p><p>Thank you,<br>Milk Villa</p>`,
  });
}

export async function sendCustomerStatusEmail(order) {
  if (!order.email) throw new Error("This order has no customer email address.");
  const statusLabel = order.status.replaceAll("-", " ");
  const customerName = escapeHtml(order.customerName);
  const orderId = escapeHtml(order.id);
  const cancellationReason = order.status === "canceled" ? order.cancellationReason || "Please contact Milk Villa for details." : "";
  const escapedCancellationReason = escapeHtml(cancellationReason);
  const statusMessage = order.status === "canceled" ? `has been canceled. Reason: ${cancellationReason}` : `is now ${statusLabel}.`;
  const statusHtml = order.status === "canceled" ? `has been canceled.<br>Reason: ${escapedCancellationReason}` : `is now <strong>${statusLabel}</strong>.`;
  const feedbackUrl = "https://g.page/r/CaAPk2WLVIAGEAI/review";
  const deliveredMessage = order.status === "delivered" ? `\n\nWe'd love your feedback: ${feedbackUrl}` : "";
  const deliveredHtml = order.status === "delivered" ? `<p><a href="${feedbackUrl}">Share your feedback</a></p>` : "";
  await sendEmail({
    to: order.email,
    subject: `Your Milk Villa order ${order.id} is ${statusLabel}`,
    text: `Hello ${order.customerName},\n\nYour order ${order.id} ${statusMessage}${deliveredMessage}\n\nThank you,\nMilk Villa`,
    html: `<p>Hello ${customerName},</p><p>Your order <strong>${orderId}</strong> ${statusHtml}</p>${deliveredHtml}<p>Thank you,<br>Milk Villa</p>`,
  });
}

export async function sendOrderNotifications(order) {
  const lines = order.items.map((item) => `${item.name} x ${item.quantity} = Rs ${item.total}`).join("\n");
  const message = `New Milk Villa order ${order.id}\n${order.customerName}, ${order.phone}\n${lines}\nTotal: Rs ${order.total}`;
  if (process.env.RESEND_API_KEY && process.env.RESEND_FROM && process.env.OWNER_EMAIL) {
    await sendEmail({ to: process.env.OWNER_EMAIL, subject: `New order ${order.id}`, text: message });
  }
  if (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_PHONE_NUMBER && process.env.OWNER_WHATSAPP_NUMBER) {
    await twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN).messages.create({ from: `whatsapp:${process.env.TWILIO_PHONE_NUMBER}`, to: `whatsapp:${process.env.OWNER_WHATSAPP_NUMBER}`, body: message });
  }
}
