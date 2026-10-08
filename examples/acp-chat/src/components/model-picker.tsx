import type { SessionModels } from "../types.js";

export function ModelPicker({
  models,
  current,
  disabled,
  onChange,
}: {
  models?: SessionModels;
  current?: string;
  disabled?: boolean;
  onChange: (model: string) => void;
}) {
  const options =
    models?.availableModels ??
    (models?.availableModelIds ?? []).map((modelId) => ({ modelId, name: modelId }));
  if (options.length === 0) {
    return null;
  }
  const selected = current ?? models?.currentModelId ?? options[0]?.modelId ?? "";

  return (
    <span className="chip" title="模型">
      <span className="chip-glyph" aria-hidden="true">
        ✦
      </span>
      <select
        value={selected}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        aria-label="模型"
      >
        {options.map((model) => (
          <option key={model.modelId} value={model.modelId}>
            {model.name}
          </option>
        ))}
      </select>
    </span>
  );
}
