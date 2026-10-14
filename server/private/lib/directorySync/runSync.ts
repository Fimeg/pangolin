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

// Provider-independent directory sync engine.
//
// 1. Fetch users from the provider (full, or incremental from the stored cursor).
// 2. Resolve each user's roles per org from `idpOrg.directoryRoleMapping`.
// 3. Create/update matching users and their auto-provisioned memberships.
// 4. When `idpOrg.directorySyncDeletions` is on, delete the Pangolin users sync manages that
//    were deleted or disabled in the directory, or no longer match any role mapping.
// 5. Save the provider cursor only once everything above succeeded.

import {
    db,
    idp,
    idpOidcConfig,
    idpOrg,
    idpSyncState,
    idpSyncUser,
    Org,
    orgs,
    roleActions,
    roles,
    userOrgRoles,
    userOrgs,
    users
} from "@server/db";
import { and, eq } from "drizzle-orm";
import logger from "@server/logger";
import { generateId } from "@server/auth/sessions/app";
import { UserType } from "@server/types/UserTypes";
import { LimitId } from "@server/lib/billing";
import { usageService } from "@server/lib/billing/usageService";
import { tierMatrix } from "@server/lib/billing/tierMatrix";
import { calculateUserClientsForOrgs } from "@server/lib/calculateUserClientsForOrgs";
import { assignUserToOrg, removeUserFromOrg } from "@server/lib/userOrg";
import { isLicensedOrSubscribed } from "#dynamic/lib/isLicencedOrSubscribed";
import { defaultRoleAllowedActions } from "@server/routers/role/createRole";
import { lockManager } from "@server/private/lib/lock";
import {
    DirectorySyncRoleMappingConfig,
    parseDirectorySyncRoleMapping
} from "@app/lib/idpDirectorySyncRoleMapping";
import { AzureDirectoryProvider } from "./azure";
import {
    DirectoryCursorExpiredError,
    DirectoryFetchResult,
    DirectoryProvider,
    DirectoryUser
} from "./types";

const LOCK_TTL_MS = 30 * 60 * 1000;
/** Refuse a run that would delete more than this share of the users sync manages... */
const MAX_DELETION_RATIO = 0.5;
/** ...unless it deletes at most this many users. */
const DELETION_RATIO_MIN_USERS = 10;

export type DirectorySyncReport = {
    fetchKind: DirectoryFetchResult["kind"] | null;
    requests: number;
    fetchedUsers: number;
    created: number;
    updated: number;
    deleted: number;
    membershipsRemoved: number;
    skippedNoMatch: number;
    skippedNoIdentifier: number;
    createdRoles: string[];
    missingRoles: string[];
};

type OrgMapping = {
    org: Org;
    config: DirectorySyncRoleMappingConfig;
    syncDeletions: boolean;
    multiRole: boolean;
    /** Lower-cased role name -> role. */
    rolesByName: Map<string, { roleId: number; isAdmin: boolean }>;
};

export async function runDirectorySync(
    idpId: number
): Promise<DirectorySyncReport> {
    return lockManager.withLock(
        `idp-sync:${idpId}`,
        () => runLocked(idpId),
        LOCK_TTL_MS
    );
}

