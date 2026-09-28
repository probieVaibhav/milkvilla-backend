import { z } from "zod";

export const checkoutEmailSchema = z
  .string()
  .trim()
  .max(254, "Email address must be 254 characters or fewer.")
  .email("Enter a valid email address.")
  .transform((email) => email.toLowerCase());

const customerNameSchema = z
  .string()
  .trim()
  .min(2, "Enter your name using at least 2 characters.")
  .max(80, "Name must be 80 characters or fewer.")
  .regex(/^[\p{L}\p{M}][\p{L}\p{M} .'-’]*$/u, "Use letters, spaces, apostrophes, periods, or hyphens.");

const phoneSchema = z
  .string()
  .trim()
  .max(25, "Enter a valid mobile number.")
  .transform((phone) => phone.replace(/[().\s-]/g, ""))
  .refine((phone) => /^(?:\+91|91|0)?[6-9]\d{9}$/.test(phone), "Enter a valid 10-digit Indian mobile number.")
  .transform((phone) => phone.replace(/^(?:\+91|91|0)/, ""));

const addressSchema = z
  .string()
  .trim()
  .min(5, "Address must be at least 5 characters.")
  .max(200, "Address must be 200 characters or fewer.")
  .refine((address) => /[\p{L}\p{N}]/u.test(address), "Enter a valid street address.")
  .refine((address) => !/[\u0000-\u001F\u007F]/.test(address), "Address contains unsupported characters.");

const citySchema = z
  .string()
  .trim()
  .min(2, "City must be at least 2 characters.")
  .max(80, "City must be 80 characters or fewer.")
  .regex(/^[\p{L}\p{M} .'-’]+$/u, "Use letters, spaces, apostrophes, periods, or hyphens.");

const pincodeSchema = z
  .string()
  .trim()
  .regex(/^[1-9]\d{5}$/, "Enter a valid 6-digit PIN code.");

const notesSchema = z
  .string()
  .trim()
  .max(500, "Order notes must be 500 characters or fewer.")
  .refine((notes) => !/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(notes), "Order notes contain unsupported characters.")
  .default("");

export const checkoutCustomerSchema = z.object({
  customerName: customerNameSchema,
  email: checkoutEmailSchema,
  phone: phoneSchema,
  address: addressSchema,
  city: citySchema,
  pincode: pincodeSchema,
  notes: notesSchema,
});

export const checkoutOrderSchema = checkoutCustomerSchema.extend({
  verificationToken: z.string().trim().min(1).nullable().optional(),
  latitude: z.number().finite().min(-90).max(90),
  longitude: z.number().finite().min(-180).max(180),
  items: z
    .array(
      z.object({
        productId: z.string().trim().min(1).max(100),
        quantity: z.number().int().min(1).max(99),
      }),
    )
    .min(1, "Add at least one product to your order.")
    .max(50, "An order can contain at most 50 product types.")
    .refine((items) => new Set(items.map((item) => item.productId)).size === items.length, "Remove duplicate products from the order."),
});
