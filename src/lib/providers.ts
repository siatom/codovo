import type { AiProvider, ProviderModel, Settings } from "./settings";

/** 一个可用的「提供商 + 模型」组合；`ref` 是发给后端的 `provider/model` 引用 */
export interface ModelRef {
  providerId: string;
  modelId: string;
  ref: string;
}

/** 拼模型引用。provider id 由 `newProviderId` 生成，保证不含 `/`，所以按首个 `/` 切分是安全的 */
export function modelRef(providerId: string, modelId: string): string {
  return `${providerId}/${modelId}`;
}

export function emptyProvider(id: string, name = ""): AiProvider {
  return { id, name: name || id, baseUrl: "", apiKeySet: false, models: [], enabled: true };
}

export function emptyModel(): ProviderModel {
  return { id: "", name: "", enabled: true };
}

/**
 * 由提供商名派生一个可用的 id：小写、非字母数字换成连字符；名字全是非字母数字
 * （比如中文）时退化成 `provider`。重名就往后加 `-2`、`-3`。
 *
 * 为什么不直接用名字：id 要当模型引用前缀和钥匙串里密钥条目名的来源，
 * 得是稳定的 ASCII 标识符。
 */
export function newProviderId(name: string, existing: AiProvider[]): string {
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "provider";
  const taken = new Set(existing.map((provider) => provider.id));
  if (!taken.has(base)) return base;
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${base}-${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/**
 * 能真正拿去建连的提供商：启用 + 填了基地址。
 * 没地址的条目在后端会被当成无效，提前滤掉省得界面上给出选了也用不了的选项。
 */
export function enabledProviders(settings: Settings): AiProvider[] {
  return settings.aiProviders.filter(
    (provider) => provider.enabled && provider.baseUrl.trim() !== "",
  );
}

/** 提供商下能用的模型：启用 + 填了 id */
export function enabledModels(provider: AiProvider): ProviderModel[] {
  return provider.models.filter((model) => model.enabled && model.id.trim() !== "");
}

/** 模型的展示名：没写显示名就用 id */
export function modelLabel(model: ProviderModel): string {
  return model.name.trim() || model.id;
}

/**
 * 生效的默认模型。
 *
 * 设置里存的那对 provider/model 可能已经被删掉、停用或者清空了，所以不能直接照用：
 * 先认设置里的指向，认不了就落到第一个「有可用模型」的提供商上，全都没有返回 null。
 */
export function resolveDefaultModel(settings: Settings): ModelRef | null {
  const providers = enabledProviders(settings);
  if (providers.length === 0) return null;

  // 设置里指定的排最前，其余保持原顺序：默认那家废了就自动退到下一家
  const preferred = providers.find((provider) => provider.id === settings.aiDefaultProvider);
  const ordered = preferred
    ? [preferred, ...providers.filter((provider) => provider !== preferred)]
    : providers;

  for (const provider of ordered) {
    const models = enabledModels(provider);
    if (models.length === 0) continue;
    const model =
      provider.id === settings.aiDefaultProvider
        ? (models.find((item) => item.id === settings.aiDefaultModel) ?? models[0])
        : models[0];
    return { providerId: provider.id, modelId: model.id, ref: modelRef(provider.id, model.id) };
  }
  return null;
}

/**
 * 某个 agent 实际该用的模型引用：它自己绑了就用绑的，留空才跟随全局默认。
 *
 * 未绑定返回 null 表示「无可用的模型」，调用方据此拦下来给提示。
 */
export function boundModelRef(settings: Settings, agentModel: string): string | null {
  const bound = agentModel.trim();
  if (bound) return bound;
  return resolveDefaultModel(settings)?.ref ?? null;
}

/** 候选项：全局默认 + 每个「提供商 · 模型」，值都是 `provider/model` */
export function modelRefOptions(settings: Settings): { value: string; label: string }[] {
  const options: { value: string; label: string }[] = [];
  for (const provider of enabledProviders(settings)) {
    for (const model of enabledModels(provider)) {
      options.push({
        value: modelRef(provider.id, model.id),
        label: `${provider.name} · ${modelLabel(model)}`,
      });
    }
  }
  return options;
}

/** 模型引用的可读名字，找不到原样返回（模型可能刚被删掉） */
export function modelRefLabel(settings: Settings, ref: string): string {
  const cut = ref.indexOf("/");
  if (cut <= 0) return ref;
  const providerId = ref.slice(0, cut);
  const modelId = ref.slice(cut + 1);
  const provider = settings.aiProviders.find((item) => item.id === providerId);
  if (!provider) return ref;
  const model = provider.models.find((item) => item.id === modelId);
  return `${provider.name} · ${model ? modelLabel(model) : modelId}`;
}
