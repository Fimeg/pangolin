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
    roles,
    userOrgs,
    users,
    type Role
} from "@server/db";

import { durationToMs } from "@app/lib/durationToMs";
import {
    parseDirectorySyncRoleMapping,
    type DirectorySyncRoleMappingConfig
} from "@app/lib/idpDirectorySyncRoleMapping";
import { generateId } from "@server/auth/sessions/app";
import { UserType } from "@server/types/UserTypes";
import {
    and,
    eq,
    inArray,
    type InferInsertModel,
    type InferSelectModel
} from "drizzle-orm";
import { AzureDirectorySyncProvider } from "./azure";
import type {
    DirectoryFetchContext,
    DirectorySyncProvider,
    DirectoryUser
} from "./types";

type InsertUser = InferInsertModel<typeof users>;
type UpdateUser = Pick<InsertUser, "username" | "email" | "name" | "userId">;

type SyncedUser<T> = {
    user: T;
    /** Roles the user should have in `orgId` after the sync. */
    roleIds: number[];
};

// the planned changes for one idpOrg, computed first and
// applied in a single transaction at the end
export type IdpOrgSyncPlan = {
    idpId: number;
    orgId: string;
    usersToCreate: SyncedUser<InsertUser>[];
    usersToUpdate: SyncedUser<UpdateUser>[];
    /** Users still in Pangolin but gone from the directory (or no longer matching any role); removed from the org, not deleted. */
    userIdsToRemoveFromOrg: string[];
};

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

    return await Promise.allSettled(fetchPromises);
}

