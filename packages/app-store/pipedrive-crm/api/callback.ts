import type { NextApiRequest, NextApiResponse } from "next";

import { WEBAPP_URL_FOR_OAUTH } from "@calcom/lib/constants";
import { getSafeRedirectUrl } from "@calcom/lib/getSafeRedirectUrl";

import getAppKeysFromSlug from "../../_utils/getAppKeysFromSlug";
import getInstalledAppPath from "../../_utils/getInstalledAppPath";
import createOAuthAppCredential from "../../_utils/oauth/createOAuthAppCredential";
import { decodeOAuthState } from "../../_utils/oauth/decodeOAuthState";
import appConfig from "../config.json";

export interface PipedriveToken {
  access_token: string;
  token_type: string;
  refresh_token: string;
  scope: string;
  expires_in: number;
  api_domain: string;
  expiryDate?: number;
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { code } = req.query;
  const state = decodeOAuthState(req);

  if (code && typeof code !== "string") {
    res.status(400).json({ message: "`code` must be a string" });
    return;
  }

  if (!req.session?.user?.id) {
    return res.status(401).json({ message: "You must be logged in to do this" });
  }

  let clientId = "";
  let clientSecret = "";
  const appKeys = await getAppKeysFromSlug(appConfig.slug);
  if (typeof appKeys.client_id === "string") clientId = appKeys.client_id;
  if (typeof appKeys.client_secret === "string") clientSecret = appKeys.client_secret;
  if (!clientId) return res.status(400).json({ message: "Pipedrive client id missing." });
  if (!clientSecret) return res.status(400).json({ message: "Pipedrive client secret missing." });

  const redirectUri = `${WEBAPP_URL_FOR_OAUTH}/api/integrations/pipedrive-crm/callback`;
  const authHeader = `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`;

  const tokenResponse = await fetch("https://oauth.pipedrive.com/oauth/token", {
    method: "POST",
    headers: {
      Authorization: authHeader,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: code || "",
      redirect_uri: redirectUri,
    }),
  });

  if (!tokenResponse.ok) {
    const errorBody = await tokenResponse.text();
    console.error("Pipedrive OAuth token request failed:", {
      status: tokenResponse.status,
      statusText: tokenResponse.statusText,
      body: errorBody,
    });

    return res.status(400).json({
      message: "Failed to exchange code for access token. Please try reconnecting the integration.",
      error: errorBody,
    });
  }

  const pipedriveToken: PipedriveToken = await tokenResponse.json();

  if (!pipedriveToken.access_token || !pipedriveToken.refresh_token) {
    console.error("Pipedrive token response missing required fields:", pipedriveToken);
    return res.status(400).json({
      message: "Received invalid token response from Pipedrive. Please try again.",
    });
  }

  pipedriveToken.expiryDate = Math.round(Date.now() + (pipedriveToken.expires_in || 3600) * 1000);

  await createOAuthAppCredential({ appId: appConfig.slug, type: appConfig.type }, pipedriveToken, req);

  res.redirect(
    getSafeRedirectUrl(state?.returnTo) ??
      getInstalledAppPath({ variant: appConfig.variant, slug: appConfig.slug })
  );
}
