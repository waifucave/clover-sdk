// HOW STRONG EACH MODEL IS, BY HAND (the owner's ruling, 2026-11-12: "this strength should be manually set for each
// model not based on the slots").
//
// One line per canonical model id in the catalog (`WinterModelDescriptor.canonicalModelId`), so the same model on
// another provider has the same class with no second entry. A family's slots are NOT a strength claim (types.ts, D26),
// and no name or size rule decides a class here: every line was looked at and set by hand. Where the class was not
// clear, the lower one was chosen and the line ends in `// unsure`, so the owner can find them.
//
// What the class is for: the file tools' read-before-edit rule (runtime `tools/impl/read-ladder.ts`). A strong or
// medium model may edit what it hasn't read; a weak one must have read the lines it edits since the file last
// changed. A model with no entry (a custom or local model, or a third-party plugin's row that states none) is weak.
//
// The catalog's assemblers stamp each row's `strength` from this table (`stampFamilyFields`); a row that states its
// own `strength` keeps it. `model-strength.test.ts` holds this table to the catalog: every canonical id has a line,
// no line names a model the catalog doesn't have, and the counts are pinned.
import type { ModelStrength } from "./types.ts";

export const MODEL_STRENGTH: Readonly<Record<string, ModelStrength>> = {
  // ---- claude
  "claude-3.5-sonnet-20241022": "medium",
  "claude-3.7-sonnet": "medium",
  "claude-3.7-sonnet-20250514": "medium",
  "claude-4-sonnet": "medium",
  "claude-fable-5": "strong",
  "claude-fable-5.1": "strong",
  "claude-haiku-4.5": "weak",
  "claude-haiku-4.5-20251001": "weak",
  "claude-haiku-5.5": "weak",
  "claude-opus-4.5": "strong",
  "claude-opus-4.6": "strong",
  "claude-opus-4.7": "strong",
  "claude-opus-4.8": "strong",
  "claude-opus-4.8-thinking": "strong",
  "claude-opus-5": "strong",
  "claude-opus-5-thinking": "strong",
  "claude-opus-5.5": "strong",
  "claude-sonnet-4.5": "medium",
  "claude-sonnet-4.6": "medium",
  "claude-sonnet-5": "medium",
  "claude-sonnet-5.5": "medium",
  // ---- command
  "command-a-03-2025": "medium", // unsure
  "command-a-plus-05-2026": "medium", // unsure
  "command-a-reasoning-08-2025": "medium", // unsure
  "command-a-vision-07-2025": "weak", // unsure
  "command-r-08-2024": "weak", // unsure
  "command-r-plus-08-2024": "weak", // unsure
  "command-r7b-12-2024": "weak", // unsure
  // ---- deepseek
  "deepseek-chat": "medium",
  "deepseek-flash": "medium",
  "deepseek-r1": "medium",
  "deepseek-r1-0528": "medium",
  "deepseek-reasoner": "medium",
  "deepseek-v3": "medium",
  "deepseek-v3-0324": "medium",
  "deepseek-v3.1": "medium",
  "deepseek-v3.2": "medium",
  "deepseek-v3.2-tee": "medium",
  "deepseek-v4-1-flash": "medium",
  "deepseek-v4-flash": "medium",
  "deepseek-v4-flash-0731": "medium",
  "deepseek-v4-flash-0731-tee": "medium",
  "deepseek-v4-flash-202605": "medium",
  "deepseek-v4-flash-ga-260731": "medium",
  "deepseek-v4-flash-vision-exp": "medium", // unsure
  "deepseek-v4-pro": "strong",
  "deepseek-v4-pro-0813": "strong",
  "deepseek-v4-pro-202606": "strong",
  "deepseek-v4-pro-260425": "strong",
  "deepseek-v4.1-flash": "medium",
  "deepseek-v4.1-flash-1017": "medium",
  // ---- ernie
  "ernie-3.5-8k": "weak",
  "ernie-4.0-8k": "weak",
  "ernie-4.0-turbo-128k": "weak",
  "ernie-4.0-turbo-8k": "weak",
  "ernie-4.5-0.3b": "weak",
  "ernie-4.5-21b-a3b": "weak",
  "ernie-4.5-turbo-128k": "weak",
  "ernie-4.5-turbo-20260402": "weak",
  "ernie-4.5-turbo-32k": "weak",
  "ernie-4.5-turbo-vl": "weak",
  "ernie-4.5-turbo-vl-32k": "weak",
  "ernie-5.0": "medium", // unsure
  "ernie-5.0-thinking-exp": "medium", // unsure
  "ernie-5.0-thinking-latest": "medium", // unsure
  "ernie-5.0-thinking-preview": "medium", // unsure
  "ernie-5.1": "medium", // unsure
  "ernie-lite-8k": "weak",
  "ernie-speed-128k": "weak",
  "ernie-speed-8k": "weak",
  "ernie-tiny-8k": "weak",
  "ernie-x1.1": "medium", // unsure
  // ---- gemini
  "gemini-1.5-pro": "medium",
  "gemini-2.0-flash": "weak", // unsure
  "gemini-2.0-flash-exp": "weak", // unsure
  "gemini-2.5-flash": "medium",
  "gemini-2.5-flash-lite": "weak",
  "gemini-2.5-pro": "strong",
  "gemini-3-flash-preview": "medium",
  "gemini-3.1-flash-lite": "weak",
  "gemini-3.1-flash-lite-preview": "weak",
  "gemini-3.1-pro": "strong",
  "gemini-3.1-pro-preview": "strong",
  "gemini-3.5-flash": "medium",
  "gemini-3.5-flash-lite": "weak",
  "gemini-3.6-flash": "medium",
  "gemini-3.7-flash": "strong",
  "gemini-3.8-flash": "strong",
  "gemini-3.8-flash-cyber": "strong", // unsure
  "gemini-4-argon": "strong", // unsure
  // ---- gemma
  "gemma-2-2b-it": "weak",
  "gemma-2-9b-it": "weak",
  "gemma-3-12b-it": "weak",
  "gemma-3-27b-it": "weak",
  "gemma-3-4b-it": "weak",
  "gemma-3-4b-pt": "weak",
  "gemma-3n-e2b-it": "weak",
  "gemma-4-26b-a4b-it": "weak",
  "gemma-4-31b": "weak", // unsure
  "gemma-4-31b-it": "weak", // unsure
  "gemma-4-31b-it-turbo": "weak", // unsure
  "gemma-4-31b-it-ultra": "weak", // unsure
  "gemma-4-31b-turbo-tee": "weak", // unsure
  // ---- glm
  "glm-4-32b-0414-128k": "weak",
  "glm-4-flash": "weak",
  "glm-4.5": "medium",
  "glm-4.5-air": "medium", // unsure
  "glm-4.5-airx": "medium", // unsure
  "glm-4.5-x": "medium",
  "glm-4.6": "medium",
  "glm-4.6v-flash": "weak",
  "glm-4.7": "medium",
  "glm-4.7-flash": "weak",
  "glm-4.7-flashx": "weak",
  "glm-5": "strong",
  "glm-5-turbo": "medium", // unsure
  "glm-5.1": "strong",
  "glm-5.1-fp8": "strong",
  "glm-5.1-tee": "strong",
  "glm-5.2": "strong",
  "glm-5.2-260617": "strong",
  "glm-5.2-fast-preview": "strong",
  "glm-5.2-tee": "strong",
  "glm-5.3": "strong",
  "glm-5.3-flash": "medium",
  "glm-5.3-flashx": "medium",
  "glm-5p1": "strong",
  "glm-5p3": "strong",
  // ---- gpt
  "gpt-4": "medium", // unsure
  "gpt-4.1": "medium",
  "gpt-4.1-mini": "weak",
  "gpt-4.1-nano": "weak",
  "gpt-4.1-nano-2025-04-14": "weak",
  "gpt-4o": "medium",
  "gpt-4o-2024-11-20": "medium",
  "gpt-4o-mini": "weak",
  "gpt-4o-mini-2024-07-18": "weak",
  "gpt-5": "strong",
  "gpt-5-codex": "strong",
  "gpt-5-mini": "weak", // unsure
  "gpt-5-nano": "weak",
  "gpt-5-pro": "strong",
  "gpt-5.1": "strong",
  "gpt-5.1-codex": "strong",
  "gpt-5.1-codex-max": "strong",
  "gpt-5.1-codex-mini": "weak", // unsure
  "gpt-5.2": "strong",
  "gpt-5.2-codex": "strong",
  "gpt-5.2-pro": "strong",
  "gpt-5.3-codex": "strong",
  "gpt-5.4": "strong",
  "gpt-5.4-mini": "weak", // unsure
  "gpt-5.4-nano": "weak",
  "gpt-5.4-pro": "strong",
  "gpt-5.5": "strong",
  "gpt-5.5-pro": "strong",
  "gpt-5.6": "strong",
  "gpt-5.6-luna": "medium",
  "gpt-5.6-sol": "strong",
  "gpt-5.6-terra": "strong",
  "gpt-6-astra": "strong",
  "gpt-6-luna": "medium",
  "gpt-6-sol": "strong",
  "gpt-6.1-sol": "strong",
  "gpt-6.1-terra": "strong",
  "gpt-chat-latest": "medium", // unsure
  // ---- gpt-oss
  "gpt-oss-120b": "medium",
  "gpt-oss-120b-turbo": "medium",
  "gpt-oss-120b-ultra": "medium",
  "gpt-oss-20b": "weak",
  "gpt-oss-safeguard-20b": "weak",
  // ---- grok
  "grok-2-1212": "weak", // unsure
  "grok-3": "medium",
  "grok-4.1-fast": "medium",
  "grok-4.20": "strong",
  "grok-4.20-0309-non-reasoning": "medium",
  "grok-4.20-0309-reasoning": "strong",
  "grok-4.20-multi-agent-0309": "strong",
  "grok-4.3": "strong",
  "grok-4.5": "strong",
  "grok-4.6": "strong",
  "grok-4.7": "strong",
  "grok-build-0.1": "medium", // unsure
  // ---- hunyuan
  "hunyuan-functioncall": "weak",
  "hunyuan-lite": "weak",
  "hunyuan-pro": "weak",
  "hunyuan-role-latest": "weak",
  "hunyuan-t1-latest": "medium", // unsure
  "hunyuan-turbos-latest": "medium", // unsure
  "hunyuan-vision": "weak",
  "hy3": "medium", // unsure
  "hy4-preview": "medium", // unsure
  // ---- kimi
  "k3": "strong",
  "k3.1-pro": "strong",
  "k3.1-pro-highspeed": "strong",
  "kimi-for-coding": "medium", // unsure
  "kimi-for-coding-highspeed": "medium", // unsure
  "kimi-k2": "medium",
  "kimi-k2-thinking": "medium",
  "kimi-k2.5": "medium",
  "kimi-k2.6": "medium",
  "kimi-k2.6-tee": "medium",
  "kimi-k2.7-code": "medium",
  "kimi-k2.7-code-highspeed": "medium",
  "kimi-k2p5": "medium",
  "kimi-k2p6": "medium",
  "kimi-k3": "strong",
  "kimi-k3-eco": "medium", // unsure
  "kimi-k3-tee": "strong",
  "kimi-k3.1-pro": "strong",
  "kimi-k3.1-pro-highspeed": "strong",
  // ---- llama
  "llama-3-8b-instruct": "weak",
  "llama-3.1-405b": "medium", // unsure
  "llama-3.1-70b-instruct": "weak",
  "llama-3.1-8b-instruct": "weak",
  "llama-3.1-nemoguard-8b-content-safety": "weak",
  "llama-3.1-nemoguard-8b-topic-control": "weak",
  "llama-3.2-11b-instruct": "weak",
  "llama-3.2-11b-vision-instruct": "weak",
  "llama-3.2-1b-instruct": "weak",
  "llama-3.2-3b-instruct": "weak",
  "llama-3.2-90b-vision-instruct": "weak",
  "llama-3.3-70b-instruct": "weak",
  "llama-3.3-70b-instruct-turbo": "weak",
  "llama-3.3-70b-versatile": "weak",
  "llama-4-maverick": "medium", // unsure
  "llama-4-maverick-17b-128e-instruct": "medium", // unsure
  "llama-4-scout": "weak",
  "llama-4-scout-17b-16e-instruct": "weak",
  "llama-guard-4-12b": "weak",
  // ---- mimo
  "mimo-v2.5": "medium", // unsure
  "mimo-v2.5-pro": "medium", // unsure
  "mimo-v2.6-flash": "weak", // unsure
  "mimo-v2.6-pro": "medium", // unsure
  "mimo-v2.6-pro-ultraspeed": "medium", // unsure
  // ---- minimax
  "minimax-m2": "medium",
  "minimax-m2.1": "medium",
  "minimax-m2.1-highspeed": "medium",
  "minimax-m2.5": "medium",
  "minimax-m2.5-highspeed": "medium",
  "minimax-m2.7": "medium",
  "minimax-m2.7-highspeed": "medium",
  "minimax-m2p5": "medium",
  "minimax-m2p7": "medium",
  "minimax-m3": "medium", // unsure
  "minimax-m3.1-flash": "weak", // unsure
  // ---- mistral
  "codestral-2508": "medium", // unsure
  "codestral-latest": "medium", // unsure
  "devstral-2-123b-instruct-2512": "medium",
  "devstral-latest": "medium",
  "ministral-14b-2512": "weak",
  "ministral-14b-instruct-2512": "weak",
  "ministral-3b-2512": "weak",
  "ministral-8b-2512": "weak",
  "mistral-7b": "weak",
  "mistral-7b-instruct": "weak",
  "mistral-large": "medium",
  "mistral-large-2512": "medium",
  "mistral-large-3-675b-instruct-2512": "medium",
  "mistral-large-latest": "medium",
  "mistral-large2": "medium",
  "mistral-medium-3.1": "medium",
  "mistral-medium-3.5": "medium",
  "mistral-medium-3.5-128b": "medium",
  "mistral-medium-latest": "medium",
  "mistral-nemo-instruct-2407": "weak",
  "mistral-small-24b-instruct-2501": "weak",
  "mistral-small-2603": "weak",
  "mistral-small-3.2-24b-instruct-2506": "weak",
  "mistral-small-4-119b-2603": "weak", // unsure
  "mistral-small-latest": "weak",
  // ---- muse
  "muse-glimmer-30b": "weak", // unsure
  "muse-spark-1.1": "medium", // unsure
  "muse-spark-1.2": "medium", // unsure
  "muse-spark-1.2-contributor": "medium", // unsure
  "muse-spark-1.3": "medium", // unsure
  "muse-spark-1.3-contributor": "medium", // unsure
  "muse-spark-open": "weak", // unsure
  // ---- nemotron
  "llama-3.1-nemotron-nano-8b-v1": "weak",
  "llama-3.1-nemotron-nano-vl-8b-v1": "weak",
  "llama-3.1-nemotron-safety-guard-8b-v3": "weak",
  "llama-3.3-nemotron-super-49b-v1": "weak", // unsure
  "llama-3.3-nemotron-super-49b-v1.5": "weak", // unsure
  "mistral-nemotron": "weak", // unsure
  "nemotron-3-content-safety": "weak",
  "nemotron-3-nano-30b-a3b": "weak",
  "nemotron-3-nano-omni-30b-a3b-reasoning": "weak",
  "nemotron-3-nano-omni-30b-tee": "weak",
  "nemotron-3-super": "medium", // unsure
  "nemotron-3-super-120b-a12b": "medium", // unsure
  "nemotron-3-ultra": "medium", // unsure
  "nemotron-3-ultra-550b-a55b": "medium", // unsure
  "nemotron-3.5-content-safety": "weak",
  "nemotron-3.5-lightning": "weak",
  "nemotron-3.5-lightning-30b-a3b": "weak",
  "nemotron-3.5-super-vl": "medium", // unsure
  "nemotron-3.5-super-vl-120b-a12b": "medium", // unsure
  "nemotron-mini-4b-instruct": "weak",
  "nemotron-nano-12b-v2-vl": "weak",
  "nvidia-nemotron-3-super-120b-a12b": "medium", // unsure
  "nvidia-nemotron-3-super-120b-a12b-nvfp4": "medium", // unsure
  "nvidia-nemotron-3-ultra-550b-a55b": "medium", // unsure
  "nvidia-nemotron-3.5-lightning": "weak",
  "nvidia-nemotron-nano-9b-v2": "weak",
  // ---- nova
  "amazon.nova-2-lite": "weak",
  "amazon.nova-lite": "weak",
  "amazon.nova-micro": "weak",
  "amazon.nova-premier": "medium",
  "amazon.nova-pro": "medium", // unsure
  // ---- o-series
  "o1": "strong",
  "o1-mini": "weak", // unsure
  "o3": "strong",
  "o3-mini": "medium",
  "o3-pro": "strong",
  "o4-mini": "medium",
  // ---- qwen
  "qwen-3.8-27b": "weak", // unsure
  "qwen-max": "medium", // unsure
  "qwen-plus": "medium",
  "qwen-turbo": "weak",
  "qwen2.5-72b-instruct": "weak",
  "qwen2.5-7b-instruct": "weak",
  "qwen2.5-coder-32b-instruct": "weak",
  "qwen2.5-vl-72b-instruct": "weak",
  "qwen3-1.7b-base": "weak",
  "qwen3-14b": "weak",
  "qwen3-235b-a22b-instruct-2507": "medium",
  "qwen3-235b-a22b-thinking-2507-tee": "medium",
  "qwen3-30b-a3b": "weak",
  "qwen3-32b": "weak",
  "qwen3-32b-tee": "weak",
  "qwen3-4b-base": "weak",
  "qwen3-8b": "weak",
  "qwen3-coder-480b-a35b-instruct": "medium",
  "qwen3-coder-480b-a35b-instruct-turbo": "medium",
  "qwen3-coder-next": "medium", // unsure
  "qwen3-coder-plus": "medium",
  "qwen3-max": "strong", // unsure
  "qwen3-max-2026-01-23": "strong", // unsure
  "qwen3-max-thinking": "strong", // unsure
  "qwen3-next-80b-a3b-instruct": "weak", // unsure
  "qwen3-vl-235b-a22b-instruct": "medium", // unsure
  "qwen3-vl-30b-a3b-instruct": "weak",
  "qwen3-vl-flash": "weak",
  "qwen3-vl-plus": "medium", // unsure
  "qwen3.5-122b-a10b": "medium", // unsure
  "qwen3.5-27b": "weak", // unsure
  "qwen3.5-35b-a3b": "weak",
  "qwen3.5-397b": "medium",
  "qwen3.5-397b-a17b": "medium",
  "qwen3.5-397b-a17b-tee": "medium",
  "qwen3.5-9b": "weak",
  "qwen3.5-plus": "medium",
  "qwen3.5-plus-2026-04-20": "medium",
  "qwen3.6-27b": "weak", // unsure
  "qwen3.6-27b-tee": "weak", // unsure
  "qwen3.6-35b-a3b": "weak",
  "qwen3.6-flash": "weak", // unsure
  "qwen3.6-plus": "medium",
  "qwen3.7-flash": "weak", // unsure
  "qwen3.7-max": "strong",
  "qwen3.7-max-2026-06-08": "strong",
  "qwen3.7-plus": "medium",
  "qwen3.8-2.4t-a95b": "strong", // unsure
  "qwen3.8-27b": "weak", // unsure
  "qwen3.8-27b-tee": "weak", // unsure
  "qwen3.8-flash": "weak", // unsure
  "qwen3.8-max": "strong",
  "qwen3.8-max-0902": "strong",
  "qwen3.8-omni-flash": "weak",
  "qwen3p6-plus": "medium",
  "qwen3p8-max": "strong",
  // ---- other
  "4.0ultra": "weak", // unsure
  "@cf/aisingapore/gemma-sea-lion-v4-27b-it": "weak",
  "@cf/deepseek-ai/deepseek-r1-distill-qwen-32b": "weak", // unsure
  "@cf/deepseek-ai/deepseek-v4-flash-0731": "medium",
  "@cf/deepseek-ai/deepseek-v4-pro-0813": "strong",
  "@cf/google/gemma-4-26b-a4b-it": "weak",
  "@cf/ibm-granite/granite-4.0-h-micro": "weak", // unsure
  "@cf/meta/llama-3.1-8b-instruct-fp8": "weak",
  "@cf/meta/llama-3.2-11b-vision-instruct": "weak",
  "@cf/meta/llama-3.2-1b-instruct": "weak",
  "@cf/meta/llama-3.2-3b-instruct": "weak",
  "@cf/meta/llama-3.3-70b-instruct-fp8-fast": "weak",
  "@cf/meta/llama-4-scout-17b-16e-instruct": "weak",
  "@cf/mistralai/mistral-small-3.1-24b-instruct": "weak",
  "@cf/moonshotai/kimi-k2.6": "medium",
  "@cf/moonshotai/kimi-k2.7-code": "medium",
  "@cf/nvidia/nemotron-3-120b-a12b": "medium", // unsure
  "@cf/openai/gpt-oss-120b": "medium",
  "@cf/openai/gpt-oss-20b": "weak",
  "@cf/qwen/qwen2.5-coder-32b-instruct": "weak",
  "@cf/qwen/qwen3-30b-a3b-fp8": "weak",
  "@cf/qwen/qwen3.8-27b": "weak", // unsure
  "@cf/qwen/qwq-32b": "weak",
  "@cf/zai-org/glm-4.7-flash": "weak",
  "@cf/zai-org/glm-5.2": "strong",
  "@cf/zai-org/glm-5.3": "strong",
  "@cf/zai-org/glm-5.3-flash": "medium",
  "abacusai/dracarys-llama-3.1-70b-instruct": "weak",
  "adamo1139/hermes-3-llama-3.1-8b-fp8-dynamic": "weak",
  "agnes-1.5-flash": "weak", // unsure
  "agnes-2.0-flash": "weak", // unsure
  "agnes-2.5-flash": "weak", // unsure
  "aisingapore/qwen-sea-lion-v4.5-27b-it": "weak", // unsure
  "auto": "weak", // unsure
  "auto:free": "weak", // unsure
  "baichuan3-turbo": "weak", // unsure
  "baichuan3-turbo-128k": "weak", // unsure
  "baichuan4": "weak", // unsure
  "baichuan4-air": "weak", // unsure
  "baichuan4-turbo": "weak", // unsure
  "big-pickle": "weak", // unsure
  "bytedance-seed/seed-2.1-turbo": "weak", // unsure
  "bytedance/seed-1.8": "weak", // unsure
  "bytedance/seed-2.0-code": "medium", // unsure
  "bytedance/seed-2.0-mini": "weak",
  "bytedance/seed-2.0-pro": "medium", // unsure
  "chatdolphin": "weak", // unsure
  "codex-mini": "weak", // unsure
  "cohere/command-a-plus": "medium", // unsure
  "dgridai/free": "weak", // unsure
  "dolphin": "weak", // unsure
  "doubao-1.5-pro-32k-250115": "weak", // unsure
  "doubao-pro-32k": "weak", // unsure
  "doubao-seed-1.6-251015": "weak", // unsure
  "doubao-seed-1.6-flash-250828": "weak",
  "doubao-seed-1.8-251228": "weak", // unsure
  "doubao-seed-2.0-code-preview-260215": "medium", // unsure
  "doubao-seed-2.0-lite": "weak",
  "doubao-seed-2.0-lite-260215": "weak",
  "doubao-seed-2.0-mini-260215": "weak",
  "doubao-seed-2.0-pro-260215": "medium", // unsure
  "doubao-seed-2.1-pro-260628": "medium", // unsure
  "doubao-seed-2.1-pro-260915": "medium", // unsure
  "doubao-seed-2.1-turbo": "weak", // unsure
  "doubao-seed-2.1-turbo-260628": "weak", // unsure
  "doubao-seed-evolving": "weak", // unsure
  "elorian/glimpse": "weak", // unsure
  "finetuned-llama-3-70b": "weak",
  "fireworks/ember-1": "weak", // unsure
  "gemma4-31b": "weak", // unsure
  "generalv3": "weak", // unsure
  "generalv3.5": "weak", // unsure
  "gryphe/mythomax-l2-13b": "weak",
  "hcx-005": "weak", // unsure
  "hcx-007": "weak", // unsure
  "hermes-4-405b": "medium", // unsure
  "hermes-4-70b": "weak",
  "huggingfacetb/smollm3-3b-base": "weak",
  "hy-role": "weak",
  "hyper/auto": "weak", // unsure
  "ibm-granite/granite-4.2-30b": "weak", // unsure
  "ibm-granite/granite-4.2-3b": "weak", // unsure
  "ibm-granite/granite-4.2-8b": "weak", // unsure
  "inception/mercury-2.5": "weak", // unsure
  "inception/mercury-3": "weak", // unsure
  "inclusionai/ling-3.0-flash": "weak", // unsure
  "inclusionai/ling-3.0-flash-fin": "weak", // unsure
  "inclusionai/ling-3.0-flash-vl": "weak", // unsure
  "inclusionai/ling-3.1-flash": "weak", // unsure
  "intern-latest": "weak", // unsure
  "intern-s1": "weak", // unsure
  "intern-s1-mini": "weak", // unsure
  "intern-s1-pro": "medium", // unsure
  "internvl3.5-latest": "weak", // unsure
  "ising-calibration-1-35b-a3b": "weak",
  "k3-256k": "strong",
  "ling-2.6-1t": "medium", // unsure
  "ling-2.6-flash": "weak", // unsure
  "ling-3.0-flash": "weak", // unsure
  "ling-3.0-flash-vl": "weak", // unsure
  "ling-3.1-flash": "weak", // unsure
  "liquid-lfm-40b": "weak", // unsure
  "liquid/lfm-2.5-2.6b": "weak", // unsure
  "liquid/lfm-2.5-24b-a2b": "weak", // unsure
  "lite": "weak", // unsure
  "llama3-3-70b": "weak",
  "llama3.1-405b": "medium", // unsure
  "llama3.1-70b": "weak",
  "llama3.1-8b": "weak",
  "llama4-maverick": "medium", // unsure
  "longcat-2.0": "medium", // unsure
  "max-32k": "weak", // unsure
  "meituan/longcat-2.0": "medium", // unsure
  "mercury-2": "weak", // unsure
  "mercury-2.5": "weak", // unsure
  "mercury-3": "weak", // unsure
  "meta-llama-3.1-70b-instruct-turbo": "weak",
  "meta-llama-3.1-8b-instruct-turbo": "weak",
  "meta-llama-3_3-70b-instruct": "weak",
  "meta-models/muse-glimmer-30b": "weak", // unsure
  "microsoft/phi-4": "weak", // unsure
  "minimaxai/minimax-m2.7": "medium",
  "minimaxai/minimax-m2.7-turbo": "medium",
  "minimaxai/minimax-m3": "medium", // unsure
  "mixtral-8x7b-instruct-v0.1": "weak",
  "moondream/moondream3.1-9b-a2b": "weak", // unsure
  "nex-agi/nex-n2.5-mini": "weak", // unsure
  "nex-agi/nex-n2.5-pro": "weak", // unsure
  "nousresearch/hermes-3-llama-3.1-405b": "medium", // unsure
  "nousresearch/hermes-3-llama-3.1-70b": "weak",
  "openai-gpt-4.1": "medium",
  "openai-gpt-5": "strong",
  "openai-gpt-5-mini": "weak", // unsure
  "openai-gpt-5-nano": "weak",
  "openai-gpt-5.1": "strong",
  "openai-gpt-5.2": "strong",
  "openrouter/auto": "weak", // unsure
  "palmyra-x4": "weak", // unsure
  "palmyra-x5": "medium", // unsure
  "palmyra-x6": "medium", // unsure
  "particle-ai/particle-1": "weak", // unsure
  "perceptron/perceptron-mk1.5": "weak", // unsure
  "plamo-3.0-prime": "weak", // unsure
  "poolside/laguna-s-2.1": "weak", // unsure
  "poolside/laguna-xs-2.1": "weak", // unsure
  "prism-ml/ternary-bonsai-2-27b": "weak", // unsure
  "prism-ml/ternary-bonsai-2-9b": "weak", // unsure
  "pro-128k": "weak", // unsure
  "qianfan-code-latest": "weak", // unsure
  "qwq-32b": "weak",
  "reflection/beam-1.0-501b-a23b": "weak", // unsure
  "reka-edge-2603": "weak", // unsure
  "reka-flash": "weak", // unsure
  "reka-flash-3": "weak", // unsure
  "ring-2.6-1t": "medium", // unsure
  "riva-translate-4b-instruct-v1.1": "weak",
  "sakana/sakana-namazu": "weak", // unsure
  "sao10k/l3-8b-lunaris-v1-turbo": "weak",
  "sao10k/l3.1-70b-euryale-v2.2": "weak",
  "sarvam-105b": "weak", // unsure
  "sarvam-30b": "weak", // unsure
  "sarvamai/sarvam-m": "weak", // unsure
  "seed-2.0": "weak", // unsure
  "sensenova-6.7-flash-lite": "weak",
  "snowflake-llama-3.3-70b": "weak",
  "sonar": "weak", // unsure
  "sonar-deep-research": "medium", // unsure
  "sonar-pro": "medium", // unsure
  "sonar-reasoning-pro": "medium", // unsure
  "space-bunny-free": "weak", // unsure
  "stealth/space-bunny-alpha": "weak", // unsure
  "step-1o-turbo-vision": "weak", // unsure
  "step-1v": "weak", // unsure
  "step-3.5-flash": "weak", // unsure
  "step-3.5-flash-2603": "weak", // unsure
  "step-3.7-flash": "weak", // unsure
  "step-5-preview": "medium", // unsure
  "stepfun-ai/step-3.5-flash": "weak", // unsure
  "stepfun-ai/step-3.7-flash": "weak", // unsure
  "stepfun/step-3.7-flash": "weak", // unsure
  "stockmark/stockmark-2-100b-instruct": "weak", // unsure
  "tc-code-latest": "weak", // unsure
  "tencent/hy3": "medium", // unsure
  "tencent/hy4-preview": "medium", // unsure
  "thedrummer/cydonia-24b-v4.3": "weak", // unsure
  "thedrummer/skyfall-31b-v4.2": "weak", // unsure
  "thinkingmachines/inkling": "medium", // unsure
  "thinkingmachines/inkling-small": "weak", // unsure
  "trinity-large-thinking": "weak", // unsure
  "typhoon-v2.5-30b-a3b-instruct": "weak", // unsure
  "unsloth/mistral-nemo-instruct-2407-tee": "weak",
  "upstage/solar-10.7b-instruct": "weak", // unsure
  "upstage/solar-mini4": "weak", // unsure
  "upstage/solar-pro4": "weak", // unsure
  "xiaomi/mimo-v2.6-flash": "weak", // unsure
  "xiaomi/mimo-v2.6-pro": "medium", // unsure
  "xiaomi/mimo-v2.6-pro-ultraspeed": "medium", // unsure
  "xiaomimimo/mimo-v2.5-pro": "medium", // unsure
  "xiaomimimo/mimo-v2.6-flash": "weak", // unsure
  "xiaomimimo/mimo-v2.6-pro": "medium", // unsure
  "yi-large": "weak", // unsure
  "zai/glm-5.3": "strong",
  "zai/glm-5.3-flash": "medium",
};

/** A canonical model id's class, or `undefined` for a model the table doesn't name (read as weak by the runtime). */
export function strengthOfCanonicalModel(canonicalModelId: string): ModelStrength | undefined {
  return Object.prototype.hasOwnProperty.call(MODEL_STRENGTH, canonicalModelId) ? MODEL_STRENGTH[canonicalModelId] : undefined;
}
