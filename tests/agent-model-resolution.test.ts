import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AuthStorage, DefaultResourceLoader, ModelRegistry, SettingsManager } from "@earendil-works/pi-coding-agent";
import { WorkflowAgent } from "../src/agent.js";

const models = [
  { id: "glm-5", name: "GLM 5", provider: "zhipu" },
  { id: "claude-haiku-4-5", name: "Claude Haiku 4.5", provider: "anthropic" },
  { id: "claude-haiku-4-5-20250514", name: "Claude Haiku 4.5 (dated)", provider: "anthropic" },
  { id: "claude-opus-4-5", name: "Claude Opus 4.5", provider: "anthropic" },
  { id: "claude-opus-4-5", name: "Claude Opus 4.5", provider: "openrouter" },
  { id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5", provider: "anthropic" },
  { id: "vendor/claude-sonnet-4", name: "Vendor Claude Sonnet 4", provider: "openrouter" },
  { id: "anthropic/claude-sonnet-4", name: "OpenRouter Claude Sonnet 4", provider: "openrouter" },
  { id: "anthropic/claude-new", name: "OpenRouter Claude New", provider: "openrouter" },
  { id: "claude-haiku-4-5", name: "Claude Haiku 4.5", provider: "openrouter" },
];

const fakeRegistry = {
  getAll: () => models,
  getAvailable: () => models,
  find: (provider: string, modelId: string) => models.find((m) => m.provider === provider && m.id === modelId),
} as any;

const agent: any = new WorkflowAgent();

async function writeProviderExtension(cwd: string, provider: string, modelId: string): Promise<void> {
  const extensionDir = join(cwd, ".pi", "extensions");
  await mkdir(extensionDir, { recursive: true });
  await writeFile(
    join(extensionDir, "model-provider.ts"),
    `export default function (pi) {
  pi.registerProvider("${provider}", {
    baseUrl: "http://localhost:1234",
    apiKey: "test-key",
    api: "openai-completions",
    models: [{
      id: "${modelId}",
      name: "Test Model",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 4096,
      maxTokens: 1024
    }]
  });
  pi.registerTool({
    name: "workflow",
    label: "Recursive Workflow",
    description: "Test-only recursive workflow tool",
    parameters: { type: "object", properties: {} },
    execute: async () => ({ content: [{ type: "text", text: "unexpected recursion" }], details: {} })
  });
  pi.on("session_start", () => {
    pi.setActiveTools([...pi.getActiveTools(), "workflow"]);
  });
}
`,
  );
}

test("resolveModel matches a bare id", () => {
  const resolved = agent.resolveModel("glm-5", fakeRegistry);
  assert.equal(resolved.id, "glm-5");
});

test("resolveModel matches provider/id via find()", () => {
  const resolved = agent.resolveModel("anthropic/claude-opus-4-5", fakeRegistry);
  assert.equal(resolved.id, "claude-opus-4-5");
  assert.equal(resolved.provider, "anthropic");
});

test("resolveModel matches a bare id containing a slash", () => {
  const resolved = agent.resolveModel("vendor/claude-sonnet-4", fakeRegistry);
  assert.equal(resolved.id, "vendor/claude-sonnet-4");
  assert.equal(resolved.provider, "openrouter");
});

test("resolveModel honors a known provider before a slash-bearing raw id", () => {
  const resolved = agent.resolveModel("anthropic/claude-sonnet-4", fakeRegistry);
  assert.equal(resolved.id, "claude-sonnet-4-5");
  assert.equal(resolved.provider, "anthropic");
});

test("resolveModel matches shorthand patterns case-insensitively", () => {
  const resolved = agent.resolveModel("HaIkU", fakeRegistry, "anthropic");
  assert.equal(resolved.id, "claude-haiku-4-5");
  assert.equal(resolved.provider, "anthropic");
});

test("resolveModel matches partial ids within an explicit provider", () => {
  const resolved = agent.resolveModel("anthropic/opus", fakeRegistry);
  assert.equal(resolved.id, "claude-opus-4-5");
  assert.equal(resolved.provider, "anthropic");
});

test("resolveModel rejects an ambiguous provider-qualified fuzzy match", () => {
  assert.throws(() => agent.resolveModel("anthropic/claude", fakeRegistry), /ambiguous model/);
});

test("resolveModel rejects a known provider miss instead of falling through to another provider", () => {
  assert.throws(() => agent.resolveModel("anthropic/claude-new", fakeRegistry), /unknown model/);
});

test("resolveModel uses natural version ordering for preferred provider matches", () => {
  const versionedModels = [
    ...models,
    { id: "claude-sonnet-4-9", name: "Claude Sonnet 4.9", provider: "anthropic" },
    { id: "claude-sonnet-4-10", name: "Claude Sonnet 4.10", provider: "anthropic" },
  ];
  const versionedRegistry = { getAll: () => versionedModels, getAvailable: () => versionedModels } as any;
  const resolved = agent.resolveModel("sonnet", versionedRegistry, "anthropic");
  assert.equal(resolved.id, "claude-sonnet-4-10");
});

test("resolveModel rejects an ambiguous exact bare id", () => {
  assert.throws(
    () => agent.resolveModel("claude-opus-4-5", fakeRegistry, "anthropic"),
    /anthropic\/claude-opus-4-5.*openrouter\/claude-opus-4-5/,
  );
});

test("resolveModel rejects a cross-provider exact-id fallback when the preferred provider is unavailable", () => {
  const unavailablePreferredRegistry = {
    getAll: () => models,
    getAvailable: () => models.filter((model) => !(model.provider === "anthropic" && model.id === "claude-opus-4-5")),
  } as any;

  assert.throws(
    () => agent.resolveModel("claude-opus-4-5", unavailablePreferredRegistry, "anthropic"),
    /unavailable.*anthropic\/claude-opus-4-5/,
  );
});

test("resolveModel rejects a cross-provider fuzzy fallback when the preferred provider is unavailable", () => {
  const unavailablePreferredRegistry = {
    getAll: () => models,
    getAvailable: () => models.filter((model) => model.provider !== "anthropic"),
  } as any;

  assert.throws(
    () => agent.resolveModel("sonnet", unavailablePreferredRegistry, "anthropic"),
    /unavailable.*anthropic\/claude-sonnet-4-5/,
  );
});

test("resolveModelSpec prefers an exact colon-bearing model id over a thinking suffix", () => {
  const colonModels = [{ id: "foo:high", name: "Foo High", provider: "custom" }];
  const colonRegistry = { getAll: () => colonModels, getAvailable: () => colonModels } as any;

  const resolved = agent.resolveModelSpec("custom/foo:high", colonRegistry, "custom", undefined);
  assert.equal(resolved.model.id, "foo:high");
  assert.equal(resolved.model.provider, "custom");
  assert.equal(resolved.thinkingLevel, undefined);
});

test("resolveModel rejects cross-provider fuzzy matches without a preferred provider", () => {
  assert.throws(() => agent.resolveModel("haiku", fakeRegistry), /ambiguous model/);
});

test("resolveModel rejects an unavailable canonical model", () => {
  const unavailableRegistry = {
    getAll: () => models,
    getAvailable: () => models.filter((model) => model.id !== "glm-5"),
  } as any;
  assert.throws(() => agent.resolveModel("zhipu/glm-5", unavailableRegistry), /unavailable/);
});

test("resolveModel throws on unknown pattern", () => {
  assert.throws(() => agent.resolveModel("nope", fakeRegistry), /unknown model/);
});

test("resolveModel rejects an empty pattern", () => {
  assert.throws(() => agent.resolveModel("  ", fakeRegistry), /must not be empty/);
});

test("resolveModel rejects a provider reference without a model pattern", () => {
  assert.throws(() => agent.resolveModel("anthropic/", fakeRegistry), /unknown model/);
});

test("createSession resolves models registered by project extensions", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-dynamic-workflows-"));
  await writeProviderExtension(cwd, "extension-provider", "extension-model");

  try {
    const extensionAgent: any = new WorkflowAgent({ cwd, session: { agentDir: join(cwd, "agent") } });
    const { session } = await extensionAgent.createSession("extension-provider/extension-model", []);
    assert.equal(session.model?.provider, "extension-provider");
    assert.equal(session.model?.id, "extension-model");
    assert.ok(!session.getActiveToolNames().includes("workflow"));
    session.dispose();
    await assert.rejects(() => extensionAgent.createSession("", []), /must not be empty/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("createSession preserves extension providers when reusing a custom resource loader", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-dynamic-workflows-loader-"));
  const agentDir = join(cwd, "agent");
  await writeProviderExtension(cwd, "reused-provider", "reused-model");

  try {
    const settingsManager = SettingsManager.create(cwd, agentDir);
    const resourceLoader = new DefaultResourceLoader({ cwd, agentDir, settingsManager });
    await resourceLoader.reload();
    const extensionAgent: any = new WorkflowAgent({
      cwd,
      session: { agentDir, resourceLoader, settingsManager },
    });

    for (let run = 0; run < 2; run++) {
      const { session } = await extensionAgent.createSession("reused-provider/reused-model", []);
      assert.equal(session.model?.provider, "reused-provider");
      assert.equal(session.model?.id, "reused-model");
      assert.ok(!session.getActiveToolNames().includes("workflow"));
      session.dispose();
    }
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("createSession inherits the session model and permits a per-agent override", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-dynamic-workflows-model-override-"));
  const authStorage = AuthStorage.inMemory({ anthropic: { type: "api_key", key: "test-key" } });
  const modelRegistry = ModelRegistry.inMemory(authStorage);
  const inheritedModel = modelRegistry.find("anthropic", "claude-haiku-4-5");
  assert.ok(inheritedModel);

  try {
    const modelAgent: any = new WorkflowAgent({
      cwd,
      tools: [],
      session: {
        agentDir: join(cwd, "agent"),
        authStorage,
        modelRegistry,
        model: inheritedModel,
      },
    });

    const { session: inheritedSession } = await modelAgent.createSession(undefined, []);
    assert.equal(inheritedSession.model?.provider, inheritedModel.provider);
    assert.equal(inheritedSession.model?.id, inheritedModel.id);
    inheritedSession.dispose();

    const { session: overriddenSession } = await modelAgent.createSession("sonnet", []);
    assert.equal(overriddenSession.model?.provider, "anthropic");
    assert.match(overriddenSession.model?.id ?? "", /sonnet/);
    assert.notEqual(overriddenSession.model?.id, inheritedModel.id);
    overriddenSession.dispose();

    const { session: shorthandSession } = await modelAgent.createSession("sonnet:low", []);
    assert.equal(shorthandSession.model?.provider, "anthropic");
    assert.match(shorthandSession.model?.id ?? "", /sonnet/);
    assert.equal(shorthandSession.thinkingLevel, "low");
    shorthandSession.dispose();

    const offSession = await modelAgent.createSession("sonnet:off", []);
    assert.equal(offSession.session.thinkingLevel, "off");
    offSession.session.dispose();

    const maxSession = await modelAgent.createSession("sonnet:max", []);
    assert.ok(["xhigh", "high"].includes(maxSession.session.thinkingLevel));
    maxSession.session.dispose();
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("run disposes the session when the model callback throws", async () => {
  let disposeCalls = 0;
  const callbackAgent: any = new WorkflowAgent({ tools: [] });
  callbackAgent.createSession = async () => ({
    session: {
      model: { provider: "custom", id: "model" },
      dispose: () => disposeCalls++,
    },
  });

  await assert.rejects(
    () =>
      callbackAgent.run("test", {
        onModel: () => {
          throw new Error("display failed");
        },
      }),
    /display failed/,
  );
  assert.equal(disposeCalls, 1);
});
