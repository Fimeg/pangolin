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

import { durationToMs } from "@app/lib/durationToMs";
import { and, eq, inArray } from "drizzle-orm";
import type { DirectorySyncProvider, DirectoryFetchContext } from "./types";
import { AzureDirectorySyncProvider } from "./azure";

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
        .map(({ idp, idpOidcConfig }) => {
            if (idpOidcConfig.variant === "azure") {
                return syncIdp(azureSyncProvider, {
                    idpId: idp.idpId,
                    identifierPath: idpOidcConfig.identifierPath,
                    cursor: null
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

    // ...
    console.dir({
        result
    });

    return result;
}