async function syncIdp(
    provider: DirectorySyncProvider,
    ctx: DirectoryFetchContext
) {
    // Note
    // username is unique only within IDPs or within internal ?
    // we can have two users with the same username, one in an IDP and another `internal`
    // Which means: a user can have two accounts w/ the same username (email in azure for ex)
    // and each account can have different roles within the same Org

    // ...
    // Later: we might need to change the `identifierPath` for azure/google idps to `sub` (for ex)
    // which is an immutable external ID that survives username/email changes
    // but first we need to check if that ID is the same returned by Entra/google workspace
    // if it's not the same ID, we might kepp `idpSyncUser` otherwise, we may need to see how
    // we can maybe get rid of that table (or just not need it anymore)

    // ...
    // For global idps, we will rely on org policies
    // we will not store a default mapping for directory sync
    // if the admin wants to add the synched IDP to an org, they can create an org policy
    // & set the role mapping to `automatic` (for ex)
    // for global idps, if there is not an org policy for a specific org, the user is not added to that org

    // 1. Fetch
    const result = await provider.fetch(ctx);

    /**
     * user =>
     *  user (has roles within) - org
     *
     * algorithm:

        fetch users for org:
            - if user is new to pangolin and idp:
                - if fixed roles:
                    -> create new user in DB
                - if group mapping:
                    - check that the user groups match at least one of the mapped groups:
                        -> create new user in DB
                - if automatic groups:
                    - if create:
                        -> create new user in DB
                    - if not create:
                        - check that group names matches:
                            -> create new user in DB
                
                -> Add user to Org with the correct roles

            - if user is not new to pangolin and idp:
                - if fixed roles or automatic groups with create :
                    - if user doesn't belongs to org:
                        -> add user to org with the correct roles
                    - else:
                        -> update user roles in org
                - if group mapping matches any role: 
                    -> update user roles in org
                - if automatic groups without create still matches groups:
                    -> update user roles in org
                - else:
                    -> remove user from org
            
            - if user exists in pangolin & IDP but not in remote users:
                -> remove user from org

for each remote user:
    roleIds = resolveRoles(user, ctx.roleMapping)   // fixed / group mapping / automatic
                                                    // [] = user doesn't qualify for this org
    if user is disabled: roleIds = []

    pangolinUser = match by externalUserId, then username
    if no pangolinUser:
        if roleIds empty: skip
        create user
    else:
        update profile (name, email, username)       // user-level, always safe

    membership = userOrg for (pangolinUser, orgId)
    if no membership:
        if roleIds non-empty: add to org with roleIds, flag = true
    else if membership.flag is true:
        if roleIds non-empty: set roles to roleIds
        else:                 remove from org
    else (manual membership):
        skip                                         // admin-owned, don't touch

for each membership with flag = true whose user is not in the remote set:
    remove from org                                  // user row stays (may be in other orgs)

     
                */

    const existingUsers = await db
        .select()
        .from(users)
        .where(eq(users.idpId, ctx.idpId));

    const existingUserOrgs = await db
        .select()
        .from(users)
        .innerJoin(userOrgs, eq(userOrgs.userId, users.userId))
        .where(and(eq(users.idpId, ctx.idpId), eq(userOrgs.orgId, ctx.orgId)));

    const existingPangolinUsers = new Map<
        string,
        (typeof existingUsers)[number]
    >();
    for (const u of existingUsers) {
        // rely on the external ID in the tenant if it exists, else use the username
        if (u.externalUserId) {
            existingPangolinUsers.set(u.externalUserId, u);
        } else {
            existingPangolinUsers.set(u.username, u);
        }
    }

    const syncPlan: IdpOrgSyncPlan = {
        idpId: ctx.idpId,
        orgId: ctx.orgId,
        usersToCreate: [],
        usersToUpdate: [],
        userIdsToRemoveFromOrg: []
    };

    // for (const user of result.users) {
    //     const existing = map.get(user.externalId) ?? map.get(user.username);
    //     if (existing) {
    //         usersToUpdate.push({
    //             username: user.username,
    //             email: user.email,
    //             name: user.name,
    //             userId: existing.userId
    //         });
    //     } else {
    //         const userId = generateId(15);
    //         usersToInsert.push({
    //             userId,
    //             username: user.username,
    //             email: user.email,
    //             name: user.name,
    //             type: UserType.OIDC,
    //             idpId: ctx.idpId,
    //             emailVerified: true, // OIDC users are always verified
    //             dateCreated: new Date().toISOString()
    //         });
    //     }
    // }

    // await db.transaction(async (trx) => {
    //     await trx.insert(users).values(usersToInsert);

    //     await Promise.all(
    //         usersToUpdate.map((u) =>
    //             trx.update(users).set(u).where(eq(users.userId, u.userId))
    //         )
    //     );
    // });

    // ...
    // console.dir(
    //     {
    //         result
    //     },
    //     { depth: null }
    // );
    // await db.select().from(idp)

    return syncPlan;
}

async function resolveUserRoles(
    user: DirectoryUser,
    roleMapping: DirectorySyncRoleMappingConfig,
    orgId: string
) {
    if (!user.enabled) return [];

    let matchedRoles: Role[] = [];

    switch (roleMapping.mode) {
        case "fixedRoles": {
            if (roleMapping.fixedRoleNames.length > 0) {
                matchedRoles = await db
                    .select()
                    .from(roles)
                    .where(
                        and(
                            eq(roles.orgId, orgId),
                            inArray(roles.name, roleMapping.fixedRoleNames)
                        )
                    );
            }
            break;
        }
        case "groupMapping": {
            const roleNames: string[] = [];
            const groupMapping = new Map(
                roleMapping.groupRules.map((rule) => [
                    rule.group,
                    rule.roleNames
                ])
            );

            for (const group of user.groups) {
                let roles: string[] = [];
                if (group.displayName) {
                    roles =
                        groupMapping.get(group.displayName) ??
                        groupMapping.get(group.id) ??
                        [];
                } else {
                    roles =
                        groupMapping.get(group.displayName ?? group.id) ?? [];
                }
                roleNames.push(...roles);
            }

            if (roleNames.length > 0) {
                matchedRoles = await db
                    .select()
                    .from(roles)
                    .where(
                        and(
                            eq(roles.orgId, orgId),
                            inArray(roles.name, roleNames)
                        )
                    );
            }
            break;
        }
        case "automatic":
            break;
    }

    return matchedRoles.map((role) => role.roleId);
}
