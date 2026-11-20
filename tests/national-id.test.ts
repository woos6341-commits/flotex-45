import { describe, expect, it } from "vitest";
import { isValidEgyptianNationalId, normalizeEgyptianNationalId, parseEgyptianNationalId } from "../shared/national-id";

describe("الرقم القومي المصري", () => {
  it("يقبل رقمًا صحيحًا من 14 رقمًا ويحوّل الأرقام العربية", () => {
    expect(isValidEgyptianNationalId("29001310100001")).toBe(true);
    expect(normalizeEgyptianNationalId("٢٩٠٠١٣١٠١٠٠٠٠١")).toBe("29001310100001");
    expect(parseEgyptianNationalId("29001310100001")).toBe("29001310100001");
  });

  it.each(["29001310100002", "19001310100001", "29009990100001", "2900131010000", "290013101000001"]) (
    "يرفض الرقم غير الصحيح %s",
    (value) => expect(isValidEgyptianNationalId(value)).toBe(false),
  );
});
