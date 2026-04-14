import { describe, expect, it } from "vitest";
import { GENERATED_NETWORK } from "./network.generated.js";

describe("generated network", () => {
  it("exports basic network metadata", () => {
    expect(GENERATED_NETWORK).toBeTruthy();
    expect(typeof GENERATED_NETWORK.chainId).toBe("number");
    expect(GENERATED_NETWORK.chainId).toBeGreaterThan(0);
    expect(typeof GENERATED_NETWORK.makeit).toBe("string");
  });
});
