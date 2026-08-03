import { z } from 'zod';

export const ReviewInputSchema = z.object({
  doctorId: z.string().min(1).max(64),
  authorName: z.string().trim().max(80).optional().default('Anonymous'),
  rating: z.coerce.number().int().min(1).max(5),
  comment: z.string().trim().min(3, 'Comment is too short').max(2000),
  turnstileToken: z.string().optional(),
});
export type ReviewInput = z.infer<typeof ReviewInputSchema>;

export const REPORT_REASONS = ['wrongAddress', 'wrongPhone', 'doctorNotThere', 'closedPermanently', 'other'] as const;

export const ReportInputSchema = z
  .object({
    doctorId: z.string().min(1).max(64).optional(),
    clinicId: z.string().min(1).max(64).optional(),
    reason: z.enum(REPORT_REASONS),
    details: z.string().trim().max(2000).optional().default(''),
    turnstileToken: z.string().optional(),
  })
  .refine((v) => !!v.doctorId || !!v.clinicId, {
    message: 'Either doctorId or clinicId is required',
  });
export type ReportInput = z.infer<typeof ReportInputSchema>;
