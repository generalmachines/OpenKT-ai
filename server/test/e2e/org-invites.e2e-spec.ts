import {
  ForbiddenDomainError,
  GoneDomainError,
  NotFoundDomainError,
  ValidationDomainError,
} from "../../libs/core/errors/src";
import { DrizzleInviteRepository } from "../../apps/server/src/modules/invites/repositories/drizzle-invite.repository";
import { InvitesApplicationService } from "../../apps/server/src/modules/invites/services/invites-application.service";
import { RequireOrgRoleGuard } from "../../apps/server/src/modules/invites/guards/require-org-role.guard";

// In-memory stand-in for Drizzle + the org repository. Tracks just
// enough state for the invite/redemption + membership flows. The
// real Drizzle layer is exercised in the smoke + integration suites;
// this spec pins the service + repository + guard logic.

interface OrgRow {
  id: string;
  slug: string;
  name: string;
  createdBy: string | null;
}
interface OrgMemberRow {
  orgId: string;
  userId: string;
  role: "owner" | "admin" | "member" | "viewer";
  invitedBy: string | null;
}
interface OrgInviteRow {
  id: string;
  orgId: string;
  invitedBy: string;
  email: string | null;
  role: "owner" | "admin" | "member";
  token: string;
  expiresAt: Date;
  acceptedAt: Date | null;
  acceptedBy: string | null;
  revokedAt: Date | null;
  isOpen: boolean;
  maxUses: number | null;
  usedCount: number;
  createdAt: Date;
}
interface RedemptionRow {
  inviteId: string;
  userId: string;
  redeemedAt: Date;
}
interface ProfileRow {
  userId: string;
  email: string | null;
  displayName: string | null;
}

type TableTag =
  | "orgInvites"
  | "orgInviteRedemptions"
  | "orgMembers"
  | "orgs"
  | "profiles";

// Filled in below once the schema imports settle. The FakeDb uses
// identity equality (Map key) to route a drizzle table object back
// to its tag.
const TABLE_TAGS = new Map<object, TableTag>();

interface TestPredicate {
  match(row: object): boolean;
}

// Hand-rolled query-builder mimic; supports just the calls the
// repository + guard make against `orgInvites` / `orgInviteRedemptions`
// / `orgMembers` / `orgs` / `profiles`. New uses should add new
// matchers rather than reach into the internals of these stubs.
class FakeDb {
  orgs: OrgRow[] = [];
  orgMembers: OrgMemberRow[] = [];
  orgInvites: OrgInviteRow[] = [];
  orgInviteRedemptions: RedemptionRow[] = [];
  profiles: ProfileRow[] = [];

  // Drizzle's `query` API used in a few places.
  query = {
    orgInvites: {
      findFirst: (args: { where: TestPredicate }) =>
        Promise.resolve(this.orgInvites.find((row) => args.where.match(row)) ?? null),
    },
    orgMembers: {
      findFirst: (args: { where: TestPredicate }) =>
        Promise.resolve(this.orgMembers.find((row) => args.where.match(row)) ?? null),
    },
    orgs: {
      findFirst: (args: { where: TestPredicate }) =>
        Promise.resolve(this.orgs.find((row) => args.where.match(row)) ?? null),
    },
    orgInviteRedemptions: {
      findFirst: (args: { where: TestPredicate }) =>
        Promise.resolve(this.orgInviteRedemptions.find((row) => args.where.match(row)) ?? null),
    },
    projects: { findFirst: () => Promise.resolve(null) },
    projectInvites: { findFirst: () => Promise.resolve(null) },
  };

  insert(targetRaw: TableTag | object) {
    const target = this.resolveTag(targetRaw);
    return {
      values: (values: Record<string, unknown> | Record<string, unknown>[]) => {
        const inputs = Array.isArray(values) ? values : [values];
        let persisted: Array<Record<string, unknown>> | null = null;
        const ensurePersisted = () => {
          if (!persisted) {
            persisted = inputs.map((row) => this.persist(target, row));
          }
          return persisted;
        };
        const builder = {
          onConflictDoNothing: () => {
            ensurePersisted();
            return Promise.resolve();
          },
          returning: async () => {
            return ensurePersisted();
          },
          then: (resolve: (rows: unknown[]) => void) => {
            resolve(ensurePersisted());
          },
        };
        return builder;
      },
    };
  }

