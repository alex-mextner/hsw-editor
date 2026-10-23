/**
 * Import drafts: the review state between "photos uploaded" and "tools added to the library".
 * A draft holds one record per detected object with its class suggestions, the observation (profile and
 * colours, kept so changes refit without the sidecar), the user's decisions and the preview files.
 * Browser-safe types and zod schemas only; the disk logic is `node/drafts.ts`.
 */
import { z } from 'zod';
import { ColorSegmentSchema, ObservedProfileSchema, ToolIdSchema } from './schema.ts';
import { TagsSchema } from './tags.ts';

export const DraftIdSchema = ToolIdSchema;

/** Either a known scale or a two-point reference with its real distance; a half-specified one is rejected, never guessed. */
export const CalibrationInputSchema = z
  .strictObject({
    /** Known scale. */
    mmPerPx: z.number().positive().optional(),
    /** Two points in the photo and their real distance (a ruler, a bank tool of known size). */
    pointsPx: z
      .tuple([z.tuple([z.number(), z.number()]), z.tuple([z.number(), z.number()])])
      .optional(),
    distanceMm: z.number().positive().optional(),
  })
  .superRefine((c, ctx) => {
    if ((c.pointsPx === undefined) !== (c.distanceMm === undefined)) {
      ctx.addIssue({
        code: 'custom',
        message: 'pointsPx and distanceMm must be given together',
      });
    } else if (c.mmPerPx === undefined && c.pointsPx === undefined) {
      ctx.addIssue({
        code: 'custom',
        message: 'give mmPerPx, or pointsPx with distanceMm',
      });
    }
  });
export type CalibrationInput = z.infer<typeof CalibrationInputSchema>;

export const SuggestionSchema = z.strictObject({
  classId: z.string(),
  score: z.number().min(0).max(1),
});

export const DraftObjectStatus = z.enum(['pending', 'accepted', 'discarded', 'added']);

export const DraftObjectSchema = z.strictObject({
  /** `<photo index>:<sidecar object id>`; merged objects get `m<n>` ids. */
  key: z.string(),
  photo: z.number().int().nonnegative(),
  objectId: z.number().int(),
  /** Other photos showing the same tool (keys), in addition to this primary observation. */
  alsoSeenIn: z.array(z.string()).max(200),
  status: DraftObjectStatus,
  name: z.strictObject({
    en: z.string().max(120).optional(),
    ru: z.string().max(120).optional(),
  }),
  /** Library tags the committed tool gets (normalised). */
  tags: TagsSchema.default([]),
  suggestions: z.array(SuggestionSchema).max(10),
  /** Chosen class; null = generic loft; the top suggestion until the user overrides it. */
  classId: z.string().nullable(),
  classOverridden: z.boolean(),
  /** Missing until the photo has a scale. */
  observation: z
    .strictObject({
      profile: ObservedProfileSchema,
      colors: z.array(ColorSegmentSchema),
      profileKind: z.string().optional(),
      /** The photo had no scale: `profile` is in pixels and is scaled by a class-typical or a typed size when fitted. */
      profileInPixels: z.literal(true).optional(),
    })
    .nullable(),
  userDimensions: z
    .strictObject({
      length: z.number().positive().optional(),
      width: z.number().positive().optional(),
      thickness: z.number().positive().optional(),
    })
    .optional(),
  fit: z
    .strictObject({
      method: z.enum(['class-profile', 'generic-loft', 'manual']),
      iou: z.number(),
      confidence: z.number(),
      /** Alternatives tried while choosing the class (what the compare widget shows). */
      alternatives: z.array(
        z.strictObject({
          classId: z.string(),
          iou: z.number(),
          score: z.number(),
        }),
      ),
    })
    .nullable(),
  dimensionsMm: z
    .strictObject({
      length: z.number(),
      width: z.number(),
      thickness: z.number(),
    })
    .nullable(),
  needsScale: z.boolean(),
  /** The size is the class-typical one (no scale on the photo, nothing typed): a flagged estimate, never a measurement. */
  dimensionsEstimated: z.boolean().default(false),
  /** Crop / cut-out of the object, relative to the draft directory. */
  images: z.strictObject({
    crop: z.string().optional(),
    cutout: z.string().optional(),
    mask: z.string().optional(),
  }),
  preview: z.strictObject({ glb: z.string(), thumb: z.string() }).nullable(),
  /** Set once added to the library. */
  toolId: z.string().optional(),
  error: z.string().optional(),
});
export type DraftObject = z.infer<typeof DraftObjectSchema>;

export const DraftSchema = z.strictObject({
  version: z.literal(1),
  id: DraftIdSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
  state: z.enum(['created', 'analyzing', 'ready', 'failed']),
  /** `single`: every photo shows the same tool; `multi`: photos with several different tools. */
  mode: z.enum(['single', 'multi']),
  photos: z
    .array(
      z.strictObject({
        index: z.number().int().nonnegative(),
        file: z.string(),
        name: z.string(),
        sha256: z.string(),
        mmPerPx: z.number().nullable(),
        calibrationMethod: z.string().nullable(),
        overlay: z.string().optional(),
      }),
    )
    .max(40),
  calibration: CalibrationInputSchema.nullable(),
  objects: z.array(DraftObjectSchema),
  error: z.string().optional(),
});
export type Draft = z.infer<typeof DraftSchema>;

export const DraftObjectPatchSchema = z.strictObject({
  name: z
    .strictObject({ en: z.string().max(120), ru: z.string().max(120) })
    .partial()
    .optional(),
  status: z.enum(['pending', 'accepted', 'discarded']).optional(),
  /** Replaces the tag list. */
  tags: TagsSchema.optional(),
  /** Class override (`null` forces the generic loft). */
  classId: z.string().nullable().optional(),
  /** Real dimensions typed by the user; they win over the photo scale. */
  dimensionsMm: z
    .strictObject({
      length: z.number().positive().optional(),
      width: z.number().positive().optional(),
      thickness: z.number().positive().optional(),
    })
    .optional(),
});
export type DraftObjectPatch = z.infer<typeof DraftObjectPatchSchema>;
