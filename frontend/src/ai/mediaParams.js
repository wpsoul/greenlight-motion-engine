/*
 * Request keys for multi-file media inputs. No imports, so the AI Fill unit
 * tests (node --test) can load it alongside the Generate panel.
 */

/**
 * The key a list of several files for `field` is posted under.
 *
 * Built-in providers (WaveSpeed, GeminiGen, …) read a multi-image `image_url`
 * slot as `image_urls`. Pika is different: its fields are the vendor schema's
 * own keys, and it drops any key the schema doesn't declare — so Kling 3.0
 * Omni's `image_url` list posted as `image_urls` reached the API with no
 * reference images at all. Pika keeps the declared key.
 */
export function multiMediaPostKey(model, field) {
  if (field?.field_type === "image" && field.key === "image_url" && model?.provider !== "pika") {
    return "image_urls";
  }
  return field?.key;
}
