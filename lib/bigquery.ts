import { BigQuery } from "@google-cloud/bigquery";

let cached: BigQuery | null = null;

/**
 * Returns a BigQuery client authenticated with the service account whose JSON
 * key is base64-encoded in GCP_SERVICE_ACCOUNT_KEY. Lazy / singleton.
 */
export function getBigQuery(): BigQuery | null {
  if (cached) return cached;
  const b64 = process.env.GCP_SERVICE_ACCOUNT_KEY;
  if (!b64) return null;
  try {
    const json = JSON.parse(Buffer.from(b64, "base64").toString("utf-8"));
    cached = new BigQuery({
      projectId: json.project_id,
      credentials: { client_email: json.client_email, private_key: json.private_key },
    });
    return cached;
  } catch (err) {
    console.error("BigQuery credential parse failed:", err);
    return null;
  }
}