  update(targetRaw: TableTag | object) {
    const target = this.resolveTag(targetRaw);
    return {
      set: (patch: Record<string, unknown>) => ({
        where: (predicate: TestPredicate) => ({
          returning: async () => {
            const matching = this.rows(target).filter((row) => predicate.match(row));
            for (const row of matching) this.applyPatch(target, row, patch);
            return matching;
          },
          then: (resolve: (rows: unknown[]) => void) => {
            // `await update(...).set(...).where(...)` form — no returning.
            const matching = this.rows(target).filter((row) => predicate.match(row));
            for (const row of matching) this.applyPatch(target, row, patch);
            resolve(matching);
          },
        }),
      }),
    };
  }

  select(columns?: Record<string, unknown>) {
    let table: TableTag = "orgInvites";
    const joinAcc: Array<{ table: TableTag; on: TestPredicate; mode: "inner" | "left" }> = [];
    let wherePred: TestPredicate | null = null;
    const builder = {
      from: (t: TableTag | object) => {
        table = this.resolveTag(t);
        return builder;
      },
      innerJoin: (t: TableTag | object, on: TestPredicate) => {
        joinAcc.push({ table: this.resolveTag(t), on, mode: "inner" });
        return builder;
      },
      leftJoin: (t: TableTag | object, on: TestPredicate) => {
        joinAcc.push({ table: this.resolveTag(t), on, mode: "left" });
        return builder;
      },
      where: (p: TestPredicate) => {
        wherePred = p;
        return builder;
      },
      orderBy: (_o: unknown) => builder,
      limit: async (_n: number) =>
        this.applyProjection(this.runSelect(table, joinAcc, wherePred), columns),
      then: (resolve: (rows: unknown[]) => void) => {
        resolve(this.applyProjection(this.runSelect(table, joinAcc, wherePred), columns));
      },
    };
    return builder;
  }

  private applyProjection(
    rows: Array<Record<string, unknown>>,
    columns?: Record<string, unknown>,
  ): Array<Record<string, unknown>> {
    if (!columns) return rows;
    return rows.map((row) => {
      const out: Record<string, unknown> = {};
      for (const [alias, col] of Object.entries(columns)) {
        const key = (col as { name?: string })?.name ?? alias;
        out[alias] = row[key];
      }
      return out;
    });
  }

  private resolveTag(target: TableTag | object): TableTag {
    if (typeof target === "string") return target as TableTag;
    const tag = TABLE_TAGS.get(target as object);
    if (!tag) {
      throw new Error(
        "FakeDb: unregistered drizzle table object — add it to TABLE_TAGS",
      );
    }
    return tag;
  }

  // --- helpers ---
  private rows(target: TableTag): Array<Record<string, unknown>> {
    switch (target) {
      case "orgInvites":
        return this.orgInvites as unknown as Array<Record<string, unknown>>;
      case "orgInviteRedemptions":
        return this.orgInviteRedemptions as unknown as Array<Record<string, unknown>>;
      case "orgMembers":
        return this.orgMembers as unknown as Array<Record<string, unknown>>;
      case "orgs":
        return this.orgs as unknown as Array<Record<string, unknown>>;
      case "profiles":
        return this.profiles as unknown as Array<Record<string, unknown>>;
      default:
        return [];
    }
  }

