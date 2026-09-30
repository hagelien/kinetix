import { describe, expect, it } from "vitest";
import {
  canContribute,
  DEFAULT_NEW_USER_ROLE,
  isReviewer,
  isRole,
  ROLE_VALUES,
  roleAtLeast,
} from "./roles";

describe("roleAtLeast", () => {
  it("orders authenticated < contributor < editor < admin", () => {
    expect(roleAtLeast("admin", "authenticated")).toBe(true);
    expect(roleAtLeast("editor", "contributor")).toBe(true);
    expect(roleAtLeast("contributor", "authenticated")).toBe(true);
    expect(roleAtLeast("authenticated", "contributor")).toBe(false);
    expect(roleAtLeast("contributor", "editor")).toBe(false);
    expect(roleAtLeast("editor", "admin")).toBe(false);
  });

  it("treats null/undefined and unknown roles as below every tier", () => {
    expect(roleAtLeast(null, "authenticated")).toBe(false);
    expect(roleAtLeast(undefined, "authenticated")).toBe(false);
    expect(roleAtLeast("viewer", "authenticated")).toBe(false);
  });
});

describe("isReviewer", () => {
  it("is true only for editor and admin", () => {
    expect(isReviewer("admin")).toBe(true);
    expect(isReviewer("editor")).toBe(true);
    expect(isReviewer("contributor")).toBe(false);
    expect(isReviewer("authenticated")).toBe(false);
    expect(isReviewer(null)).toBe(false);
  });
});

describe("canContribute", () => {
  it("is true for contributor and above", () => {
    expect(canContribute("admin")).toBe(true);
    expect(canContribute("editor")).toBe(true);
    expect(canContribute("contributor")).toBe(true);
    expect(canContribute("authenticated")).toBe(false);
    expect(canContribute(null)).toBe(false);
  });
});

describe("isRole / ROLE_VALUES / defaults", () => {
  it("recognizes the four canonical roles", () => {
    for (const r of ROLE_VALUES) {
      expect(isRole(r)).toBe(true);
    }
    expect(isRole("viewer")).toBe(false);
    expect(isRole("")).toBe(false);
  });

  it("defaults new signups to authenticated", () => {
    expect(DEFAULT_NEW_USER_ROLE).toBe("authenticated");
  });
});
