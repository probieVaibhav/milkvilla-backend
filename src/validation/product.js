import { z } from "zod";

const isSingleEmoji = (value) => {
  const segments = [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(value)];
  return segments.length === 1 && /[\p{Extended_Pictographic}\p{Regional_Indicator}\u20e3]/u.test(value);
};

export const productInputSchema = z.object({
  name: z.string().trim().min(2, "Product name must be at least 2 characters.").max(80, "Product name must be 80 characters or fewer."),
  category: z.string().trim().min(2, "Product type must be at least 2 characters.").max(40, "Product type must be 40 characters or fewer.").regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Use lowercase letters, numbers, and hyphens for the product type."),
  price: z.number().finite().positive("Price must be greater than zero.").max(1_000_000, "Price cannot exceed ₹1,000,000."),
  packSize: z.number().finite().positive("Pack size must be greater than zero.").multipleOf(0.01, "Pack size can have at most two decimal places.").max(100_000, "Pack size cannot exceed 100,000."),
  unitType: z.enum(["L", "KG", "G"], { error: "Choose L, KG, or G as the unit." }),
  description: z.string().trim().min(5, "Description must be at least 5 characters.").max(300, "Description must be 300 characters or fewer."),
  emoji: z
    .string()
    .min(1, "Choose an emoji from the picker.")
    .max(16, "Choose one emoji from the picker.")
    .refine(isSingleEmoji, "Choose one emoji from the emoji picker."),
});
