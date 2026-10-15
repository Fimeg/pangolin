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
    DirectorySyncProvider,
    DirectoryUser
} from "./types";
import { decrypt } from "@server/lib/crypto";
import config from "@server/lib/config";
import cache from "@server/lib/cache";
import z from "zod";
import logger from "@server/logger";
import { fromError } from "zod-validation-error";
import { parseDirectorySyncRoleMapping } from "@app/lib/idpDirectorySyncRoleMapping";

const removedSchema = z.object({ reason: z.string() });

const userBodySchema = z.object({
    "@odata.nextLink": z.url().optional(),
    "@odata.deltaLink": z.url().optional(),
    value: z.array(
        z.union([
            z.object({
                id: z.uuid(),
                displayName: z.string().optional(),
                mail: z.email().nullable().optional(),
                accountEnabled: z.boolean().optional(),
                userPrincipalName: z.string().optional(),
                otherMails: z.array(z.email()).optional(),
                "@removed": removedSchema.optional()
            })
        ])
    )
});

const groupBodySchema = z.object({
    "@odata.nextLink": z.url().optional(),
    "@odata.deltaLink": z.url().optional(),
    value: z.array(
        z.union([
            z.object({
                id: z.uuid(),
                "@removed": removedSchema
            }),
            z.object({
                id: z.uuid(),
                displayName: z.string(),
                // omitted when the group has no member (changes)
                "members@delta": z
                    .array(
                        z.object({
                            id: z.uuid(),
                            "@removed": removedSchema.optional()
                        })
                    )
                    .default([])
            })
        ])
    )
});

const tokenBodySchema = z.object({
    expires_in: z.int(),
    access_token: z.string()
});

type MicrosoftGraphUser = z.output<typeof userBodySchema>["value"][number];
type MicrosoftGraphGroup = z.output<typeof groupBodySchema>["value"][number];

type ExistingGraphUser = Required<Omit<MicrosoftGraphUser, "@removed">>;

type IdpDbResponse = Awaited<ReturnType<typeof ensureValidIdp>>;
export class AzureDirectorySyncProvider implements DirectorySyncProvider {
    #TOKEN_CACHE_KEY_PREFIX = "azureDirectorySyncToken";
    #microsoftGraphBaseUrl = "https://graph.microsoft.com/v1.0";

    async fetch(ctx: DirectoryFetchContext): Promise<DirectoryFetchResult> {
        let directoryUsers: Record<string, DirectoryUser> = {};
        const removedExternalIds: string[] = [];
        // first type of fetch: `full`
        // 0. fetch idp and check that it is valid
        const idpRes = await ensureValidIdp(ctx.idpId);

        // 1. get access token (and cache)
        const token = await this.#getToken(idpRes);

        // 1. get users & groups
        const [userResponse, groupResponse] = await Promise.all([
            this.#fetchAllUsers(token, idpRes.idp.idpId),
            this.#fetchAllGroups(token, idpRes.idp.idpId)
        ]);

        for (let user of userResponse.users) {
            if ("@removed" in user) {
                removedExternalIds.push(user.id);
                continue;
            }
            const existingUser = user as unknown as ExistingGraphUser;

            let email = existingUser.mail ?? existingUser.otherMails[0];

            if (!email) {
                // uPn is formatted with `#EXT#<something>` at the end, we remove that
                const extSuffixRegex = /(\#EXT\#.*$)/;
                const uPnWithoutEXT = existingUser.userPrincipalName.replaceAll(
                    extSuffixRegex,
                    ""
                );

                // split uPn with `_` (Entra `_` replaces `@`)
                let splitted = uPnWithoutEXT.split("_");
                if (splitted.length === 2) {
                    email = splitted.join("@");
                }
            }

            if (!email) {
                logger.warn(
                    `Directory sync: skipping Entra user ${existingUser.userPrincipalName} (id: ${existingUser.id}) for IdP ${idpRes.idp.idpId}: no email found in \`mail\`, \`otherMails\` or \`userPrincipalName\``
                );
            } else {
                directoryUsers[existingUser.id] = {
                    email,
                    externalId: existingUser.id,
                    enabled: existingUser.accountEnabled,
                    name: existingUser.displayName,
                    username: email,
                    groups: []
                };
            }
        }

        for (const group of groupResponse.groups) {
            if ("@removed" in group) {
                continue;
            }

            for (const member of group["members@delta"]) {
                const user = directoryUsers[member.id];
                if (user) {
                    user.groups.push({
                        displayName: group.displayName,
                        id: group.id
                    });
                }
            }
        }

        return {
            kind: "incremental",
            users: Object.entries(directoryUsers).map(([_, user]) => user),
            removedExternalIds,
            nextCursor: null
        };
    }

    async #getToken(idpRes: IdpDbResponse): Promise<string> {
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

    async #fetchAllUsers(token: string, idpId: number) {
        // we need to follow `@odata.nextLink` as-is until it is absent,
        //    the last page returns `@odata.deltaLink` instead
        //    (microsoft graph returns a max of 100 users per page)
        const sp = new URLSearchParams({
            $select:
                "id,displayName,mail,userPrincipalName,accountEnabled,otherMails"
        });
        let nextUrl: string | undefined =
            `${this.#microsoftGraphBaseUrl}/users/delta?${sp.toString()}`;
        let deltaLink: string | null = null;
        const allUsers: MicrosoftGraphUser[] = [];

        while (nextUrl) {
            logger.info(`Fetching URL: ${nextUrl}`);
            const res = await fetch(nextUrl, {
                headers: {
                    Authorization: `Bearer ${token}`
                }
            });

            const body: any = await res.json().catch(() => ({}));
            if (!res.ok) {
                const reason =
                    body.error?.message ??
                    body.error?.code ??
                    res.statusText ??
                    "no error details in response";
                throw new Error(
                    `Directory sync: Entra users request for IdP ${idpId} failed (HTTP ${res.status}): ${reason}`
                );
            }

            try {
                const response = userBodySchema.parse(body);

                allUsers.push(...response.value);
                nextUrl = response["@odata.nextLink"];
                deltaLink = response["@odata.deltaLink"] ?? null;
            } catch (e) {
                console.dir(
                    {
                        body
                    },
                    { depth: null }
                );
                throw new Error(
                    `Directory sync: unexpected Entra users response for IdP ${idpId}: ${fromError(e).toString()}`,
                    { cause: e }
                );
            }
        }

        logger.info(`Fetched ${allUsers.length} users from Microsoft Graph`);
        return {
            deltaLink,
            users: allUsers
        };
    }