async function runLocked(idpId: number): Promise<DirectorySyncReport> {
    const report: DirectorySyncReport = {
        fetchKind: null,
        requests: 0,
        fetchedUsers: 0,
        created: 0,
        updated: 0,
        deleted: 0,
        membershipsRemoved: 0,
        skippedNoMatch: 0,
        skippedNoIdentifier: 0,
        createdRoles: [],
        missingRoles: []
    };

    const [existingIdp] = await db
        .select()
        .from(idp)
        .innerJoin(idpOidcConfig, eq(idpOidcConfig.idpId, idp.idpId))
        .where(eq(idp.idpId, idpId));

    if (!existingIdp) throw new Error(`IdP ${idpId} not found`);
    if (!existingIdp.idp.directorySyncEnabled) {
        throw new Error(`Directory sync is not enabled for IdP ${idpId}`);
    }
    if (existingIdp.idp.autoProvision) {
        throw new Error(
            `IdP ${idpId} has autoProvision enabled, which is exclusive with directory sync`
        );
    }

    const provider = createProvider(existingIdp.idpOidcConfig);

    const [state] = await db
        .select()
        .from(idpSyncState)
        .where(eq(idpSyncState.idpId, idpId));

    const startedAt = Date.now();
    await db
        .insert(idpSyncState)
        .values({ idpId, lastSyncStartedAt: startedAt })
        .onConflictDoUpdate({
            target: idpSyncState.idpId,
            set: { lastSyncStartedAt: startedAt }
        });

    try {
        const fetchWith = (cursor: string | null) =>
            provider.fetch({
                idpId,
                identifierPath: existingIdp.idpOidcConfig.identifierPath,
                cursor,
                onRequest: () => report.requests++
            });

        let result: DirectoryFetchResult;
        try {
            result = await fetchWith(state?.cursor ?? null);
        } catch (err) {
            if (!(err instanceof DirectoryCursorExpiredError)) throw err;
            logger.info(
                `Directory sync cursor expired for IdP ${idpId}, running a full sync`
            );
            result = await fetchWith(null);
        }

        report.fetchKind = result.kind;
        report.fetchedUsers = result.users.length;

        await applyResult(idpId, result, report);

        await db
            .update(idpSyncState)
            .set({
                cursor: result.nextCursor,
                lastSyncSucceededAt: Date.now(),
                lastError: null,
                consecutiveFailures: 0
            })
            .where(eq(idpSyncState.idpId, idpId));
    } catch (err) {
        await db
            .update(idpSyncState)
            .set({
                lastError: err instanceof Error ? err.message : String(err),
                consecutiveFailures: (state?.consecutiveFailures ?? 0) + 1
            })
            .where(eq(idpSyncState.idpId, idpId));
        throw err;
    }

    logger.info("Directory sync done", { idpId, ...report });
    return report;
}

function createProvider(
    oidcConfig: typeof idpOidcConfig.$inferSelect
): DirectoryProvider {
    switch (oidcConfig.variant) {
        case "azure": {
            const tenantId = AzureDirectoryProvider.tenantIdFromAuthUrl(
                oidcConfig.authUrl
            );
            if (!tenantId) {
                throw new Error("Could not parse Azure tenant ID from authUrl");
            }
            return new AzureDirectoryProvider({
                tenantId,
                encryptedClientId: oidcConfig.clientId,
                encryptedClientSecret: oidcConfig.clientSecret
            });
        }
        default:
            throw new Error(
                `Directory sync is not supported for variant "${oidcConfig.variant}"`
            );
    }
}

async function loadOrgMappings(idpId: number): Promise<OrgMapping[]> {
    const rows = await db
        .select()
        .from(idpOrg)
        .innerJoin(orgs, eq(orgs.orgId, idpOrg.orgId))
        .where(eq(idpOrg.idpId, idpId));

    const mappings: OrgMapping[] = [];
    for (const row of rows) {
        if (!row.idpOrg.directoryRoleMapping) {
            logger.warn(
                `IdP ${idpId} has no directory role mapping for org ${row.orgs.orgId}, skipping that org`
            );
            continue;
        }
        const orgRoles = await db
            .select()
            .from(roles)
            .where(eq(roles.orgId, row.orgs.orgId));

        mappings.push({
            org: row.orgs,
            config: parseDirectorySyncRoleMapping(
                row.idpOrg.directoryRoleMapping
            ),
            syncDeletions: row.idpOrg.directorySyncDeletions,
            multiRole: await isLicensedOrSubscribed(
                row.orgs.orgId,
                tierMatrix.fullRbac
            ),
            rolesByName: new Map(
                orgRoles.map((r) => [
                    r.name.toLowerCase(),
                    { roleId: r.roleId, isAdmin: !!r.isAdmin }
                ])
            )
        });
    }
    return mappings;
}

