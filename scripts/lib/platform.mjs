// scripts/lib/platform.mjs
// Helper module imported lazily by scripts/setup.mjs on Windows to (a)
// locate an existing system Python interpreter without depending on
// PATH munging and (b) download the official Python installer when no
// system Python is found.
//
// Kept as its own file (rather than inlined into setup.mjs) so it can
// be unit-tested in isolation and so the dynamic-import path in
// setup.mjs has something to resolve.

const PYTHON_VERSION = '3.12.7'; // pinned for reproducibility; bumping
                                 // this is a deliberate choice — must
                                 // re-verify the installer .exe still
                                 // exists for all archs at the new
                                 // version on python.org/ftp.

/**
 * Returns a URL to the OFFICIAL Python installer (.exe) for the given
 * CPU architecture. We deliberately use the full installer rather than
 * the embeddable ZIP because the ZIP omits pip + venv + ensurepip —
 * setup.mjs needs all three to create the .venv and run
 * `pip install -e .[decoder]` later in the install flow.
 *
 * @param {string} arch process.arch ('x64', 'arm64', or 'ia32')
 * @returns {string} HTTPS URL to a python-<ver>-{amd64|arm64|<empty>}.exe
 * @throws {Error} if arch is unrecognized (rather than silently picking
 *                 a default — bootstrap should surface this clearly).
 */
export function pythonWinInstallerUrl(arch) {
  // Naming convention on https://www.python.org/ftp/python/<ver>/:
  //   python-<ver>-amd64.exe   (x64)
  //   python-<ver>-arm64.exe   (arm64)
  //   python-<ver>.exe         (x86 / ia32 — no suffix)
  let suffix;
  switch (arch) {
    case 'x64':   suffix = '-amd64'; break;
    case 'arm64': suffix = '-arm64'; break;
    case 'ia32':  suffix = '';       break;
    default:
      throw new Error(
        `pythonWinInstallerUrl: unsupported arch '${arch}'. ` +
        `Supported: x64, arm64, ia32. Install Python ${PYTHON_VERSION}+ ` +
        `manually from https://www.python.org/downloads/ and re-run.`
      );
  }
  return `https://www.python.org/ftp/python/${PYTHON_VERSION}/python-${PYTHON_VERSION}${suffix}.exe`;
}

/**
 * Enumerates the places a system Python interpreter is plausibly
 * already installed on a fresh Windows 11 box. setup.mjs walks the
 * iterable and probes each one (`<cand> --version`); the first that
 * reports Python >= 3.9 wins. If nothing matches, setup.mjs falls
 * back to downloading the official installer via
 * `pythonWinInstallerUrl` above.
 *
 * Probe order is fast-to-slow / common-to-rare:
 *   1. `py` launcher with specific version flags — fastest, exact
 *   2. `py -3` and bare `python` / `python3` — PATH-resolved
 *   3. Per-user install dirs under %LOCALAPPDATA%\Programs\Python\PythonXXX
 *   4. System-wide install dirs under %ProgramFiles%\PythonXXX
 *   5. The bundled location at .tooling\python\python.exe (only set
 *      after a prior install; included so re-runs find it without
 *      re-downloading the installer)
 *
 * @returns {Iterable<string>} candidate commands or absolute paths
 */
export function windowsPythonCandidates() {
  const candidates = [
    // py launcher with explicit version pins (newest first)
    'py -3.13',
    'py -3.12',
    'py -3.11',
    'py -3.10',
    'py -3.9',
    'py -3',
    // PATH-resolved names
    'python3.13',
    'python3.12',
    'python3.11',
    'python3.10',
    'python3.9',
    'python3',
    'python',
  ];
  // Per-user install dirs (common when a noob installs from python.org
  // without elevation — the default is per-user / no PATH).
  const localAppData = process.env.LOCALAPPDATA;
  if (localAppData) {
    for (const v of ['313', '312', '311', '310', '39']) {
      candidates.push(`${localAppData}\\Programs\\Python\\Python${v}\\python.exe`);
    }
  }
  // System-wide install dirs (admin-elevated installer, less common).
  const programFiles = process.env.ProgramFiles;
  if (programFiles) {
    for (const v of ['313', '312', '311', '310', '39']) {
      candidates.push(`${programFiles}\\Python${v}\\python.exe`);
    }
  }
  return candidates;
}

export { PYTHON_VERSION };