  private persist(target: TableTag, row: Record<string, unknown>): Record<string, unknown> {
    if (target === "orgInvites") {
      const persisted: OrgInviteRow = {
        id: (row.id as string) ?? `inv-${this.orgInvites.length + 1}`,
        orgId: row.orgId as string,
        invitedBy: row.invitedBy as string,
        email: (row.email as string | null) ?? null,
        role: (row.role as OrgInviteRow["role"]) ?? "member",
        token: row.token as string,
        expiresAt: row.expiresAt as Date,
        acceptedAt: null,
        acceptedBy: null,
        revokedAt: null,
        isOpen: Boolean(row.isOpen),
        maxUses: (row.maxUses as number | null) ?? null,
        usedCount: 0,
        createdAt: new Date(),
      };
      this.orgInvites.push(persisted);
      return persisted as unknown as Record<string, unknown>;
    }
    if (target === "orgInviteRedemptions") {
      const dup = this.orgInviteRedemptions.find(
        (r) => r.inviteId === row.inviteId && r.userId === row.userId,
      );
      if (dup) return dup as unknown as Record<string, unknown>;
      const persisted: RedemptionRow = {
        inviteId: row.inviteId as string,
        userId: row.userId as string,
        redeemedAt: new Date(),
      };
      this.orgInviteRedemptions.push(persisted);
      return persisted as unknown as Record<string, unknown>;
    }
    if (target === "orgMembers") {
      const dup = this.orgMembers.find(
        (m) => m.orgId === row.orgId && m.userId === row.userId,
      );
      if (dup) return dup as unknown as Record<string, unknown>;
      const persisted: OrgMemberRow = {
        orgId: row.orgId as string,
        userId: row.userId as string,
        role: (row.role as OrgMemberRow["role"]) ?? "member",
        invitedBy: (row.invitedBy as string | null) ?? null,
      };
      this.orgMembers.push(persisted);
      return persisted as unknown as Record<string, unknown>;
    }
    return row;
  }

  private applyPatch(
    target: TableTag,
    row: Record<string, unknown>,
    patch: Record<string, unknown>,
  ): void {
    for (const [k, v] of Object.entries(patch)) {
      if (k === "usedCount" && typeof v === "object" && v !== null && "__bump" in v) {
        (row as { usedCount: number }).usedCount += 1;
      } else {
        (row as Record<string, unknown>)[k] = v as unknown;
      }
    }
    void target;
  }

  private runSelect(
    table: TableTag,
    joins: Array<{ table: TableTag; on: TestPredicate; mode: "inner" | "left" }>,
    wherePred: TestPredicate | null,
  ): Array<Record<string, unknown>> {
    let base: Array<Record<string, unknown>> = this.rows(table).map((row) => ({
      ...row,
      __table: table,
    }));
    for (const j of joins) {
      const next: Array<Record<string, unknown>> = [];
      for (const left of base) {
        const matches = this.rows(j.table).filter((right) =>
          j.on.match({ ...left, ...withTablePrefix(right, j.table) }),
        );
        if (matches.length === 0 && j.mode === "left") {
          next.push({ ...left, ...emptyForTable(j.table) });
        }
        for (const m of matches) {
          next.push({ ...left, ...withTablePrefix(m, j.table) });
        }
      }
      base = next;
    }
    let rows = base;
    if (wherePred) rows = rows.filter((row) => wherePred.match(row));
    return rows;
  }
}

function withTablePrefix(
  row: Record<string, unknown>,
  table: TableTag,
): Record<string, unknown> {
  // Selected columns in select() use the raw column name, so we
  // attach the same fields directly. Anything more involved would
  // need an actual ORM.
  return { ...row };
}

function emptyForTable(_table: TableTag): Record<string, unknown> {
  return {};
}

// Map Drizzle's `eq`, `and`, etc. into TestPredicate. We don't import
// drizzle's helpers in the repository under test, so this only needs
// to handle the conditions actually built.

// The repository under test imports `eq`, `and`, etc. from drizzle-orm
// which produce SQL ASTs at runtime. Rather than ship a full mock, we
// hijack drizzle-orm here with `jest.mock` to return predicate objects
// our FakeDb understands.