    async #fetchAllGroups(token: string, idpId: number) {
        // we need to follow `@odata.nextLink` as-is until it is absent,
        //    the last page returns `@odata.deltaLink` instead
        //    (microsoft graph returns a max of 100 groups per page)
        const sp = new URLSearchParams({
            $select: "id,displayName,members"
        });
        let nextUrl: string | undefined =
            `${this.#microsoftGraphBaseUrl}/groups/delta?${sp.toString()}`;
        let deltaLink: string | null = null;
        const allGroups: MicrosoftGraphGroup[] = [];

        while (nextUrl) {
            logger.info(`Fetching URL: ${nextUrl}`);

            const res = await fetch(nextUrl, {
                headers: {
                    Authorization: `Bearer ${token}`
                }
            });

            const body: any = await res.json().catch(() => ({}));
            if (!res.ok) {
                const reason =
                    body.error?.message ??
                    body.error?.code ??
                    res.statusText ??
                    "no error details in response";
                throw new Error(
                    `Directory sync: Entra groups request for IdP ${idpId} failed (HTTP ${res.status}): ${reason}`
                );
            }

            try {
                const response = groupBodySchema.parse(body);

                allGroups.push(...response.value);
                nextUrl = response["@odata.nextLink"];
                deltaLink = response["@odata.deltaLink"] ?? null;
            } catch (e) {
                console.dir(
                    {
                        body
                    },
                    { depth: null }
                );
                throw new Error(
                    `Directory sync: unexpected Entra groups response for IdP ${idpId}: ${fromError(e).toString()}`,
                    { cause: e }
                );
            }
        }

        logger.info(`Fetched ${allGroups.length} groups from Microsoft Graph`);
        return {
            groups: allGroups,
            deltaLink
        };
    }
    // async #fetchGroupMembers(token: string, groupId: string) {
    //     const userSelect = "id,displayName";

    //     const res = await fetch(
    //         `${this.#microsoftGraphBaseUrl}/groups/${groupId}/transitiveMembers?$select=${userSelect}`,
    //         {
    //             headers: {
    //                 Authorization: `Bearer ${token}`
    //             }
    //         }
    //     );

    //     const body: any = await res.json().catch(() => ({}));
    //     if (!res.ok) {
    //         const reason =
    //             body.error_description ??
    //             body.error ??
    //             res.statusText ??
    //             "no error details in response";
    //         throw new Error(
    //             `Directory sync: Entra fetch user failed (HTTP ${res.status}): ${reason}` // todo: improve
    //         );
    //     }

    //     try {
    //         return groupBodySchema.parse(body).value;
    //     } catch (e) {
    //         throw new Error(
    //             `Directory sync: `, // todo: improve
    //             { cause: e }
    //         );
    //     }
    // }
}

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
