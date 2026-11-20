import { describe, expect, it } from "vitest";
import { getTransactionDisplay } from "../lib/transaction-display";

describe("shared customer transaction rows",()=>{
  it.each([
    ["adjustment","100.00","إيداع","تمت إضافة الأموال","+100.00 ج.م","#47D7A5"],
    ["adjustment","-50.00","خصم","تم خصم الأموال","-50.00 ج.م","#FF7D8D"],
    ["deposit","500.00","إيداع","تمت إضافة الأموال","+500.00 ج.م","#47D7A5"],
    ["withdrawal","50.00","سحب","تم سحب الأموال","-50.00 ج.م","#FF7D8D"],
    ["withdrawal","-50.00","سحب","تم سحب الأموال","-50.00 ج.م","#FF7D8D"],
  ])("renders %s %s correctly",(type,amount,title,description,amountText,color)=>{
    expect(getTransactionDisplay({type,amount,status:"approved"})).toMatchObject({title,description,amountText,color});
  });
  it("formats large amounts consistently and never repeats a sign",()=>{
    expect(getTransactionDisplay({type:"adjustment",amount:"1000.00"}).amountText).toBe("+1,000.00 ج.م");
    expect(getTransactionDisplay({type:"adjustment",amount:"-1000.00"}).amountText).toBe("-1,000.00 ج.م");
  });
  it("never displays old administrative labels or raw reasons",()=>{
    const result=getTransactionDisplay({type:"adjustment",amount:"-50.00",status:"approved",customerTitle:"تعديل إداري",customerDescription:"اعتماد إداري"});
    expect(result.title).toBe("خصم");expect(result.description).toBe("تم خصم الأموال");
  });
  it("does not display a supplied success message for pending or rejected records",()=>{
    expect(getTransactionDisplay({type:"deposit",amount:"500.00",status:"pending",customerDescription:"تمت إضافة الأموال"}).description).toBe("العملية قيد المراجعة");
    expect(getTransactionDisplay({type:"deposit",amount:"500.00",status:"rejected"}).description).toBe("تم رفض العملية ولم يتغير الرصيد");
  });
  it("renders savings refunds as green credits with the exact refund wording",()=>{
    const result=getTransactionDisplay({type:"savings_refund",source:"savings_refund",amount:"100.00",direction:"credit",status:"completed",customerTitle:"استرداد الإدخار"});
    expect(result.title).toBe("استرداد الأموال");expect(result.description).toBe("تم استرداد الأموال");expect(result.amountText).toBe("+100.00 ج.م");expect(result.color).toBe("#47D7A5");
  });
});
