const scanButton = document.querySelector("#scan-button");
const searchInput = document.querySelector("#search-input");
const statusFilter = document.querySelector("#status-filter");
const treeElement = document.querySelector("#device-tree");
const emptyState = document.querySelector("#empty-state");
const emptyTitle = document.querySelector("#empty-title");
const emptyCopy = document.querySelector("#empty-copy");
const resultCount = document.querySelector("#result-count");
const reportMeta = document.querySelector("#report-meta");
const notice = document.querySelector("#notice");

let devices = null;
const canScanLocally = location.protocol === "http:" && location.hostname === "127.0.0.1";

scanButton.disabled = !canScanLocally;
if (!canScanLocally) scanButton.title = "Start the local server to scan this machine";

searchInput.addEventListener("input", renderRows);
statusFilter.addEventListener("change", renderRows);
scanButton.addEventListener("click", scanMachine);

async function scanMachine() {
  if (!canScanLocally) return;
  scanButton.disabled = true;
  scanButton.textContent = "Scanning…";
  notice.textContent = "";

  try {
    const response = await fetch("/api/scan", { cache: "no-store" });
    const report = await response.json();
    if (!response.ok) throw new Error(report.error || "Local scan failed.");
    applyReport(report);
  } catch (error) {
    notice.textContent = error.message;
  } finally {
    scanButton.textContent = "Scan this machine";
    scanButton.disabled = false;
  }
}

function applyReport(report) {
  const reportDevices = Array.isArray(report) ? report : report?.devices;
  if (!Array.isArray(reportDevices)) {
    throw new Error("The report must contain a devices array.");
  }

  const nextDevices = reportDevices.map(normalizeDevice);
  devices = nextDevices;
  const platform = report?.platform ?? report?.os ?? "Local scan";
  const scannedAt = report?.scanned_at ?? report?.created_at;
  reportMeta.textContent = scannedAt
    ? `${platform} · ${formatDate(scannedAt)}`
    : `${platform} · scan completed`;
  searchInput.disabled = false;
  statusFilter.disabled = false;
  notice.textContent = "";
  updateSummary();
  renderRows();
}

function normalizeDevice(device, index) {
  if (!device || typeof device !== "object" || Array.isArray(device)) {
    throw new Error(`Device entry ${index + 1} must be an object.`);
  }

  const driver = normalizeDriver(device.driver);
  const address = textValue(device.address ?? device.instance_id ?? device.id);
  const vendorId = normalizeId(device.vendor_id ?? device.vendorId);
  const deviceId = normalizeId(device.device_id ?? device.deviceId);
  const label = textValue(device.name ?? device.description) || address || "Unnamed device";

  return {
    label,
    address,
    vendorId,
    deviceId,
    driverName: driver.name,
    driverReason: driver.reason,
    status: driver.status,
  };
}

function normalizeDriver(value) {
  if (typeof value === "string") {
    const normalized = value.trim();
    const status = normalized.toLowerCase();
    if (["missing", "unbound", "none"].includes(status)) {
      return { status: "missing", name: "", reason: "" };
    }
    if (["unknown", "indeterminate"].includes(status)) {
      return { status: "unknown", name: "", reason: "" };
    }
    if (normalized) return { status: "bound", name: normalized, reason: "" };
  }

  if (value && typeof value === "object" && !Array.isArray(value)) {
    const stateName = Object.keys(value)[0];
    const stateValue = stateName ? value[stateName] : null;
    const state = stateName?.toLowerCase();
    if (state === "bound") {
      const name = typeof stateValue === "string" ? stateValue : stateValue?.driver;
      return name
        ? { status: "bound", name: String(name), reason: "" }
        : { status: "unknown", name: "", reason: "Driver name unavailable" };
    }
    if (state === "missing") return { status: "missing", name: "", reason: "" };
    if (state === "unknown") {
      const reason = typeof stateValue === "string" ? stateValue : stateValue?.reason;
      return { status: "unknown", name: "", reason: textValue(reason) };
    }

    const status = textValue(value.status ?? value.state).toLowerCase();
    const name = textValue(value.name ?? value.driver);
    if (["missing", "unbound"].includes(status)) {
      return { status: "missing", name: "", reason: "" };
    }
    if (status === "bound" || (name && !status)) {
      return name
        ? { status: "bound", name, reason: "" }
        : { status: "unknown", name: "", reason: "Driver name unavailable" };
    }
    if (status === "unknown") {
      return { status: "unknown", name: "", reason: textValue(value.reason) };
    }
  }

  return { status: "unknown", name: "", reason: "Driver status not provided" };
}

