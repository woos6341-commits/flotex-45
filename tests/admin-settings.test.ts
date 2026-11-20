import { beforeEach, describe, expect, it, vi } from "vitest";
import { appRouter } from "../server/routers";

const paymentService = vi.hoisted(() => ({
  updatePaymentMethod: vi.fn(),
  getPaymentServiceStatus: vi.fn(),
  updatePaymentServiceStatus: vi.fn(),
}));
const databaseService = vi.hoisted(() => ({
  getOperationLimits: vi.fn(),
  updateOperationLimits: vi.fn(),
}));

vi.mock("../server/payment-settings", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../server/payment-settings")>()),
  ...paymentService,
}));
vi.mock("../server/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../server/db")>()),
  ...databaseService,
}));

function caller(user: { id: number; role: "user" | "admin"; email: string }) {
  return appRouter.createCaller({ req: {} as any, res: { setHeader: vi.fn() } as any, user } as any);
}

const admin = { id: 42, role: "admin" as const, email: "dyblhwyty@gmail.com" };
const regularUser = { id: 13, role: "user" as const, email: "customer@example.com" };

beforeEach(() => {
  vi.clearAllMocks();
  paymentService.updatePaymentMethod.mockResolvedValue({
    id: "vodafone",
    name: "Vodafone Cash",
    transferNumber: "01001234567",
    imageUrl: null,
  });
  paymentService.getPaymentServiceStatus.mockResolvedValue({ depositEnabled: true, withdrawalEnabled: true, updatedAt: null });
  paymentService.updatePaymentServiceStatus.mockResolvedValue({ depositEnabled: false, withdrawalEnabled: true, updatedAt: new Date() });
  databaseService.getOperationLimits.mockResolvedValue({
    minDepositAmount: 500,
    minWithdrawalAmount: 50,
    minTransferAmount: 1200,
    maxTradeAmount: null,
    maxDepositAmount: null,
    maxWithdrawalAmount: null,
  });
  databaseService.updateOperationLimits.mockResolvedValue({
    minDepositAmount: 600,
    minWithdrawalAmount: 50,
    minTransferAmount: 1200,
    maxTradeAmount: null,
    maxDepositAmount: null,
    maxWithdrawalAmount: null,
  });
});

describe("admin payment settings routes", () => {
  it("routes payment-number edits to the protected payment-method service", async () => {
    const input = { id: "vodafone" as const, name: "Vodafone Cash", transferNumber: "01001234567" };
    await expect(caller(admin).admin.updatePaymentMethod(input)).resolves.toMatchObject(input);
    expect(paymentService.updatePaymentMethod).toHaveBeenCalledWith(admin.id, input);
  });

  it("routes limit updates to the protected database service", async () => {
    const input = { minDepositAmount: "600.00", minWithdrawalAmount: "50.00", minTransferAmount: "1200.00" };
    await caller(admin).admin.updateLimits(input);
    expect(databaseService.updateOperationLimits).toHaveBeenCalledWith(admin.id, input);
  });

  it("rejects payment-method and limit edits from a regular user", async () => {
    const ordinary = caller(regularUser);
    await expect(ordinary.admin.updatePaymentMethod({ id: "vodafone", name: "Vodafone Cash", transferNumber: "01001234567" }))
      .rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(ordinary.admin.updateLimits({ minDepositAmount: "600.00" }))
      .rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(paymentService.updatePaymentMethod).not.toHaveBeenCalled();
    expect(databaseService.updateOperationLimits).not.toHaveBeenCalled();
  });

  it("reads and updates deposit and withdrawal service switches independently", async () => {
    await expect(caller(admin).admin.paymentServiceStatus()).resolves.toMatchObject({ depositEnabled: true, withdrawalEnabled: true });
    const input = { depositEnabled: false };
    await expect(caller(admin).admin.updatePaymentServiceStatus(input)).resolves.toMatchObject({ depositEnabled: false, withdrawalEnabled: true });
    expect(paymentService.updatePaymentServiceStatus).toHaveBeenCalledWith(admin.id, input);
    await expect(caller(regularUser).admin.updatePaymentServiceStatus(input)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});
