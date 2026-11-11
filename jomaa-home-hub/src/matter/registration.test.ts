import assert from "node:assert/strict";
import { test } from "node:test";
import { ManualPairingCodeCodec, VendorId } from "@matter/main/types";
import { selectedCommissioningRequest } from "./controller.js";
import { MatterError, type CommissionableDevice } from "./nodes.js";

const device: CommissionableDevice = {
  instanceName: "desk",
  deviceName: "Desk Lamp",
  vendorId: 0xfff1,
  productId: 0x8000,
  deviceType: 256,
  longDiscriminator: 1234,
  commissioningMode: 2,
  addresses: ["fd00::1"],
  port: 5540,
};

test("manual pairing keeps the selected full discriminator and address", () => {
  const code = ManualPairingCodeCodec.encode({ passcode: 20202021, discriminator: 1234 });
  assert.deepEqual(selectedCommissioningRequest(code, device), {
    passcode: 20202021,
    longDiscriminator: 1234,
    knownAddress: { ip: "fd00::1", port: 5540 },
  });
});

test("codes for another discriminator or manufacturer cannot pair the selection", () => {
  const differentDiscriminator = ManualPairingCodeCodec.encode({ passcode: 20202021, discriminator: 2048 });
  const differentVendor = ManualPairingCodeCodec.encode({
    passcode: 20202021,
    discriminator: 1234,
    vendorId: VendorId(0xfff2),
    productId: 1,
  });
  for (const code of [differentDiscriminator, differentVendor]) {
    assert.throws(() => selectedCommissioningRequest(code, device), /does not match/);
  }
});

test("QR pairing checks the full discriminator and product identity", () => {
  const code = "MT:Y.K90AFN00KA0648G00";
  const qrDevice = { ...device, longDiscriminator: 3840 };
  assert.equal(selectedCommissioningRequest(code, qrDevice).longDiscriminator, 3840);
  assert.throws(() => selectedCommissioningRequest(code, device), /does not match/);
  assert.throws(() => selectedCommissioningRequest(code, { ...qrDevice, productId: 1 }), /does not match/);
});

test("invalid setup codes do not appear in error messages", () => {
  for (const code of ["private-invalid-code", "MT:private-invalid-code"]) {
    assert.throws(
      () => selectedCommissioningRequest(code, device),
      (reason: unknown) => {
        assert.ok(reason instanceof MatterError);
        assert.equal(reason.message.includes(code), false);
        return true;
      },
    );
  }
});
