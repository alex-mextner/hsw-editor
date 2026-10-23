/**
 * Data model of a user (custom) tool: `~/.local/share/hsw-editor/tools/<id>/tool.json`. A custom tool
 * is either a built-in class generator fitted to a photo (`classId` + `params`) or, for unknown objects, a
 * generic loft of the observed width profile (`classId: null`). Colours are stored per part so the model
 * can be rebuilt deterministically from this file alone.
 */
import { z } from 'zod';
import { TagsSchema } from './tags.ts';

export const TOOL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
export const ToolIdSchema = z.string().regex(TOOL_ID_PATTERN);

const hex = z.string().regex(/^#[0-9a-f]{6}$/i);
const finite = z.number().finite();

export const ProfileStationSchema = z.strictObject({
  /** 0 at the first (wide) end, 1 at the far end. */
  t: z.number().min(0).max(1),
  lo: finite,
  hi: finite,
});
export type ProfileStation = z.infer<typeof ProfileStationSchema>;

export const ObservedProfileSchema = z.strictObject({
  lengthMm: z.number().positive(),
  /** Wide end first, lateral extents (mm) either side of the axis. */
  stations: z.array(ProfileStationSchema).min(2).max(200),
});
export type ObservedProfile = z.infer<typeof ObservedProfileSchema>;

export const ColorSegmentSchema = z.strictObject({
  /** Fraction of the observed axis (0 = wide end). */
  t0: z.number().min(0).max(1),
  t1: z.number().min(0).max(1),
  hex,
  weight: z.number().min(0).max(1).default(0),
});
export type ColorSegment = z.infer<typeof ColorSegmentSchema>;

/** `estimated`: the photo had no scale, so the length is the class-typical one (a flagged guess); `user`: typed by the user. */
export const DimensionSourceSchema = z.enum(['photo', 'user', 'estimated']);

export const CustomToolSchema = z.strictObject({
  version: z.literal(1),
  id: ToolIdSchema,
  name: z.strictObject({
    en: z.string().max(120).optional(),
    ru: z.string().max(120).optional(),
  }),
  createdAt: z.string(),
  updatedAt: z.string(),
  /** Free-form library tags (normalised); tool.json files written before tags existed read as []. */
  tags: TagsSchema.default([]),
  /** Built-in class generator the model is built from; null = generic loft of `profile`. */
  classId: z.string().nullable(),
  classCandidates: z
    .array(z.strictObject({ classId: z.string(), score: z.number().min(0).max(1) }))
    .max(10),
  /** Values of the class schema (clamped on build). */
  params: z.record(z.string(), z.union([z.number(), z.string()])),
  /** Observed silhouette profile (kept so the generic loft and re-fits do not need the photo). */
  profile: ObservedProfileSchema.nullable(),
  /** Colour segments sampled from the photo along the observed axis. */
  colors: z.array(ColorSegmentSchema).max(24),
  /** Colour per part name sampled from the photo by the last fit (re-sampled whenever the tool is refitted). */
  partColors: z.record(z.string(), hex),
  /** Part colours the user chose; win over the sampled `partColors` and survive refits. */
  userPartColors: z.record(z.string(), hex).optional(),
  /** Sidecar shape kind of the photo object (`lathe_profile`, `box`, ...): sets the thickness of a generic loft. */
  profileKind: z.string().optional(),
  dimensionsMm: z.strictObject({
    length: z.number().positive(),
    width: z.number().positive(),
    thickness: z.number().positive(),
    source: DimensionSourceSchema,
  }),
  /** Dimensions the user typed, exactly as typed: refits aim at these, not at the (approximate) fitted size. */
  userDimensionsMm: z
    .strictObject({
      length: z.number().positive().optional(),
      width: z.number().positive().optional(),
      thickness: z.number().positive().optional(),
    })
    .optional(),
  fit: z.strictObject({
    method: z.enum(['class-profile', 'generic-loft', 'manual']),
    /** Profile IoU of the fitted model against the observed silhouette (0..1). */
    iou: z.number().min(0).max(1),
    confidence: z.number().min(0).max(1),
    view: z.enum(['front', 'side']),
    /** The observed wide end maps to the far end of the generator axis. */
    flipped: z.boolean(),
    /** Non-uniform scale of the model along Z (thickness) applied after generation; 1 = as generated. */
    zScale: z.number().positive().default(1),
  }),
  sources: z
    .array(
      z.strictObject({
        /** File under `source/` of the tool directory. */
        file: z.string(),
        objectId: z.string().optional(),
        sha256: z.string().optional(),
      }),
    )
    .max(40),
  model: z.strictObject({
    glb: z.string(),
    glbLod1: z.string(),
    thumb: z.string(),
    triangles: z.number().int().nonnegative(),
    bboxMm: z.strictObject({
      min: z.tuple([finite, finite, finite]),
      max: z.tuple([finite, finite, finite]),
    }),
  }),
  notes: z.string().max(2000).optional(),
});
export type CustomTool = z.infer<typeof CustomToolSchema>;

/** What the user may change after import (PATCH). The model is rebuilt from the result. */
export const CustomToolPatchSchema = z.strictObject({
  name: z
    .strictObject({ en: z.string().max(120), ru: z.string().max(120) })
    .partial()
    .optional(),
  classId: z.string().nullable().optional(),
  /** Replaces the tag list. */
  tags: TagsSchema.optional(),
  params: z.record(z.string(), z.union([z.number(), z.string()])).optional(),
  partColors: z.record(z.string(), hex).optional(),
  /** Real dimensions typed by the user; rescales the fit. */
  dimensionsMm: z
    .strictObject({
      length: z.number().positive().optional(),
      width: z.number().positive().optional(),
      thickness: z.number().positive().optional(),
    })
    .optional(),
  notes: z.string().max(2000).optional(),
});
export type CustomToolPatch = z.infer<typeof CustomToolPatchSchema>;
