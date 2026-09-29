"use strict";

const fs = require("node:fs/promises");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

const webRoot = path.join(__dirname, "web");
const staticFiles = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/index.html", ["index.html", "text/html; charset=utf-8"]],
  ["/styles.css", ["styles.css", "text/css; charset=utf-8"]],
  ["/app.js", ["app.js", "text/javascript; charset=utf-8"]],
]);

function classifyDriver(devicePath) {
  try {
    const target = require("node:fs").readlinkSync(path.join(devicePath, "driver"));
    const driver = path.basename(target);
    return driver
      ? { status: "bound", name: driver }
      : { status: "unknown", reason: "driver link has no readable name" };
  } catch (error) {
    if (error.code === "ENOENT") {
      return {
        status: "unknown",
        reason: "device has no driver binding; this alone cannot confirm a missing driver",
      };
    }
    return { status: "unknown", reason: error.message };
  }
}

async function readId(devicePath, name) {
  try {
    const value = await fs.readFile(path.join(devicePath, name), "utf8");
    return value.trim().replace(/^0x/i, "").toLowerCase() || null;
  } catch {
    return null;
  }
}

async function scanLinuxPci(sysfsRoot = "/sys") {
  const devicesPath = path.join(sysfsRoot, "bus", "pci", "devices");
  const entries = await fs.readdir(devicesPath, { withFileTypes: true });
  const devices = await Promise.all(entries.map(async (entry) => {
    const devicePath = path.join(devicesPath, entry.name);
    const [vendorId, deviceId] = await Promise.all([
      readId(devicePath, "vendor"),
      readId(devicePath, "device"),
    ]);
    return {
      address: entry.name,
      vendor_id: vendorId,
      device_id: deviceId,
      driver: classifyDriver(devicePath),
    };
  }));

  devices.sort((left, right) => left.address.localeCompare(right.address));
  return devices;
}

function sendJson(response, status, value) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(JSON.stringify(value));
}

function createServer({ sysfsRoot = "/sys" } = {}) {
  return http.createServer(async (request, response) => {
    const pathname = new URL(request.url, "http://127.0.0.1").pathname;
    if (pathname === "/api/scan") {
      if (request.method !== "GET") {
        response.setHeader("Allow", "GET");
        return sendJson(response, 405, { error: "Method not allowed" });
      }
      if (process.platform !== "linux") {
        return sendJson(response, 501, {
          error: `Local scanning is not implemented for ${process.platform}`,
        });
      }

      try {
        const devices = await scanLinuxPci(sysfsRoot);
        return sendJson(response, 200, {
          platform: "Linux",
          kernel: os.release(),
          scanned_at: new Date().toISOString(),
          devices,
        });
      } catch (error) {
        return sendJson(response, 500, { error: `PCI scan failed: ${error.message}` });
      }
    }

    if (request.method !== "GET") {
      response.setHeader("Allow", "GET");
      response.writeHead(405);
      return response.end("Method not allowed");
    }

    const file = staticFiles.get(pathname);
    if (!file) {
      response.writeHead(404);
      return response.end("Not found");
    }

    try {
      const content = await fs.readFile(path.join(webRoot, file[0]));
      response.writeHead(200, {
        "Content-Type": file[1],
        "Cache-Control": "no-store",
        "Content-Security-Policy": "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'",
        "Referrer-Policy": "no-referrer",
        "X-Content-Type-Options": "nosniff",
      });
      return response.end(content);
    } catch {
      response.writeHead(500);
      return response.end("Unable to read local application files");
    }
  });
}

if (require.main === module) {
  const port = Number(process.env.PORT || 4173);
  const server = createServer();
  server.listen(port, "127.0.0.1", () => {
    process.stdout.write(`OpenSourceDrivers running at http://127.0.0.1:${port}\n`);
  });
  server.on("error", (error) => {
    process.stderr.write(`Unable to start local server: ${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = { classifyDriver, createServer, scanLinuxPci };