import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
let generateOpenRouterImageBytes:
  typeof import("./openrouter-image.ts").generateOpenRouterImageBytes;

const { generate, send, listModels, listModelEndpoints, getModel } = vi.hoisted(() => ({
  generate: vi.fn(),
  send: vi.fn(),
  listModelEndpoints: vi.fn(),
  listModels: vi.fn(),
  getModel: vi.fn(),
}));

vi.mock("@openrouter/sdk", () => ({
  OpenRouter: class {
    images = { generate, listModels, listModelEndpoints };
    chat = { send };
    models = { get: getModel };
  },
}));

describe("generateOpenRouterImageBytes", () => {
  beforeEach(async () => {
    vi.resetModules();
    ({ generateOpenRouterImageBytes } = await import("./openrouter-image.ts"));
    vi.stubEnv("IMAGE_MODEL", "meta/muse-image");
    vi.stubEnv("OPENROUTER_API_KEY", "test-key");
    generate.mockReset();
    send.mockReset();
    listModelEndpoints.mockReset().mockResolvedValue({ endpoints: [] });
    listModels.mockReset().mockResolvedValue({ data: [] });
    getModel.mockReset().mockResolvedValue({ data: { architecture: { outputModalities: ["image"] } } });
    generate.mockResolvedValue({ data: [{ b64Json: "BAUG" }] });
    send.mockResolvedValue({ choices: [{ message: {
      role: "assistant", content: null,
      images: [{ type: "image_url", imageUrl: { url: "data:image/png;base64,AQID" } }],
    } }] });
  });

  afterEach(() => vi.unstubAllEnvs());

  it("uses the image catalog even when Muse has no listed provider endpoints", async () => {
    listModels.mockResolvedValue({ data: [{ id: "meta/muse-image", supportedParameters: {} }] });
    expect(await generateOpenRouterImageBytes("a pear")).toEqual(new Uint8Array([4, 5, 6]));
    expect(send).not.toHaveBeenCalled();
    expect(getModel).not.toHaveBeenCalled();
    expect(listModelEndpoints).not.toHaveBeenCalled();
  });

  it("uses chat for an image model absent from the dedicated image catalog", async () => {
    expect(await generateOpenRouterImageBytes("a pear")).toEqual(new Uint8Array([1, 2, 3]));
    expect(send).toHaveBeenCalledWith({ chatRequest: {
      model: "meta/muse-image", stream: false, modalities: ["image"],
      messages: [{ role: "user", content: "a pear. Photographic, plain background, no text, no letters, no words anywhere in the image." }],
    } });
    expect(generate).not.toHaveBeenCalled();
  });

  it("keeps Flux on the dedicated image endpoint", async () => {
    vi.stubEnv("IMAGE_MODEL", "black-forest-labs/flux.2-klein-4b");
    listModels.mockResolvedValue({ data: [{ id: "black-forest-labs/flux.2-klein-4b" }] });
    expect(await generateOpenRouterImageBytes("a pear")).toEqual(new Uint8Array([4, 5, 6]));
    expect(generate).toHaveBeenCalledWith({ imageGenerationRequest: {
      model: "black-forest-labs/flux.2-klein-4b",
      prompt: "a pear. Photographic, plain background, no text, no letters, no words anywhere in the image.",
      size: "1024x1024",
    } });
    expect(send).not.toHaveBeenCalled();
  });

  it.each(["google/gemini-image", "openai/image-model", "future/new-image-model"])(
    "routes %s using catalog membership, not its name", async (model) => {
      vi.stubEnv("IMAGE_MODEL", model);
      listModels.mockResolvedValueOnce({ data: [{ id: model }] });
      expect(await generateOpenRouterImageBytes("a pear")).toEqual(new Uint8Array([4, 5, 6]));
      expect(send).not.toHaveBeenCalled();

      // A fresh server can discover a different transport for the same ID.
      vi.resetModules();
      ({ generateOpenRouterImageBytes } = await import("./openrouter-image.ts"));
      getModel.mockResolvedValue({ data: { architecture: { outputModalities: ["text", "image"] } } });
      expect(await generateOpenRouterImageBytes("a pear")).toEqual(new Uint8Array([1, 2, 3]));
      expect(send).toHaveBeenCalledWith({ chatRequest: expect.objectContaining({
        model, modalities: ["text", "image"],
      }) });
      const [author, slug] = model.split("/");
      expect(getModel).toHaveBeenCalledWith({ author, slug });
    },
  );

  it("shares discovery for concurrent and subsequent generations", async () => {
    let resolveModels!: (value: { data: [] }) => void;
    listModels.mockReturnValue(new Promise((resolve) => {
      resolveModels = resolve;
    }));
    const first = generateOpenRouterImageBytes("a pear");
    const second = generateOpenRouterImageBytes("an apple");
    expect(listModels).toHaveBeenCalledTimes(1);
    resolveModels({ data: [] });
    expect(await Promise.all([first, second])).toEqual([
      new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 3]),
    ]);
    expect(await generateOpenRouterImageBytes("a plum")).toEqual(new Uint8Array([1, 2, 3]));
    expect(listModels).toHaveBeenCalledTimes(1);
    expect(getModel).toHaveBeenCalledTimes(1);
  });

  it("caches routes independently by model ID", async () => {
    await generateOpenRouterImageBytes("a pear");
    vi.stubEnv("IMAGE_MODEL", "other/image-model");
    listModels.mockResolvedValue({ data: [{ id: "other/image-model" }] });
    expect(await generateOpenRouterImageBytes("a pear")).toEqual(new Uint8Array([4, 5, 6]));
    vi.stubEnv("IMAGE_MODEL", "meta/muse-image");
    expect(await generateOpenRouterImageBytes("a pear")).toEqual(new Uint8Array([1, 2, 3]));
    expect(listModels).toHaveBeenCalledTimes(2);
  });

  it("retries discovery after a failed lookup", async () => {
    getModel.mockRejectedValueOnce(new Error("Discovery unavailable"));
    await expect(generateOpenRouterImageBytes("a pear")).rejects.toThrow("Discovery unavailable");
    expect(await generateOpenRouterImageBytes("a pear")).toEqual(new Uint8Array([1, 2, 3]));
    expect(listModels).toHaveBeenCalledTimes(2);
    expect(getModel).toHaveBeenCalledTimes(2);
  });

  it("rejects models without image output before generation", async () => {
    getModel.mockResolvedValue({ data: { architecture: { outputModalities: ["text"] } } });
    await expect(generateOpenRouterImageBytes("a pear")).rejects.toThrow("does not support image output");
    expect(send).not.toHaveBeenCalled();
    expect(generate).not.toHaveBeenCalled();
  });

  it("propagates discovery errors without generating", async () => {
    listModels.mockRejectedValue(new Error("Discovery unavailable"));
    await expect(generateOpenRouterImageBytes("a pear")).rejects.toThrow("Discovery unavailable");
    expect(send).not.toHaveBeenCalled();
    expect(generate).not.toHaveBeenCalled();
  });

  it("rejects a chat response without an image", async () => {
    send.mockResolvedValue({ choices: [{ message: { content: "Unable to generate" } }] });
    await expect(generateOpenRouterImageBytes("a pear")).rejects.toThrow("Model returned no image");
  });

  it.each(["https://example.com/image.png", "data:text/plain;base64,AQID", "data:image/png;base64,"])(
    "rejects unsupported image data: %s", async (url) => {
      send.mockResolvedValue({ choices: [{ message: { images: [{ imageUrl: { url } }] } }] });
      await expect(generateOpenRouterImageBytes("a pear")).rejects.toThrow("Model returned an unsupported image format");
    },
  );

  it("propagates provider errors without trying another generation", async () => {
    send.mockRejectedValue(new Error("Provider unavailable"));
    await expect(generateOpenRouterImageBytes("a pear")).rejects.toThrow("Provider unavailable");
    expect(generate).not.toHaveBeenCalled();
  });
});
