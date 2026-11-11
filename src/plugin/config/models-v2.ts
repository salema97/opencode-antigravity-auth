import { OPENCODE_MODEL_DEFINITIONS, type OpencodeModelDefinition } from "./models.ts"
import type { AvailableModel } from "../quota.ts"
import { registerAdvertisedModelIds } from "../transform/model-resolver.ts"
import { z } from "zod"

export const ModelCatalogCacheSchema = z.object({
  version: z.literal(3),
  identity: z.string(), updatedAt: z.number(),
  accounts: z.record(z.string(), z.array(z.string())),
  models: z.record(z.string(), z.object({
    displayName: z.string().optional(), maxTokens: z.number().positive().optional(), maxOutputTokens: z.number().positive().optional(),
    supportsImages: z.boolean().optional(), supportsThinking: z.boolean().optional(), disabled: z.boolean().optional(), selectable: z.boolean().optional(),
  })),
})

// Used before login or when discovery is unavailable. Once connected, Google's
// catalog replaces this list, including model IDs, names and token limits.
const fallbackModels: Record<string, OpencodeModelDefinition> = Object.fromEntries(
  ["antigravity-gemini-3-flash", "antigravity-claude-sonnet-4-6", "antigravity-claude-opus-4-6-thinking"]
    .flatMap(id => OPENCODE_MODEL_DEFINITIONS[id] ? [[id, OPENCODE_MODEL_DEFINITIONS[id]]] : []),
)
for (const tier of ["low", "medium", "high"]) {
  fallbackModels[`antigravity-gemini-3.8-flash-${tier}`] = {
    name: "Gemini 3.8 Flash",
    limit: { context: 1048576, output: 65536 },
    modalities: { input: ["text", "image", "pdf"], output: ["text"] },
  }
}

export interface V2ModelVariant {
  id: string
  settings?: Record<string, unknown>
  body?: Record<string, unknown>
}

export interface V2ModelDefinition {
  name: string
  package: string
  limit: { context: number; output: number }
  capabilities: { tools: boolean; input: string[]; output: string[] }
  cost: Array<{ input: number; output: number; cache: { read: number; write: number } }>
  variants: V2ModelVariant[]
}

// The provider suffix and parenthetical qualifiers like "(Medium)" or
// "(Thinking)" repeat what the model ID already says.
const NAME_NOISE = /\s*\((?:antigravity|low|medium|high|thinking)\)/gi

function cleanModelName(name: string): string {
  return name.replace(NAME_NOISE, "").replace(/\s{2,}/g, " ").trim()
}

function definition(model: OpencodeModelDefinition): V2ModelDefinition {
  return {
    name: cleanModelName(model.name),
    package: "aisdk:@ai-sdk/google",
    limit: { ...model.limit },
    capabilities: { tools: true, ...model.modalities },
    cost: [{ input: 0, output: 0, cache: { read: 0, write: 0 } }],
    variants: Object.entries(model.variants ?? {}).map(([id, settings]) => ({
      id,
      settings: settings.thinkingLevel
        ? { thinkingConfig: { thinkingLevel: settings.thinkingLevel } }
        : { ...settings },
    })),
  }
}

const FALLBACK_V2_MODEL_DEFINITIONS: Record<string, V2ModelDefinition> = Object.fromEntries(
  Object.entries(fallbackModels).map(([id, model]) => [id, definition(model)]),
)
export type V2ModelDefinitions = Record<string, V2ModelDefinition>

// Exclude completion/internal, image-generation, tier routers and explicitly
// disabled entries. They are not selectable chat models.
function selectable(id: string, model: AvailableModel): boolean {
  return /^(gemini-|claude-|gpt-oss-)/.test(id) && !/image|imagen|-(disabled|tiered)$/.test(id) && !model.disabled && model.selectable !== false
}

/** Catalog IDs that become selectable models, before tier grouping. */
export function selectableModelIDs(models: Record<string, AvailableModel>): string[] {
  return Object.entries(models).filter(([id, model]) => selectable(id, model)).map(([id]) => id)
}

/** Body key that carries the selected variant's tier to the transport. */
export const TIER_BODY_MARKER = "__antigravityTier"

const TIER_SUFFIX = /^(.*)-(low|medium|high)$/
const TIER_ORDER = ["low", "medium", "high"] as const

export interface TierVariantGroup {
  readonly tiers: readonly string[]
  readonly defaultTier: string
}

const tierVariantGroups = new Map<string, TierVariantGroup>()

/** Grouped base model key (with the `antigravity-` prefix) and its tiers. */
export function tierVariantGroup(modelKey: string): TierVariantGroup | undefined {
  return tierVariantGroups.get(modelKey)
}

/** Rewrites a grouped base key to the requested tier, or the default tier. */
export function tieredModelKey(modelKey: string, tier?: string): string {
  const group = tierVariantGroups.get(modelKey)
  if (!group) return modelKey
  return `${modelKey}-${tier && group.tiers.includes(tier) ? tier : group.defaultTier}`
}

/**
 * Collapses `-low`/`-medium`/`-high` catalog IDs into one base model whose
 * variants carry the tier in a body marker; the transport restores the real
 * tiered ID before the request leaves. Families with a bare base ID, or with a
 * single tier, keep their own entries.
 */
function groupTierVariants(definitions: V2ModelDefinitions): V2ModelDefinitions {
  tierVariantGroups.clear()
  const grouped: V2ModelDefinitions = { ...definitions }
  const tiersByBase = new Map<string, Set<string>>()
  for (const key of Object.keys(definitions)) {
    const match = TIER_SUFFIX.exec(key)
    if (!match?.[1] || !match[2]) continue
    const tiers = tiersByBase.get(match[1]) ?? new Set<string>()
    tiersByBase.set(match[1], tiers)
    tiers.add(match[2])
  }
  for (const [base, found] of tiersByBase) {
    const tiers = TIER_ORDER.filter(tier => found.has(tier))
    if (tiers.length < 2 || definitions[base]) continue
    const defaultTier = tiers.includes("medium") ? "medium" : tiers[0]!
    const source = definitions[`${base}-${defaultTier}`]!
    grouped[base] = {
      ...source,
      variants: tiers.map(tier => ({ id: tier, body: { [TIER_BODY_MARKER]: tier } })),
    }
    tierVariantGroups.set(base, { tiers, defaultTier })
    for (const tier of tiers) delete grouped[`${base}-${tier}`]
  }
  return grouped
}

export const OPENCODE_V2_MODEL_DEFINITIONS = groupTierVariants(FALLBACK_V2_MODEL_DEFINITIONS)

export function buildAccountModelDefinitions(models: Record<string, AvailableModel>): V2ModelDefinitions {
  const definitions: V2ModelDefinitions = {}
  for (const [id, model] of Object.entries(models)) {
    if (!selectable(id, model)) continue
    const key = `antigravity-${id}`
    const known = OPENCODE_MODEL_DEFINITIONS[key]
    definitions[key] = definition({
      name: model.displayName ?? id,
      limit: {
        context: model.maxTokens ?? known?.limit.context ?? 200000,
        output: model.maxOutputTokens ?? known?.limit.output ?? 64000,
      },
      modalities: { input: model.supportsImages === false ? ["text"] : ["text", "image", "pdf"], output: ["text"] },
      variants: known?.variants,
    })
  }
  registerAdvertisedModelIds(Object.keys(models))
  return groupTierVariants(definitions)
}