function updateSummary() {
  const counts = { bound: 0, missing: 0, unknown: 0 };
  for (const device of devices) counts[device.status] += 1;

  document.querySelector("#count-total").textContent = String(devices.length);
  document.querySelector("#count-bound").textContent = String(counts.bound);
  document.querySelector("#count-missing").textContent = String(counts.missing);
  document.querySelector("#count-unknown").textContent = String(counts.unknown);
}

function renderRows() {
  if (!devices) return;
  const query = searchInput.value.trim().toLowerCase();
  const selectedStatus = statusFilter.value;
  const filtered = devices.filter((device) => {
    const matchesStatus = selectedStatus === "all" || device.status === selectedStatus;
    const searchable = [
      device.label,
      device.address,
      device.vendorId,
      device.deviceId,
      device.driverName,
      device.driverReason,
    ].join(" ").toLowerCase();
    return matchesStatus && searchable.includes(query);
  });

  renderTree(filtered);
  resultCount.textContent = `${filtered.length} of ${devices.length} devices`;
  emptyState.hidden = filtered.length > 0;
  if (devices.length === 0) {
    emptyTitle.textContent = "No devices in report";
    emptyCopy.textContent = "This report contains no device records.";
  } else if (filtered.length === 0) {
    emptyTitle.textContent = "No matching devices";
    emptyCopy.textContent = "Adjust the search or status filter to see other findings.";
  }
}

function renderTree(filtered) {
  const groups = [
    { status: "missing", label: "Missing", open: true },
    { status: "unknown", label: "Unknown", open: true },
    { status: "bound", label: "Driver bound", open: false },
  ];

  treeElement.replaceChildren(...groups.flatMap((group) => {
    const matchingDevices = filtered.filter((device) => device.status === group.status);
    return matchingDevices.length ? [createTreeGroup(group, matchingDevices)] : [];
  }));
}

function createTreeGroup(group, matchingDevices) {
  const details = document.createElement("details");
  details.className = `tree-group tree-${group.status}`;
  details.open = group.open;

  const summary = document.createElement("summary");
  summary.className = "tree-group-summary";
  const heading = document.createElement("span");
  heading.textContent = group.label;
  const count = document.createElement("span");
  count.className = "tree-count";
  count.textContent = String(matchingDevices.length);
  summary.append(heading, count);

  const list = document.createElement("ul");
  list.className = "tree-children";
  for (const device of matchingDevices) list.append(createTreeDevice(device));
  details.append(summary, list);
  return details;
}

function createTreeDevice(device) {
  const item = document.createElement("li");
  item.className = "tree-device";

  const name = document.createElement("span");
  name.className = "tree-device-name";
  name.textContent = device.label;
  const address = document.createElement("span");
  address.className = "tree-device-address";
  address.textContent = device.address || "Address not reported";

  const metadata = document.createElement("span");
  metadata.className = "tree-device-metadata";
  const hardwareId = formatHardwareId(device);
  const driver = device.driverName || device.driverReason || statusLabel(device.status);
  metadata.textContent = `${hardwareId} · ${driver}`;
  item.append(name, address, metadata);
  return item;
}

function formatHardwareId(device) {
  if (device.vendorId && device.deviceId) return `${device.vendorId}:${device.deviceId}`;
  return device.vendorId || device.deviceId || "—";
}

function normalizeId(value) {
  const id = textValue(value).trim().toLowerCase();
  return id.replace(/^0x/, "");
}

function textValue(value) {
  return typeof value === "string" || typeof value === "number" ? String(value) : "";
}

function statusLabel(status) {
  return { bound: "Driver bound", missing: "Missing", unknown: "Unknown" }[status];
}

function formatDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? textValue(value) : date.toLocaleString();
}