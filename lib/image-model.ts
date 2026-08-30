export const DEFAULT_IMAGE_MODEL = "tt-image-2";

export const IMAGE_MODEL = process.env.AI_IMAGE_MODEL?.trim() || DEFAULT_IMAGE_MODEL;
export const IMAGE_GENERATE_ENDPOINT = "/v1/media/generate";
export const IMAGE_STATUS_ENDPOINT = "/v1/media/status";

export function imageStatusPath(taskId: string) {
  return `${IMAGE_STATUS_ENDPOINT}?task_id=${encodeURIComponent(taskId)}`;
}
