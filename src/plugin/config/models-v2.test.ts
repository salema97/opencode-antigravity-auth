import { describe, expect, it } from "vitest"
import { OPENCODE_V2_MODEL_DEFINITIONS, TIER_BODY_MARKER, buildAccountModelDefinitions, tierVariantGroup, tieredModelKey } from "./models-v2"
import { resolveModelForHeaderStyle } from "../transform/model-resolver"

describe("OpenCode V2 models", () => {
  it("registers tools, modalities, and V2 variant overlays", () => {
    expect(OPENCODE_V2_MODEL_DEFINITIONS["gemini-2.5-flash"]).toBeUndefined()
    expect(OPENCODE_V2_MODEL_DEFINITIONS["antigravity-gemini-3-flash"]).toMatchObject({
      package: "aisdk:@ai-sdk/google",
      capabilities: { tools: true, input: ["text", "image", "pdf"], output: ["text"] },
      variants: expect.arrayContaining([{ id: "high", settings: { thinkingConfig: { thinkingLevel: "high" } } }]),
    })
    expect(OPENCODE_V2_MODEL_DEFINITIONS["antigravity-claude-opus-4-6-thinking"]?.variants).toContainEqual({
      id: "max", settings: { thinkingConfig: { thinkingBudget: 32768 } },
    })
  })

  it("uses account metadata and preserves backend tiers while filtering unavailable models", () => {
    const catalog = buildAccountModelDefinitions({
      "claude-opus-5-5-high": { displayName: "Claude Opus 5.5 High", maxTokens: 1000000, maxOutputTokens: 128000 },
      "gemini-3.9-flash-medium": { displayName: "Gemini 3.9 Flash (Medium)", maxTokens: 1048576, maxOutputTokens: 65536 },
      "gemini-4-argon-disabled": { disabled: true },
      "gemini-3.8-flash-tiered": {},
      "gemini-3.1-flash-image": {},
      "gemini-2.5-pro": { selectable: false },
      "tab_flash_lite_preview": {},
    })
    expect(Object.keys(catalog)).toEqual(["antigravity-claude-opus-5-5-high", "antigravity-gemini-3.9-flash-medium"])
    expect(catalog["antigravity-claude-opus-5-5-high"]).toMatchObject({
      limit: { context: 1000000, output: 128000 },
      cost: [{ input: 0, output: 0, cache: { read: 0, write: 0 } }],
      variants: [],
    })
    expect(resolveModelForHeaderStyle("antigravity-gemini-3.9-flash-medium", "antigravity").actualModel).toBe("gemini-3.9-flash-medium")
    expect(OPENCODE_V2_MODEL_DEFINITIONS["antigravity-gemini-3.8-flash-high"]).toBeUndefined()
    expect(OPENCODE_V2_MODEL_DEFINITIONS["antigravity-gemini-3.8-flash"]).toMatchObject({
      name: "Gemini 3.8 Flash",
      variants: [
        { id: "low", body: { [TIER_BODY_MARKER]: "low" } },
        { id: "medium", body: { [TIER_BODY_MARKER]: "medium" } },
        { id: "high", body: { [TIER_BODY_MARKER]: "high" } },
      ],
    })
  })

  it("groups tier families into one model with tier variants and keeps single tiers whole", () => {
    const catalog = buildAccountModelDefinitions({
      "gemini-4-argon-low": { displayName: "Gemini 4 Argon (Low)", maxTokens: 1048576, maxOutputTokens: 65536 },
      "gemini-4-argon-medium": { displayName: "Gemini 4 Argon (Medium)", maxTokens: 1048576, maxOutputTokens: 65536 },
      "gemini-4-argon-high": { displayName: "Gemini 4 Argon (High)", maxTokens: 1048576, maxOutputTokens: 65536 },
      "claude-opus-5-5-high": { displayName: "Claude Opus 5.5 (High)" },
      "gpt-oss-120b-medium": { displayName: "GPT-OSS 120B (Medium)" },
    })

    expect(Object.keys(catalog)).toEqual([
      "antigravity-claude-opus-5-5-high",
      "antigravity-gpt-oss-120b-medium",
      "antigravity-gemini-4-argon",
    ])
    expect(catalog["antigravity-gemini-4-argon"]?.name).toBe("Gemini 4 Argon")
    expect(catalog["antigravity-gpt-oss-120b-medium"]?.name).toBe("GPT-OSS 120B")
    expect(catalog["antigravity-claude-opus-5-5-high"]?.name).toBe("Claude Opus 5.5")
    expect(catalog["antigravity-gemini-4-argon"]?.variants).toEqual([
      { id: "low", body: { [TIER_BODY_MARKER]: "low" } },
      { id: "medium", body: { [TIER_BODY_MARKER]: "medium" } },
      { id: "high", body: { [TIER_BODY_MARKER]: "high" } },
    ])
    expect(tierVariantGroup("antigravity-gemini-4-argon")).toEqual({ tiers: ["low", "medium", "high"], defaultTier: "medium" })
    expect(tierVariantGroup("antigravity-gpt-oss-120b-medium")).toBeUndefined()
  })

  it("resolves a grouped base key to the requested or default tier", () => {
    buildAccountModelDefinitions({
      "gemini-4-argon-low": {},
      "gemini-4-argon-high": {},
    })
    expect(tieredModelKey("antigravity-gemini-4-argon", "high")).toBe("antigravity-gemini-4-argon-high")
    expect(tieredModelKey("antigravity-gemini-4-argon")).toBe("antigravity-gemini-4-argon-low")
    expect(tieredModelKey("antigravity-gemini-4-argon", "bogus")).toBe("antigravity-gemini-4-argon-low")
    expect(tieredModelKey("antigravity-gpt-oss-120b-medium")).toBe("antigravity-gpt-oss-120b-medium")
  })
})
