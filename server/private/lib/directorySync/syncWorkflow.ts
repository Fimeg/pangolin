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
import {
    db,
    idp,
    idpOidcConfig,
    idpOrg,
    idpSyncUser,
    users,
    type User
} from "@server/db";

import { durationToMs } from "@app/lib/durationToMs";
import { and, eq, inArray, type InferInsertModel } from "drizzle-orm";
import type { DirectorySyncProvider, DirectoryFetchContext } from "./types";
import { AzureDirectorySyncProvider } from "./azure";
import { parseDirectorySyncRoleMapping } from "@app/lib/idpDirectorySyncRoleMapping";
import { generateId } from "@cli/commands/setAdminCredentials";
import { UserType } from "@server/types/UserTypes";

type InsertUser = InferInsertModel<typeof users>;
type UpdateUser = Omit<InsertUser, "userId">;

// Track if the offline checker interval is running
let directorySyncInterval: NodeJS.Timeout | null = null;
const DIRECTORY_SYNC_RUN_INTERVAL = durationToMs(5, "minutes");

export async function runIdpDirectorySync() {
    // to sync idps, we need
    const idpsToSync = await db
        .select()
        .from(idp)
        .innerJoin(idpOidcConfig, eq(idpOidcConfig.idpId, idp.idpId))
        .innerJoin(idpOrg, and(eq(idpOrg.idpId, idp.idpId)))
        .where(
            and(
                inArray(idpOidcConfig.variant, ["azure", "google"]),
                eq(idp.directorySyncEnabled, true),
                eq(idp.autoProvision, false)
            )
        );

    const azureSyncProvider = new AzureDirectorySyncProvider();
    const fetchPromises = idpsToSync
        .map(({ idp, idpOidcConfig, idpOrg }) => {
            if (idpOidcConfig.variant === "azure") {
                return syncIdp(azureSyncProvider, {
                    idpId: idp.idpId,
                    orgId: idpOrg.orgId,
                    identifierPath: idpOidcConfig.identifierPath,
                    roleMapping: parseDirectorySyncRoleMapping(
                        idpOrg.directoryRoleMapping
                    )
                });
            }
            return null;
        })
        .filter((p) => p != null);

    await Promise.allSettled(fetchPromises);
}

async function syncIdp(
    provider: DirectorySyncProvider,
    ctx: DirectoryFetchContext
) {
    const result = await provider.fetch(ctx);

    const existingUsers = await db
        .select()
        .from(users)
        .where(eq(users.idpId, ctx.idpId));

    const usersToInsert: InsertUser[] = [];

    for (const user of result.users) {
        const userId = generateId(15);
        usersToInsert.push({
            userId,
            username: user.username,
            email: user.email,
            name: user.name,
            type: UserType.OIDC,
            idpId: ctx.idpId,
            emailVerified: true, // OIDC users are always verified
            dateCreated: new Date().toISOString()
        });
    }

    // 1st case: the users don't exist
    await db.transaction(async (trx) => {
        trx.insert(users).values(usersToInsert);
    });

    // ...
    // console.dir(
    //     {
    //         result
    //     },
    //     { depth: null }
    // );
    // await db.select().from(idp)

    return result;
}
