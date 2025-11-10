import logger from "@calcom/lib/logger";
import type { CredentialPayload } from "@calcom/types/Credential";

import { CrmServiceMap } from "../crm.apps.generated";

const log = logger.getSubLogger({ prefix: ["CrmManager"] });
export const getCrm = async (credential: CredentialPayload, appOptions: any) => {
  if (!credential || !credential.key) {
    log.warn(`Invalid credential: credential or credential.key is missing for credential ID ${credential?.id}`);
    return null;
  }
  const { type: crmType } = credential;

  const crmName = crmType.split("_")[0];

  const crmServiceImportFn = await CrmServiceMap[crmName as keyof typeof CrmServiceMap];

  if (!crmServiceImportFn) {
    log.warn(`crm of type ${crmType} is not implemented`);
    return null;
  }

  const CrmService = crmServiceImportFn.default;

  if (!CrmService) {
    log.warn(`crm of type ${crmType} is not implemented`);
    return null;
  }

  try {
    return new CrmService(credential, appOptions);
  } catch (error) {
    log.error(
      `Failed to initialize CRM service for ${crmType} (credential ID: ${credential.id})`,
      error instanceof Error ? error.message : String(error)
    );
    return null;
  }
};

export default getCrm;
