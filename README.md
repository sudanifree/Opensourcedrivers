# OpenSourceDrivers

An offline hardware driver inventory tool with a local HTML/CSS/JavaScript UI,
a Node.js Linux and Windows scanner, and a Rust library for native discovery.
Erlang/OTP coordination is planned.

## Scope

The current dashboard calls a read-only Node.js service bound to loopback. It
scans Linux PCI sysfs and Windows Plug and Play devices through local WMI. The
Rust library exposes the Linux PCI inventory slice. Neither replaces
operating-system drivers or bypasses platform security. Hardware discovery and
driver status come from native operating-system interfaces, so each supported
platform needs its own adapter.

The first useful release should detect and report before attempting any
installation. Driver installation is OS- and vendor-specific, often requires
administrator privileges, and can make a system unusable if the wrong package
is selected. Recommendations should identify their source and link to the
operating-system or hardware vendor; installing them should remain an explicit
user action.

## Platform Boundaries

| Platform | Practical first-release capability |
| --- | --- |
| Windows 7 and 10 PCs and servers | Enumerate Plug and Play devices through WMI; only problem code 28 is reported as missing, while other problem states remain unknown. |
| Linux PCs and servers | Local dashboard scans PCI devices and bindings from sysfs. Unbound devices remain indeterminate unless stronger evidence is available. |
| macOS | Report hardware and system information available through supported system interfaces; macOS does not expose a general-purpose third-party driver installer. |
| Android | Limited device inventory where permitted by Android permissions and device policy; an ordinary app cannot install kernel drivers. |
| iOS/iPadOS | No general third-party API for enumerating arbitrary hardware driver failures or installing drivers. Treat as unsupported for driver repair. |

“All operating systems” therefore means a shared Erlang core plus explicit
platform capabilities, not identical detection or automatic repair everywhere.
Embedded systems and server distributions should be added as adapters for
specific supported OS versions and hardware buses.

## Design

- Keep the current web service loopback-only and read-only. Move scan
	coordination to Erlang/OTP when that layer is implemented.
- Normalize device records at the adapter boundary. An unavailable or
	restricted native interface must produce an explicit unsupported,
	permission, or indeterminate result, not a guessed diagnosis.
- Include hardware identifiers, detected driver/binding, OS version, severity,
  and evidence in reports so recommendations can be checked.
- Never download or install a driver without explicit user approval. Verify
  package provenance and signatures through the platform's trusted mechanism.
- Avoid sending hardware inventory off-device by default.

## Run Locally

The local dashboard and scanners use Node.js built-ins only. Start
the loopback-only server with `npm start`, then open
`http://127.0.0.1:4173`. The **Scan this machine** action reads local PCI sysfs
on Linux and queries `Win32_PnPEntity` through Windows PowerShell and WMI on
Windows. The scan remains in the current browser session. Windows 7 requires
a compatible Node.js 12 runtime, which is end-of-life; keep the service local
and use a supported Node.js release on Windows 10. Run the server tests with
`npm test`.

For a C-based Linux diagnostic, compile `c/driver_scan.c` with
`cc -std=c11 -Wall -Wextra -Werror -O2 c/driver_scan.c -o driver-scan` and run
`./driver-scan`. It compares unbound PCI device modaliases with the running
kernel's `modules.alias` and `modules.builtin.alias` indexes. `available-unbound`
reports a matching module that is not currently bound; `missing` means neither
index contains a match. If either index is unavailable, unbound devices remain
`unknown`. The tool is read-only and does not load, download, or install drivers.

## Offline Operation

The local server binds only to `127.0.0.1`, and its API reads local system
interfaces only: Linux sysfs or Windows WMI. It does not download driver
packages or upload inventory.
Live scanning requires the local server; opening `web/index.html` directly
shows the interface but cannot scan devices. Cargo is configured for offline
dependency resolution, and the Rust crate has no third-party dependencies.
Run its tests with `cargo test --offline` when Cargo is available.

Offline scans can identify devices and local driver bindings, but this project
does not yet include an offline hardware-ID recommendation catalog. Driver
downloads and installation are not part of the scanner.

## Initial Milestones

1. Unify the Rust and Node Linux PCI record formats and tests.
2. Add Windows and macOS adapters against their native interfaces.
3. Add Android inventory only where public APIs permit it; document iOS as
	unsupported for generic driver diagnosis.
4. Add vendor/package recommendations only when hardware IDs can be matched
	reliably to trusted sources. Keep installation a separate, opt-in feature.

## Development Status

The live dashboard scans Linux PCI devices and Windows Plug and Play devices.
The Rust library contains the Linux read-only adapter, but it is not wired into
the Node service. Erlang/OTP coordination and macOS and mobile adapters are not
implemented. Linux devices without a driver link and Windows devices with
problem codes other than 28 are shown as unknown rather than presumed to be
missing a driver.