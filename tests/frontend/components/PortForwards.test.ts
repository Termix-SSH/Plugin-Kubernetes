import { describe, expect, it } from "vitest";
import {
  firstPort,
  localPortFor,
} from "../../../src/frontend/components/PortForwards";

describe("port forward defaults", () => {
  it("takes the first port from a service's port list", () => {
    expect(firstPort("80/TCP,443:30443/TCP")).toBe(80);
    expect(firstPort("")).toBeNull();
    expect(firstPort(undefined)).toBeNull();
  });

  it("moves privileged ports out of the way on the host", () => {
    expect(localPortFor(80)).toBe(8080);
    expect(localPortFor(5432)).toBe(5432);
  });
});