/** Role IDs the user should have in this org, in mapping order. Empty = no match. */
async function resolveRoleIds(
    mapping: OrgMapping,
    user: DirectoryUser,
    report: DirectorySyncReport
): Promise<number[]> {
    const { config, org } = mapping;
    const roleIds: number[] = [];
    const addRole = (roleId: number) => {
        if (!roleIds.includes(roleId)) roleIds.push(roleId);
    };
    const addByName = (roleName: string) => {
        const role = mapping.rolesByName.get(roleName.toLowerCase());
        if (role) {
            addRole(role.roleId);
        } else if (!report.missingRoles.includes(`${org.orgId}/${roleName}`)) {
            report.missingRoles.push(`${org.orgId}/${roleName}`);
        }
    };

    switch (config.mode) {
        case "fixedRoles":
            config.fixedRoleNames.forEach(addByName);
            break;
        case "groupMapping":
            for (const rule of config.groupRules) {
                const match = rule.group.trim().toLowerCase();
                const isMember = user.groups.some(
                    (g) =>
                        g.id.toLowerCase() === match ||
                        g.displayName?.toLowerCase() === match
                );
                if (isMember) rule.roleNames.forEach(addByName);
            }
            break;
        case "automatic":
            for (const group of user.groups) {
                const name = group.displayName?.trim();
                if (!name) continue;
                const role = mapping.rolesByName.get(name.toLowerCase());
                if (role) {
                    // Never hand out admin roles implicitly from a group name.
                    if (!role.isAdmin) addRole(role.roleId);
                } else if (config.createMissingRoles) {
                    addRole(await createRole(mapping, name, report));
                } else if (
                    !report.missingRoles.includes(`${org.orgId}/${name}`)
                ) {
                    report.missingRoles.push(`${org.orgId}/${name}`);
                }
            }
            break;
    }

    return mapping.multiRole ? roleIds : roleIds.slice(0, 1);
}

async function createRole(
    mapping: OrgMapping,
    name: string,
    report: DirectorySyncReport
): Promise<number> {
    const orgId = mapping.org.orgId;
    const roleId = await db.transaction(async (trx) => {
        const [role] = await trx
            .insert(roles)
            .values({
                orgId,
                name,
                description: "Created by directory sync"
            })
            .returning();
        await trx.insert(roleActions).values(
            defaultRoleAllowedActions.map((actionId) => ({
                roleId: role.roleId,
                actionId,
                orgId
            }))
        );
        return role.roleId;
    });

    mapping.rolesByName.set(name.toLowerCase(), { roleId, isAdmin: false });
    report.createdRoles.push(`${orgId}/${name}`);
    return roleId;
}

