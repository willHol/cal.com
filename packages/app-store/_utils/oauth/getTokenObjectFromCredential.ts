import logger from "@calcom/lib/logger";
import { safeStringify } from "@calcom/lib/safeStringify";
import type { CredentialPayload } from "@calcom/types/Credential";

import { OAuth2TokenResponseInDbSchema } from "./universalSchema";

export function getTokenObjectFromCredential(credential: Pick<CredentialPayload, "key" | "id">) {
  const parsedTokenResponse = OAuth2TokenResponseInDbSchema.safeParse(credential.key);
  if (!parsedTokenResponse.success) {
    logger.error(
      "getTokenObjectFromCredential",
      `Failed to parse credential.key for credential ID ${credential.id}:`,
      safeStringify(parsedTokenResponse.error.issues)
    );
    throw new Error(
      `Could not parse credential.key ${credential.id} with error: ${safeStringify(parsedTokenResponse.error.issues)}`
    );
  }

  const tokenResponse = parsedTokenResponse.data;
  if (!tokenResponse) {
    throw new Error(`credential.key is not set for credential ${credential.id}`);
  }

  return tokenResponse;
}