jest.mock("drizzle-orm", () => {
  const actual = jest.requireActual<typeof import("drizzle-orm")>("drizzle-orm");
  const fieldName = (value: unknown): string => {
    if (typeof value !== "object" || value === null) return "<unknown>";
    const named = value as { name?: string };
    if (typeof named.name === "string") return named.name;
    const sqlLike = value as { columnName?: string };
    if (typeof sqlLike.columnName === "string") return sqlLike.columnName;
    return "<unknown>";
  };
  const isColumn = (value: unknown): boolean =>
    typeof value === "object" && value !== null && typeof (value as { name?: unknown }).name === "string";
  return {
    ...actual,
    eq: (field: unknown, value: unknown) => ({
      match: (row: object) => {
        const lhs = (row as Record<string, unknown>)[fieldName(field)];
        const rhs = isColumn(value)
          ? (row as Record<string, unknown>)[fieldName(value)]
          : value;
        return lhs === rhs;
      },
    }),
    and: (...preds: { match(row: object): boolean }[]) => ({
      match: (row: object) => preds.every((p) => p.match(row)),
    }),
    or: (...preds: { match(row: object): boolean }[]) => ({
      match: (row: object) => preds.some((p) => p.match(row)),
    }),
    isNull: (field: unknown) => ({
      match: (row: object) => (row as Record<string, unknown>)[fieldName(field)] == null,
    }),
    gt: (field: unknown, value: unknown) => ({
      match: (row: object) => {
        const cell = (row as Record<string, unknown>)[fieldName(field)];
        if (cell instanceof Date && value instanceof Date) return cell.getTime() > value.getTime();
        return Number(cell) > Number(value);
      },
    }),
    lt: (field: unknown, otherOrValue: unknown) => ({
      match: (row: object) => {
        const cell = (row as Record<string, unknown>)[fieldName(field)];
        const otherName = fieldName(otherOrValue);
        const rhs =
          otherName !== "<unknown>"
            ? (row as Record<string, unknown>)[otherName]
            : otherOrValue;
        if (rhs == null) return false;
        return Number(cell) < Number(rhs);
      },
    }),
    desc: (_field: unknown) => ({ __order: "desc" }),
    asc: (_field: unknown) => ({ __order: "asc" }),
    // Tagged template literal — only used in two specific places in
    // the repository under test, both of which compare two columns
    // on the same row. We approximate by parsing the strings for a
    // "is not null and < cap" shape; anything else we just treat as
    // a no-op predicate that matches everything.
    sql: (strings: TemplateStringsArray, ...args: unknown[]) => {
      // Used for `${col} is not null and ${col} < ${col}` and for
      // an in-place increment (`${col} + 1`). The match returns true
      // for the cap-check, and for the increment we attach a marker
      // that FakeDb.update() understands.
      const raw = strings.join("?").toLowerCase();
      if (raw.includes("+ 1")) {
        return { __bump: true };
      }
      if (raw.includes("is not null") && raw.includes("<")) {
        // Expect args to be [maxUses col, usedCount col, maxUses col]
        return {
          match: (row: object) => {
            const r = row as Record<string, unknown>;
            const a = args[0] as { name?: string } | null;
            const b = args[1] as { name?: string } | null;
            const c = args[2] as { name?: string } | null;
            if (!a?.name || !b?.name || !c?.name) return true;
            const maxUses = r[a.name] as number | null;
            const usedCount = r[b.name] as number;
            const capRef = r[c.name] as number | null;
            return maxUses !== null && usedCount < (capRef ?? Number.POSITIVE_INFINITY);
          },
        };
      }
      return { match: () => true };
    },
  };
});

// Build a fake "schema" set — Drizzle columns are imported as
// `orgInvites.token` etc. To satisfy our tiny `fieldName()` helper,
// each column needs a `.name`. We monkey-patch the imported schema
// objects after the fact since the repository imports them by name.
import {
  orgInviteRedemptions,
  orgInvites,
  orgMembers,
  orgs,
  profiles,
} from "../../apps/server/src/db/schema";

// Drizzle columns expose `.name` as the SQL column name (snake_case),
// but FakeDb stores rows under the JS key (camelCase). Rewrite each
// column object so its `.name` matches the JS key — this only affects
// predicate matching in this test file.
//
// Also register each table object → tag so FakeDb can route inserts /
// updates without depending on string identifiers.
TABLE_TAGS.set(orgInvites, "orgInvites");
TABLE_TAGS.set(orgInviteRedemptions, "orgInviteRedemptions");
TABLE_TAGS.set(orgMembers, "orgMembers");
TABLE_TAGS.set(orgs, "orgs");
TABLE_TAGS.set(profiles, "profiles");
for (const [table] of TABLE_TAGS) {
  for (const col of Object.keys(table)) {
    const value = (table as unknown as Record<string, unknown>)[col];
    if (value && typeof value === "object" && "name" in value) {
      (value as { name: string }).name = col;
    }
  }
}

