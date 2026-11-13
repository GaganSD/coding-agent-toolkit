import { isDeepStrictEqual } from "node:util";
import { InMemoryCredentialStore, type Api, type Model } from "@earendil-works/pi-ai";
import { ModelRuntime, type ModelRegistry } from "@earendil-works/pi-coding-agent";

/** A credentialless SDK transport. The owning registry remains the only catalog/auth authority.
 * No provider registrations, credentials, refresh jobs, or extension runners are copied. */
export class ProviderBridge {
  private readonly installed = new Set<string>();
  readonly runtime: ModelRuntime;
  private readonly registry: () => ModelRegistry;
  private constructor(runtime: ModelRuntime, registry: () => ModelRegistry) {
    this.runtime = runtime;
    this.registry = registry;
  }

  static async create(registry: () => ModelRegistry): Promise<ProviderBridge> {
    const runtime = await ModelRuntime.create({
      modelsPath: null, credentials: new InMemoryCredentialStore(),
      refreshOnCreate: false, allowModelNetwork: false,
    });
    return new ProviderBridge(runtime, registry);
  }

  ensure(provider: string): void {
    if (this.installed.has(provider)) return;
    this.runtime.registerNativeProvider({
      id: provider, name: provider,
      // Look up the current composed provider, never a captured registration or catalog.
      getModels: () => this.registry().getProvider(provider)?.getModels() ?? [],
      auth: { apiKey: {
        name: "Owning Pi registry",
        // This transport is keyless; admission checks the parent, which authenticates each request.
        check: async () => ({ type: "api_key", source: "forwarding transport" }),
        // The parent authenticates the actual request. Do not resolve or copy its secrets here.
        resolve: async () => { this.registry(); return { auth: {}, source: "owning registry" }; },
      } },
      stream: (model, context, options) => this.registry().stream(this.current(model), context, options),
      streamSimple: (model, context, options) => this.registry().streamSimple(this.current(model), context, options),
    });
    this.installed.add(provider);
  }

  checkAuth = async (model: Model<Api>, signal?: AbortSignal): Promise<boolean> => {
    const available = await this.registry().getAvailableOfType("chat", model.provider, { signal });
    return available.some(candidate => candidate.provider === model.provider && candidate.id === model.id);
  };

  private current(model: Model<Api>): Model<Api> {
    // Metadata is pinned for this attempt; removal/virtual replacement must never route or fall back.
    const current = this.runtime.getPhysicalModel(model.provider, model.id);
    if (!current) {
      throw new Error(`Exact native model '${model.provider}/${model.id}' is unavailable; no aliases, virtual models, or fallback`);
    }
    if (!isDeepStrictEqual(model, current)) {
      throw new Error(`Exact native model '${model.provider}/${model.id}' changed during this attempt; start a new run`);
    }
    return model;
  }
}
