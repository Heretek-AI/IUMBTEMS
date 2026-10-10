// S5.4 (CodeQL #84) remote property injection (repair-151): request headers
// parse into a Map (never a plain `{}` keyed by remote names), non-token
// names are rejected, and `field()` is actually case-insensitive.
import { describe, expect, test } from "bun:test"
import { field, parseHeaders } from "../src/telemetry.ts"

describe("header parsing (S5.4)", () => {
  test("__proto__ stays a plain key, never the prototype", () => {
    const headers = parseHeaders(["__proto__: polluted", "X-Ok: 1"])
    expect(headers.get("__proto__")).toBe("polluted")
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
    expect((Object.prototype as Record<string, unknown>).polluted).toBeUndefined()
    delete (Object.prototype as Record<string, unknown>).polluted
  })

  test("names are lowercased and non-token names are rejected", () => {
    const headers = parseHeaders(["HoSt: 127.0.0.1:9", "Bad Name: x", "X-Ok: 1", ": empty", "NoColon"])
    expect(headers.get("host")).toBe("127.0.0.1:9")
    expect(headers.has("bad name")).toBe(false)
    expect(headers.get("x-ok")).toBe("1")
    expect(headers.size).toBe(2)
  })

  test("field() is case-insensitive", () => {
    const headers = parseHeaders(["Host: 127.0.0.1:9", "Authorization: Bearer abc"])
    expect(field(headers, "Host")).toBe("127.0.0.1:9")
    expect(field(headers, "HOST")).toBe("127.0.0.1:9")
    expect(field(headers, "authorization")).toBe("Bearer abc")
    expect(field(headers, "AUTHORIZATION")).toBe("Bearer abc")
    expect(field(headers, "missing")).toBeUndefined()
  })
})
