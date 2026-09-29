use std::error::Error;
use std::fmt;
use std::fs;
use std::io;
use std::path::Path;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DriverState {
    Bound { driver: String },
    Missing,
    Unknown { reason: String },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PciDevice {
    pub address: String,
    pub vendor_id: Option<String>,
    pub device_id: Option<String>,
    pub driver: DriverState,
}

#[derive(Debug)]
pub enum ProbeError {
    Io(io::Error),
    UnsupportedPlatform,
}

impl fmt::Display for ProbeError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Io(error) => write!(formatter, "PCI sysfs scan failed: {error}"),
            Self::UnsupportedPlatform => {
                write!(formatter, "PCI probing is not implemented for this platform")
            }
        }
    }
}

impl Error for ProbeError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Io(error) => Some(error),
            Self::UnsupportedPlatform => None,
        }
    }
}

impl From<io::Error> for ProbeError {
    fn from(error: io::Error) -> Self {
        Self::Io(error)
    }
}

/// Read PCI devices and driver bindings from Linux sysfs without modifying the system.
pub fn scan_pci() -> Result<Vec<PciDevice>, ProbeError> {
    #[cfg(target_os = "linux")]
    {
        scan_linux_pci(Path::new("/sys"))
    }

    #[cfg(not(target_os = "linux"))]
    {
        Err(ProbeError::UnsupportedPlatform)
    }
}

#[cfg(target_os = "linux")]
fn scan_linux_pci(sysfs: &Path) -> Result<Vec<PciDevice>, ProbeError> {
    let devices_path = sysfs.join("bus/pci/devices");
    let mut devices = Vec::new();

    for entry in fs::read_dir(devices_path)? {
        let entry = entry?;
        let address = entry.file_name().to_string_lossy().into_owned();
        let device_path = entry.path();

        devices.push(PciDevice {
            address,
            vendor_id: read_hex_id(&device_path.join("vendor")),
            device_id: read_hex_id(&device_path.join("device")),
            driver: read_driver(&device_path),
        });
    }

    devices.sort_by(|left, right| left.address.cmp(&right.address));
    Ok(devices)
}

#[cfg(target_os = "linux")]
fn read_hex_id(path: &Path) -> Option<String> {
    fs::read_to_string(path)
        .ok()
        .map(|value| value.trim().trim_start_matches("0x").to_ascii_lowercase())
        .filter(|value| !value.is_empty())
}

#[cfg(target_os = "linux")]
fn read_driver(device_path: &Path) -> DriverState {
    match fs::read_link(device_path.join("driver")) {
        Ok(driver_path) => match driver_path.file_name().and_then(|name| name.to_str()) {
            Some(driver) => DriverState::Bound {
                driver: driver.to_owned(),
            },
            None => DriverState::Unknown {
                reason: "driver link has no readable name".to_owned(),
            },
        },
        Err(error) if error.kind() == io::ErrorKind::NotFound => DriverState::Unknown {
            reason: "device has no driver binding; sysfs alone cannot confirm a missing driver"
                .to_owned(),
        },
        Err(error) => DriverState::Unknown {
            reason: error.to_string(),
        },
    }
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::{read_driver, scan_linux_pci, DriverState};
    use std::fs;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    struct TestSysfs(PathBuf);

    impl TestSysfs {
        fn new() -> Self {
            let nonce = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("clock should be after epoch")
                .as_nanos();
            let root = std::env::temp_dir().join(format!(
                "open_source_drivers_{}_{}",
                std::process::id(),
                nonce
            ));
            fs::create_dir_all(root.join("bus/pci/devices")).expect("create fake sysfs");
            Self(root)
        }

        fn add_device(&self, address: &str, vendor: &str, device: &str) -> PathBuf {
            let path = self.0.join("bus/pci/devices").join(address);
            fs::create_dir_all(&path).expect("create fake device");
            fs::write(path.join("vendor"), vendor).expect("write vendor id");
            fs::write(path.join("device"), device).expect("write device id");
            path
        }
    }

    impl Drop for TestSysfs {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn scans_ids_and_reports_unbound_device_as_unknown() {
        let sysfs = TestSysfs::new();
        sysfs.add_device("0000:00:01.0", "0x1234\n", "0xabcd\n");

        let devices = scan_linux_pci(&sysfs.0).expect("scan fake sysfs");

        assert_eq!(devices.len(), 1);
        assert_eq!(devices[0].vendor_id.as_deref(), Some("1234"));
        assert_eq!(devices[0].device_id.as_deref(), Some("abcd"));
        assert!(matches!(devices[0].driver, DriverState::Unknown { .. }));
    }

    #[test]
    fn reports_bound_driver_from_sysfs_link() {
        let sysfs = TestSysfs::new();
        let device = sysfs.add_device("0000:00:02.0", "0x1234", "0x0001");
        let driver = sysfs.0.join("bus/pci/drivers/test_driver");
        fs::create_dir_all(&driver).expect("create fake driver");
        std::os::unix::fs::symlink(driver, device.join("driver")).expect("link fake driver");

        assert_eq!(
            read_driver(&device),
            DriverState::Bound {
                driver: "test_driver".to_owned()
            }
        );
    }
}