"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createServer, scanLinuxPci } = require("../server.js");

async function createFakeSysfs(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "opensourcedrivers-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const devicesPath = path.join(root, "bus", "pci", "devices");
  await fs.mkdir(devicesPath, { recursive: true });

  async function addDevice(address, { vendor = "0x1234\n", device = "0xabcd\n", driver } = {}) {
    const devicePath = path.join(devicesPath, address);
    await fs.mkdir(devicePath, { recursive: true });
    await fs.writeFile(path.join(devicePath, "vendor"), vendor);
    await fs.writeFile(path.join(devicePath, "device"), device);
    if (driver) {
      const driverPath = path.join(root, "bus", "pci", "drivers", driver);
      await fs.mkdir(driverPath, { recursive: true });
      await fs.symlink(driverPath, path.join(devicePath, "driver"));
    }
  }

  return { root, addDevice };
}

test("scans PCI IDs and distinguishes bound from indeterminate devices", async (t) => {
  const sysfs = await createFakeSysfs(t);
  await sysfs.addDevice("0000:00:02.0", { driver: "test_driver" });
  await sysfs.addDevice("0000:00:01.0");

  const devices = await scanLinuxPci(sysfs.root);

  assert.deepEqual(devices.map((device) => device.address), ["0000:00:01.0", "0000:00:02.0"]);
  assert.equal(devices[0].vendor_id, "1234");
  assert.equal(devices[0].device_id, "abcd");
  assert.equal(devices[0].driver.status, "unknown");
  assert.equal(devices[1].driver.status, "bound");
  assert.equal(devices[1].driver.name, "test_driver");
});

test("serves the web app and a local JSON scan report", async (t) => {
  const sysfs = await createFakeSysfs(t);
  await sysfs.addDevice("0000:00:03.0", { driver: "test_driver" });
  const server = createServer({ sysfsRoot: sysfs.root });
  server.listen(0, "127.0.0.1");
  await new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const page = await fetch(baseUrl);
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-security-policy"), /connect-src 'self'/);
  const pageHtml = await page.text();
  assert.match(pageHtml, /Hardware report/);
  assert.doesNotMatch(pageHtml, /Open report|Export CSV|Choose report/);

  const scan = await fetch(`${baseUrl}/api/scan`);
  assert.equal(scan.status, 200);
  const report = await scan.json();
  assert.equal(report.platform, "Linux");
  assert.equal(report.devices.length, 1);
  assert.equal(report.devices[0].driver.name, "test_driver");
});