// Team join links — the pure helpers: codes, parsing a pasted link, slugs.

import { slugFromName } from "../../apps/server/src/modules/projects/services/projects-application.service";
import { newJoinCode } from "../../apps/server/src/modules/teams/repositories/join-link.repository";
import { isPersonalSpace, parseJoinCode } from "../../apps/server/src/modules/teams/services/teams.service";

describe("join codes", () => {
  it("are 10 characters from [A-Za-z0-9] and do not repeat", () => {
    const codes = new Set(Array.from({ length: 2000 }, () => newJoinCode()));
    expect(codes.size).toBe(2000);
    for (const code of codes) expect(code).toMatch(/^[A-Za-z0-9]{10}$/);
  });

  it("parse from a bare code or a whole link, and refuse anything else", () => {
    expect(parseJoinCode("AbCdE12345")).toBe("AbCdE12345");
    expect(parseJoinCode("  https://api.openkt.ai/join/AbCdE12345  ")).toBe("AbCdE12345");
    expect(parseJoinCode("https://api.openkt.ai/join/AbCdE12345?utm=x#y")).toBe("AbCdE12345");
    expect(parseJoinCode("api.openkt.ai/join/AbCdE12345/")).toBe("AbCdE12345");
    expect(parseJoinCode("Ab12x")).toBeNull(); // 5 characters: one short of the minimum
    expect(parseJoinCode("Ab12xY")).toBe("Ab12xY"); // 6: the minimum
    expect(parseJoinCode("a".repeat(32))).toBe("a".repeat(32));
    expect(parseJoinCode("a".repeat(33))).toBeNull();
    expect(parseJoinCode("https://api.openkt.ai/join/")).toBeNull();
    expect(parseJoinCode("drop table;--")).toBeNull();
  });
});

describe("slugFromName", () => {
  it("makes a valid slug from any name, never `personal`", () => {
    expect(slugFromName("Hackathon Crew!")).toBe("hackathon-crew");
    expect(slugFromName("  Café  Déjà Vu ")).toBe("cafe-deja-vu");
    expect(slugFromName("Personal")).toBe("personal-team");
    expect(slugFromName("!!")).toBe("team");
    expect(slugFromName("x")).toBe("team");
    expect(slugFromName("ab")).toBe("ab");
    const long = slugFromName("a".repeat(35) + " b" + "c".repeat(50));
    expect(long).toBe("a".repeat(35));
    expect(slugFromName("z".repeat(80))).toHaveLength(36);
    for (const name of ["Hackathon Crew!", "  Café  Déjà Vu ", "Personal", "!!", "a".repeat(35) + " b"]) {
      expect(slugFromName(name)).toMatch(/^[a-z0-9][a-z0-9-]{1,40}$/);
    }
  });
});

describe("isPersonalSpace", () => {
  it("is the org-less, personal space named `personal` only", () => {
    expect(isPersonalSpace({ visibility: "personal", orgId: null, slug: "personal" })).toBe(true);
    expect(isPersonalSpace({ visibility: "personal", orgId: null, slug: "personal-team" })).toBe(false);
    expect(isPersonalSpace({ visibility: "org", orgId: null, slug: "personal" })).toBe(false);
    expect(isPersonalSpace({ visibility: "personal", orgId: "0b8b0b1e-0000-4000-8000-000000000000", slug: "personal" })).toBe(false);
  });
});