async function applyResult(
    idpId: number,
    result: DirectoryFetchResult,
    report: DirectorySyncReport
) {
    const mappings = await loadOrgMappings(idpId);
    if (!mappings.length) {
        throw new Error(
            `IdP ${idpId} has no org with a directory role mapping, nothing to sync`
        );
    }
    // Deleting a user removes it from every org, so every org has to allow it.
    const deletionsEnabled = mappings.every((m) => m.syncDeletions);

    const links = await db
        .select()
        .from(idpSyncUser)
        .where(eq(idpSyncUser.idpId, idpId));
    const userIdByExternalId = new Map(
        links.map((l) => [l.externalId, l.userId])
    );

    // ---- plan: who to upsert, who to delete ----
    const toUpsert: {
        user: DirectoryUser;
        rolesByOrg: Map<string, number[]>;
    }[] = [];
    const toDelete = new Set<string>(); // external IDs

    if (result.kind === "incremental") {
        result.removedExternalIds.forEach((id) => toDelete.add(id));
    } else {
        const seen = new Set(result.users.map((u) => u.externalId));
        for (const externalId of userIdByExternalId.keys()) {
            if (!seen.has(externalId)) toDelete.add(externalId);
        }
    }

    for (const user of result.users) {
        if (!user.enabled) {
            toDelete.add(user.externalId);
            continue;
        }
        if (!user.username) {
            logger.warn(
                `No identifier for directory user ${user.externalId}, skipping`
            );
            report.skippedNoIdentifier++;
            continue;
        }

        const rolesByOrg = new Map<string, number[]>();
        for (const mapping of mappings) {
            const roleIds = await resolveRoleIds(mapping, user, report);
            if (roleIds.length) rolesByOrg.set(mapping.org.orgId, roleIds);
        }

        if (!rolesByOrg.size) {
            report.skippedNoMatch++;
            toDelete.add(user.externalId);
            continue;
        }
        toUpsert.push({ user, rolesByOrg });
    }

    // Only users sync manages can be deleted.
    const deleteUserIds = deletionsEnabled
        ? [...toDelete]
              .map((externalId) => userIdByExternalId.get(externalId))
              .filter((userId): userId is string => !!userId)
        : [];

    if (
        deleteUserIds.length > DELETION_RATIO_MIN_USERS &&
        deleteUserIds.length > userIdByExternalId.size * MAX_DELETION_RATIO
    ) {
        throw new Error(
            `Refusing to delete ${deleteUserIds.length} of ${userIdByExternalId.size} synced users in one run`
        );
    }

    // ---- apply ----
    const touchedOrgIds = new Set<string>();
    const touchedUserIds = new Set<string>();

    for (const { user, rolesByOrg } of toUpsert) {
        const userId = await upsertUser(
            idpId,
            user,
            userIdByExternalId.get(user.externalId),
            report
        );
        touchedUserIds.add(userId);

        await db.transaction(async (trx) => {
            const currentUserOrgs = await trx
                .select()
                .from(userOrgs)
                .where(eq(userOrgs.userId, userId));

            for (const mapping of mappings) {
                const orgId = mapping.org.orgId;
                const roleIds = rolesByOrg.get(orgId) ?? [];
                const current = currentUserOrgs.find((o) => o.orgId === orgId);

                if (!current) {
                    if (!roleIds.length) continue;
                    await assignUserToOrg(
                        mapping.org,
                        { orgId, userId, autoProvisioned: true },
                        roleIds,
                        trx
                    );
                    touchedOrgIds.add(orgId);
                    continue;
                }

                // Memberships added by hand are never changed by sync.
                if (!current.autoProvisioned) continue;

                if (!roleIds.length) {
                    if (mapping.syncDeletions) {
                        await removeUserFromOrg(mapping.org, userId, trx);
                        report.membershipsRemoved++;
                        touchedOrgIds.add(orgId);
                    }
                    continue;
                }

                await trx
                    .delete(userOrgRoles)
                    .where(
                        and(
                            eq(userOrgRoles.userId, userId),
                            eq(userOrgRoles.orgId, orgId)
                        )
                    );
                await trx
                    .insert(userOrgRoles)
                    .values(
                        roleIds.map((roleId) => ({ userId, orgId, roleId }))
                    );
            }
        });
    }

    for (const userId of deleteUserIds) {
        const [user] = await db
            .select()
            .from(users)
            .where(and(eq(users.userId, userId), eq(users.idpId, idpId)));
        if (!user) continue;
        if (user.serverAdmin) {
            logger.warn(
                `Directory sync won't delete server admin ${user.username}`
            );
            continue;
        }

        const memberships = await db
            .select()
            .from(userOrgs)
            .where(eq(userOrgs.userId, userId));
        memberships.forEach((m) => touchedOrgIds.add(m.orgId));

        // Cascades to sessions, memberships and the idpSyncUser link.
        await db.delete(users).where(eq(users.userId, userId));
        touchedUserIds.add(userId);
        report.deleted++;
    }

    for (const orgId of touchedOrgIds) {
        const members = await db
            .select()
            .from(userOrgs)
            .where(eq(userOrgs.orgId, orgId));
        await usageService.updateCount(orgId, LimitId.USERS, members.length);
    }

    for (const userId of touchedUserIds) {
        await calculateUserClientsForOrgs(userId).catch((err) =>
            logger.error("Error calculating user clients after sync", {
                userId,
                error: err
            })
        );
    }
}

/**
 * Create or update the Pangolin user for a directory user and make sure it is linked.
 * An existing user of this IdP with the same username (e.g. created by an earlier login)
 * is adopted instead of duplicated.
 */
async function upsertUser(
    idpId: number,
    user: DirectoryUser,
    linkedUserId: string | undefined,
    report: DirectorySyncReport
): Promise<string> {
    const username = user.username!;

    return db.transaction(async (trx) => {
        let [existing] = linkedUserId
            ? await trx
                  .select()
                  .from(users)
                  .where(
                      and(
                          eq(users.userId, linkedUserId),
                          eq(users.idpId, idpId)
                      )
                  )
            : [];
        if (!existing) {
            [existing] = await trx
                .select()
                .from(users)
                .where(
                    and(eq(users.username, username), eq(users.idpId, idpId))
                );
        }

        let userId: string;
        if (existing) {
            userId = existing.userId;
            await trx
                .update(users)
                .set({ username, email: user.email, name: user.name })
                .where(eq(users.userId, userId));
            report.updated++;
        } else {
            userId = generateId(15);
            await trx.insert(users).values({
                userId,
                username,
                email: user.email,
                name: user.name,
                type: UserType.OIDC,
                idpId,
                emailVerified: true,
                dateCreated: new Date().toISOString()
            });
            report.created++;
        }

        if (linkedUserId !== userId) {
            await trx
                .insert(idpSyncUser)
                .values({ idpId, externalId: user.externalId, userId })
                .onConflictDoUpdate({
                    target: [idpSyncUser.idpId, idpSyncUser.externalId],
                    set: { userId }
                });
        }
        return userId;
    });
}
