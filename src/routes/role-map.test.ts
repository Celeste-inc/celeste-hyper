import { describe, it, expect } from "bun:test";
import { requiredRole, hasRole, isMutation } from "./role-map.ts";

describe("role hierarchy", () => {
  it("ranks admin > operator > viewer", () => {
    expect(hasRole("admin", "viewer")).toBe(true);
    expect(hasRole("admin", "operator")).toBe(true);
    expect(hasRole("admin", "admin")).toBe(true);
    expect(hasRole("operator", "viewer")).toBe(true);
    expect(hasRole("operator", "operator")).toBe(true);
    expect(hasRole("operator", "admin")).toBe(false);
    expect(hasRole("viewer", "viewer")).toBe(true);
    expect(hasRole("viewer", "operator")).toBe(false);
    expect(hasRole("nonsense", "viewer")).toBe(false);
  });
});

describe("requiredRole", () => {
  it("reads require viewer", () => {
    expect(requiredRole("GET", "/api/clusters")).toBe("viewer");
    expect(requiredRole("GET", "/api/services/x/pods")).toBe("viewer");
  });
  it("mutations require operator", () => {
    expect(requiredRole("POST", "/api/clusters")).toBe("operator");
    expect(requiredRole("DELETE", "/api/services/x")).toBe("operator");
    expect(requiredRole("PATCH", "/api/clusters/x")).toBe("operator");
  });
  it("self-service auth routes require only viewer regardless of method", () => {
    expect(requiredRole("POST", "/api/change-password")).toBe("viewer");
    expect(requiredRole("POST", "/api/logout")).toBe("viewer");
    expect(requiredRole("GET", "/api/me")).toBe("viewer");
  });
  it("minting a log-stream token is a read (viewer), though it is a POST", () => {
    expect(requiredRole("POST", "/api/services/hello/logs/token")).toBe("viewer");
  });
  it("admin-only paths require admin (reserved for user management)", () => {
    expect(requiredRole("POST", "/api/users")).toBe("admin");
    expect(requiredRole("DELETE", "/api/users/bob")).toBe("admin");
    expect(requiredRole("GET", "/api/users")).toBe("admin");
  });
});

describe("isMutation", () => {
  it("treats non-read methods as mutations", () => {
    expect(isMutation("GET")).toBe(false);
    expect(isMutation("HEAD")).toBe(false);
    expect(isMutation("POST")).toBe(true);
    expect(isMutation("PATCH")).toBe(true);
    expect(isMutation("PUT")).toBe(true);
    expect(isMutation("DELETE")).toBe(true);
  });
});
