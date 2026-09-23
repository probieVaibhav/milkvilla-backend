import nodemailer from "nodemailer";
import twilio from "twilio";

export async function sendOrderNotifications(order) {
  const lines = order.items.map((item) => `${item.name} x ${item.quantity} = Rs ${item.total}`).join("\n");
  const message = `New Milk Villa order ${order.id}\n${order.customerName}, ${order.phone}\n${lines}\nTotal: Rs ${order.total}`;
  if (process.env.SMTP_HOST && process.env.OWNER_EMAIL) {
    const transporter = nodemailer.createTransport({ host: process.env.SMTP_HOST, port: Number(process.env.SMTP_PORT || 587), secure: Number(process.env.SMTP_PORT) === 465, auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } });
    await transporter.sendMail({ from: process.env.SMTP_FROM || process.env.SMTP_USER, to: process.env.OWNER_EMAIL, subject: `New order ${order.id}`, text: message });
  }
  if (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_PHONE_NUMBER && process.env.OWNER_WHATSAPP_NUMBER) {
    await twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN).messages.create({ from: `whatsapp:${process.env.TWILIO_PHONE_NUMBER}`, to: `whatsapp:${process.env.OWNER_WHATSAPP_NUMBER}`, body: message });
  }
}