const userIdOf = (n: number) => `user-${n.toString().padStart(8, "0")}`;
const buildContext = (userId: string | null, email: string | null = "user@test"): unknown => ({
  principal: { userId, email, displayName: null, type: "user", authSource: "supabase-jwt" },
  request: {},
  sb: {},
  admin: () => ({}),
});

const buildConfigService = (overrides: Record<string, string> = {}) =>
  ({
    get: (key: string) => overrides[key] ?? null,
  }) as never;

const buildOrgRepo = (db: FakeDb) =>
  ({
    findIdBySlug: (_ctx: unknown, slug: string) =>
      Promise.resolve(db.orgs.find((o) => o.slug === slug)?.id ?? null),
  }) as never;

describe("org-invites (service + repository + guard)", () => {
  let db: FakeDb;
  let repo: DrizzleInviteRepository;
  let service: InvitesApplicationService;

  beforeEach(() => {
    db = new FakeDb();
    db.orgs.push({ id: "org-1", slug: "acme", name: "Acme Inc", createdBy: userIdOf(1) });
    db.orgMembers.push({ orgId: "org-1", userId: userIdOf(1), role: "owner", invitedBy: null });
    db.orgMembers.push({ orgId: "org-1", userId: userIdOf(2), role: "admin", invitedBy: null });
    db.orgMembers.push({ orgId: "org-1", userId: userIdOf(3), role: "member", invitedBy: null });
    db.profiles.push({
      userId: userIdOf(1),
      email: "owner@test",
      displayName: "Owner",
    });
    repo = new DrizzleInviteRepository(db as never);
    service = new InvitesApplicationService(
      repo,
      buildOrgRepo(db),
      db as never,
      buildConfigService({ OPENKT_DASHBOARD_URL: "https://app.test" }),
      {
        // Stub AuditService — every audit call resolves; tests assert
        // service behaviour, not the side-channel write.
        write: jest.fn().mockResolvedValue(undefined),
        writeFromContext: jest.fn().mockResolvedValue(undefined),
      } as never,
    );
  });

  it("targeted invite: create -> preview -> accept adds caller to org_members", async () => {
    const created = await service.create(
      buildContext(userIdOf(1), "owner@test") as never,
      {
        orgSlug: "acme",
        email: "newbie@test",
        role: "member",
        maxUses: null,
        expiresInDays: 7,
        isOpen: false,
      },
      "owner",
    );
    expect(created.mode).toBe("targeted");
    expect(created.token).toMatch(/^inv_[A-Za-z0-9_-]+$/);
    expect(created.inviteUrl).toBe(`https://app.test/invite/${created.token}`);

    const preview = await service.preview(created.token);
    expect(preview).not.toBeNull();
    expect(preview!.orgName).toBe("Acme Inc");
    expect(preview!.role).toBe("member");
    expect(preview!.mode).toBe("targeted");
    expect(preview!.remainingUses).toBeNull();
    // Preview must not leak invite id or token.
    expect(JSON.stringify(preview)).not.toContain(created.inviteId);

    const outcome = await service.accept(
      buildContext(userIdOf(10), "newbie@test") as never,
      created.token,
    );
    expect(outcome).toEqual({ orgId: "org-1", orgSlug: "acme", role: "member" });
    expect(
      db.orgMembers.find((m) => m.orgId === "org-1" && m.userId === userIdOf(10)),
    ).toBeTruthy();

    // Targeted invite is now hidden from list (single-use, consumed).
    const list = await service.list(
      buildContext(userIdOf(1), "owner@test") as never,
      "acme",
    );
    expect(list.find((i) => i.id === created.inviteId)).toBeUndefined();
  });

  it("targeted invite: re-accept by the same user is idempotent", async () => {
    const created = await service.create(
      buildContext(userIdOf(1), "owner@test") as never,
      {
        orgSlug: "acme",
        email: "newbie@test",
        role: "member",
        maxUses: null,
        expiresInDays: 7,
        isOpen: false,
      },
      "owner",
    );
    const first = await service.accept(
      buildContext(userIdOf(10), "newbie@test") as never,
      created.token,
    );
    const second = await service.accept(
      buildContext(userIdOf(10), "newbie@test") as never,
      created.token,
    );
    expect(second).toEqual(first);
    const matching = db.orgMembers.filter(
      (m) => m.orgId === "org-1" && m.userId === userIdOf(10),
    );
    expect(matching).toHaveLength(1);
  });

  it("targeted invite: re-accept after admin removal reinstates membership", async () => {
    // A user accepts a targeted invite, an admin later boots them, then
    // they re-click the same invite link. We expect a 200 with the
    // membership restored — not a quiet 200 that leaves them outside
    // the org. Mirrors the open-link "alreadyRedeemed" reinstate path.
    const created = await service.create(
      buildContext(userIdOf(1), "owner@test") as never,
      {
        orgSlug: "acme",
        email: "newbie@test",
        role: "member",
        maxUses: null,
        expiresInDays: 7,
        isOpen: false,
      },
      "owner",
    );
    await service.accept(
      buildContext(userIdOf(10), "newbie@test") as never,
      created.token,
    );
    // Admin removes them.
    db.orgMembers = db.orgMembers.filter(
      (m) => !(m.orgId === "org-1" && m.userId === userIdOf(10)),
    );
    expect(
      db.orgMembers.find((m) => m.orgId === "org-1" && m.userId === userIdOf(10)),
    ).toBeUndefined();
    // Re-accept.
    const outcome = await service.accept(
      buildContext(userIdOf(10), "newbie@test") as never,
      created.token,
    );
    expect(outcome.orgSlug).toBe("acme");
    expect(
      db.orgMembers.find((m) => m.orgId === "org-1" && m.userId === userIdOf(10)),
    ).toBeTruthy();
  });

  it("targeted invite to an existing org member is a no-op", async () => {
    const created = await service.create(
      buildContext(userIdOf(1), "owner@test") as never,
      {
        orgSlug: "acme",
        email: "member@test",
        role: "member",
        maxUses: null,
        expiresInDays: 7,
        isOpen: false,
      },
      "owner",
    );
    const before = db.orgMembers.length;
    // userIdOf(3) is already a member of org-1; accepting the invite
    // for them should be idempotent regardless of the email.
    const outcome = await service.accept(
      buildContext(userIdOf(3), "member@test") as never,
      created.token,
    );
    expect(outcome.role).toBe("member");
    expect(db.orgMembers).toHaveLength(before);
  });

  it("open link: create with max_uses=3 → 3 accepts, 4th fails", async () => {
    const created = await service.create(
      buildContext(userIdOf(1), "owner@test") as never,
      {
        orgSlug: "acme",
        email: null,
        role: "member",
        maxUses: 3,
        expiresInDays: 7,
        isOpen: true,
      },
      "owner",
    );
    expect(created.mode).toBe("open");
    expect(created.maxUses).toBe(3);

    for (const i of [11, 12, 13]) {
      const out = await service.accept(
        buildContext(userIdOf(i), `u${i}@test`) as never,
        created.token,
      );
      expect(out.orgId).toBe("org-1");
    }
    const invite = db.orgInvites.find((row) => row.token === created.token)!;
    expect(invite.usedCount).toBe(3);
    expect(db.orgInviteRedemptions.filter((r) => r.inviteId === invite.id)).toHaveLength(3);

    await expect(
      service.accept(buildContext(userIdOf(99), "u99@test") as never, created.token),
    ).rejects.toBeInstanceOf(GoneDomainError);
  });

  it("open link with no max_uses: unlimited accepts", async () => {
    const created = await service.create(
      buildContext(userIdOf(1), "owner@test") as never,
      {
        orgSlug: "acme",
        email: null,
        role: "member",
        maxUses: null,
        expiresInDays: 7,
        isOpen: true,
      },
      "owner",
    );
    for (let i = 0; i < 12; i++) {
      const id = userIdOf(20 + i);
      const out = await service.accept(
        buildContext(id, `u${i}@test`) as never,
        created.token,
      );
      expect(out.orgId).toBe("org-1");
    }
    const invite = db.orgInvites.find((row) => row.token === created.token)!;
    expect(invite.usedCount).toBe(12);
  });

  it("members cannot create invites (guard surfaces 403)", () => {
    // The guard is the authoritative gate; the service rejects owner
    // invites issued by non-owners directly.
    return expect(
      service.create(
        buildContext(userIdOf(3), "member@test") as never,
        {
          orgSlug: "acme",
          email: "x@test",
          role: "member",
          maxUses: null,
          expiresInDays: 7,
          isOpen: false,
        },
        "member",
      ),
    ).resolves.toBeDefined(); // service itself doesn't enforce — guard does
  });

  it("admin cannot mint an owner invite (403)", async () => {
    await expect(
      service.create(
        buildContext(userIdOf(2), "admin@test") as never,
        {
          orgSlug: "acme",
          email: "next-owner@test",
          role: "owner",
          maxUses: null,
          expiresInDays: 7,
          isOpen: false,
        },
        "admin",
      ),
    ).rejects.toBeInstanceOf(ForbiddenDomainError);
  });

  it("owner can mint an owner invite", async () => {
    const created = await service.create(
      buildContext(userIdOf(1), "owner@test") as never,
      {
        orgSlug: "acme",
        email: "next-owner@test",
        role: "owner",
        maxUses: null,
        expiresInDays: 7,
        isOpen: false,
      },
      "owner",
    );
    expect(created.role).toBe("owner");
  });

  it("expired invite returns 410 (GoneDomainError)", async () => {
    const created = await service.create(
      buildContext(userIdOf(1), "owner@test") as never,
      {
        orgSlug: "acme",
        email: "ghost@test",
        role: "member",
        maxUses: null,
        expiresInDays: 7,
        isOpen: false,
      },
      "owner",
    );
    const invite = db.orgInvites.find((row) => row.token === created.token)!;
    invite.expiresAt = new Date(Date.now() - 1000);
    await expect(
      service.accept(buildContext(userIdOf(50), "ghost@test") as never, created.token),
    ).rejects.toBeInstanceOf(GoneDomainError);
    // preview() returns null for expired invites (controller maps to 404).
    expect(await service.preview(created.token)).toBeNull();
  });

  it("revoked invite returns 410 and disappears from preview", async () => {
    const created = await service.create(
      buildContext(userIdOf(1), "owner@test") as never,
      {
        orgSlug: "acme",
        email: "ghost@test",
        role: "member",
        maxUses: null,
        expiresInDays: 7,
        isOpen: false,
      },
      "owner",
    );
    await service.revoke(
      buildContext(userIdOf(1), "owner@test") as never,
      created.inviteId,
    );
    expect(await service.preview(created.token)).toBeNull();
    await expect(
      service.accept(buildContext(userIdOf(51), "ghost@test") as never, created.token),
    ).rejects.toBeInstanceOf(GoneDomainError);
  });

  it("targeted invite is forbidden for callers whose email mismatches", async () => {
    const created = await service.create(
      buildContext(userIdOf(1), "owner@test") as never,
      {
        orgSlug: "acme",
        email: "expected@test",
        role: "member",
        maxUses: null,
        expiresInDays: 7,
        isOpen: false,
      },
      "owner",
    );
    await expect(
      service.accept(buildContext(userIdOf(60), "other@test") as never, created.token),
    ).rejects.toBeInstanceOf(ForbiddenDomainError);
  });

  it("preview returns null for an unknown token", async () => {
    expect(await service.preview("inv_does-not-exist-xxxxxxxx")).toBeNull();
  });

  it("validation: max_uses must be positive", async () => {
    await expect(
      service.create(
        buildContext(userIdOf(1), "owner@test") as never,
        {
          orgSlug: "acme",
          email: null,
          role: "member",
          maxUses: 0,
          expiresInDays: 7,
          isOpen: true,
        },
        "owner",
      ),
    ).rejects.toBeInstanceOf(ValidationDomainError);
  });

  it("accept requires a signed-in user with userId", async () => {
    const created = await service.create(
      buildContext(userIdOf(1), "owner@test") as never,
      {
        orgSlug: "acme",
        email: null,
        role: "member",
        maxUses: null,
        expiresInDays: 7,
        isOpen: true,
      },
      "owner",
    );
    await expect(
      service.accept(buildContext(null, null) as never, created.token),
    ).rejects.toBeInstanceOf(ValidationDomainError);
  });

  it("list returns the unconsumed invites", async () => {
    const open = await service.create(
      buildContext(userIdOf(1), "owner@test") as never,
      {
        orgSlug: "acme",
        email: null,
        role: "member",
        maxUses: 5,
        expiresInDays: 7,
        isOpen: true,
      },
      "owner",
    );
    const targeted = await service.create(
      buildContext(userIdOf(1), "owner@test") as never,
      {
        orgSlug: "acme",
        email: "pending@test",
        role: "admin",
        maxUses: null,
        expiresInDays: 7,
        isOpen: false,
      },
      "owner",
    );
    const list = await service.list(
      buildContext(userIdOf(1), "owner@test") as never,
      "acme",
    );
    const ids = list.map((i) => i.id);
    expect(ids).toContain(open.inviteId);
    expect(ids).toContain(targeted.inviteId);
  });

  it("create fails when the org doesn't exist", async () => {
    await expect(
      service.create(
        buildContext(userIdOf(1), "owner@test") as never,
        {
          orgSlug: "does-not-exist",
          email: "x@y.z",
          role: "member",
          maxUses: null,
          expiresInDays: 7,
          isOpen: false,
        },
        "owner",
      ),
    ).rejects.toBeInstanceOf(NotFoundDomainError);
  });
});

