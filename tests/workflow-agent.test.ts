import assert from "node:assert/strict";
import test from "node:test";
import type { Model } from "@earendil-works/pi-ai";
import { resolveModel, suggestModels } from "../src/agent.js";

function model(provider: string, id: string): Model<any> {
  return { provider, id } as Model<any>;
}

function registry(models: Model<any>[], availableModels = models) {
  return {
    getAll() {
      return models;
    },
    getAvailable() {
      return availableModels;
    },
    find(provider: string, modelId: string) {
      return models.find((item) => item.provider === provider && item.id === modelId);
    },
  };
}

test("resolveModel accepts canonical provider/model strings", () => {
  const target = model("anthropic", "claude-3-5-haiku-20241022");

  assert.equal(resolveModel(registry([target]), "anthropic/claude-3-5-haiku-20241022"), target);
});

test("resolveModel accepts unique bare model ids", () => {
  const target = model("anthropic", "claude-3-5-haiku-20241022");

  assert.equal(resolveModel(registry([target]), "claude-3-5-haiku-20241022"), target);
});

test("resolveModel accepts unique bare model ids containing separators", () => {
  const colonModel = model("ollama", "llama3.1:8b");
  const slashModel = model("openrouter", "z-ai/glm-4.5v");

  assert.equal(resolveModel(registry([colonModel, slashModel]), "llama3.1:8b"), colonModel);
  assert.equal(resolveModel(registry([colonModel, slashModel]), "z-ai/glm-4.5v"), slashModel);
});

test("resolveModel rejects ambiguous bare model ids", () => {
  const models = [model("provider-a", "shared-model"), model("provider-b", "shared-model")];

  assert.equal(resolveModel(registry(models), "shared-model"), undefined);
  assert.equal(resolveModel(registry(models), "provider-a/shared-model"), models[0]);
});

test("resolveModel only accepts available models", () => {
  const available = model("anthropic", "claude-sonnet-4-20250514");
  const unavailable = model("amazon-bedrock", "anthropic.claude-sonnet-4-20250514-v1:0");

  assert.equal(
    resolveModel(
      registry([available, unavailable], [available]),
      "amazon-bedrock/anthropic.claude-sonnet-4-20250514-v1:0",
    ),
    undefined,
  );
  assert.equal(
    resolveModel(registry([available, unavailable], [available]), "anthropic/claude-sonnet-4-20250514"),
    available,
  );
});

test("suggestModels returns ranked canonical model hints", () => {
  const models = [
    model("openai", "gpt-5.5"),
    model("anthropic", "claude-sonnet-4-20250514"),
    model("openrouter", "anthropic/claude-sonnet-4"),
    model("anthropic", "claude-opus-4-5"),
  ];

  assert.deepEqual(suggestModels(registry(models), "sonnet"), [
    "anthropic/claude-sonnet-4-20250514",
    "openrouter/anthropic/claude-sonnet-4",
  ]);
});

test("suggestModels only returns available model hints", () => {
  const available = model("anthropic", "claude-sonnet-4-20250514");
  const unavailable = model("amazon-bedrock", "anthropic.claude-sonnet-4-20250514-v1:0");

  assert.deepEqual(suggestModels(registry([available, unavailable], [available]), "sonnet"), [
    "anthropic/claude-sonnet-4-20250514",
  ]);
});

test("suggestModels prioritizes the default provider", () => {
  const models = [model("anthropic", "claude-sonnet-4-20250514"), model("openrouter", "anthropic/claude-sonnet-4")];

  assert.deepEqual(suggestModels(registry(models), "sonnet", { defaultProvider: "openrouter" }), [
    "openrouter/anthropic/claude-sonnet-4",
    "anthropic/claude-sonnet-4-20250514",
  ]);
});
