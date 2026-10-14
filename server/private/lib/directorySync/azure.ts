/*
 * This file is part of a proprietary work.
 *
 * Copyright (c) 2025-2026 Fossorial, Inc.
 * All rights reserved.
 *
 * This file is licensed under the Fossorial Commercial License.
 * You may not use this file except in compliance with the License.
 * Unauthorized use, copying, modification, or distribution is strictly prohibited.
 *
 * This file is not licensed under the AGPLv3.
 */

import { db, idp, idpOidcConfig, idpOrg } from "@server/db";
import { eq, and } from "drizzle-orm";
import type {
    DirectoryFetchContext,
    DirectoryFetchResult,
    DirectorySyncProvider
} from "./types";
import { decrypt } from "@server/lib/crypto";
import config from "@server/lib/config";
import cache from "@server/lib/cache";
import z from "zod";
import logger from "@server/logger";
import { fromError } from "zod-validation-error";
import { parseDirectorySyncRoleMapping } from "@app/lib/idpDirectorySyncRoleMapping";

async function ensureValidIdp(idpId: number) {
    const [idpRes] = await db
        .select()
        .from(idp)
        .where(eq(idp.idpId, idpId))
        .innerJoin(idpOidcConfig, eq(idpOidcConfig.idpId, idp.idpId))
        .innerJoin(idpOrg, and(eq(idpOrg.idpId, idp.idpId)))
        .limit(1);

    if (!idpRes) {
        throw new Error(
            `Directory sync: IdP ${idpId} not found, or it has no OIDC config or org mapping`
        );
    }

    if (idpRes.idpOidcConfig.variant !== "azure") {
        throw new Error(
            `Directory sync: IdP ${idpId} has variant "${idpRes.idpOidcConfig.variant}", expected "azure"`
        );
    }

    if (!idpRes.idp.directorySyncEnabled) {
        throw new Error(
            `Directory sync: directory sync is not enabled on IdP ${idpId}`
        );
    }

    if (idpRes.idp.autoProvision) {
        throw new Error(
            `Directory sync: IdP ${idpId} has both directory sync and auto-provisioning enabled; only one can be active`
        );
    }
    return idpRes;
}

export class AzureDirectorySyncProvider implements DirectorySyncProvider {
    #TOKEN_CACHE_KEY_PREFIX = "azureDirectorySyncToken";
    #microsoftGraphBaseUrl = "https://graph.microsoft.com/v1.0";

    async fetch(ctx: DirectoryFetchContext): Promise<DirectoryFetchResult> {
        // first type of fetch: `full`
        // 0. fetch idp and check that it is valid
        const idpRes = await ensureValidIdp(ctx.idpId);

        // 1. get access token (and cache)
        const token = await this.#getToken(idpRes);
        const directorySyncMapping = parseDirectorySyncRoleMapping(
            idpRes.idpOrg.directoryRoleMapping
        );

        if (directorySyncMapping.mode === "fixedRoles") {
            // ..
        }

        // if fixed roles
        //   2. get all users
        // if create or map groups
        //   2. get list of all groups
        //   3. get group members ?

        console.dir({
            token
        });

        return {
            kind: "full",
            users: [],
            nextCursor: null
        };
    }

    async #getToken(
        idpRes: Awaited<ReturnType<typeof ensureValidIdp>>
    ): Promise<string> {
        const cacheKey = `${this.#TOKEN_CACHE_KEY_PREFIX}:${idpRes.idp.idpId}`;
        const cached = await cache.get<string>(cacheKey);

        if (cached) {
            logger.info("Returning cached access token");
            return cached;
        }

        logger.info("Fetching fresh access token");
        const key = config.getRawConfig().server.secret!;

        let clientId = "";
        let clientSecret = "";

        if (idpRes.idp.type === "oidc") {
            clientSecret = decrypt(idpRes.idpOidcConfig.clientSecret, key);
            clientId = decrypt(idpRes.idpOidcConfig.clientId, key);
        }

        const res = await fetch(idpRes.idpOidcConfig.tokenUrl, {
            method: "POST",
            headers: {
                "Content-Type": "application/x-www-form-urlencoded"
            },
            body: new URLSearchParams({
                grant_type: "client_credentials",
                client_id: clientId,
                client_secret: clientSecret,
                scope: "https://graph.microsoft.com/.default"
            })
        });

        const body: any = await res.json().catch(() => ({}));
        if (!res.ok) {
            const reason =
                body.error_description ??
                body.error ??
                res.statusText ??
                "no error details in response";
            throw new Error(
                `Directory sync: Entra token request for IdP ${idpRes.idp.idpId} failed (HTTP ${res.status}): ${reason}`
            );
        }

        const tokenBodySchema = z.object({
            expires_in: z.int(),
            access_token: z.string()
        });

        try {
            const tokenResponse = tokenBodySchema.parse(body);
            await cache.set(
                cacheKey,
                tokenResponse.access_token,
                tokenResponse.expires_in - 30 // keep the response 30 seconds less than the token to make sure to always have a fresh token
            );

            logger.info(
                `Got new access token (expires in: ${tokenResponse.expires_in}s)`
            );

            return tokenResponse.access_token;
        } catch (e) {
            throw new Error(
                `Directory sync: unexpected Entra token response for IdP ${idpRes.idp.idpId}: ${fromError(e).toString()}`,
                { cause: e }
            );
        }
    }

    async #fetchAllUsers(token: string) {
        //...
        const userSelectQuery =
            "id,displayName,mail,userPrincipalName,accountEnabled";

        const res = await fetch(
            `${this.#microsoftGraphBaseUrl}/users?$select=${userSelectQuery}`,
            {
                headers: {
                    Authorization: `Bearer ${token}`
                }
            }
        );

        const body: any = await res.json().catch(() => ({}));
        if (!res.ok) {
            const reason =
                body.error_description ??
                body.error ??
                res.statusText ??
                "no error details in response";
            throw new Error(
                `Directory sync: Entra fetch user failed (HTTP ${res.status}): ${reason}` // todo: improve
            );
        }

        const userBodySchema = z.object({
            value: z.array(
                z.object({
                    mail: z.email(),
                    userPrincipalName: z.string(),
                    id: z.uuidv4()
                })
            )
        });

        try {
            const tokenResponse = userBodySchema.parse(body);

            return tokenResponse;
        } catch (e) {
            throw new Error(
                `Directory sync: `, // todo: improve
                { cause: e }
            );
        }
    }

    async #fetchAllGroups(token: string) {
        //...
    }
    async #fetchGroupMembers(token: string) {
        //...
    }
}
