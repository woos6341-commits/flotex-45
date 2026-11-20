import { describe, expect, it } from "vitest";
import { getVisiblePaymentMethodFields, validateCustomFieldValues, validateMethodFields, type PaymentMethodField } from "../shared/payment-method-fields";

const validFields: PaymentMethodField[] = [
  { key: "account_name", label: "اسم صاحب الحساب", kind: "text", required: true },
  { key: "phone", label: "رقم الهاتف", kind: "phone", required: false },
  { key: "amount_note", label: "تفاصيل إضافية", kind: "note", required: false },
];

describe("الحقول الديناميكية لوسائل الدفع", () => {
  it("يدعم وسائل الدفع القديمة بلا حقول إضافية ولا يتجاوز الحقول التالفة أو غير المعتمدة", () => {
    expect(validateCustomFieldValues(undefined, undefined)).toEqual({});
    expect(validateCustomFieldValues(null, {})).toEqual({});
    expect(() => validateCustomFieldValues(undefined, { invented: "value" })).toThrow("غير معتمد");
    expect(() => validateCustomFieldValues({} as never, {})).toThrow();
  });
  it("يقبل أنواع الحقول المدعومة والحقول الاختيارية مع تحقق القيم المطلوبة", () => {
    expect(validateMethodFields(validFields)).toEqual(validFields);
    expect(validateCustomFieldValues(validFields, { account_name: "  اسم العميل  ", phone: "+201001234567" })).toEqual({ account_name: "اسم العميل", phone: "+201001234567", amount_note: "" });
  });

  it("يرفض المفاتيح المتكررة والحقول المحجوزة والحقول غير المعرفة", () => {
    expect(() => validateMethodFields([{ ...validFields[0] }, { ...validFields[0] }])).toThrow();
    expect(() => validateMethodFields([{ key: "amount", label: "المبلغ", kind: "number", required: true }])).toThrow("محجوز");
    expect(() => validateCustomFieldValues(validFields, { account_name: "عميل", undeclared: "قيمة" })).toThrow("غير معتمد");
  });

  it("يرفض ترك حقل مطلوب فارغًا والقيم الرقمية أو الهاتفية غير الصحيحة", () => {
    expect(() => validateCustomFieldValues(validFields, {})).toThrow("مطلوب");
    expect(() => validateCustomFieldValues([{ key: "ref_number", label: "مرجع", kind: "number", required: true }], { ref_number: "2x" })).toThrow("رقمية");
    expect(() => validateCustomFieldValues([{ key: "contact_phone", label: "الهاتف", kind: "phone", required: true }], { contact_phone: "abc" })).toThrow("هاتف");
  });

  it("يحافظ على ترتيب الحقول ويخفي غير المفعّل عن نموذج العميل والتحقق", () => {
    const fields: PaymentMethodField[] = [
      { key: "withdrawal_code", label: "كود السحب", kind: "reference", required: true },
      { key: "external_id", label: "ID المستخدم", kind: "text", required: false, enabled: false },
      { key: "extra_note", label: "ملاحظة إضافية", kind: "note", required: false },
    ];
    expect(getVisiblePaymentMethodFields(fields).map((field) => field.key)).toEqual(["withdrawal_code", "extra_note"]);
    expect(validateCustomFieldValues(fields, { withdrawal_code: "WD123", extra_note: "" })).toEqual({ withdrawal_code: "WD123", extra_note: "" });
    expect(() => validateCustomFieldValues(fields, { withdrawal_code: "WD123", external_id: "hidden" })).toThrow("غير معتمد");
  });
});
