import { getCurrentEnd } from "../../../../components/utils/getCurrentEnd";

describe("getCurrentEnd", () => {
  it("returns the last character of a string", () => {
    expect(getCurrentEnd("hello")).toBe("o");
    expect(getCurrentEnd("world")).toBe("d");
  });

  it("handles empty string", () => {
    expect(getCurrentEnd("")).toBe("");
  });

  it("handles single character string", () => {
    expect(getCurrentEnd("a")).toBe("a");
  });

  it("returns the last element of an array", () => {
    expect(getCurrentEnd([1, 2, 3])).toStrictEqual([1, 2, 3]);
  });

  it("returns undefined for null input", () => {
    expect(getCurrentEnd(null)).toBe(null);
  });

  it("returns undefined for undefined input", () => {
    expect(getCurrentEnd(undefined)).toBe(undefined);
  });

  it("returns the last character of a string with special characters", () => {
    expect(getCurrentEnd("hello!")).toBe("!");
    expect(getCurrentEnd("привет")).toBe("т");
  });
});