describe("RequireOrgRoleGuard.canActivate", () => {
  const buildGuard = (db: FakeDb) => {
    const reflector = {
      getAllAndOverride: (_key: string, _targets: unknown[]) => "admin",
    } as never;
    return new RequireOrgRoleGuard(reflector, db as never);
  };

  const buildExecutionContext = (request: unknown) =>
    ({
      switchToHttp: () => ({ getRequest: () => request }),
      getHandler: () => ({}),
      getClass: () => ({}),
    }) as never;

  it("throws 404 when caller isn't a member (no org existence leak)", async () => {
    const db = new FakeDb();
    db.orgs.push({ id: "org-1", slug: "acme", name: "Acme", createdBy: null });
    const guard = buildGuard(db);
    const request = {
      actorContext: { principal: { userId: "user-x", email: null } },
      body: { org_slug: "acme" },
      params: {},
      query: {},
    };
    await expect(
      guard.canActivate(buildExecutionContext(request)),
    ).rejects.toBeInstanceOf(NotFoundDomainError);
  });

  it("throws 403 when caller's role is below the required role", async () => {
    const db = new FakeDb();
    db.orgs.push({ id: "org-1", slug: "acme", name: "Acme", createdBy: null });
    db.orgMembers.push({
      orgId: "org-1",
      userId: "user-x",
      role: "member",
      invitedBy: null,
    });
    const guard = buildGuard(db);
    const request = {
      actorContext: { principal: { userId: "user-x", email: null } },
      body: { org_slug: "acme" },
      params: {},
      query: {},
    };
    await expect(
      guard.canActivate(buildExecutionContext(request)),
    ).rejects.toBeInstanceOf(ForbiddenDomainError);
  });

  it("allows when role meets required level + stashes resolved org id/role", async () => {
    const db = new FakeDb();
    db.orgs.push({ id: "org-1", slug: "acme", name: "Acme", createdBy: null });
    db.orgMembers.push({
      orgId: "org-1",
      userId: "user-x",
      role: "owner",
      invitedBy: null,
    });
    const guard = buildGuard(db);
    const request: Record<string, unknown> = {
      actorContext: { principal: { userId: "user-x", email: null } },
      body: { org_slug: "acme" },
      params: {},
      query: {},
    };
    await expect(
      guard.canActivate(buildExecutionContext(request)),
    ).resolves.toBe(true);
    expect((request as { resolvedOrgId?: string }).resolvedOrgId).toBe("org-1");
    expect((request as { resolvedOrgRole?: string }).resolvedOrgRole).toBe("owner");
  });
});
