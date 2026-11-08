import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { EveLanguageModel } from "eve";

// One place to change every agent's model.
//
// Two modes, chosen by environment:
//
// - `FACTORY_MODEL_BASE_URL` set: every agent runs on that OpenAI-compatible
//   server (a local shim, Ollama, LM Studio, vLLM). `FACTORY_MODEL_NAME` is
//   required with it; `FACTORY_MODEL_IMPLEMENTER` and `FACTORY_MODEL_REVIEWER`
//   optionally give the coding station and its reviewer different model names
//   so the review stays independent. `FACTORY_MODEL_API_KEY` is sent when the
//   server requires one, and `FACTORY_MODEL_CONTEXT_TOKENS` (default 64_000)
//   tells eve when to compact, since an OpenAI-compatible server carries no
//   model catalog metadata.
// - Unset: ids are Vercel AI Gateway strings (<provider>/<model>), so routing,
//   credentials, and fallbacks stay on the gateway and no provider SDK is
//   wired in. This is the deployable path; a shim on a LAN is not reachable
//   from a deployment.
//
// Each agent.ts reads its entry here (model: MODELS.<agent>) instead of
// hardcoding a string.

const shimBaseUrl = process.env.FACTORY_MODEL_BASE_URL;
const shimModelName = process.env.FACTORY_MODEL_NAME;

if (shimBaseUrl !== undefined && shimModelName === undefined) {
  throw new Error(
    "FACTORY_MODEL_BASE_URL is set but FACTORY_MODEL_NAME is not (e.g. 'factory-model')."
  );
}

const shim = shimBaseUrl
  ? createOpenAICompatible({
      apiKey: process.env.FACTORY_MODEL_API_KEY,
      baseURL: shimBaseUrl,
      includeUsage: true,
      name: "factory-shim",
    })
  : undefined;

const defaultShimName = shimModelName ?? "";

const pick = (
  gatewayId: string,
  shimName?: string
): EveLanguageModel | string =>
  shim === undefined ? gatewayId : shim(shimName ?? defaultShimName);

export const MODELS = {
  analyst: pick("openai/gpt-5.6-terra-fast"),
  classifier: pick("openai/gpt-5.6-terra-fast"),
  // the station that writes the code gets the strongest coding model
  implementer: pick(
    "anthropic/claude-fable-5",
    process.env.FACTORY_MODEL_IMPLEMENTER
  ),
  orchestrator: pick("openai/gpt-5.6-terra-fast"),
  researcher: pick("openai/gpt-5.6-terra-fast"),
  // different vendor than implementer on purpose: independent review
  reviewer: pick(
    "openai/gpt-5.6-terra-fast",
    process.env.FACTORY_MODEL_REVIEWER ?? process.env.FACTORY_MODEL_IMPLEMENTER
  ),
} as const;

/**
 * Context window to tell eve for shim models; `undefined` under the gateway,
 * where the model catalog supplies it. Set as `modelContextWindowTokens` in
 * each defineAgent.
 */
export const MODEL_CONTEXT_WINDOW_TOKENS: number | undefined =
  shim === undefined
    ? undefined
    : Number.parseInt(process.env.FACTORY_MODEL_CONTEXT_TOKENS ?? "", 10) ||
      64_000;

export type FactoryAgent = keyof typeof MODELS;
